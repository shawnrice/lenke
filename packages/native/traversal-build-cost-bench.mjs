/**
 * WHAT DOES BUILDING A GREMLIN TRAVERSAL COST, AND IS IT PAID PER QUERY IN REAL USE? (item 1841)
 *
 * ⚠️ THE GREMLIN PROBE'S OWN HEADER FLAGS THIS AND THEN RELIES ON IT: "EVERY `SHAPES` ENTRY IS
 * BUILT ONCE, AT MODULE LEVEL, AND THE PLAN OBJECT IS REUSED ACROSS REPS." That is right for
 * measuring a WALK — building the traversal per rep would time the builder — but it means no
 * instrument here has ever measured the builder itself. A real caller writes
 * `g.V().out('E').values('k')` inline and builds a fresh object every time.
 *
 * This is the Gremlin twin of item 1840's question on the GQL side. There the per-query cost was a
 * parse and a cache; here there is no text and no parse, so the question is whether constructing
 * the step chain and lowering it is a per-call cost worth knowing about.
 *
 * ⚠️ THREE ARMS, BECAUSE TWO CANNOT SEPARATE THE PARTS:
 *
 *   - `build`     — construct the traversal and throw it away. No graph touched.
 *   - `execute`   — run a traversal built ONCE outside the timed loop (the probe's own shape).
 *   - `both`      — build it fresh and run it, which is what a caller actually does.
 *
 * `both - execute` is the per-call builder cost, and `build` is a cross-check on that subtraction:
 * if the two disagree the subtraction is measuring something else. ⚠️ Item 1839's subtraction sat
 * inside its own noise band, which is why this one is checked against a direct arm rather than
 * trusted.
 *
 * ⚠️ A SMALL GRAPH ON PURPOSE. Execution is the noise the builder has to be seen through; at 200
 * vertices the walk is microseconds, so a per-call build cost is not buried under row work. The
 * ratio reported is therefore an UPPER BOUND on what build costs a real query — on a big graph the
 * same absolute cost is a smaller share, and that is stated rather than left for the reader to
 * infer.
 *
 *     ARM=both bun traversal-build-cost-bench.mjs
 *     ARM=execute NODES=200 REPS=14 DROP=3 bun traversal-build-cost-bench.mjs
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const ARM = process.env.ARM ?? 'both';
const NODES = Number(process.env.NODES ?? 200);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const CALLS = Number(process.env.CALLS ?? 2_000);

if (!['build', 'execute', 'both'].includes(ARM)) {
  throw new Error(`ARM must be build|execute|both, got ${ARM}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { k: i % 8 } });
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3) % NODES) + 1)),
    labels: ['E'],
  });
}

/** The shape a caller would write inline — three steps plus the source and the projection. */
const make = () => traversal(V(), hasLabel('T'), out('E'), values('k'));
const prebuilt = make();

const once = () => {
  if (ARM === 'build') {
    // ⚠️ The result is RETURNED, not discarded in place: a builder whose output is unused is
    // exactly the shape an optimizer may elide, and a measured zero would then be an artifact.
    return make().steps.length;
  }

  if (ARM === 'execute') {
    return toArray(prebuilt, g).length;
  }

  return toArray(make(), g).length;
};

for (let w = 0; w < 200; w += 1) {
  once();
}

const series = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (let c = 0; c < CALLS; c += 1) {
    sink += once();
  }

  series.push(((performance.now() - t0) * 1000) / CALLS);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median =
  kept.length % 2 === 1
    ? kept[kept.length >> 1]
    : (kept[(kept.length >> 1) - 1] + kept[kept.length >> 1]) / 2;

// The sink is the answer guard: each arm has its own invariant per call, so a drifting arm is not
// comparable however fast it reads.
const perCall = ARM === 'build' ? 4 : NODES;

if (sink !== perCall * CALLS * REPS) {
  throw new Error(`sink ${sink}, expected ${perCall * CALLS * REPS} — this arm is not comparable`);
}

console.log(
  JSON.stringify({
    arm: ARM,
    nodes: NODES,
    calls: CALLS,
    usPerCall: Number(median.toFixed(3)),
    p25: Number(kept[Math.floor(kept.length * 0.25)].toFixed(3)),
    p75: Number(kept[Math.floor(kept.length * 0.75)].toFixed(3)),
    series: series.map((x) => Number(x.toFixed(3))),
  }),
);
