/**
 * WHAT WOULD A SLOT-SPACE DRAIN BE WORTH TO THE *UNFILTERED* YIELDING HOP?
 *
 * Item 1692 took the FAR-FILTERED hop (`V().out(E).has(k,eq).id()`) from 120.34 ms to 3.16 by
 * resolving the filter once per vertex and emitting from flat slot runs. Its A/B shows the
 * unfiltered shapes untouched — `V().out(E).values(n)` read 122.66 PRE against 121.29 POST — because
 * they go to `hop-values.ts`, a different module, and the arm needs a far filter to exist.
 *
 * Those shapes are now the largest in `bun run bench:gremlin`:
 *
 * ```text
 *    V().out()x3.values(age)      462.9 ms   (native 1254.6 — TS is already 2.7x FASTER)
 *    V().out().values(age).order() 385.2     (native  80.7 — 4.8x)
 *    V().out().id()               207.6      (native 100.2 — 2.1x)
 *    V().out().values(age)        171.0      (native  27.2 — 6.3x)
 *    V().out() [bare]             118.7      (native 324.9 — TS faster)
 * ```
 *
 * ⚠️ AND THE `order()` ROW'S SORT IS NOT THE TARGET. Items 879/890 settled that: the sort of 1M
 * numbers costs 88 ms and the engine's NaN-total order costs the same, so the ordering CONTRACT is
 * free; item 879 built the single-`by` specialization (1.19x) and item 890 REFUTED the residual at
 * 1.04x, "matched exactly by an unreachable control; reverted". What is left in that row above the
 * sum of sort + walk is what those two items already fought over. **The WALK is the shared part**,
 * and it is what this prices.
 *
 * ⚠️ WHAT THE FILTERED CASE'S DECOMPOSITION PREDICTS. Item 1691 separated the two effects on the
 * filtered row: a flat CSR alone moved it 109.4 -> 67.7 (1.62x) while the per-vertex mask moved it
 * 109.4 -> 76.4. The mask has nothing to offer here — every row needs the far vertex's property —
 * so 1.62x is the honest expectation, NOT the 38x the filtered row got. A probe that reported more
 * would be measuring something else.
 *
 * Arms (ARM=<name>, ONE PER PROCESS — item 1691's seven-arm process read the same arm at 31.9, 44.2
 * and 65.6 ms):
 *
 *   engineValues / engineId / engineBare   the real traversals
 *   handGen                                the generator walk by hand — today's data access
 *   handCsr                                the same walk over flat slot runs
 *
 *   ARM=engineValues node gremlin-unfiltered-hop-probe.mjs
 */
import { Graph } from '@lenke/core';
import { V, id, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `u${i}`, labels: ['User'], properties: { age: i % 90, n: i } }));
}

let e = 0;
const targets = new Set();

// ⚠️ NONLINEAR in `i`, so in-degree varies: a linear `(a*i+b) % N` is a bijection per layer and
// makes the graph functional, which turns a multi-hop row into a chain (items 1516/1518/1684).
for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    targets.add(mix % N);
    g.addEdge({ id: `e${e}`, from: vs[i], to: vs[mix % N], labels: ['E'], properties: {} });
    e += 1;
  }
}

if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const order = [...g.verticesById.values()];

const buildCsr = () => {
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(g.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const edge of order[i].adjFrom?.get('E') ?? []) {
      nbr[at] = idx.get(edge.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { off, nbr };
};

const CSR = buildCsr();

/** Today's data access, by hand: the generator chain plus `edge.to` per edge. */
const handGen = () => {
  const acc = [];

  for (const v of order) {
    for (const edge of v.adjFrom?.get('E') ?? []) {
      acc.push(edge.to.properties.age);
    }
  }

  return acc;
};

/** The same walk, with the adjacency flattened. The property read is unchanged and unavoidable. */
const handCsr = ({ off, nbr }) => {
  const acc = [];

  for (let s = 0; s < order.length; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      acc.push(order[nbr[i]].properties.age);
    }
  }

  return acc;
};

/** ⚠️ WITH THE CSR BUILD INSIDE THE TIMED REGION — the cold case, which a cached CSR only pays once
 *  but which must be reported, since item 1691's 91x was an artefact of hoisting one out. */
const handCsrPlusBuild = () => handCsr(buildCsr());

const ARMS = {
  engineValues: () => toArray(traversal(V(), out('E'), values('age')), g),
  engineId: () => toArray(traversal(V(), out('E'), id()), g),
  engineBare: () => toArray(traversal(V(), out('E')), g),
  handGen,
  handCsr: () => handCsr(CSR),
  handCsrPlusBuild,
};

const PICK = process.env.ARM;

if (PICK === undefined || ARMS[PICK] === undefined) {
  throw new Error(`set ARM to one of: ${Object.keys(ARMS).join(', ')}`);
}

// ⚠️ The VALUES arms are one question and `id`/bare are others, so each is checked against the arm
// that answers the SAME question — not against whichever ran first.
const rows = ARMS[PICK]().length;

if (PICK === 'handGen' || PICK === 'handCsr' || PICK === 'handCsrPlusBuild') {
  const want = ARMS.engineValues();
  const got = ARMS[PICK]();

  if (got.length !== want.length) {
    throw new Error(`ARM ${PICK} produced ${got.length} rows, engine produced ${want.length}`);
  }

  // Gremlin stream order is a CONTRACT compared ordered by the differential fuzzer, so the hand
  // arms must match the sequence, not the multiset.
  for (let i = 0; i < want.length; i += 1) {
    if (got[i] !== want[i]) {
      throw new Error(`ARM ${PICK} diverges at row ${i}: ${got[i]} vs ${want[i]}`);
    }
  }
}

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  ARMS[PICK]();
  series.push(performance.now() - t0);
}

/** ⚠️ MEDIAN of the warm reps: `min` has reversed a verdict's sign in this repo. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${PICK.padEnd(18)} median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(8)} rows=${String(rows).padStart(8)} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
