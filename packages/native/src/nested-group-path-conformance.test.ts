// A PATH bound over a NESTED subpath group: the engines disagree, and it is a VALUE difference
// (item 1236).
//
// Found by following a performance target, not by fuzzing. Item 1235 gave `RepeatGroup` a
// `PathNeed` and item 1234 named `NestedGroup` as the larger remaining one; checking whether
// marking it was worth anything turned up something else entirely — `exec/nested.rs` contains no
// `Lineage` at all, and the plan for a nested group with a path variable is a bare
// `Project { NestedGroup { .. } }` with no path-tracking wrapper. So the accessors have nothing to
// read.
//
// ⚠️ THIS IS NOT A REGISTRY CANDIDATE. `divergence-registry.ts` states the rule plainly: "There is
// deliberately NO `value` axis, and `accept` refuses a value divergence whatever the registry says.
// If the engines disagree about the answer to a determinate question, that is a bug in one of them,
// and no entry may excuse it." These tests therefore PIN the current behaviour so it cannot change
// silently while the fix direction is decided; they are not an endorsement of either answer.
//
// ⚠️ WHY THE FUZZER NEVER FOUND IT. `differential-fuzz.test.ts` does generate a named path over a
// quantified group, but its unit is FLAT — `MATCH pp = (a:T)((x)-[:E]->(m)){q}(b:T)` — a single
// hop. Item 244 added nested UNITS to a different arm (the one that reads no path). So paths over
// flat groups are covered, nested units are covered, and their INTERSECTION is not. Adding a nested
// unit to the named-path arm is a one-line change that would turn this red, which is why it is
// recorded here rather than done unilaterally.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// Four nodes and three edges, arranged so a nested unit `(x)-[:KNOWS]->(m)<-[:KNOWS]-(y)` has a
// couple of distinct instantiations and the counts stay small enough to assert exactly.
const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"n":4}}',
  '{"type":"edge","id":"e1","labels":["KNOWS"],"from":"1","to":"2"}',
  '{"type":"edge","id":"e2","labels":["KNOWS"],"from":"3","to":"2"}',
  '{"type":"edge","id":"e3","labels":["KNOWS"],"from":"3","to":"4"}',
].join('\n');

const UNIT = '((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2}';

const suite = nativeReady ? describe : describe.skip;

suite('a path bound over a NESTED subpath group', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const outcome = (engine: 'ts' | 'native', q: string): string => {
    try {
      const r = (engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q)) as unknown[];

      return `ok [${[...r]
        .map((x) => JSON.stringify(x))
        .sort()
        .join('|')}]`;
    } catch (e) {
      return `ERR ${(e as { code?: string } | undefined)?.code ?? 'NO_CODE'}`;
    }
  };
  const agree = (q: string): string => {
    const a = outcome('ts', q);

    expect(`${q}\n  ${a}`).toBe(`${q}\n  ${outcome('native', q)}`);

    return a;
  };

  test('AGREEMENT: with no path mentioned, the two walkers enumerate identically', () => {
    // This is the control that makes the rest diagnostic. The nested walk itself is NOT in
    // dispute — only what happens once a path is bound over it.
    expect(agree(`MATCH ${UNIT} RETURN count(*) AS c`)).toContain('"c":2');
    expect(agree(`MATCH ${UNIT} (t) RETURN t.n AS n`)).toBe('ok [{"n":1}|{"n":3}]');
  });

  test('OPEN: merely BINDING a path changes the row count, on the TS side only (item 1236)', () => {
    // Nothing reads `p`. Binding a path should not change which rows exist, and for the Rust
    // engine it does not — it answers the same 2 rows as the control above. TS answers 3.
    const q = `MATCH p = ${UNIT} RETURN 1 AS one`;

    expect(outcome('ts', q)).toBe('ok [{"one":1}|{"one":1}|{"one":1}]');
    expect(outcome('native', q)).toBe('ok [{"one":1}|{"one":1}]');
  });

  test('OPEN: every path accessor is NULL in the Rust engine (item 1236)', () => {
    // `path_length`, `cardinality`, `nodes` and `edges` all read a lineage the nested walker
    // never builds, so they come back null rather than erroring — a silent wrong answer, which
    // is the kind this repo's registry refuses to excuse.
    for (const [acc, tsExpected] of [
      ['path_length(p)', 'ok [{"x":1}|{"x":1}|{"x":1}]'],
      ['cardinality(p)', 'ok [{"x":3}|{"x":3}|{"x":3}]'],
    ] as const) {
      const q = `MATCH p = ${UNIT} RETURN ${acc} AS x`;

      expect(outcome('ts', q)).toBe(tsExpected);
      expect(outcome('native', q)).toBe('ok [{"x":null}|{"x":null}]');
    }

    // The ELEMENT accessors, where a missing lineage shows hardest: TS renders real element
    // maps, the Rust engine renders null.
    const nodesQ = `MATCH p = ${UNIT} RETURN nodes(p) AS x`;

    expect(outcome('ts', nodesQ)).toContain('"labels":["P"]');
    expect(outcome('native', nodesQ)).toBe('ok [{"x":null}|{"x":null}]');
  });

  test('OPEN: with a path bound, TS answers a DIFFERENT QUERY — wrong endpoint, lost bindings, and MODE-INSENSITIVE (item 1237)', () => {
    // The unit is `(x)->(m)<-(y)`, so the pattern's endpoint is `y`. Without a path both engines
    // say `{1, 3}` — those are the `y` values, and they are what a hand enumeration gives. WITH a
    // path bound, TS says `{2, 2, 4}`, which are the MIDDLE nodes: it has stopped treating the
    // unit as nested and ends at `m`.
    const endpoint = `MATCH p = ${UNIT} (t) RETURN t.n AS n`;

    expect(outcome('ts', endpoint)).toBe('ok [{"n":2}|{"n":2}|{"n":4}]');
    expect(outcome('native', endpoint)).toBe('ok [{"n":1}|{"n":3}]');
    // And the group's inner lists vanish on the TS side, where native still binds them.
    const lists = `MATCH p = ${UNIT} RETURN size(x) AS sx, size(y) AS sy`;

    expect(outcome('ts', lists)).toBe(
      'ok [{"sx":null,"sy":null}|{"sx":null,"sy":null}|{"sx":null,"sy":null}]',
    );
    expect(outcome('native', lists)).toBe('ok [{"sx":1,"sy":1}|{"sx":1,"sy":1}]');

    // ⚠️ THE DECISIVE EVIDENCE, and the reason this is recorded as TS being wrong rather than as a
    // disagreement: with a path bound, TS returns THE SAME THREE ROWS under WALK and under TRAIL.
    // WALK permits edge reuse and TRAIL forbids it, so no correct implementation can be
    // insensitive to the difference on this fixture — and native is not, answering 18 against 2.
    const walk = 'MATCH p = WALK ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2} (t) RETURN t.n AS n';
    const trail = 'MATCH p = TRAIL ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2} (t) RETURN t.n AS n';

    expect(outcome('ts', walk)).toBe(outcome('ts', trail));
    expect(outcome('native', walk)).not.toBe(outcome('native', trail));
    expect(outcome('native', trail)).toBe('ok [{"n":1}|{"n":3}]');

    // AGREEMENT that bounds the whole thing: at exactly TWO repetitions both engines answer NO
    // rows, because every continuing edge is already used. So the engines agree about the shape of
    // the search and disagree only once a path is bound.
    const two = 'MATCH p = ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){2,2} (t) RETURN t.n AS n';

    expect(agree(two)).toBe('ok []');
  });

  test('CONTROL: the same accessors over a FLAT group and a var-length hop AGREE', () => {
    // So the defect is specific to the NESTED walker, not to path accessors in general — and
    // these are the shapes the differential fuzzer does generate, which is why it stayed green.
    expect(agree('MATCH p = ((a)-[:KNOWS]->(b)){1,2} RETURN path_length(p) AS x')).toBe(
      'ok [{"x":1}|{"x":1}|{"x":1}]',
    );
    expect(agree('MATCH p = (x)-[:KNOWS]->{1,2}(y) RETURN path_length(p) AS x')).toBe(
      'ok [{"x":1}|{"x":1}|{"x":1}]',
    );
  });
});
