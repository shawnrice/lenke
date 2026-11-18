/**
 * ⚠️⚠️⚠️ **WHAT DOES A WRITE DO TO THE TS ENGINE'S PER-ELEMENT CACHES? (item 2245)**
 *
 * Item 2239 established that `#box` (properties), `#toV` (an edge's resolved endpoint) and `#adjTo` /
 * `#adjFrom` (a vertex's adjacency map) are **load-bearing** — replacing them with direct store lookups was
 * 1.7x WORSE. Each is a `??=` memo on the ELEMENT, filled on first read.
 *
 * 🔑 That raises two questions nothing in the corpus asks, and `CLAUDE.md` records the native engine
 * failing the second one badly (one `add_edge` clears `csr_fresh` with nothing to re-arm it, so EVERY later
 * read is demoted for the rest of the session — up to 24.07x):
 *
 * 1. **CORRECTNESS.** After `addEdge`, does a traversal SEE the new edge? A stale `#adjFrom` memo would
 *    silently return the OLD adjacency — a wrong answer no count-only probe could catch.
 * 2. **PERFORMANCE.** Does one write demote later reads, and if so does the next read RE-ARM the memo or
 *    does the demotion persist?
 *
 * ⚠️ The third possibility matters most and is the one to look for: a memo that is neither invalidated
 * (wrong answers) nor re-armed (permanent demotion). Both would be invisible to every existing instrument.
 */
import { Graph } from '@lenke/core';
import { V, count, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const REPS = Number(process.env.REPS ?? 9);

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) => `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 97}}}`,
  );
  let id = 0;

  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < N; i += 1) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["E"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

const g = deserialize(doc, 'ndjson', new Graph());

/*
 * ⚠️⚠️ **THE SHAPE MUST ACTUALLY WALK ADJACENCY, AND THE FIRST ATTEMPT DID NOT.** `out('E').count()` is the
 * DEGREE-SUM CLOSED FORM — it reads per-type degree totals and never touches `#adjTo`/`#adjFrom`, so it
 * timed at 0.0 ms and could say nothing about memo invalidation. (Its answer was still correct after the
 * write, which does tell us the degree totals are maintained.) `values` after a hop has to enumerate the
 * edges, so it is the shape that exercises the memo.
 */
const WALKS = process.env.SHAPE !== 'count';
const plan = WALKS
  ? traversal(V(), hasLabel('User'), out('E'), values('team'))
  : traversal(V(), hasLabel('User'), out('E'), count());

/** The WALKING shape yields one row per edge, so its ROW COUNT is the quantity a new edge must change. */
const hop = (): number => {
  const rows = toArray(plan, g);

  return WALKS ? rows.length : Number(rows[0]);
};

/** One timed execution. */
const once = (): { ms: number; n: number } => {
  const t = performance.now();
  const n = hop();

  return { ms: performance.now() - t, n };
};

console.log(`  N=${N} vertices, ${N * 4} edges\n`);

/* WARM: let every memo fill and the JIT settle. */
const warm: number[] = [];
let baseline = 0;

for (let r = 0; r < REPS; r += 1) {
  const { ms, n } = once();

  warm.push(ms);
  baseline = n;
}

console.log(`  warm count      = ${baseline}`);
console.log(`  warm series     = ${warm.map((x) => x.toFixed(1)).join(' ')}`);

/*
 * 🔑 ONE WRITE — a single new edge from a vertex that already has four. A traversal run immediately after
 * MUST include it: the expected count is exactly baseline + 1.
 */
const from = g.getVertexById('v7');
const to = g.getVertexById('v11');

if (from === null || to === null) {
  throw new Error('fixture vertices missing');
}

g.addEdge({ id: 'probe-edge', from, to, labels: ['E'], properties: {} });

const after: Array<{ ms: number; n: number }> = [];

for (let r = 0; r < REPS; r += 1) {
  after.push(once());
}

const counts = [...new Set(after.map((a) => a.n))];

console.log(`  after-write     = ${counts.join(',')}   expected ${baseline + 1}`);
console.log(
  `  CORRECTNESS     : ${counts.length === 1 && counts[0] === baseline + 1 ? 'OK — the write is visible' : '*** WRONG ANSWER — a stale memo ***'}`,
);
console.log(`  after series    = ${after.map((a) => a.ms.toFixed(1)).join(' ')}`);

/* Median of the settled reps on each side — the per-rep series is printed above so a STEP is visible. */
const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const before = med(warm.slice(3));
const afterMed = med(after.map((a) => a.ms).slice(3));

console.log(
  `\n  median before ${before.toFixed(2)} ms   after ${afterMed.toFixed(2)} ms   ${(afterMed / before).toFixed(2)}x`,
);
console.log(
  `  PERFORMANCE     : ${afterMed / before > 1.3 ? '*** DEMOTED — and check whether later reps recover ***' : 'no demotion beyond noise'}`,
);
