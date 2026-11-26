/**
 * WHAT COULD A FILTERED TWO-HOP COUNT COST? — the ceiling, before any engine edit (item 1860)
 *
 * Item 1859 nominated `V().hasLabel(L).out(T).out(T).count()`: 51.6 ms on the Gremlin bench against
 * native's 2.87. It is NOT a missing rung — `hopChainCount` answers it — but the `hasLabel` makes
 * `unfiltered` false, so the O(V) degree inner product (item 590) is skipped and the arm that runs
 * reads `degreeOfTypes` (a `Map.get` plus `.size`) ONCE PER EDGE, ~1M times.
 *
 * THIS MEASURES THE CEILING, NOT THE CHANGE, and that order is deliberate. `denseChainCount` and
 * `slotChainCount` already exist and are wired for THREE hops and up; the two-hop arm never tries
 * them. Rather than edit the engine to find out whether that is worth doing, this hand-rolls the
 * dense two-hop in plain JavaScript over the same fixture: if the hand-rolled floor is near 51 ms
 * the target is refuted for free, and only if it is far below does an engine edit get written.
 *
 * THE EXISTING REFUTATION DOES NOT PRICE THIS, so read which one it is. `hopChainCount`'s own
 * note records a map version losing — 33.56/33.00/31.70 ms against 26.83/24.26/25.89 — but that is
 * the `Map<Vertex, number>` version at 120,000 edges. This is the DENSE version at 1,000,000.
 *
 * THE ANSWERS ARE COMPARED, not just the times. A faster wrong answer is the defect class
 * CLAUDE.md opens with, and a two-hop count over a graph with parallel edges and self-loops is
 * exactly where an "obvious" dense rewrite drops multiplicities.
 *
 * ONE SHAPE PER PROCESS is NOT needed here: both arms are measured in this process, but they are
 * not two versions of ONE dispatch site — the engine arm goes through the engine and the dense arm
 * is local code that no engine query can reach. Item 762's trap is a redistributed call site, and
 * there is none. The engine arm is still measured FIRST and again LAST, as its own control.
 */
import { Graph as TsGraph } from '@lenke/core';
import { V, count, hasLabel, out, toArray, traversal } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PROBE_N ?? 200_000);
const REPS = Number(process.env.PROBE_REPS ?? 5);
const FANOUT = Number(process.env.PROBE_FANOUT ?? 5);

// Byte-for-byte the Gremlin bench's fixture expression — including the `Math.floor(k / N)` split
// that item 1632 added, without which every vertex's out-edges are parallel edges to ONE target.
const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N * FANOUT; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${to}","properties":{"w":${k % 7}}}`,
  );
}

const g = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

/** The fixture must BRANCH, or a two-hop count is `F^2 * N` whatever the arms do (CLAUDE.md). */
const distinctOut = new Set();

for (let k = 0; k < N * FANOUT; k += 1) {
  if ((k * 7919) % N === 0) {
    distinctOut.add(((k % N) * 104_729 + Math.floor(k / N) * 977) % N);
  }
}

if (distinctOut.size < 2) {
  throw new Error(`fixture is functional: vertex v0 reaches ${distinctOut.size} distinct targets`);
}

const PLAN = traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), count());

const engineArm = () => toArray(PLAN, g)[0];

/**
 * THE DENSE TWO-HOP, hand-rolled: build a CSR of `out('KNOWS')` neighbour SLOTS once, seed the
 * survivors' slots with multiplicity 1, push one level, then sum `ways[slot] * runLength[slot]`.
 *
 * THE CSR BUILD IS INSIDE THE TIMED REGION ON THE FIRST REP AND MEMOIZED AFTER, which is what
 * the engine's `chainCsrFor` does — so the reported min-of-N is the WARM cost, and the first rep is
 * printed separately because a serving workload that asks once pays it.
 */
let csr = null;

const buildCsr = () => {
  const vtx = [...g.verticesById.values()];
  const slotOf = new Map();

  for (const [i, v] of vtx.entries()) {
    slotOf.set(v, i);
  }

  const n = vtx.length;
  const len = new Int32Array(n);

  for (const [i, v] of vtx.entries()) {
    const box = v.adjFrom;

    if (box !== undefined) {
      const set = box.get('KNOWS');

      len[i] = set === undefined ? 0 : set.size;
    }
  }

  const off = new Int32Array(n);
  let acc = 0;

  for (let i = 0; i < n; i += 1) {
    off[i] = acc;
    acc += len[i];
  }

  const flat = new Int32Array(acc);

  for (const [i, v] of vtx.entries()) {
    const box = v.adjFrom;

    if (box === undefined) {
      continue;
    }

    const set = box.get('KNOWS');

    if (set === undefined) {
      continue;
    }

    let at = off[i];

    for (const e of set) {
      flat[at] = slotOf.get(e.to);
      at += 1;
    }
  }

  return { vtx, slotOf, len, off, flat };
};

const denseArm = () => {
  csr ??= buildCsr();

  const { vtx, len, off, flat } = csr;
  const n = vtx.length;
  const ways = new Float64Array(n);
  const frontier = [];

  // The survivors of `hasLabel('Person')`, each with multiplicity one.
  for (const [i, v] of vtx.entries()) {
    if (v.labels.has('Person')) {
      if (ways[i] === 0) {
        frontier.push(i);
      }

      ways[i] += 1;
    }
  }

  const next = new Float64Array(n);
  const nextFrontier = [];

  for (const slot of frontier) {
    const m = ways[slot];
    const base = off[slot];
    const run = len[slot];

    for (let i = 0; i < run; i += 1) {
      const to = flat[base + i];

      if (next[to] === 0) {
        nextFrontier.push(to);
      }

      next[to] += m;
    }
  }

  let total = 0;

  for (const slot of nextFrontier) {
    total += next[slot] * len[slot];
  }

  return total;
};

const time = (fn, reps) => {
  const series = [];
  let answer;

  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();

    answer = fn();
    series.push(performance.now() - t0);
  }

  return { answer, series, min: Math.min(...series) };
};

const engineFirst = time(engineArm, REPS);
const dense = time(denseArm, REPS);
const engineLast = time(engineArm, REPS);

console.log(`${N} vertices / ${N * FANOUT} edges, min of ${REPS}`);
console.log(`  engine  (first)   ${engineFirst.min.toFixed(2)} ms   answer ${engineFirst.answer}`);
console.log(`  dense   (warm)    ${dense.min.toFixed(2)} ms   answer ${dense.answer}`);
console.log(`  dense   (rep 1)   ${dense.series[0].toFixed(2)} ms   — includes the CSR build`);
console.log(`  engine  (control) ${engineLast.min.toFixed(2)} ms   answer ${engineLast.answer}`);

if (String(engineFirst.answer) !== String(dense.answer)) {
  throw new Error(`ANSWERS DISAGREE: engine ${engineFirst.answer} vs dense ${dense.answer}`);
}

console.log(`  answers agree; ceiling is ${(engineFirst.min / dense.min).toFixed(2)}x`);
