/**
 * Item 930: DECOMPOSE item 929's 1.71x cross-surface gap on the filtered hop into a per-conjunct
 * SLOPE and a residual INTERCEPT, because a ratio does not say where the cost is.
 *
 * Item 929 established that the GQL/Gremlin gap is not specific to the node-scan filter shape: an
 * edge-walking filtered count reads 1.71x (arms 1.19x / 1.06x — the tightest instrument this
 * question has), inside the same band as the node-scan pairs at 1.80-1.85x. It called the cause
 * "GQL's per-row filter path generally". THAT IS A LOCATION, NOT A MECHANISM, and item 929 did not
 * measure which half of `hop + filter` carries it.
 *
 * WHY THE OBVIOUS DECOMPOSITION IS UNAVAILABLE. The natural baseline is the hop with no filter,
 * subtracted from the hop with one. It does not exist: item 929 measured that an UNFILTERED edge
 * count is answered O(1) from a size on BOTH surfaces — 0.00 vs 0.01 ms at 200k/600k and again at
 * 800k/2,400,000, four times the graph — so there is no "hop alone" reading to subtract. Item 926
 * hit the same wall on the node scan (`count(*)` reads 0.01 ns/vertex) and solved it with a
 * `WHERE true` floor; there is no `WHERE true` on the Gremlin surface, so that fix does not carry.
 *
 * THE INSTRUMENT INSTEAD: hold the hop CONSTANT and vary the number of conjuncts.
 *
 *   per-conjunct SLOPE  = the per-row predicate cost on that surface
 *   residual INTERCEPT  = everything else — the walk, the row building, the count
 *
 * If the gap is in the FILTER, the slopes differ and the intercepts converge. If it is in the HOP,
 * the slopes agree and the intercepts differ. Those are distinguishable outcomes, which is what
 * makes this a diagnosis rather than a second ratio.
 *
 * EVERY CONJUNCT MUST BE TRUE FOR EVERY ROW, and that is load-bearing twice over:
 *
 *   - `k = i % 50`, so `k > -1`, `k > -2`, … are all true. AND short-circuits on FALSE in WRITTEN
 *     order on both engines (items 258/259), so a ladder of RESTRICTIVE conjuncts would evaluate
 *     the 2nd only for rows that passed the 1st — the per-conjunct cost would then fall with
 *     position and the slope would measure selectivity, not predicate cost.
 *   - The conjuncts are DISTINCT bounds rather than a repeated one, so neither planner can dedupe
 *     the ladder down to a single test and report a flat slope that looks like a free filter.
 *
 * Both consequences are asserted, not assumed: every arm must answer the same row count (600,000 —
 * all edges survive), and the analysis fails if any arm disagrees.
 *
 * ONE SHAPE PER PROCESS (item 762), selected by A_SHAPE: a filtered hop's dispatch sites are
 * exactly what a second shape in the same process would pollute, and item 800 measured a GQL member
 * roughly DOUBLING when it shared a process with other shapes.
 *
 * Usage:  A_SHAPE=gql:2 bun run hop-filter-ladder-probe.ts
 *         bun run probe:hopladder            # the parent, one child per arm
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gt, has, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.A_N ?? 200_000);
const REPS = Number(process.env.A_REPS ?? 14);
const DROP = 3;
const EDGES_PER = 3;
/** 1..MAX_CONJ conjuncts. Four points is enough for a slope and leaves the arms under ~100ms. */
const MAX_CONJ = 4;

/** The i-th always-true bound. Distinct per i so no planner can collapse the ladder. */
const bound = (i: number): number => -1 - i;

const gqlQuery = (conj: number): string => {
  const where = Array.from({ length: conj }, (_, i) => `b.k > ${bound(i)}`).join(' AND ');

  return `MATCH (a:P)-[:E]->(b) WHERE ${where} RETURN count(*) AS c`;
};

const build = (): Graph => {
  const g = new Graph();
  const made: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < N; i += 1) {
    made.push(
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50, s: `s${i % 7}` } }),
    );
  }

  // BOTH ENDPOINTS SCATTERED by different multipliers, as `surface-probe.ts` and items 164/286/287
  // require: with `from` in creation order and `to` permuted, one adjacency map is walked
  // sequentially and the other jumped around, which made every from-driven spelling look ~2x
  // faster than its twin. Here it would read as a surface difference.
  for (let e = 0; e < N * EDGES_PER; e += 1) {
    g.addEdge({ labels: ['E'], from: made[(e * 104729) % N], to: made[(e * 15485863) % N] });
  }

  return g;
};

const runOne = (surface: string, conj: number): void => {
  const g = build();
  const series: number[] = [];
  let answer = -1;

  const run =
    surface === 'gql'
      ? (): number => Number(query(g, gqlQuery(conj))[0].c)
      : (): number => {
          // The same ladder as the GQL arm: `conj` far-end property tests, all true, distinct bounds.
          const steps = Array.from({ length: conj }, (_, i) => has('k', gt(bound(i))));

          return Number(toArray(traversal(V(), hasLabel('P'), out('E'), ...steps, count()), g)[0]);
        };

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = run();

    series.push(performance.now() - t0);
    answer = got;
  }

  // ASSERTED, not printed and eyeballed: an arm whose predicates were not all-true would survive a
  // different number of rows, and the slope would then be selectivity rather than predicate cost.
  if (answer !== N * EDGES_PER) {
    throw new Error(
      `${surface}:${conj} kept ${answer} rows, expected ${N * EDGES_PER} — a conjunct was not always true`,
    );
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(`${surface}\t${conj}\t${median.toFixed(3)}\t${answer}`);
};

const shape = process.env.A_SHAPE;

if (shape !== undefined) {
  const [surface, conj] = shape.split(':');

  if (surface !== 'gql' && surface !== 'grm') {
    console.error(`A_SHAPE surface must be gql or grm — got ${surface}`);
    process.exit(2);
  }

  const n = Number(conj);

  if (!Number.isInteger(n) || n < 1 || n > MAX_CONJ) {
    console.error(`A_SHAPE conjunct count must be 1..${MAX_CONJ} — got ${conj}`);
    process.exit(2);
  }

  runOne(surface, n);
} else {
  // The PARENT. One child per arm, so no arm shares a process with another.
  const order = (process.env.A_ORDER ?? 'gql,grm').split(',');

  if (order.length !== 2 || !order.includes('gql') || !order.includes('grm')) {
    console.error(`A_ORDER must be a permutation of gql,grm — got ${order.join(',')}`);
    process.exit(2);
  }

  console.log(
    `# hop-filter ladder, ${N} vertices / ${N * EDGES_PER} edges, median of ${REPS - DROP}`,
  );
  console.log(`# order=${order.join(',')}`);
  console.log('surface\tconj\tms\trows');

  for (let conj = 1; conj <= MAX_CONJ; conj += 1) {
    for (const surface of order) {
      const r = Bun.spawnSync({
        cmd: [process.argv[0] ?? 'bun', import.meta.path],
        env: { ...process.env, A_SHAPE: `${surface}:${conj}` },
        stdout: 'pipe',
        stderr: 'inherit',
      });

      if (!r.success) {
        console.error(`ARM FAILED ${surface}:${conj} exit ${r.exitCode}`);
        process.exit(1);
      }

      process.stdout.write(new TextDecoder().decode(r.stdout));
    }
  }
}
