/**
 * THE GATE ON ITEM 1495's 4.1x: what does removal cost if the adjacency bucket becomes an ARRAY?
 *
 * Item 1495 measured the read side and selected the design — `Map<string, Set<Edge>>` becomes
 * `Map<string, Edge[]>`, worth 4.1x on a bare hop, with insert still O(1) and iteration order
 * unchanged (a `Set` and an appended array are both insertion-ordered). It left exactly one thing
 * unmeasured, and it is the thing that disqualified the global dense ordinal at items
 * 1369-1372/1397: **removal.** `Set.delete` is O(1); an order-preserving array removal is
 * `indexOf` + `splice`, both O(degree).
 *
 * ⚠️ A MICRO ON `Set.delete` IS MEANINGLESS ON ITS OWN. "A micro's ratio is bounded by the profile
 * share" is this corpus's most-repeated correction (items 1364, 1368, 1477), so this probe has two
 * halves: the data-structure micro by DEGREE, and the cost of a real `graph.removeEdge` today. The
 * second tells you what share the first can possibly move — if a removal costs 2 us and the
 * `Set.delete` is 20 ns of it, turning that into 200 ns is a 9% regression, not a 10x one.
 *
 *     NODES=20000 node adjacency-removal-probe.mjs
 *     PART=micro node adjacency-removal-probe.mjs
 */
import { Graph } from '@lenke/core';

const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 2);
const { PART } = process.env;

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

/** ── PART ONE: the data structures, by degree ──────────────────────────────────────────────── */
//
// Each arm removes EVERY member of a bucket of the given degree, one at a time, in a scattered
// order — not front-to-back, which would make `splice` look free (removing the last element shifts
// nothing) or maximally dear (removing the first shifts everything). A real delete hits a random
// position, so the expected shift is degree/2.
const DEGREES = [4, 16, 64, 256, 1024, 4096];

const microArms = {
  // `Set.delete` — what the engine does today. O(1), no search.
  set: (members, order) => {
    const s = new Set(members);

    for (const m of order) {
      s.delete(m);
    }

    return s.size;
  },

  // ORDER-PRESERVING array removal: `indexOf` to find it, `splice` to close the gap. Both O(d), so
  // this is the honest cost of keeping byte-identity.
  splice: (members, order) => {
    const a = [...members];

    for (const m of order) {
      const i = a.indexOf(m);

      if (i !== -1) {
        a.splice(i, 1);
      }
    }

    return a.length;
  },

  // SWAP-REMOVE: O(1) after the search, but it REORDERS the bucket. Included as the bound, and as
  // the thing that must NOT be used — adjacency iteration order is observable in row order, and
  // byte-identity between the TS and Rust engines turns on it.
  swap: (members, order) => {
    const a = [...members];

    for (const m of order) {
      const i = a.indexOf(m);

      if (i !== -1) {
        a[i] = a[a.length - 1];
        a.pop();
      }
    }

    return a.length;
  },

  // An array PLUS a side index from member to position, kept updated on removal. Removes the
  // `indexOf` search but not the `splice` shift, and costs a Map the Set version already pays for.
  indexed: (members, order) => {
    const a = [...members];
    const at = new Map();

    for (let i = 0; i < a.length; i += 1) {
      at.set(a[i], i);
    }

    for (const m of order) {
      const i = at.get(m);

      if (i === undefined) {
        continue;
      }

      a.splice(i, 1);
      at.delete(m);

      for (let k = i; k < a.length; k += 1) {
        at.set(a[k], k);
      }
    }

    return a.length;
  },
};

if (PART === undefined || PART === 'micro') {
  console.log(`\nREMOVAL BY DEGREE — ns per removal, ${REPS} reps (drop ${DROP})\n`);
  console.log(
    `${'degree'.padStart(7)}${'set'.padStart(11)}${'splice'.padStart(11)}${'swap'.padStart(11)}${'indexed'.padStart(11)}   splice/set`,
  );

  for (const d of DEGREES) {
    // Objects, not numbers: the engine's buckets hold `Edge` references, and `indexOf` on objects
    // is a reference scan where on small integers it could be anything.
    const members = Array.from({ length: d }, (_, i) => ({ i }));
    // A scattered removal order, so the expected shift is degree/2.
    const order = [...members];

    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = (i * 7919 + 13) % (i + 1);

      [order[i], order[j]] = [order[j], order[i]];
    }

    const out = {};

    for (const [name, fn] of Object.entries(microArms)) {
      const reps = [];

      for (let r = 0; r < REPS; r += 1) {
        const t0 = performance.now();
        const left = fn(members, order);

        reps.push(performance.now() - t0);

        if (left !== 0) {
          throw new Error(
            `ARM ${name} left ${left} members at degree ${d} — it did not remove all.`,
          );
        }
      }

      out[name] = (med(reps.slice(DROP)) * 1e6) / d;
    }

    console.log(
      `${String(d).padStart(7)}${out.set.toFixed(1).padStart(11)}${out.splice.toFixed(1).padStart(11)}` +
        `${out.swap.toFixed(1).padStart(11)}${out.indexed.toFixed(1).padStart(11)}` +
        `   ${(out.splice / out.set).toFixed(1)}x`,
    );
  }

  console.log();
}

/** ── PART TWO: what a real `removeEdge` costs today ────────────────────────────────────────── */
//
// Without this the micro above is unbounded. The engine's removal does far more than touch the
// adjacency bucket — element bookkeeping, both direction indexes, the label box, the id maps — so
// the bucket operation is some share of it, and that share caps what any of this can cost.
if (PART === undefined || PART === 'engine') {
  const NODES = Number(process.env.NODES ?? 20_000);

  console.log(`ENGINE removeEdge — NODES=${NODES}, one edge per removal\n`);
  console.log(`${'degree'.padStart(7)}${'ns per removeEdge'.padStart(20)}`);

  // Sweep the DEGREE of the vertex being removed from, because that is the axis the array design
  // is sensitive to and the Set design is not.
  for (const deg of [4, 64, 1024]) {
    const reps = [];

    for (let r = 0; r < REPS; r += 1) {
      // A fresh graph per rep: removal is destructive, so reusing one would measure a shrinking
      // graph and the later reps would be a different question.
      const g = new Graph();
      const hub = g.addVertex({ id: 'hub', labels: ['P'] });
      const count = Math.min(deg, NODES);

      for (let i = 0; i < count; i += 1) {
        g.addVertex({ id: `v${i}`, labels: ['P'] });
      }

      const edges = [];

      for (let i = 0; i < count; i += 1) {
        edges.push(
          g.addEdge({ id: `e${i}`, labels: ['E'], from: hub, to: g.getVertexById(`v${i}`) }),
        );
      }

      const t0 = performance.now();

      // ⚠️ `removeEdge` takes the EDGE, not its id — passing a string reads `edge.labels.size` off
      // `undefined` and throws inside the engine rather than at the call. Resolve first, OUTSIDE
      // the timed region, so the timing is the removal and not `getEdgeById`.
      for (const e of edges) {
        g.removeEdge(e);
      }

      reps.push(performance.now() - t0);

      if (g.edgeCount !== 0) {
        throw new Error(`removeEdge left ${g.edgeCount} edges at degree ${deg}.`);
      }
    }

    const ns = (med(reps.slice(DROP)) * 1e6) / Math.min(deg, NODES);

    console.log(`${String(deg).padStart(7)}${ns.toFixed(1).padStart(20)}`);
  }

  console.log();
}
