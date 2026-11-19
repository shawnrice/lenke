/**
 * ✅✅ **THE LOSING SHAPE THE PREFILL's OWN AUTHOR FLAGGED AND NO PROBE COVERS (item 2334).**
 *
 * `hop-chain-values.ts` prefills every slot's projected value before the walk:
 *
 * ```ts
 *     const vals = Array.from({ length: n });
 *     for (let s = 0; s < n; s += 1) { vals[s] = pick(vtx[s]); }
 * ```
 *
 * ✅ That is what makes Gremlin 5.12x faster than GQL on a two-hop projection (items 2332/2333) — the
 * property is read once per VERTEX rather than once per PATH. ⚠️ But its doc comment states the risk in as
 * many words:
 *
 *   *"AND ITS COST IS O(slots) ON A HIGHLY SELECTIVE FILTER — picks for slots nothing reaches. The
 *   filtered shapes above are the check on that and they all IMPROVED, because the walk still visits most
 *   slots; **a filter admitting a handful out of 200,000 is the shape that would lose, and no probe covers
 *   it.**"*
 *
 * 🔑 So this probe is that shape. The prefill is O(|V|) whatever the filter admits, so the question is what
 * a query emitting a HANDFUL of rows pays for picks over the whole vertex set.
 *
 * ⚠️ **ns-per-EMITTED-ROW IS THE WRONG YARDSTICK ALONE** — a selective filter emits few rows, so any fixed
 * cost divides into a huge per-row number and would "prove" a regression that is really just arithmetic.
 * ✅ The honest comparison is the absolute µs of a selective query against the SAME query shape whose
 * filter admits everything: if the prefill dominates, the selective arm costs nearly as much as the
 * unselective one despite emitting 1/1000th the rows.
 */
import { Graph } from '@lenke/core';
import { V, eq, has, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'selective';

const graph = new Graph();

/*
 * ⚠️ `sel` is 1-in-NODES — exactly ONE vertex carries `sel: 1` — which is the "handful out of 200,000"
 * the comment names. `k` is the projected key and is present on every vertex.
 */
for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { k: i % 97, sel: i === 0 ? 1 : 0, all: 1 },
  });
}

const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

const plans = {
  /* ⚠️ THE FLAGGED SHAPE: a far filter admitting ONE vertex, so almost no slot is emitted. */
  selective: traversal(V(), hasLabel('N'), out('E'), out('E'), has('sel', eq(1)), values('k')),
  /* ✅ THE SAME SHAPE whose filter admits EVERYTHING — same steps, same walk, every slot emitted. */
  unselective: traversal(V(), hasLabel('N'), out('E'), out('E'), has('all', eq(1)), values('k')),
  /* ✅ And the unfiltered twin, for what the walk costs with no `has` at all. */
  nofilter: traversal(V(), hasLabel('N'), out('E'), out('E'), values('k')),
};

const arm = () => toArray(plans[ARM], graph).length;

for (let w = 0; w < 10; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 20_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = arm();

console.log(
  `  ARM=${ARM.padEnd(12)} ${(med * 1000).toFixed(0).padStart(7)} us   rows=${String(rows).padStart(6)}`,
);
