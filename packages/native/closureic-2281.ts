/**
 * ⚠️⚠️ **DID MY OWN PROBE CREATE THE `getVertexById` GAP? (item 2281)** The growth sweep showed
 * `getVertexById` at 4.5x the SAME map accessed directly, growing with N while the map stayed flat — but the
 * function is one line, `this.verticesById.get(id) ?? null`, which cannot cost 237 ns.
 *
 * 🔑 **THE MECHANISM I SUSPECT IS MINE, NOT THE ENGINE'S.** `getVertexById` is a per-instance ARROW FIELD,
 * so every `new Graph()` mints a NEW function object. My sweep built one graph per rep, so a single call
 * site saw 9 different callees — **megamorphic**, which defeats inlining. A real application holds ONE
 * graph and that site stays monomorphic.
 *
 * ✅ So this probe asks the question three ways at ONE size, with one shape per measurement:
 *
 *   oneGraph    one Graph, one callee at the site    — what an application actually sees
 *   manyGraphs  9 Graphs round-robin at the site     — what my sweep accidentally measured
 *   direct      the same map, `.get` inline          — the floor
 *
 * ⚠️ If `oneGraph` matches `direct`, the gap was my instrument and there is nothing to fix. If `oneGraph`
 * is still far above, the arrow field is a real per-call cost and a prototype method would fix it.
 */
import { Graph } from '@lenke/core';

const N = 160_000;
const PROBE = 50_000;
const REPS = 11;

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const lcg = (seed: number) => {
  let s = seed | 0;

  return (): number => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

    return (s >>> 1) % 1_000_000_007;
  };
};

const idOf = (i: number): string => `v${String(i).padStart(7, '0')}`;

const mkGraph = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: idOf(i), labels: ['T'], properties: { k: i % 977 } });
  }

  return g;
};

const graphs = [mkGraph()];

for (let i = 0; i < 8; i += 1) {
  graphs.push(mkGraph());
}

const rnd = lcg(0xbeef);
const keys: string[] = [];

for (let i = 0; i < PROBE; i += 1) {
  keys.push(idOf(rnd() % N));
}

const [one] = graphs;
const store = one.verticesById;

const oneNs: number[] = [];
const manyNs: number[] = [];
const directNs: number[] = [];
let sink = 0;

for (let rep = 0; rep < REPS; rep += 1) {
  let t = performance.now();

  for (const k of keys) {
    if (one.getVertexById(k) !== null) {
      sink += 1;
    }
  }

  oneNs.push(((performance.now() - t) * 1e6) / PROBE);

  t = performance.now();

  for (let i = 0; i < keys.length; i += 1) {
    /* Round-robin the CALLEE, which is what one-graph-per-rep did by accident. */
    if (graphs[i % graphs.length]?.getVertexById(keys[i]) !== null) {
      sink += 1;
    }
  }

  manyNs.push(((performance.now() - t) * 1e6) / PROBE);

  t = performance.now();

  for (const k of keys) {
    if (store.get(k) !== undefined) {
      sink += 1;
    }
  }

  directNs.push(((performance.now() - t) * 1e6) / PROBE);
}

if (sink !== PROBE * REPS * 3) {
  throw new Error(`guard: sink=${sink} expected ${PROBE * REPS * 3}`);
}

const o = med(oneNs);
const m = med(manyNs);
const d = med(directNs);

console.log(`  N=${N}, ${PROBE} lookups, median of ${REPS} (ns/op)`);
console.log(
  `    oneGraph    getVertexById, ONE callee     ${o.toFixed(1).padStart(7)}   ${(o / d).toFixed(2)}x floor`,
);
console.log(
  `    manyGraphs  getVertexById, 9 callees      ${m.toFixed(1).padStart(7)}   ${(m / d).toFixed(2)}x floor`,
);
console.log(`    direct      same map, .get inline         ${d.toFixed(1).padStart(7)}   floor`);
console.log(`    per-rep oneGraph:   ${oneNs.map((x) => x.toFixed(0)).join(' ')}`);
console.log(`    per-rep manyGraphs: ${manyNs.map((x) => x.toFixed(0)).join(' ')}`);
console.log(`    per-rep direct:     ${directNs.map((x) => x.toFixed(0)).join(' ')}`);
