// Item 551. The four non-foldable ORDER-SENSITIVE aggregates were refused on the hop rung under
// item 419's rule — the walk may be FAR-DRIVEN, so it can visit rows in a different order from
// the general path, and `sum`/`avg`/the stddevs differ in the last ulp while `collect`'s order IS
// its answer. Item 532 priced them at 4.5x each and recorded that widening the rung "would be
// WRONG, not slow".
//
// It would have been. The hazard is real and reproduces on NINE rows:
//
//   MATCH (a)-[:K]->(b) RETURN b.age AS k   ts [0,0,1,2,2,3,4,5]   native [5,2,3,4,0,0,2,1]
//
// (no start label, so the far-driven walk fits; row order without an ORDER BY is unspecified, so
// that is legal for a PROJECTION and fatal for a fold.) But the rule is about ONE of the walks:
// with a non-vacuous start label the same query reads `[5,2,3,4,0,0,2,1]` in BOTH engines. So the
// start-driven walk's order is the general path's, and an order-sensitive fold may ride THAT one.
//
// `detectHopProjection` now takes `forceStartDriven`, the aggregate rung passes it for those six
// names, and the undirected form is refused outright (two walks emit all out-rows then all
// in-rows where the general path interleaves them).
//
// Every shape below is asked of BOTH engines, because the last ulp and the list order are exactly
// what a byte-identity invariant is about. The fixture is built so a far-driven walk would reorder
// it: crossed edges, and a far vertex with NO `age` so the null rule shows too.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const lines: string[] = [];

for (let i = 0; i < 6; i++) {
  // Non-integral ages, so a reordered `sum` shows in the last ulp rather than cancelling.
  lines.push(
    JSON.stringify({ type: 'node', id: `s${i}`, labels: ['P'], properties: { age: i * 1.7 } }),
  );
}

// Three `Q` nodes make `:P` genuinely SELECTIVE, which is what makes the labelled spellings
// start-driven while the unlabelled ones are far-driven. Four vertices out of 200,004 were enough
// to matter in item 325; three out of ten are enough here.
for (let i = 0; i < 3; i++) {
  lines.push(
    JSON.stringify({ type: 'node', id: `q${i}`, labels: ['Q'], properties: { age: 100 + i } }),
  );
}

lines.push(JSON.stringify({ type: 'node', id: 'z', labels: ['P'], properties: {} }));

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
  lines.push(
    JSON.stringify({ type: 'edge', id: `e${i}`, labels: ['K'], from: `s${a}`, to: `s${b}` }),
  ),
);
lines.push(JSON.stringify({ type: 'edge', id: 'e8', labels: ['K'], from: 's1', to: 'z' }));

const NDJSON = lines.join('\n');
const suite = nativeReady ? describe : describe.skip;

suite('the order-sensitive hop aggregates ride the START-driven walk (item 551)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** Compared as a SEQUENCE: the order is the thing under test. */
  const agree = (q: string, want: unknown): void => {
    expect(`${q} ${JSON.stringify(tsQuery(tsGraph, q))}`).toBe(
      `${q} ${JSON.stringify(nativeGraph.query(q))}`,
    );
    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe(JSON.stringify([{ m: want }]));
  };

  const AGGS = [
    'sum(b.age)',
    'avg(b.age)',
    'collect(b.age)',
    'collect_list(b.age)',
    'stddev_pop(b.age)',
    'stddev_samp(b.age)',
  ] as const;

  test('the UNLABELLED hop, where the far-driven walk would have been chosen', () => {
    // `collect` is the whole item: this exact list is what a far-driven walk gets wrong.
    agree('MATCH (a)-[:K]->(b) RETURN collect(b.age) AS m', [8.5, 3.4, 5.1, 6.8, 0, 0, 3.4, 1.7]);
    agree('MATCH (a)-[:K]->(b) RETURN sum(b.age) AS m', 28.9);
    agree('MATCH (a)-[:K]->(b) RETURN avg(b.age) AS m', 3.6125);
    agree('MATCH (a)-[:K]->(b) RETURN stddev_pop(b.age) AS m', 2.874646717424595);
    agree('MATCH (a)-[:K]->(b) RETURN stddev_samp(b.age) AS m', 3.0731266070334855);
    // `z` has no `age`, so nine rows fold eight values — the same `nonNull` rule the general
    // path applies, and `collect` above is one element short of the row count because of it.
    expect(tsQuery(tsGraph, 'MATCH (a)-[:K]->(b) RETURN count(*) AS m')).toEqual([{ m: 9 }]);
  });

  test('the LABELLED hop, which was start-driven all along', () => {
    for (const f of AGGS) {
      const q = `MATCH (a:P)-[:K]->(b) RETURN ${f} AS m`;

      expect(`${q} ${JSON.stringify(tsQuery(tsGraph, q))}`).toBe(
        `${q} ${JSON.stringify(nativeGraph.query(q))}`,
      );
    }

    agree('MATCH (a:P)-[:K]->(b) RETURN collect(b.age) AS m', [8.5, 3.4, 5.1, 6.8, 0, 0, 3.4, 1.7]);
  });

  test('the REVERSED arrow', () => {
    agree('MATCH (b)<-[:K]-(a) RETURN collect(b.age) AS m', [0, 0, 1.7, 3.4, 3.4, 5.1, 6.8, 8.5]);
    agree('MATCH (b)<-[:K]-(a) RETURN sum(b.age) AS m', 28.9);
  });

  test('the UNDIRECTED hop is refused, and still answers', () => {
    // Two walks would emit all out-rows then all in-rows; the general path interleaves them per
    // start vertex. The rung declines, so this list is the general path's — and native's.
    for (const f of [...AGGS, 'max(b.age)', 'count(*)']) {
      const q = `MATCH (a)-[:K]-(b) RETURN ${f} AS m`;

      expect(`${q} ${JSON.stringify(tsQuery(tsGraph, q))}`).toBe(
        `${q} ${JSON.stringify(nativeGraph.query(q))}`,
      );
    }

    expect(tsQuery(tsGraph, 'MATCH (a)-[:K]-(b) RETURN count(*) AS m')).toEqual([{ m: 18 }]);
  });

  test('the controls the widening must not reach', () => {
    // The order-INDEPENDENT rungs, which still take the far-driven walk.
    agree('MATCH (a)-[:K]->(b) RETURN max(b.age) AS m', 8.5);
    agree('MATCH (a)-[:K]->(b) RETURN min(b.age) AS m', 0);
    agree('MATCH (a)-[:K]->(b) RETURN count(b.age) AS m', 8);
    agree('MATCH (a)-[:K]->(b) RETURN percentile_cont(b.age, 0.5) AS m', 3.4);
    // A DISTINCT argument is refused by `hopPercentile` and must keep its answer.
    agree('MATCH (a)-[:K]->(b) RETURN count(DISTINCT b.age) AS m', 6);
  });
});

// The FILTERED walk has its own far-driven branch, chosen by `hopDrivesFar` when the far side
// enumerates fewer vertices than the start side — and the guard on it survived its mutant against
// the fixture above, because nothing there reaches that branch. It is load-bearing: with the guard
// removed, `collect(a.age)` over 40 `:P` sources and 3 `:R` far vertices answers
//
//   [0.6, 1.5, 2.4, 3.3, …]    against native's    [0, 0.3, 0.6, 0.8999999999999999, …]
//
// — the start values grouped by which far vertex they reach, instead of in start order. This block
// is that shape, and it is what gives the second guard teeth.
const WIDE: string[] = [];
const SOURCES = 40;

for (let i = 0; i < SOURCES; i++) {
  WIDE.push(
    JSON.stringify({ type: 'node', id: `s${i}`, labels: ['P'], properties: { age: i * 0.3 } }),
  );
}

for (let i = 0; i < 3; i++) {
  WIDE.push(
    JSON.stringify({ type: 'node', id: `r${i}`, labels: ['R'], properties: { age: 10 + i * 1.7 } }),
  );
}

for (let i = 0; i < SOURCES; i++) {
  WIDE.push(
    JSON.stringify({
      type: 'edge',
      id: `w${i}`,
      labels: ['K'],
      from: `s${i}`,
      to: `r${(i * 7 + 1) % 3}`,
    }),
  );
}

const WIDE_NDJSON = WIDE.join('\n');

suite('the FILTERED walk is forced start-driven too (item 551)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), WIDE_NDJSON);
  const tsGraph = tsDeserialize(WIDE_NDJSON, 'ndjson', new Graph());

  const agree = (q: string): void => {
    expect(`${q} ${JSON.stringify(tsQuery(tsGraph, q))}`).toBe(
      `${q} ${JSON.stringify(nativeGraph.query(q))}`,
    );
  };

  test('an aggregate reading the START variable keeps start order', () => {
    // THE one that catches the filtered walk's guard.
    agree('MATCH (a:P)-[:K]->(b:R) RETURN collect(a.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) RETURN sum(a.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) RETURN collect_list(a.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) RETURN stddev_pop(a.age) AS m');
    // Pin the sequence as well, so a future fixture change cannot quietly disarm the check: the
    // 40 start ages in creation order, which is NOT the order grouped by far vertex.
    const collected = tsQuery(tsGraph, 'MATCH (a:P)-[:K]->(b:R) RETURN collect(a.age) AS m');

    expect(JSON.stringify(collected).slice(0, 36)).toBe('[{"m":[0,0.3,0.6,0.8999999999999999,');
  });

  test('the far-end aggregate, and the start-predicate shape', () => {
    agree('MATCH (a:P)-[:K]->(b:R) RETURN collect(b.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) WHERE a.age > 1 RETURN collect(b.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) WHERE a.age > 1 RETURN collect(a.age) AS m');
    // The controls: the order-independent rungs over the same shape.
    agree('MATCH (a:P)-[:K]->(b:R) RETURN max(a.age) AS m');
    agree('MATCH (a:P)-[:K]->(b:R) RETURN count(*) AS m');
  });
});

// Item 552 extends the same admission to the MULTI-aggregate rung, which required every item to
// have a streaming fold and so declined any projection carrying one of the six. ts, 200,000
// vertices / 200,000 edges:
//
//   RETURN count(*), sum(b.age)        313.32 -> 126.92 ms   2.5x
//   RETURN sum(b.age), avg(b.age)      360.59 -> 137.34      2.6x
//   RETURN collect(b.age), count(*)    320.79 -> 117.98      2.7x
//
// with the foldable controls flat (`count(*), max` 92.75 -> 89.7, `max, min` 101.32 -> 99.5-102.6
// over three repeats; the first reading of 149.49 was a one-off and did not reproduce). The
// percentiles come along for free on this rung — they read no order, so they need no forcing.
suite('the MULTI-aggregate hop rung takes them too (item 552)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const agree = (q: string): void => {
    expect(`${q} ${JSON.stringify(tsQuery(tsGraph, q))}`).toBe(
      `${q} ${JSON.stringify(nativeGraph.query(q))}`,
    );
  };

  test('an order-sensitive item beside a foldable one', () => {
    agree('MATCH (a)-[:K]->(b) RETURN count(*) AS c, sum(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN collect(b.age) AS l, count(*) AS c');
    agree('MATCH (a)-[:K]->(b) RETURN sum(b.age) AS s, avg(b.age) AS v');
    agree('MATCH (a)-[:K]->(b) RETURN max(b.age) AS m, collect(b.age) AS l');
    agree('MATCH (a)-[:K]->(b) RETURN stddev_pop(b.age) AS s, stddev_samp(b.age) AS t');
    // Three items, mixing all three accumulator kinds.
    agree('MATCH (a)-[:K]->(b) RETURN count(*) AS c, max(b.age) AS m, collect(b.age) AS l');
  });

  test('the percentiles, which need no forcing', () => {
    agree('MATCH (a)-[:K]->(b) RETURN count(*) AS c, percentile_cont(b.age, 0.5) AS p');
    agree('MATCH (a)-[:K]->(b) RETURN percentile_disc(b.age, 0.25) AS p, max(b.age) AS m');
  });

  test('the START-reading shape, which routes through the filtered walk', () => {
    agree('MATCH (a:P)-[:K]->(b) RETURN count(*) AS c, collect(a.age) AS l');
    agree('MATCH (a:P)-[:K]->(b) RETURN sum(a.age) AS s, max(b.age) AS m');
  });

  test('the refusals', () => {
    // UNDIRECTED with an order-sensitive item: two walks, so the rung declines.
    agree('MATCH (a)-[:K]-(b) RETURN count(*) AS c, collect(b.age) AS l');
    agree('MATCH (a)-[:K]-(b) RETURN sum(b.age) AS s, avg(b.age) AS v');
    // A DISTINCT argument has no fold and is not one of the admitted names.
    agree('MATCH (a)-[:K]->(b) RETURN count(*) AS c, count(DISTINCT b.age) AS d');
    // The foldable controls the widening must not reach.
    agree('MATCH (a)-[:K]->(b) RETURN count(*) AS c, max(b.age) AS m');
    agree('MATCH (a)-[:K]->(b) RETURN max(b.age) AS m, min(b.age) AS n');
  });
});
