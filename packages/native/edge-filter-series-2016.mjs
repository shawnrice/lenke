/**
 * Item 2016 — IS `edge-filter-floor-1882.mjs`'s "unfiltered floor" THE SAME WALK WITHOUT A
 * PREDICATE, OR A DIFFERENT DATA STRUCTURE?
 *
 * **THE QUESTION EXISTS BECAUSE TWO DERIVATIONS OF THE PREDICATE'S COST DISAGREED BY 4x.** At
 * 200,000/5 the floor probe reads `filtered` 98 ns and `unfiltered` 52 ns per edge visit, which it
 * presents as the predicate costing 1.88x. Solving the two arms as `tests·T + picks·P` gives
 * **T = 68 ns a test** — more than the pick, which chases a far vertex. The CPU profile of the
 * filtered shape says the opposite: the pick closure is **23.6% self** and the test closure
 * **8.6%**, i.e. a test around 18 ns. Both cannot be right, and the usual reason is that the two
 * arms are not the same walk.
 *
 * **THE HYPOTHESIS IS `seenBefore`.** `hopValuesCsr` (item 1889) serves the UNFILTERED shape over
 * a flat `Int32Array` CSR, but only from the SECOND ask on a topology version — item 1889's
 * second-ask policy, so a one-shot query never pays a build. `edge-filtered-hop-values.ts` has NO
 * CSR arm at all: it walks `Set`s of boxed edges on every ask, forever. If that is what is being
 * measured, then the floor probe's `unfiltered` arm is NOT this walk minus a predicate — it is a
 * different data structure, and the 1.88x is mostly route rather than predicate.
 *
 * MIN-OF-N CANNOT SEE THIS, WHICH IS WHY THIS FILE EXISTS. With REPS >= 2 the CSR is armed for
 * every rep but the first, so the minimum is always the armed one and the cold ask never shows.
 * [[ts-spelling-probe]] records the same lesson from the other side: print the per-rep series before
 * trusting any summary of it.
 *
 * ONE SHAPE PER PROCESS (item 762), because the three arms share a dispatch site otherwise and
 * the figure belongs to the mix.
 *
 *     for s in filtered unfiltered hop; do SHAPE=$s bun edge-filter-series-2016.mjs; done
 *     N=200000 SHAPE=unfiltered bun edge-filter-series-2016.mjs
 */
import { Graph } from '@lenke/core';
import { gt, has, inV, out, outE, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'filtered';

// `edge-filter-floor-1882.mjs`'s own domain, verbatim, so the numbers are comparable to it.
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50, s: `s${i % 7}` },
  });
}

let edges = 0;

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  // SPLIT ON THE REPEAT INDEX — CLAUDE.md's rule. `to = (a*k + b) % N` is invariant under
  // `k -> k + N`, so without `hop` in the expression one vertex's FANOUT edges all land on ONE
  // target and every degree statistic still reads correctly.
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: ['E'],
    properties: { w: W_POOL[e % W_POOL.length] },
  });
  edges += 1;
}

const SHAPES = {
  filtered: () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
  // `edge-filter-floor-1882.mjs` CALLS THIS THE FLOOR. The point of this file is whether it is.
  unfiltered: () => traversal(V(), outE('E'), inV(), values('n')),
  hop: () => traversal(V(), out('E'), values('n')),
  /*
   * THE HONEST CEILING FOR THE FILTERED WALK, and it is NOT the `unfiltered` arm above. It does
   * exactly what `edge-filtered-hop-values.ts`'s `drain` does, over the same `Set`s: per vertex one
   * bucket lookup, then per edge one edge-property read, the predicate inline, and the far vertex's
   * property. Same structure as the shipped walk, which is what makes it a floor (CLAUDE.md: a hand
   * ceiling is only a floor if it uses the structure the cure will use).
   */
  hand: 'HAND',
  /*
   * AND THE FLAT-ARRAY CEILING — what an EDGE-indexed CSR could add, which is the lever item
   * 1893's header priced at 62.23 against 34.69 and did not build. Built here per-process so the
   * build cost is NOT in the timed loop: the question is what the WALK would cost over a flat array,
   * not what arming it costs (the second-ask policy is the answer to that, as on the unfiltered
   * arm).
   */
  flat: 'FLAT',
  /*
   * **AND THE SAME ARRAY WALKED LINEARLY, WITH NO `off`/`len` AT ALL.** This shape never needs the
   * vertex — the predicate reads the EDGE's bag and the projection reads `edge.to` — so the per-vertex
   * loop exists only to find the next bucket. Appending the buckets in `graph.vertices` order makes a
   * linear pass over the edge array produce exactly the nested loop's sequence, which matters because
   * Gremlin rows are compared ORDERED. If this lands at `flat`, the structure the rung needs is a
   * plain `Edge[]`, not a CSR.
   */
  flatlinear: 'FLATLINEAR',
  /*
   * **THE ARM THAT SETTLES WHAT THE REMAINING GAP IS.** `flatlinear` INLINES the predicate and
   * the projection; the engine cannot — it compiles them to closures, because the key, the operator
   * and the projected key are plan data and [[no-runtime-codegen]] is FIRM (no `new Function`: it
   * forces `unsafe-eval` into every embedder's CSP). So this arm is `flatlinear` with exactly the
   * engine's TWO indirect calls per edge and nothing else changed. If it lands near the engine, the
   * residual is closure dispatch and is UNREACHABLE rather than pending; if it lands near
   * `flatlinear`, the residual is something else and is a target.
   */
  flatclosure: 'FLATCLOSURE',
  /*
   * **`flatclosure` BUT WITH A DYNAMIC PROPERTY KEY, which is the one thing left that the
   * engine does and the hand arms do not.** `valuePick`/`compileEdgeTests` close over `key` as a
   * STRING VARIABLE — `edge.properties[key]` — because the key is plan data. A literal
   * `edge.properties.w` gets an inline cache on a fixed object shape; a variable-keyed load takes
   * the generic path. If this arm lands near the engine, the residual is the KEYED LOAD, and that
   * is reachable (the key is known when the plan is compiled) without any codegen.
   */
  flatdynkey: 'FLATDYNKEY',
};

/** The engine's `drain`, by hand, over the same buckets. */
const handRows = () => {
  const out_ = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.properties.w > 3) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out_.push(value);
        }
      }
    }
  }

  return out_;
};

/*
 * An EDGE-indexed flat layout: `off`/`len` per vertex slot into `eflat`, which holds the edges of
 * type `E` in bucket order. Built ONCE, outside the timed loop, for the reason in `flat` above.
 */
const buildFlat = () => {
  const verts = [...g.vertices];
  const off = new Int32Array(verts.length);
  const len = new Int32Array(verts.length);
  const eflat = [];

  for (let s = 0; s < verts.length; s += 1) {
    off[s] = eflat.length;

    const bucket = verts[s].adjFrom?.get('E');

    if (bucket !== undefined) {
      for (const edge of bucket) {
        eflat.push(edge);
      }
    }

    len[s] = eflat.length - off[s];
  }

  return { verts, off, len, eflat };
};

/* eslint-disable typescript/prefer-for-of -- the indexed form IS what these arms measure */
const flatRows = (f) => {
  const { verts, off, len, eflat } = f;
  const out_ = [];

  for (let s = 0; s < verts.length; s += 1) {
    const from = off[s];
    const to = from + len[s];

    for (let i = from; i < to; i += 1) {
      const edge = eflat[i];

      if (edge.properties.w > 3) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out_.push(value);
        }
      }
    }
  }

  return out_;
};

/* The engine's two compiled closures, verbatim in shape: one edge test, one far-vertex pick. */
const EDGE_TEST = (edge) => edge.properties.w > 3;
const EDGE_PICK = (edge) => edge.to.properties.n;

const flatClosureRows = (f) => {
  const { eflat } = f;
  const out_ = [];

  for (let i = 0; i < eflat.length; i += 1) {
    const edge = eflat[i];

    if (!EDGE_TEST(edge)) {
      continue;
    }

    const value = EDGE_PICK(edge);

    if (value !== undefined) {
      out_.push(value);
    }
  }

  return out_;
};

/* The engine's closures EXACTLY: the key is a captured string variable, not a literal. */
const makeDynTest = (key) => (edge) => edge.properties[key] > 3;
const makeDynPick = (key) => (edge) => edge.to.properties[key];

const flatDynKeyRows = (f) => {
  const { eflat } = f;
  const test = makeDynTest('w');
  const pick = makeDynPick('n');
  const out_ = [];

  for (let i = 0; i < eflat.length; i += 1) {
    const edge = eflat[i];

    if (!test(edge)) {
      continue;
    }

    const value = pick(edge);

    if (value !== undefined) {
      out_.push(value);
    }
  }

  return out_;
};

const flatLinearRows = (f) => {
  const { eflat } = f;
  const out_ = [];

  for (let i = 0; i < eflat.length; i += 1) {
    const edge = eflat[i];

    if (edge.properties.w > 3) {
      const value = edge.to.properties.n;

      if (value !== undefined) {
        out_.push(value);
      }
    }
  }

  return out_;
};

const build = SHAPES[SHAPE];
const NEEDS_FLAT = new Set(['FLAT', 'FLATLINEAR', 'FLATCLOSURE', 'FLATDYNKEY']);
const flatTables = NEEDS_FLAT.has(build) ? buildFlat() : undefined;
const plan = typeof build === 'string' ? undefined : build();
const series = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  // A LOOKUP, NOT NESTED TERNARIES — a third hand arm would have nested again.
  const HANDS = {
    HAND: handRows,
    FLAT: () => flatRows(flatTables),
    FLATLINEAR: () => flatLinearRows(flatTables),
    FLATCLOSURE: () => flatClosureRows(flatTables),
    FLATDYNKEY: () => flatDynKeyRows(flatTables),
  };
  const got = plan === undefined ? HANDS[build]() : toArray(plan, g);

  series.push(performance.now() - t0);
  rows = got.length;
}

/* eslint-enable typescript/prefer-for-of */
const sorted = [...series].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const [first] = series;
const [best] = sorted;

console.log(
  `# N=${String(N)} FANOUT=${String(FANOUT)} |E|=${String(edges)} SHAPE=${SHAPE} rows=${String(rows)}`,
);
console.log(`series: ${series.map((x) => x.toFixed(2)).join(' ')}`);
console.log(
  `first ${first.toFixed(2)} ms   best ${best.toFixed(2)}   median ${med.toFixed(2)}` +
    `   first/best ${(first / best).toFixed(2)}x` +
    `   best = ${((best * 1e6) / edges).toFixed(0)} ns/edge-visit`,
);
/*
 * `first/best` IS THE WHOLE READING. A walk with a second-ask CSR shows a cold first rep and a
 * flat tail; a walk without one is flat from rep 0 (modulo JIT warm-up, which moves the first two
 * or three reps on EVERY arm and is why the series is printed rather than summarized).
 */
