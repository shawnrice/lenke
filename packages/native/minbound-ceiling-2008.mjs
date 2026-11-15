/**
 * WHAT IS THE CEILING FOR A `{min>=2}` ROWS RUNG? (item 2008)
 *
 * Item 2007 priced `{2,3} DISTINCT` at **674x** its `{1,3}` twin (640.28 ms against 0.95 at 5,000
 * vertices) and refuted the cheap cure: a per-level BFS answers WALK reachability, and this rung also
 * serves TRAIL, SIMPLE and the default — 10 mode divergences at `min >= 2`, because a walk may reuse
 * an edge where a trail may not.
 *
 * 🔑 **BUT ITEM 2004'S MECHANISM APPLIES AND NEEDS NO THEOREM: a TRAIL DFS collecting endpoints has
 * trail-ness as its LOOP CONDITION.** `perSourceTrailCount` already does exactly this for counts —
 * a DFS over CSR edge POSITIONS carrying a `used` set — so the shape is in the codebase and proven.
 * The question is only whether it is worth building, and that is a ceiling measurement.
 *
 * ⚠️ THE CEILING IS OVER THE **CSR**, NOT THE ADJACENCY BUCKETS. Item 1999 priced a `choose` target
 * at 2.96x against a hand ceiling that read the adjacency through `v.adjFrom.get(T)`, and the fused
 * route then beat that "ceiling" by 2.11x because the ceiling itself was a bucket walk. A ceiling is
 * only a floor if it uses the data structure the cure would use. This one walks `Int32Array`
 * neighbours with a `Uint8Array` marker, which is what the engine's own fused arms use.
 *
 * ⚠️ AND IT CHECKS ITS ANSWER AGAINST THE ENGINE, because a ceiling that answers something else is
 * not a ceiling. The engine's `{2,3}` DISTINCT is the oracle.
 *
 *     bun minbound-ceiling-2008.mjs
 *     NODES=20000 bun minbound-ceiling-2008.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);
const MIN = Number(process.env.MIN ?? 2);
const MAX = Number(process.env.MAX ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Splits on the repeat index — CLAUDE.md's rule.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

/*
 * A CSR built here by hand — the engine's `csrFor` is internal, and building it is part of what the
 * cure would pay, so it belongs INSIDE the ceiling rather than hidden behind a cache.
 */
const buildCsr = () => {
  const order = [...g.vertices];
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(g.edgeCount);
  // The EDGE id per adjacency slot, which a trail walk needs and a walk does not.
  const eid = new Int32Array(g.edgeCount);
  let at = 0;
  let edgeNo = 0;
  const edgeIds = new Map();

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    const box = order[i].adjFrom?.get('E');

    if (box !== undefined) {
      for (const e of box) {
        if (!edgeIds.has(e)) {
          edgeIds.set(e, edgeNo);
          edgeNo += 1;
        }

        nbr[at] = idx.get(e.to);
        eid[at] = edgeIds.get(e);
        at += 1;
      }
    }
  }

  off[order.length] = at;

  return { order, off, nbr, eid, edges: edgeNo };
};

/** The hand ceiling: a TRAIL DFS over the CSR, collecting endpoints reached at depth in [MIN, MAX]. */
const handTrailRows = () => {
  const { order, off, nbr, eid, edges } = buildCsr();
  const usedEdge = new Uint8Array(edges);
  const inAnswer = new Uint8Array(order.length);
  const values = [];
  const seenVal = new Set();
  const walk = (v, len) => {
    if (len >= MIN && inAnswer[v] === 0) {
      inAnswer[v] = 1;

      const val = order[v].properties.n;

      if (!seenVal.has(val)) {
        seenVal.add(val);
        values.push(val);
      }
    }

    if (len === MAX) {
      return;
    }

    const end = off[v + 1];

    for (let k = off[v]; k < end; k += 1) {
      const e = eid[k];

      // ⚠️ THE TRAIL CONDITION, and the reason this needs no theorem about walks: a repeated EDGE is
      // simply not a candidate. Item 2004's acyclic arm is the same DFS keyed on the VERTEX instead.
      if (usedEdge[e] === 1) {
        continue;
      }

      usedEdge[e] = 1;
      walk(nbr[k], len + 1);
      usedEdge[e] = 0;
    }
  };

  for (let s = 0; s < order.length; s += 1) {
    walk(s, 0);
  }

  return values;
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn) => {
  const ts = [];
  let out;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = fn();
    ts.push(performance.now() - t0);
  }

  return { ms: med(ts), out };
};

const bound = `{${String(MIN)},${String(MAX)}}`;
/*
 * ⚠️ `no-raw-interpolation` is suppressed below: `bound` is built from this file's own MIN/MAX
 * numbers, nothing is caller- or data-derived, and a quantifier is SYNTAX — no `$param` can express
 * `{2,3}`, and a tagged template would bind it as a value and produce a syntax error.
 */
const engine = time(() => [
  // eslint-disable-next-line lenke/no-raw-interpolation -- trusted literals; see above
  ...query(g, `MATCH (x:T)-[:E]->${bound}(y:T) RETURN DISTINCT y.n AS v`, {}),
]);
const hand = time(handTrailRows);
const eSet = JSON.stringify(engine.out.map((r) => r.v).sort((a, b) => Number(a) - Number(b)));
const hSet = JSON.stringify([...hand.out].sort((a, b) => Number(a) - Number(b)));

console.log(
  `|V|=${String(NODES)} fanout=${String(FANOUT)} bound=${bound} median of ${String(REPS)}\n`,
);
console.log(
  `engine (general matcher)   ${engine.ms.toFixed(2).padStart(9)} ms   ${String(engine.out.length)} rows`,
);
console.log(
  `hand TRAIL DFS over CSR    ${hand.ms.toFixed(2).padStart(9)} ms   ${String(hand.out.length)} rows`,
);
console.log(`\nceiling ratio              ${(engine.ms / hand.ms).toFixed(1).padStart(9)}x`);
console.log(
  `answers agree              ${eSet === hSet ? 'YES' : `NO\n  engine ${eSet.slice(0, 120)}\n  hand   ${hSet.slice(0, 120)}`}`,
);
console.log(
  '\n# ⚠️ The hand arm includes its own CSR build, because the cure would pay that too.\n' +
    '# ⚠️ It is the DEFAULT mode (= trail) that the realistic corpus draws, which is why the\n' +
    '#    trail condition is in the loop rather than a per-level BFS (item 2007 refuted that).',
);
