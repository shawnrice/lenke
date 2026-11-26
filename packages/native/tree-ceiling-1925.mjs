// Item 1925 — WHAT IS THE CEILING for fusing `V().out(T).tree()`?
//
// Item 1922 took `tree()`'s canonical key with a memo (1.85x) and left it at **542.94 ms for ONE
// ROW**, still the largest shape on the Gremlin surface. The profile splits it:
//
//     (anonymous) projection.ts:2293   27.0%   the `t.path.forEach` CALLBACK (2 calls a row)
//     memoizedTreeKey                  24.5%   the memo lookups + 200,000 distinct serializations
//     generatorResume                  15.8%   the traverser pipeline
//     stringify                         6.5%
//     iterLabeled                       5.6%   the adjacency generator chain
//     sort                              2.8%   toJSON() sorting property keys
//
// ONE GUESS ALREADY REFUTED: replacing the `forEach` with an indexed loop — removing a per-ROW
// closure and 1,200,000 callback invocations — measured 535-538 against 546, ~2% and inside the
// spread. V8 inlines the callback, so that 27% is the WORK inside it, not the dispatch.
//
// SO THE QUESTION IS WHAT A WHOLE-PLAN CLAIM WOULD RECOVER. It removes `generatorResume` and
// `iterLabeled` (the traverser pipeline and the adjacency chain, ~21% together) and the per-row path
// array — but NOT the key (contractual, item 1922) and NOT the nested insert. This measures that
// directly instead of subtracting percentages.
//
// THE HAND ARM USES THE **CSR** WALK, WHICH IS ITEM 1920'S MISTAKE NOT REPEATED. That item
// priced its fusion against a hand walk over the adjacency `Set`s — the BUCKET arm — while the
// engine takes the CSR arm on the second ask, so its "ceiling" was 3x BELOW what the engine
// achieved. A ceiling measured on the slower arm is a floor for the faster one.
//
//     bun tree-ceiling-1925.mjs
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8, k: i % 50 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

/**
 * THE CSR THE ENGINE WOULD WALK, built here the way `chainCsrFor` does: a dense neighbour-slot
 * array with per-vertex offsets. Built ONCE outside the timed loop, because the engine memoizes it
 * per (graph, topology, shape) and amortizes it across calls (item 1889's second-ask policy).
 */
const verts = [];

for (let i = 0; i < N; i += 1) {
  verts.push(g.getVertexById(String(i + 1)));
}

const slotOf = new Map(verts.map((v, i) => [v, i]));
const off = new Int32Array(N + 1);
const degs = new Int32Array(N);

for (let i = 0; i < N; i += 1) {
  degs[i] = verts[i].adjFrom?.get('E')?.size ?? 0;
}

for (let i = 0; i < N; i += 1) {
  off[i + 1] = off[i] + degs[i];
}

const flat = new Int32Array(off[N]);
let w = 0;

for (let i = 0; i < N; i += 1) {
  const bucket = verts[i].adjFrom?.get('E');

  if (bucket !== undefined) {
    for (const e of bucket) {
      flat[w] = slotOf.get(e.to) ?? 0;
      w += 1;
    }
  }
}

console.log(`CSR: ${N} slots, ${off[N]} edges`);

/** The engine's own key function, so the arms differ in the WALK and not in the contract. */
const treeKey = (v) => JSON.stringify(v.toJSON());

const ARMS = {
  // THE WALK FLOOR: the CSR traversal with no tree and no keys.
  walk: () => {
    let n = 0;

    for (let slot = 0; slot < N; slot += 1) {
      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        n += flat[i] >= 0 ? 1 : 0;
      }
    }

    return n;
  },
  // + the canonical key, MEMOIZED exactly as item 1922 does. This is the contractual floor.
  keys: () => {
    const memo = new Map();
    let n = 0;

    for (let slot = 0; slot < N; slot += 1) {
      const from = verts[slot];
      let fk = memo.get(from);

      if (fk === undefined) {
        fk = treeKey(from);
        memo.set(from, fk);
      }

      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        const far = verts[flat[i]];
        let tk = memo.get(far);

        if (tk === undefined) {
          tk = treeKey(far);
          memo.set(far, tk);
        }

        n += fk.length > 0 && tk.length > 0 ? 1 : 0;
      }
    }

    return n;
  },
  // THE CEILING: the whole tree built in one loop — the most a fused `tree()` could achieve.
  tree: () => {
    const memo = new Map();
    const root = Object.create(null);

    for (let slot = 0; slot < N; slot += 1) {
      const from = verts[slot];

      if (off[slot] === off[slot + 1]) {
        continue;
      }

      let fk = memo.get(from);

      if (fk === undefined) {
        fk = treeKey(from);
        memo.set(from, fk);
      }

      let level = root[fk];

      if (level === undefined) {
        level = Object.create(null);
        root[fk] = level;
      }

      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        const far = verts[flat[i]];
        let tk = memo.get(far);

        if (tk === undefined) {
          tk = treeKey(far);
          memo.set(far, tk);
        }

        if (level[tk] === undefined) {
          level[tk] = Object.create(null);
        }
      }
    }

    return Object.keys(root).length;
  },
};

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
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
  results[name] = ser[ser.length >> 1];
  console.log(`${name.padEnd(6)} median ${results[name].toFixed(2)} ms   result ${got}`);
}

const ENGINE = 542.94;

console.log(
  `\nthe CONTRACTUAL key floor is ${(results.keys - results.walk).toFixed(2)} ms ` +
    `(keys ${results.keys.toFixed(2)} - walk ${results.walk.toFixed(2)})`,
);
console.log(`the nested INSERT adds ${(results.tree - results.keys).toFixed(2)} ms on top of that`);
console.log(
  'CEILING, NOT A PREDICTION — a real rung also pays its gate and its walk wrapper.\n' +
    `   Against the engine's ${ENGINE} ms, the hand tree is ${(ENGINE / results.tree).toFixed(2)}x, so at most ` +
    `${(ENGINE - results.tree).toFixed(2)} ms is available.`,
);
