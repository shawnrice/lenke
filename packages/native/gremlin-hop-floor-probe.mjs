/**
 * THE FLOOR for a Gremlin single-type hop: what does the generator pipeline cost over a
 * hand-written loop producing the same array? (item 1411)
 *
 * WHY THIS PROBE EXISTS. A windowed profile of `V().out('E')` at 100k puts **86.2%** in one frame —
 * `values @ index.mjs:4083`, which is the single-type hop's `*[Symbol.iterator]()` generator body.
 * `V().hasLabel('P').out('E').values('k')` puts 59.0% there with `pick` at 23.8%. A share that large
 * on one frame reads like a target.
 *
 * ⚠️ BUT A SHARE IS A NOMINATION AND A FLOOR IS THE PRICE, and on this exact surface that
 * distinction has already retracted work: item 234 built floors for three Gremlin shapes and **two
 * of the three targets did not survive** — the big ratio was data layout, not step overhead. So the
 * floor is measured BEFORE anything is built, not after.
 *
 * WHAT THE FLOOR IS. The same traversal written as a plain nested `for` loop over the same
 * adjacency, pushing into an array. That is not a legal replacement — the generator is what makes
 * `out('E').limit(10)` stop after ten edges, and `eager-tail-cache` records a 473x and a 3680x from
 * filling eagerly under a LIMIT — so the floor is a BOUND on what any lazy restructuring could win,
 * never a candidate implementation.
 *
 * THREE ARMS, so the gap can be attributed rather than just observed:
 *
 *   engine    the real traversal through `toArray`
 *   floor     hand-written nested loop, array push
 *   genfloor  hand-written GENERATOR with the identical body, drained into an array
 *
 * `genfloor` is the one that matters. engine-vs-floor mixes the generator protocol with everything
 * else the pipeline does; **genfloor-vs-floor isolates the protocol alone**, and engine-vs-genfloor
 * is then what the pipeline costs ON TOP of a generator. If genfloor ≈ floor, the protocol is free
 * and the 86.2% is self-time misattribution (item 1104's shape — a small hot callee credited with
 * its caller's inlined loop), which would make this a decline with a number.
 *
 *   NODES=100000 REPS=14 FANOUT=1 node gremlin-hop-floor-probe.mjs
 */
import { Graph } from '@lenke/core';
import { out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 100_000);
const FANOUT = Number(process.env.FANOUT ?? 1);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const SHAPE = process.env.SHAPE ?? 'bare';

/** Byte-identical to `isolated-gremlin-bench.mjs`'s fixture at FANIN=1, MULTILABEL=0, VLABEL=0. */
const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: { k: i % 97, s: `s${i % 1000}`, n: i },
      }),
    );
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % NODES],
      to: vs[(k * 104_729) % NODES],
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();

// `bare` yields the far VERTEX; `vals` yields `far.properties.k`, which is where `pick` appears.
const wantsValue = SHAPE === 'vals';
const plan = wantsValue ? traversal(V(), out('E'), values('k')) : traversal(V(), out('E'));

const engine = () => toArray(plan, g);

/** The floor: the identical walk, no generator, no pipeline. */
const floor = () => {
  const acc = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      acc.push(wantsValue ? edge.to.properties['k'] : edge.to);
    }
  }

  return acc;
};

/** The SAME body as a generator, drained — isolating the protocol from everything else. */
const genBody = {
  *[Symbol.iterator]() {
    for (const v of g.vertices) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        yield wantsValue ? edge.to.properties['k'] : edge.to;
      }
    }
  },
};

const genfloor = () => [...genBody];

const ARMS = { engine, floor, genfloor };

const time = (fn) => {
  const series = [];
  let sink = 0;
  let len = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = fn();

    series.push(performance.now() - t0);
    len = rows.length;
    sink += len;
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { p25: kept[Math.floor(kept.length * 0.25)], len, sink, series };
};

// ALTERNATE the arm order across rounds, so a warming JIT or a drifting machine cannot favour
// whichever arm ran first. Three rounds, median across them.
const names = Object.keys(ARMS);
const got = {};

for (let round = 0; round < 3; round += 1) {
  const order = round % 2 === 0 ? names : [...names].reverse();

  for (const n of order) {
    const r = time(ARMS[n]);

    (got[n] ??= []).push(r);
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
};

// ⚠️ THE ARMS MUST AGREE ON THE ROW COUNT, or the floor is measuring a different question. Row
// ORDER is not compared: all three walk the same adjacency in the same order, but the engine is
// free to reorder and the probe must not pretend otherwise.
const lens = new Set(names.map((n) => got[n][0].len));

if (lens.size !== 1) {
  throw new Error(`arms disagree on row count: ${[...lens].join(' vs ')}`);
}

const rows = got['floor'][0].len;

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    fanout: FANOUT,
    rows,
    reps: REPS,
    arms: Object.fromEntries(
      names.map((n) => [n, Number(med(got[n].map((r) => r.p25)).toFixed(2))]),
    ),
  }),
);

const f = med(got['floor'].map((r) => r.p25));
const gf = med(got['genfloor'].map((r) => r.p25));
const e = med(got['engine'].map((r) => r.p25));

console.log(`\n  rows ${rows}`);
console.log(`  floor     ${f.toFixed(2)} ms   ${((f * 1e6) / rows).toFixed(0)} ns/row`);
console.log(
  `  genfloor  ${gf.toFixed(2)} ms   ${((gf * 1e6) / rows).toFixed(0)} ns/row   ` +
    `${(gf / f).toFixed(2)}x floor  <- the generator PROTOCOL alone`,
);
console.log(
  `  engine    ${e.toFixed(2)} ms   ${((e * 1e6) / rows).toFixed(0)} ns/row   ` +
    `${(e / f).toFixed(2)}x floor, ${(e / gf).toFixed(2)}x genfloor  <- the pipeline on top`,
);
