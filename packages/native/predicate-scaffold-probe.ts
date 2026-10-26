/**
 * Item 926: RE-PRICE item 798's per-vertex predicate scaffolding, because three changes landed
 * after it was measured.
 *
 * Item 798 decomposed a filtered count in the TS engine and found the predicate itself is 2-4 ns a
 * vertex while **~18-20 ns is per-VERTEX SCAFFOLDING** — `inlineHolds`'s `Map` write, `satisfies`'s
 * `{ binding, params, graph }` allocation, and the `value(env)` call. Item 801 confirmed the
 * downstream consequence (GQL ~2.1x its own Gremlin twin on a filtered node count, three
 * measurements across two fixtures and two harnesses) and called the residue "its own tick". It is
 * the largest OPEN perf item left in `CLOSED.md`.
 *
 * BUT THE 18-20 ns IS A CARRIED NUMBER AND THREE THINGS HAVE SINCE LANDED:
 *
 *   - item 799 gated the `$param` reader at compile time (1.73x / 2.11x on param predicates),
 *   - item 803 dropped the binding write entirely when nothing reads it back,
 *   - item 835 shipped the direct-read PROJECTION, removing this exact shape — binding write, env
 *     allocation, read-back-out — for projections.
 *
 * Item 261's rule is to re-price a carried number before building against it, and that rule exists
 * because 261 found a "residual 3.3x cliff" was actually 1.03x. So this probe rebuilds 798's table
 * at HEAD rather than trusting it. 798's own probe was temporary and is gone, which is why it has to
 * be rebuilt rather than re-run — the same cost item 820's vanished probe imposed.
 *
 * THE TWO CONTROLS, as item 871 established and 798 used:
 *   - `none`      — `count(*)` with no predicate at all. Reads no property; the floor.
 *   - `wheretrue` — `WHERE true` runs the filter machinery over every vertex and keeps them all, so
 *     agreement with it means the predicate is free and the cost is the SCAFFOLDING. This is the
 *     control that makes the decomposition a measurement: `none` bounds the scan, `wheretrue` bounds
 *     the scan plus scaffolding, and the difference is what 798 attributed.
 *
 * ONE SHAPE PER PROCESS (item 762), selected by A_SHAPE, because a filtered count's dispatch sites
 * are exactly what a second shape in the same process would pollute.
 *
 * Usage:  A_SHAPE=eq bun run predicate-scaffold-probe.ts
 *         for s in none wheretrue inline eq cmp param; do A_SHAPE=$s bun run ...; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 14;
const DROP = 3;
const SHAPE = process.env.A_SHAPE ?? 'eq';

/** Every arm asks the SAME question of the same graph, so a difference is the spelling. */
const SHAPES: Record<string, { q: string; params?: Record<string, unknown> }> = {
  // NOT A FLOOR, and kept only to show why. `count(*)` with no predicate is answered O(1) from the
  // label bucket's length, so it reads 0.01 ns/vertex with a series of zeros and measures no scan
  // at all. Item 801 hit the same thing comparing surfaces ("the pair cannot be compared, 0.00 vs
  // 0.01") and `spelling-probe.ts` keeps a FLOOR_MS for it. `wheretrue` is the real floor.
  none: { q: 'MATCH (n:P) RETURN count(*) AS c' },
  // CONTROL: the filter machinery runs per vertex and keeps every row.
  wheretrue: { q: 'MATCH (n:P) WHERE true RETURN count(*) AS c' },
  // An inline property constraint.
  inline: { q: 'MATCH (n:P {k: 28}) RETURN count(*) AS c' },
  // A clause equality — item 224/230's eqProps lift.
  eq: { q: 'MATCH (n:P) WHERE n.k = 28 RETURN count(*) AS c' },
  // A clause comparison — cmpProps. NOTE the selectivity: this keeps 135,542 of 200,000 rows while
  // `eq` keeps 2,222, so cmp-vs-eq is NOT a clean predicate comparison on its own.
  cmp: { q: 'MATCH (n:P) WHERE n.k > 28 RETURN count(*) AS c' },
  // SELECTIVITY-MATCHED to `eq` (both keep ~1.1%), so this pair isolates `>` against `=` with the
  // surviving-row count held constant. Without it the cmp/eq difference conflates the operator
  // with 66x the survivors.
  cmpsel: { q: 'MATCH (n:P) WHERE n.k > 88 RETURN count(*) AS c' },
  // SELECTIVITY-MATCHED the other way: keeps everything, like `wheretrue`, so the difference from
  // `wheretrue` is the property read and the comparison with nothing else moving.
  cmpall: { q: 'MATCH (n:P) WHERE n.k >= 0 RETURN count(*) AS c' },
  // The param spelling, to confirm item 799's fix still holds at HEAD.
  param: { q: 'MATCH (n:P) WHERE n.k > $a RETURN count(*) AS c', params: { a: 28 } },
};

const chosen = SHAPES[SHAPE];

if (chosen === undefined) {
  throw new Error(`unknown A_SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

// Built OUTSIDE the timed region — item 824's rule, learned there the hard way twice.
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 90, s: `s${i % 1000}` } });
}

const series: number[] = [];
let answer = -1;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const rows = query(g, chosen.q, chosen.params) as Array<{ c: number }>;

  series.push(performance.now() - t0);
  answer = rows[0].c;
}

// Asserted, not printed and ignored: an arm that answered nothing would time the error path.
if (answer < 0) {
  throw new Error(`${SHAPE} produced no answer`);
}

// Item 884's estimator for this path: drop the visible JIT warm-up, take the median.
const plateau = series.slice(DROP).sort((a, b) => a - b);
const ms = plateau[Math.floor(plateau.length / 2)];

console.log(
  JSON.stringify({
    shape: SHAPE,
    n: N,
    answer,
    ms: Number(ms.toFixed(3)),
    nsPerVertex: Number(((ms * 1e6) / N).toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
