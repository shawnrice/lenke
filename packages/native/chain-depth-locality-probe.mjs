/**
 * Is the marginal cost of a CHAIN HOP flat, or does it grow with depth? And if it grows, is that the
 * ENGINE or the FIXTURE'S ACCESS PATTERN?
 *
 * Item 1814 shipped the `chainProjection` rung and left a residual it could not explain: on
 * `runtime-profile-probe.mjs` a three-hop row projection costs ~350 ns/row where the two-hop twin
 * costs ~111, which is 3.15x the per-row price for 1.33x the levels. Item 1815 then refuted all
 * three candidates that item named — the recursive descent measured 1.052x against the two nested
 * inline loops AT THE SAME DEPTH, the emit is shared with the two-hop rung, and the per-level
 * bucket lookup is 1.6% of self time. The cost is real, it survives inside one implementation, and
 * no code-level explanation is left.
 *
 * ⚠️ THE SUSPECT IS THE GENERATOR, AND IT IS A CLASS CLAUDE.md ALREADY NAMES. The profile probe's
 * `sequential` stride wires `v_i -> v_((7i + 3) % N)`, so the multiplier COMPOUNDS with depth:
 *
 *     depth 1   consecutive starts land 7 apart
 *     depth 2   49 apart
 *     depth 3   343 apart
 *     depth 4   2401 apart
 *
 * One hop is a prefetchable stride-7 sweep; three hops is a scatter. So "the third hop costs 3x the
 * second" may be a statement about the fixture's cache behaviour rather than about the walk. This is
 * item 1516/1518's family — `to = (a*k + b) % N` looking perfectly healthy by out-degree, in-degree
 * and isolated-vertex count while being wrong for the question asked — and CLAUDE.md's rule is to
 * check the fixture's own statistics, not just its output.
 *
 * WHY A NEW INSTRUMENT AND NOT AN EXISTING ONE. `chase-depth-micro.mjs` (items 1771/1773) asks the
 * same question of a BARE dependent-load chain and answers it: depth saturates at 18-20 ns by depth
 * 4 under both allocation strides. That bounds the pure pointer-chase term an order of magnitude
 * below the ~215 ns seen here, which is what makes the engine-level sweep worth building. Nothing in
 * PROBES.md sweeps depth against WORKING-SET SIZE through the engine's own chain walk.
 *
 * THE THREE STRIDES BRACKET THE QUESTION rather than one being correct (item 1487's caveat, restated
 * at PROBES.md's locality section):
 *
 *     compound   v_i -> v_((7i + 3) % N)    the profile probe's own `sequential`; stride COMPOUNDS
 *     chain      v_i -> v_((i + 1) % N)     depth-INVARIANT locality, the control for `compound`
 *     scattered  v_i -> v_((104729i) % N)   cache-hostile at EVERY depth, so depth cannot compound
 *
 * `chain` is the load-bearing one: it holds work, row count and out-degree identical to `compound`
 * and changes ONLY how far apart consecutive hops land. If the marginal cost per hop is flat under
 * `chain` and grows under `compound`, the residual is the generator. If it grows under BOTH, it is
 * the engine and this probe has nominated depth itself.
 *
 * ROW GUARD. Every stride is a FUNCTIONAL graph (out-degree exactly 1), so a depth-k chain from all
 * N vertices yields exactly N rows at every k and every N. The guard is therefore `rows === N * reps`
 * and it scales with the sweep instead of being pinned to one fixture size — which is what the
 * profile probe's absolute `rowsPerRun: 20_000` could not do. A wrong-answer arm changes the row
 * count, and a timing from an arm that is not answer-equivalent is meaningless.
 *
 *   node chain-depth-locality-probe.mjs <depth> <nodes> <compound|chain|scattered> <reps>
 *
 * One cell per PROCESS (item 762): several depths in one process let the first shape's dispatch
 * site pollute the next one's inline caches, which is the exact effect that made item 762's controls
 * move further than its targets.
 */

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const [, , depthArg, nodesArg, strideArg, repsArg] = process.argv;

const DEPTH = Number(depthArg ?? 3);
const NODES = Number(nodesArg ?? 20_000);
const STRIDE = strideArg ?? 'compound';
const REPS = Number(repsArg ?? 20);

if (!Number.isInteger(DEPTH) || DEPTH < 1 || DEPTH > 6) {
  throw new Error(`depth must be an integer 1..6, got ${depthArg}`);
}

if (!Number.isInteger(NODES) || NODES < 100) {
  throw new Error(`nodes must be an integer >= 100, got ${nodesArg}`);
}

if (STRIDE !== 'compound' && STRIDE !== 'chain' && STRIDE !== 'scattered') {
  throw new Error(`stride must be compound|chain|scattered, got ${strideArg}`);
}

/** The three brackets. Each is functional: exactly one out-edge per vertex, so rows === NODES. */
const target = (i) => {
  if (STRIDE === 'chain') {
    return (i + 1) % NODES;
  }

  if (STRIDE === 'scattered') {
    return (i * 104_729) % NODES;
  }

  return (i * 7 + 3) % NODES;
};

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${target(i)}`),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

/**
 * `MATCH (n0:P)-[:E]->(n1:P)...->(nk:P) RETURN nk.k AS k` — the shape `hop3rows` runs, at any depth,
 * with no rel variable and no path variable so `chainProjection`/`hop2Projection`/`hopProjection`
 * admit it exactly as they admit the profile probe's rows.
 */
const buildQuery = (depth) => {
  let q = '(n0:P)';

  for (let i = 1; i <= depth; i += 1) {
    q += `-[:E]->(n${i}:P)`;
  }

  return `MATCH ${q} RETURN n${depth}.k AS k`;
};

/** The DISTINCT-ENDPOINT census CLAUDE.md requires of any new fixture, printed, not assumed. */
const census = (g) => {
  const seen = new Set();
  let edges = 0;

  for (const e of g.edges) {
    seen.add(e.toId);
    edges += 1;
  }

  return { edges, distinctTargets: seen.size };
};

const g = build();
const c = census(g);

if (c.edges !== NODES) {
  throw new Error(`fixture has ${c.edges} edges, expected ${NODES} (out-degree must be exactly 1)`);
}

const q = buildQuery(DEPTH);

// Warm-up, excluded from the timing: the first reps are visibly the JIT tiering up, and CLAUDE.md's
// estimator rule for this path is median-of-the-rest rather than min.
for (let r = 0; r < 3; r += 1) {
  query(g, q);
}

const series = [];
let rows = 0;
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = query(g, q);
  series.push(performance.now() - t0);
  rows += out.length;
  answer = out.length > 0 ? out[0].k : undefined;
}

// ⚠️ ROW GUARD, SCALED. A functional graph has exactly one depth-k walk per vertex, so anything but
// N rows per rep means this arm is not answer-equivalent and its timing says nothing.
if (rows !== NODES * REPS) {
  throw new Error(
    `depth ${DEPTH} returned ${rows} rows across ${REPS} reps, expected ${NODES * REPS} — this arm is NOT answer-equivalent, so its timing is meaningless`,
  );
}

const sorted = [...series].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];

console.log(
  JSON.stringify({
    depth: DEPTH,
    nodes: NODES,
    stride: STRIDE,
    reps: REPS,
    ms: Number(median.toFixed(3)),
    nsPerRow: Number(((median * 1e6) / NODES).toFixed(1)),
    rows,
    answer,
    distinctTargets: c.distinctTargets,
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  }),
);
