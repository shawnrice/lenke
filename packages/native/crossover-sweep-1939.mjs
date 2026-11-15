// Item 1939 — IS THE CROSSOVER THRESHOLD STABLE ACROSS SIZE AND FANOUT?
//
// Item 1938 found the edge-driven arm beats the engine's start-driven walk above ~30% start-label
// coverage and LOSES by up to 25x below ~20% — so the gate must be a cost test with a threshold.
// ⚠️ That threshold came from ONE fixture at ONE size (50,000) and ONE fanout (2), and CLAUDE.md
// requires both sweeps before a number like it can be believed:
//
//   - "Sweep the size. Cache-resident and not are different questions; the transition is between
//     200k and 1M elements."
//   - "Match the fixture to the claim. Per-edge costs scale with the edge:node ratio, per-node
//     costs do not."
//
// 🔑 THE CROSSOVER IS EXACTLY WHERE BOTH MATTER, because it is a ratio between an O(|E|) arm and an
// O(tCount x degree) one — so changing the edge:node ratio moves the two sides by DIFFERENT amounts
// and the crossing point must move with it. If it does not, that is itself the finding.
//
// Reports, per (size, fanout), the LOWEST coverage fraction at which the edge-driven arm still
// wins. A threshold that is stable across cells can be a constant; one that moves has to be a
// function of the edge:node ratio.
//
// ⚠️ RUN UNDER A CAP — a probe over generated input at these sizes is exactly what
// [[dogfood-sim-resource-limits]] is about:
//
//     timeout 900 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
//       bun crossover-sweep-1939.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const REPS = Number(process.env.REPS ?? 5);
const SIZES = (process.env.SIZES ?? '50000,200000').split(',').map(Number);
const FANOUTS = (process.env.FANOUTS ?? '1,2,5').split(',').map(Number);
const FRACS = (process.env.FRACS ?? '0.6,0.45,0.35,0.25,0.18,0.12,0.06').split(',').map(Number);

/** Every vertex is an edge source, so `|E|` is CONSTANT as coverage varies (item 1938's fix). */
const build = (nodes, fanout, tFrac) => {
  const g = new Graph();
  const tCount = Math.max(1, Math.round(nodes * tFrac));

  for (let i = 0; i < nodes; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: i < tCount ? ['U', 'T'] : ['U'],
      properties: { n: i % 97 },
    });
  }

  for (let e = 0; e < nodes * fanout; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % nodes) + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';

const handEdgeDriven = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('T') && edge.to.labels.has('T')) {
        rows.push({ x: edge.to.properties.n });
      }
    }
  }

  return rows.length;
};

const time = (fn) => {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    got = fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return [ser[ser.length >> 1], got];
};

console.log(`median of ${REPS}. "crossover" = the LOWEST coverage where edge-driven still wins.\n`);
console.log('  nodes  fanout   E:V   crossover   ratio there   ratio at 0.6');
console.log('-'.repeat(68));

/*
 * ⚠️⚠️ `await` BETWEEN CELLS, AND IT IS NOT DECORATION. The first run of this sweep printed five of
 * six cells and then died without its trailing note — and [[graph-pinned-until-microtask-drain]]
 * names the cause: a discarded Graph is retained IN FULL by its pending `drainMutations` microtask,
 * so a SYNCHRONOUS build/compute/discard loop OOMs. This sweep builds 42 graphs in one process,
 * which is precisely that shape. Yielding to the microtask queue lets each cell's graphs be
 * collected before the next builds more.
 *
 * ⚠️ And the exit code hid it: `timeout … | tail` reports TAIL's status, so the run looked like
 * exit 0. CLAUDE.md warns about this for `clippy | grep`; it is the same trap through a different
 * command. The missing cell ran fine on its own.
 */
const yieldToDrain = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const nodes of SIZES) {
  for (const fanout of FANOUTS) {
    await yieldToDrain();

    let crossover = 'none';
    let atCross = 0;
    let atTop = 0;

    for (const frac of FRACS) {
      const g = build(nodes, fanout, frac);
      const [eng, engRows] = time(() => query(g, Q, {}).length);
      const [hand, handRows] = time(handEdgeDriven(g));

      if (engRows !== handRows) {
        throw new Error(`arms disagree at ${String(nodes)}/${String(fanout)}/${String(frac)}`);
      }

      const ratio = eng / hand;

      if (frac === FRACS[0]) {
        atTop = ratio;
      }

      if (ratio > 1) {
        crossover = frac.toFixed(2);
        atCross = ratio;
      }

      await yieldToDrain();
    }

    console.log(
      [
        String(nodes).padStart(7),
        String(fanout).padStart(7),
        String(fanout).padStart(5),
        String(crossover).padStart(11),
        `${atCross.toFixed(2).padStart(13)}x`,
        `${atTop.toFixed(2).padStart(13)}x`,
      ].join(' '),
    );
  }
}

console.log(
  '\n⚠️ A crossover that MOVES across cells cannot be a constant in the gate — it has to be a\n' +
    '   function of the edge:node ratio. One that is stable can be.',
);
