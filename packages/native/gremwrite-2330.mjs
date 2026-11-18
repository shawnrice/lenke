/**
 * ✅✅ **THE GREMLIN WRITE PATH, WHICH NOTHING THIS SESSION HAS MEASURED (item 2330).**
 *
 * Items 2319-2323 shipped five Gremlin wins, all on the READ side (`values` drains and a rung gate). 🔑
 * `addV` / `property` / `addE` have had no coverage at all, and the serving bench has no Gremlin write row
 * either — its `gremlin(built)` rows are all reads.
 *
 * ⚠️ **THE COMPARISON IS AGAINST GQL's `INSERT`, WITH THE WORK MATCHED** — item 2328's correction, where a
 * "control" doing different work read 50x slower than its arm. Both arms create one vertex with the same
 * label and the same three properties, and both are driven from a hoisted plan where the language allows
 * it.
 *
 * ⚠️ **A FRESH GRAPH PER TIMED BLOCK.** Both arms GROW the graph, so reusing one would make later
 * repetitions insert into a larger graph than earlier ones and confound the arm with |V|.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { addV, property, toArray, traversal } from '@lenke/gremlin';

const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'gremAddV';

/*
 * ✅ HOISTED, because item 2325 priced not hoisting a Gremlin traversal at 3.96x and the guide prescribes
 * it. A per-call rebuild would measure plan construction rather than the write.
 */
const addPlan = traversal(
  addV('Event'),
  property('name', 'ev'),
  property('score', 7),
  property('seq', 1),
);

const ARMS = {
  /* ⚠️ THE SUBJECT: a Gremlin vertex insert with three properties. */
  gremAddV: (g) => {
    toArray(addPlan, g);
  },
  /* ✅ THE MATCHED GQL TWIN: same label, same three properties, values bound. */
  gqlInsert: (g) => {
    query(g, 'INSERT (:Event {name: $n, score: $s, seq: $q})', { n: 'ev', s: 7, q: 1 });
  },
  /* ✅ THE HOST FLOOR: what the same write costs with no query language at all. */
  hostAdd: (g, i) => {
    g.addVertex({ id: `h${i}`, labels: ['Event'], properties: { name: 'ev', score: 7, seq: 1 } });
  },
};

const arm = ARMS[ARM];
let seq = 0;

const block = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    arm(g, seq++);
  }
};

block(400);

let inner = 64;

for (;;) {
  const t0 = performance.now();

  block(inner);

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 200_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  block(inner);

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `  ARM=${ARM.padEnd(10)} ${(med * 1_000_000).toFixed(0).padStart(6)} ns/write  ops/s=${Math.round(
    1000 / med,
  )
    .toLocaleString()
    .padStart(11)}`,
);
