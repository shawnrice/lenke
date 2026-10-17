// Item 565. `inlineTrailingLet`'s substitution was ALL-OR-NOTHING: it replaced an item that WAS
// the bound name and refused any expression that merely mentioned it. So `LET c = COUNT { … }
// RETURN sum(c)` — a name read inside an aggregate, which is the common shape — never inlined and
// kept its per-row clause. Two changes close it: `boundExprs` admits a subquery binding, and
// `subst` replaces a bound name that appears as a FUNCTION ARGUMENT.
//
// At 200,000 vertices / 300,000 edges, one case per process:
//
//   LET c = COUNT { MATCH (n)-[:KNOWS]->(x) } RETURN sum(c)   114.06/170.48/173.33 -> 53.46
//   CALL (n) { … RETURN count(*) AS c } RETURN sum(c)         156.85/159.49        -> 52.93
//   RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })  (target)    50.14/52.78/52.18   -> 52.87
//
// All three spellings now land on ~53 — one question, one cost. With items 563 and 564 the CALL
// route is 779 -> 53 end to end.
//
// A SUBQUERY may only be inlined where the projection reads the name EXACTLY ONCE, because the
// evaluation COUNT has to come out the same: read twice and the work doubles, read zero times and
// the binding's evaluation disappears along with any fault it raises. Every case below is asked of
// both engines.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// Degrees 2, 1, 0 — non-uniform, so a scalar evaluated once instead of per row is visible.
const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"z","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"z","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"b","to":"z","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a LET-bound subquery inlines into a function argument (item 565)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string, want: string): void => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);
    expect(got).toBe(want);
  };

  const let_ = (tail: string): string =>
    `MATCH (n:P) LET c = COUNT { MATCH (n)-[:T]->(x) } RETURN ${tail}`;

  test('the inlined shapes', () => {
    // Degrees 2 + 1 + 0.
    agree(let_('sum(c) AS t'), '[{"t":3}]');
    agree(let_('max(c) AS t'), '[{"t":2}]');
    agree(let_('min(c) AS t'), '[{"t":0}]');
    agree(let_('avg(c) AS t'), '[{"t":1}]');
    // And the spelling it is supposed to equal.
    agree('MATCH (n:P) RETURN sum(COUNT { MATCH (n)-[:T]->(x) }) AS t', '[{"t":3}]');
  });

  test('ONE read is the condition — two reads keep the clause', () => {
    // `sum(c), max(c)` reads the name TWICE. Inlining would evaluate the subquery twice per row,
    // so the binder stays and the answer must be unchanged.
    agree(let_('sum(c) AS t, max(c) AS u'), '[{"t":3,"u":2}]');
    // ZERO reads: the binder is still evaluated per row, and dropping it would remove a fault it
    // could raise. The count is of the MATCH, not of the subquery.
    agree(let_('count(*) AS t'), '[{"t":3}]');
    // An ORDER BY key counts as a read, so this is one read and inlines.
    agree(let_('sum(c) AS t ORDER BY t'), '[{"t":3}]');
  });

  test('ONE LEVEL is the other condition', () => {
    // `sum(c + 1)` mentions the name BELOW the argument position, so the shallow substitution
    // refuses and the clause stays. 2+1 + 1+1 + 0+1 = 6.
    agree(let_('sum(c + 1) AS t'), '[{"t":6}]');
    // A bare name is the original case and still works.
    agree(let_('c AS t'), '[{"t":2},{"t":1},{"t":0}]');
    agree(let_('n.n AS k, c ORDER BY c DESC'), '[{"k":1,"c":2},{"k":2,"c":1},{"k":null,"c":0}]');
  });

  test('the cheap bindings are unaffected, and now inline too', () => {
    agree('MATCH (n:P) LET a = n.n RETURN sum(a) AS t, max(a) AS u', '[{"t":3,"u":2}]');
    agree('MATCH (n:P) LET a = n.n RETURN sum(a) AS t', '[{"t":3}]');
  });

  test('a ZERO-read binder is still EVALUATED, so its fault still raises', () => {
    // This is what the `!== 1` is for rather than a `> 1`. With zero reads the binder would be
    // dropped if the guard admitted it, and the fault it raises would disappear with it.
    const faulting =
      'MATCH (n:P) LET c = COUNT { MATCH (n)-[:T]->(x) WHERE 1 / 0 > 0 } RETURN count(*) AS t';

    expect(() => tsQuery(tsGraph, faulting)).toThrow();
    expect(() => nativeGraph.query(faulting)).toThrow();
    // The same binder with a VALUE body, since the two subquery kinds take different routes.
    const faultingValue =
      'MATCH (n:P) LET c = VALUE { MATCH (n)-[:T]->(x) RETURN max(x.n / 0) } RETURN count(*) AS t';

    expect(() => tsQuery(tsGraph, faultingValue)).toThrow();
    expect(() => nativeGraph.query(faultingValue)).toThrow();
    // The control: the same query with a NON-faulting binder is answered, so the throw is the
    // binder and not the shape.
    agree(let_('count(*) AS t'), '[{"t":3}]');
  });

  test('an ORDER BY read counts toward the once-read rule', () => {
    // One read, in the ORDER BY only — the binder is substituted there.
    agree(let_('n.n AS k ORDER BY c'), '[{"k":null},{"k":2},{"k":1}]');
  });

  test('EXISTS binds too', () => {
    agree('MATCH (n:P) LET e = EXISTS { MATCH (n)-[:T]->(x) } RETURN count(e) AS t', '[{"t":3}]');
  });
});
