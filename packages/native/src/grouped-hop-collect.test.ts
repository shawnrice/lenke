// Item 554. Item 553's call site said the grouped HOP rung needed items 551/552's walk FORCING
// because "its walk has a far-driven alternative". THAT WAS WRONG — a guess from item 419's rule
// rather than a reading of the loop, which iterates `candidateVertexSource(graph, startLabel)` and
// expands, with no far-driven alternative anywhere. Its visit order is the start side's, which is
// the general path's, so the only condition is item 553's SEED hazard and the fix is the same flag.
//
// ts, 200,000 vertices / 200,000 edges, one case per process, pristine against the change:
//
//   b.age AS k, sum(b.age)                    461.01 -> 191.52 ms   2.4x
//   b.age AS k, collect(b.age)                467.25 -> 192.49      2.4x
//   b.age AS k, percentile_cont(b.age, 0.5)   471.90 -> 192.39      2.5x
//   b.age AS k, count(*)          (control)   161.12 -> 162.10
//   b.age AS k, max(b.age)        (control)   182.73 -> 177.38
//   WHERE b.age > 1 … sum(b.age)  (refused)   487.81 -> 451.26
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const HOP: string[] = [];

for (let i = 0; i < 6; i++) {
  HOP.push(
    JSON.stringify({
      type: 'node',
      id: `s${i}`,
      labels: ['P'],
      properties: { tag: i % 2 === 1 ? 'a' : 'b', age: i * 1.7 },
    }),
  );
}

// Three `Q` nodes so `:P` is genuinely selective — the condition that decides, for every OTHER
// hop rung, whether the far-driven walk is even eligible.
for (let i = 0; i < 3; i++) {
  HOP.push(
    JSON.stringify({
      type: 'node',
      id: `q${i}`,
      labels: ['Q'],
      properties: { tag: 'c', age: 100 + i },
    }),
  );
}

HOP.push(JSON.stringify({ type: 'node', id: 'z', labels: ['P'], properties: { tag: 'a' } }));

const PAIRS: readonly (readonly [number, number])[] = [
  [0, 5],
  [1, 3],
  [2, 4],
  [3, 0],
  [4, 2],
  [5, 1],
  [0, 2],
  [2, 0],
];

PAIRS.forEach(([a, b], i) =>
  HOP.push(
    JSON.stringify({ type: 'edge', id: `e${i}`, labels: ['K'], from: `s${a}`, to: `s${b}` }),
  ),
);
HOP.push(JSON.stringify({ type: 'edge', id: 'e8', labels: ['K'], from: 's1', to: 'z' }));

const NDJSON = HOP.join('\n');
const suite = nativeReady ? describe : describe.skip;

suite('the grouped-HOP rung collects them too (item 554)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** A SEQUENCE comparison: group order is first-seen and within-group order is the answer. */
  const agree = (q: string): string => {
    const got = JSON.stringify(tsQuery(tsGraph, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(nativeGraph.query(q))}`);

    return got;
  };

  test('the far end keyed, where the walk order is the thing under test', () => {
    expect(agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, collect(b.age) AS m')).toBe(
      '[{"k":"a","m":[8.5,5.1,1.7]},{"k":"b","m":[3.4,6.8,0,0,3.4]}]',
    );
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, sum(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, avg(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, stddev_pop(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, collect_list(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, percentile_cont(b.age, 0.5) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, count(*) AS c, collect(b.age) AS l');
    // `:P` selective on the start side — the shape that is start-driven for every rung.
    agree('MATCH (a:P)-[:K]->(b) RETURN b.tag AS k, collect(b.age) AS m');
    // `z` has no `age`, so its group collects fewer values than it has rows.
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, count(*) AS c, collect(b.age) AS l');
  });

  test('the START end keyed, and the reversed arrow', () => {
    agree('MATCH (a)-[:K]->(b) RETURN a.tag AS k, collect(a.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN a.tag AS k, sum(a.age) AS m');
    // The reversed spelling walks the other index, so its order differs from the forward one —
    // and both engines agree on each, which is what says the rung is reproducing a real order.
    const forward = agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, collect(b.age) AS m');
    const reversed = agree('MATCH (b)<-[:K]-(a) RETURN b.tag AS k, collect(b.age) AS m');

    expect(reversed).not.toBe(forward);
  });

  test('the UNDIRECTED hop, which this rung walks in ONE pass', () => {
    // Unlike the un-grouped hop rungs (items 551, 552), this walk takes `both` through a single
    // `expand`, so there is no two-pass order to refuse.
    agree('MATCH (a)-[:K]-(b) RETURN b.tag AS k, collect(b.age) AS m');
    agree('MATCH (a)-[:K]-(b) RETURN b.tag AS k, sum(b.age) AS m');
  });

  test('a FILTER declines, for item 553s demonstrated reason', () => {
    agree('MATCH (a)-[:K]->(b) WHERE b.age > 1 RETURN b.tag AS k, collect(b.age) AS m');
    agree("MATCH (a)-[:K]->(b {tag: 'a'}) RETURN b.tag AS k, collect(b.age) AS m");
    // The foldable aggregates are unaffected by the flag and still take the rung.
    agree('MATCH (a)-[:K]->(b) WHERE b.age > 1 RETURN b.tag AS k, max(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) WHERE b.age > 1 RETURN b.tag AS k, count(*) AS c');
  });

  test('the refusals that are not about order', () => {
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, count(DISTINCT b.age) AS d');
    // An aggregate over the NON-keyed end — `refsOnlyVar`, which item 553 widened to cover the
    // collected accumulators and which this item makes load-bearing.
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, collect(a.age) AS l');
    agree('MATCH (a)-[:K]->(b) RETURN b.tag AS k, sum(a.age) AS s');
  });
});

// The SEED guard on this rung cannot be given teeth by a cross-engine comparison, and the reason
// is a divergence this item FOUND rather than caused. Ten `:P` nodes, a `:K` edge each, a range
// index on `age`:
//
//   MATCH (a)-[:K]->(b) WHERE b.age >= 5 RETURN b.tag AS k, collect(b.age) AS m
//     no index    ts [7,9,5] / [8,6]      native [7,9,5] / [8,6]      agree
//     indexed     ts [5,7,9] / [6,8]      native [7,9,5] / [8,6]      DIVERGE
//
// TS seeds the FAR end of a hop from the index and native does not, so the values reach their
// group in different orders. Verified against the PRISTINE build before item 554, so it is
// pre-existing; the same filter on the START end agrees with and without the index, which locates
// it in the far-end seed specifically. Recorded as open in CLOSED.md.
//
// So the guard is tested against THE GENERAL PATH instead, which is the invariant that actually
// applies to a rung: a rung must answer what the general path answers in the same engine. With the
// guard removed the rung answers its own scan order, `[7,9,5]`, where the TS general path answers
// `[5,7,9]`.
suite('the seed guard, tested against the general path (item 554)', () => {
  const SEED: string[] = [];

  for (let i = 0; i < 10; i++) {
    SEED.push(
      JSON.stringify({
        type: 'node',
        id: `n${i}`,
        labels: ['P'],
        properties: { tag: i % 2 === 1 ? 'a' : 'b', age: (i * 7) % 10 },
      }),
    );
  }

  for (let i = 0; i < 10; i++) {
    SEED.push(
      JSON.stringify({
        type: 'edge',
        id: `k${i}`,
        labels: ['K'],
        from: `n${i}`,
        to: `n${(i * 3 + 1) % 10}`,
      }),
    );
  }

  const text = SEED.join('\n');
  const indexed = (): Graph => {
    const g = tsDeserialize(text, 'ndjson', new Graph());

    g.createIndex({ on: 'vertex', kind: 'range', keys: ['age'] });

    return g;
  };

  test('a FILTERED grouped-hop collect keeps the SEEDED order, not the scan order', () => {
    const q = 'MATCH (a)-[:K]->(b) WHERE b.age >= 5 RETURN b.tag AS k, collect(b.age) AS m';

    // The general path's answer with the index in place. A rung that took this shape would
    // answer `[7,9,5]` / `[8,6]`, its own scan order.
    expect(JSON.stringify(tsQuery(indexed(), q))).toBe(
      '[{"k":"a","m":[5,7,9]},{"k":"b","m":[6,8]}]',
    );
    // Without the index there is no seek, and the same query reads the scan order — which is what
    // says the assertion above is about the SEED and not about the filter.
    expect(JSON.stringify(tsQuery(tsDeserialize(text, 'ndjson', new Graph()), q))).toBe(
      '[{"k":"a","m":[7,9,5]},{"k":"b","m":[8,6]}]',
    );
    // The foldable control over the same seeded shape, which the rung DOES take either way.
    expect(
      JSON.stringify(
        tsQuery(
          indexed(),
          'MATCH (a)-[:K]->(b) WHERE b.age >= 5 RETURN b.tag AS k, max(b.age) AS m',
        ),
      ),
    ).toBe('[{"k":"a","m":9},{"k":"b","m":8}]');
  });
});
