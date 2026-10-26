/**
 * Item 897: does the TS engine have item 895's shape — a query made SLOWER by an index? NO.
 *
 * Item 895 found that natively, an index on a dotted key made `WHERE p.meta.city = 'NYC'` **4.1x
 * SLOWER**. Not a planner bug: at 4 distinct values over 200k nodes the predicate matches ~25%, so
 * the cost model correctly rejects the seek — but the plan it falls back to (`Scan` + `Filter`)
 * evaluated the nested read by materializing the whole base column, where the no-index `IndexSeek`
 * fallback borrows per row. Two unindexed implementations of one predicate, 4.1x apart; item 896
 * fused the slow one.
 *
 * Items 359/893/894 each optimized one of those two sibling paths without checking the other, and
 * 895 exists because of that. So the cross-ENGINE sibling gets checked rather than reasoned about.
 *
 * THE ANSWER. Within one process and one graph, querying an INDEXED key costs the same as querying
 * an unindexed twin of the same cardinality and type: **4.31 ms against 4.42**, min of three
 * alternated rounds. And `idx.equals` — the materializing seek — is called **zero** times for both
 * the clause-`WHERE` and inline `{k: v}` spellings, because `SEEK_MAX_FRACTION` is 1/8 and this
 * predicate matches 25% of the bucket, so the gate declines. The TS engine evaluates row-at-a-time
 * through a compiled closure (`executor.ts`'s `'field'` arm is `baseF(env)` then
 * `recordGet`/`propOf`), so there is no intermediate column to materialize and no second path to
 * disagree with. 895's bug is specific to the native columnar evaluator.
 *
 * WHY THIS PROBE RUNS EVERYTHING IN ONE PROCESS, which is the finding underneath the finding.
 * The first version of it put each arm in its own process — the repo's usual "one shape per
 * process" rule — and reported the indexed arm **1.65x to 1.98x SLOWER**, reproducibly. That is an
 * artifact. Creating an index over 200,000 vertices changes the HEAP, so two processes differ in
 * allocation history, live-set size and GC behaviour, and that difference shows up in the query
 * timing as if it were query cost. When the thing under test CHANGES THE HEAP, separate processes
 * are not comparable; the arms have to share one.
 *
 * An `indexedOther` arm (index on a key the query never names) was added as a discriminator and
 * was ALSO misleading, for the same reason — it is still a different process. A discriminator built
 * on the broken axis does not fix the axis.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 9;
const ROUNDS = 3;
const CITIES = ['NYC', 'LDN', 'TYO', 'BER'];
const EXPECTED = Math.floor(N / CITIES.length);

/**
 * One graph with BOTH a flat and a nested copy of the same value, and an index on one flat key and
 * one nested key. Every query below then runs against the same heap, so nothing in the comparison
 * is an allocation difference.
 *
 * `tier` is a deliberate unindexed TWIN of `city`: same type, same cardinality, same values. It is
 * what makes "indexed vs not" a one-variable comparison.
 */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    const city = CITIES[i % CITIES.length];

    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { age: i % 100, city, tier: city, meta: { city, other: city } },
    });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['city'] });
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['meta.city'] });

  return g;
};

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['flat INDEXED', "MATCH (p:P) WHERE p.city = 'NYC' RETURN count(*) AS c"],
  ['flat unindexed', "MATCH (p:P) WHERE p.tier = 'NYC' RETURN count(*) AS c"],
  ['nested INDEXED', "MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN count(*) AS c"],
  ['nested unindexed', "MATCH (p:P) WHERE p.meta.other = 'NYC' RETURN count(*) AS c"],
];

const g = build();

/** Is the materializing seek ever reached? Counted rather than assumed. */
const seekCalls = (q: string): number => {
  const idx = (g as unknown as { vertexPropertyIndex: Record<string, unknown> })
    .vertexPropertyIndex;
  const original = idx.equals as (k: unknown, v: unknown) => unknown;
  let calls = 0;

  idx.equals = (k: unknown, v: unknown): unknown => {
    calls += 1;

    return original.call(idx, k, v);
  };

  try {
    // Consume the iterable; the rows themselves are not the point here, the call count is.
    const sink = [...query(g, q)].length;

    if (sink === 0) {
      throw new Error('seekCalls: the query returned no rows');
    }
  } finally {
    idx.equals = original;
  }

  return calls;
};

const best: Record<string, number[]> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  // Alternated, so neither order is charged for the other's warm-up.
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q] of order) {
    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);

      // THE FIXTURE'S OWN STATISTIC, asserted every rep. This caught a silent corruption:
      // `systemd-run` performs `${...}` expansion on the command it runs, so an inline
      // `bun -e` using `v${i}` for the vertex id gave every vertex the SAME id and the 200,000-node
      // graph collapsed to ONE node. The timings looked plausible; only the count did not.
      const c = Number((rows[0] as Record<string, unknown>)?.c ?? 0);

      if (c !== EXPECTED) {
        throw new Error(`FIXTURE WRONG for ${name}: count=${c}, expected ${EXPECTED}`);
      }
    }

    series.sort((a, b) => a - b);
    (best[name] ??= []).push(series[0]);
  }
}

console.log(
  `# item 897 — TS: does an index make the query slower? (N=${N}, min of ${ROUNDS} rounds)\n`,
);

for (const [name, q] of CASES) {
  const ms = Math.min(...best[name]);

  console.log(
    `${name.padEnd(18)} ${ms.toFixed(2).padStart(7)} ms   seek(equals) calls: ${seekCalls(q)}   rounds: ${best[name].map((x) => x.toFixed(2)).join(' ')}`,
  );
}

console.log(
  '\n(both INDEXED rows should match their unindexed twin, and every seek count should be 0:',
);
console.log(' the gate declines at 25% selectivity because SEEK_MAX_FRACTION is 1/8.)');
