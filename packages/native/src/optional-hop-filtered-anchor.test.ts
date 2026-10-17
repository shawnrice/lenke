// Item 559. `detectOptionalHopCount`'s arithmetic is Σ max(1, degree) over the anchors, so a
// FILTER changes which anchors are summed and nothing else — yet the rung refused `m.where`
// outright, and `plainNode` refused the inline spellings with it. Measured at 200,000 vertices /
// 200,000 edges, one case per process:
//
//   MATCH (n:Person) OPTIONAL MATCH (n)-[:KNOWS]->(x) RETURN count(*)        7.65 -> 10.03 ms
//   ...WHERE n.age > 60                                                    191.17 -> 22.50   8.5x
//   MATCH (n:Person {tag: 'x'}) ...                                        391.04 -> 14.49  27.0x
//   MATCH (n:Person WHERE n.age > 60) ...                                  214.24 -> 22.58   9.5x
//
// THREE SPELLINGS OF ONE FILTER, and the inline property map was the worst of them — which is the
// equivalent-spelling bug class this engine is built to avoid, found by pricing the clause form
// and then asking whether its siblings were admitted too. They were not.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// `a` has two out-edges, `c` one, `b` and `z` none — so the null-filled floor is exercised — and
// `z` has NO properties at all, so a filter over a missing key is UNKNOWN rather than false.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1,"t":"x"}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2,"t":"y"}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"n":5,"t":"x"}}',
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"node","id":"q","labels":["Q"],"properties":{"n":9,"t":"x"}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"c","to":"z","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a FILTERED anchor on the optional-hop count (item 559)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  const opt = (head: string): string => `${head} OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*) AS t`;

  test('the UNFILTERED control: four anchors, three edges, two null-filled rows', () => {
    agree(opt('MATCH (n:P)'), '[{"t":5}]');
  });

  test('all THREE spellings of one filter agree, and agree with each other', () => {
    // `t = 'x'` keeps `a` (degree 2) and `c` (degree 1): 3.
    agree(opt("MATCH (n:P {t: 'x'})"), '[{"t":3}]');
    agree(opt("MATCH (n:P WHERE n.t = 'x')"), '[{"t":3}]');
    agree(opt("MATCH (n:P) WHERE n.t = 'x'"), '[{"t":3}]');
    // `n > 1` keeps `b` (degree 0, so the floor of 1) and `c` (degree 1): 2.
    agree(opt('MATCH (n:P) WHERE n.n > 1'), '[{"t":2}]');
    agree(opt('MATCH (n:P WHERE n.n > 1)'), '[{"t":2}]');
  });

  test('the two spellings COMPOSE, in written order', () => {
    // `{t: 'x'}` keeps a and c; `n > 1` then keeps only c, whose degree is 1.
    agree(opt("MATCH (n:P {t: 'x'}) WHERE n.n > 1"), '[{"t":1}]');
    agree(opt("MATCH (n:P WHERE n.t = 'x') WHERE n.n > 1"), '[{"t":1}]');
  });

  test("three-valued logic is the general path's", () => {
    // `z` has no `n`, so `n.missing > 1` is UNKNOWN for every anchor and nothing is kept — the
    // floor does NOT apply to an anchor the filter removed, which is the whole arithmetic.
    agree(opt('MATCH (n:P) WHERE n.missing > 1'), '[{"t":0}]');
    agree(opt('MATCH (n:P) WHERE n.n > 99'), '[{"t":0}]');
  });

  test('the hop side is unchanged by the filter', () => {
    agree(opt('MATCH (n) WHERE n.n > 1'), '[{"t":3}]');
    agree(
      'MATCH (n:P) WHERE n.n > 1 OPTIONAL MATCH (n)<-[:T]-(x) RETURN count(*) AS t',
      '[{"t":2}]',
    );
    agree(
      'MATCH (n:P) WHERE n.n > 1 OPTIONAL MATCH (n)-[:T]->(x:P) RETURN count(*) AS t',
      '[{"t":2}]',
    );
    agree(
      'MATCH (n:P) WHERE n.n > 1 OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*) AS t LIMIT 1',
      '[{"t":2}]',
    );
  });

  test('WRITTEN ORDER: the inline filter short-circuits the clause WHERE', () => {
    // `{t: 'zz'}` matches nothing, so the faulting clause `WHERE` beside it is never reached and
    // the answer is 0 — in BOTH engines. Composing the two gates in the other order would fault
    // instead, which is what makes this the test for the composition order rather than a comment
    // about it.
    agree(opt("MATCH (n:P {t: 'zz'}) WHERE 1 / 0 > 0"), '[{"t":0}]');
    // The same short-circuit inside one conjunction, for comparison.
    agree(opt("MATCH (n:P) WHERE 1 / 0 > 0 AND n.t = 'zz'"), '[{"t":0}]');
  });

  test('an inline property the rung cannot gate per anchor is REFUSED', () => {
    // `{t: n.t}` reads the anchor's own variable in the VALUE position, which `inlineOf` refuses
    // because it cannot be evaluated before the anchor is bound. The rung declines, so this is the
    // general path's answer — and it is NOT compared against native, because the two engines
    // DIVERGE on this shape for a reason that has nothing to do with this rung (see below).
    //
    // TS counts all four anchors — a(2) + b(1 floor) + c(1) + z(1 floor) = 5 — because it applies
    // the inline `IS NULL` rule (item 260) to a value that EVALUATES to null, and `z` has no `t`.
    // Native applies that rule only to a LITERAL null, so it excludes `z` and answers 4.
    //
    // A rung that took this shape and dropped the gate would also answer 5, which is exactly why
    // the mutant needed this case AND why the case cannot use `agree`.
    expect(JSON.stringify(tsQuery(tsGraph, opt('MATCH (n:P {t: n.t})')))).toBe('[{"t":5}]');
    expect(JSON.stringify(nativeGraph.query(opt('MATCH (n:P {t: n.t})')))).toBe('[{"t":4}]');
    // `{t: n.missing}` is the case that DISCRIMINATES, and it took two attempts to find: the
    // value is null for every anchor, so TS's inline IS NULL rule keeps only the anchors whose
    // `t` is absent — just `z`, whose degree is 0, so the floor makes it 1. A rung that took the
    // shape and dropped the gate would count all four anchors and answer 5, the same number the
    // `{t: n.t}` case above produces either way.
    expect(JSON.stringify(tsQuery(tsGraph, opt('MATCH (n:P {t: n.missing})')))).toBe('[{"t":1}]');
  });

  test('THE DIVERGENCE this item found, isolated — an inline value that EVALUATES to null', () => {
    // Found while building the mutant above, verified against the PRISTINE build, and nothing to
    // do with item 559's rung. The two spellings the engines AGREE on bracket it:
    const two = (q: string): string =>
      `${JSON.stringify(tsQuery(tsGraph, q))} ${JSON.stringify(nativeGraph.query(q))}`;

    // A LITERAL null is an IS NULL test in both engines (item 260) — `z` matches.
    expect(two('MATCH (n:P {t: null}) RETURN count(*) AS c')).toBe('[{"c":1}] [{"c":1}]');
    // A clause `WHERE` comparison against null is UNKNOWN in both — `z` does not match.
    expect(two('MATCH (n:P) WHERE n.t = n.t RETURN count(*) AS c')).toBe('[{"c":3}] [{"c":3}]');
    // But an inline value that evaluates to null takes the IS NULL route in TS and the `= null`
    // route in native, so `z` matches in one engine and not the other.
    expect(two('MATCH (n:P {t: n.t}) RETURN count(*) AS c')).toBe('[{"c":4}] [{"c":3}]');
    expect(two('MATCH (n:P {t: n.missing}) RETURN count(*) AS c')).toBe('[{"c":1}] [{"c":0}]');
  });

  test('a faulting anchor filter still raises on both engines', () => {
    const q = opt('MATCH (n:P) WHERE 1 / 0 > 0');

    expect(() => tsQuery(tsGraph, q)).toThrow();
    expect(() => nativeGraph.query(q)).toThrow();
    // The control: the same query without the filter is answered, so the throw is the FILTER.
    agree(opt('MATCH (n:P)'), '[{"t":5}]');
  });
});
