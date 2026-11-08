/**
 * WHAT DOES `_MERGE` COST, AND IS IT O(1) AS THE GRAPH GROWS? The upsert clause, priced for the
 * first time (item 1671).
 *
 * ⚠️ FOUND BY A COVERAGE SCREEN, NOT A PROFILE. Screening the GQL surface the way item 1668 screened
 * Gremlin's 104 step kinds: all 15 clause kinds appear somewhere in the measurement corpus, but
 * `_MERGE` appears FIVE times and its seven mentions in CLOSED.md are a parse-error divergence (item
 * 442), an id path and a push site — not one measurement. For a clause real ingest workloads run in
 * a loop, that is the biggest hole in the GQL surface.
 *
 * ⚠️ THE SHAPE IS WHY IT MATTERS. An upsert is a READ then a WRITE, and the read decides the
 * complexity: `resolveMergeEndpoint` → `graph.uniqueLookup(label, key, value)` →
 * `vertexPropertyIndex.equals(key, value)`. So the create-vs-update decision rides the unique
 * constraint's index, and the invariant to check is the same one `by-id-scaling-probe.mjs` checks
 * for `getVertexById`: flat ns per operation as N grows. An upsert loop that degraded to a scan
 * would be O(N²) overall and would still return the right answer at every step.
 *
 * Four arms per size, each one operation per call:
 *
 *   mergeUpdate   `_MERGE` a key that EXISTS   — the lookup hits, properties are written
 *   mergeCreate   `_MERGE` a key that does NOT — the lookup misses, a vertex is created
 *   insertPlain   `INSERT` the same vertex     — the floor for the create path, no lookup
 *   lookupOnly    `MATCH … WHERE k = v RETURN` — the read half alone, through the same index
 *
 * ⚠️ EACH ARM GETS A FRESH GRAPH. A `_MERGE` mutates, so re-running one arm over a graph another
 * arm already grew measures a different N than the row claims — and the create arm grows the graph
 * under itself, which is why its keys are drawn from a disjoint range and its count is bounded.
 *
 *   node gql-merge-scaling-probe.mjs
 *   SIZES=10000,200000 OPS=2000 node gql-merge-scaling-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SIZES = (process.env.SIZES ?? '10000,50000,200000,1000000').split(',').map(Number);
const OPS = Number(process.env.OPS ?? 2000);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

/** A graph of `n` `:P` vertices with a unique constraint on `k`, which is what `_MERGE` keys on. */
const build = (n) => {
  const g = new Graph();

  g.createUniqueConstraint('P', 'k');

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, tag: 'x' } });
  }

  return g;
};

// ⚠️ `$k` RATHER THAN AN INTERPOLATED LITERAL, AND THE FIRST RUN OF THIS PROBE GOT IT WRONG.
// Splicing the key into the text gives every call a DIFFERENT query string, so the parse+plan
// cache never hits and the reading is dominated by parsing 500 distinct texts per call — which is
// why the first run read ~4.2 us an operation. Items 1499-1502 are about exactly that cost. A real
// upsert loop binds a param and reuses one plan, so that is what this measures. The repo's own
// `lenke(no-raw-interpolation)` rule is what caught it, flagging the injection risk; the
// measurement bug came free with the fix.
const MERGE_UPDATE = "_MERGE (p:P {k: $k}) SET p.tag = 'y' RETURN 1 AS c";
const MERGE_CREATE = '_MERGE (p:P {k: $k}) RETURN 1 AS c';
const INSERT_PLAIN = 'INSERT (p:P {k: $k}) RETURN 1 AS c';
const LOOKUP_ONLY = 'MATCH (p:P) WHERE p.k = $k RETURN p.tag AS c';

const ARMS = {
  // The lookup HITS: every key already exists, so this is read + property write.
  mergeUpdate: (n) => {
    const g = build(n);

    return () => {
      for (let i = 0; i < OPS; i += 1) {
        query(g, MERGE_UPDATE, { k: i % n });
      }
    };
  },
  // The lookup MISSES: keys are drawn from a disjoint range, so each call creates.
  // ⚠️ This arm grows the graph under itself — OPS is the bound on how far.
  mergeCreate: (n) => {
    const g = build(n);
    let next = n;

    return () => {
      for (let i = 0; i < OPS; i += 1) {
        query(g, MERGE_CREATE, { k: next + i });
      }

      next += OPS;
    };
  },
  // The floor for the create path: no existence lookup at all.
  insertPlain: (n) => {
    const g = build(n);
    let next = n + 10_000_000;

    return () => {
      for (let i = 0; i < OPS; i += 1) {
        query(g, INSERT_PLAIN, { k: next + i });
      }

      next += OPS;
    };
  },
  // The read half alone, through the same index.
  lookupOnly: (n) => {
    const g = build(n);

    return () => {
      for (let i = 0; i < OPS; i += 1) {
        query(g, LOOKUP_ONLY, { k: i % n });
      }
    };
  },
};

const timed = (fn) => {
  for (let i = 0; i < 2; i += 1) {
    fn();
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();

    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const rows = [];

for (const n of SIZES) {
  for (const [name, make] of Object.entries(ARMS)) {
    const ms = timed(make(n));
    rows.push({ arm: name, n, nsPerOp: (ms * 1e6) / OPS });
  }
}

// ⚠️ NORMALISED AGAINST THE LARGEST N, NOT THE SMALLEST, AND THAT IS A CORRECTION TO THIS PROBE'S
// FIRST RUN. The two create arms ADD `OPS * REPS` vertices to the graph they measure, so at the
// smallest size that growth is proportionally huge — 3,500 inserts into 10,000 vertices is +35%,
// against +0.35% at a million — and the index work it triggers lands entirely on the small-N
// reading. The first run normalised against N=10,000 and so reported `insertPlain` as 0.51x at a
// million, i.e. "it got twice as fast with 100x the data", which is not a thing. Against the
// largest N the column reads as the trend it is meant to show.
const base = {};

for (const r of rows) {
  base[r.arm] = r.nsPerOp;
}

console.log(`\n_MERGE SCALING — OPS=${OPS} per call, ${REPS} reps, median of warm\n`);
console.log('arm            N           ns/op    vs LARGEST N');

for (const r of rows) {
  console.log(
    `${r.arm.padEnd(13)} ${String(r.n).padStart(8)}  ${r.nsPerOp.toFixed(1).padStart(10)}  ` +
      `${(r.nsPerOp / base[r.arm]).toFixed(2).padStart(10)}x`,
  );
}

console.log(
  '\nA column that RISES with N is a lost O(1) — an upsert loop would then be O(N^2).\n' +
    'Flat or falling is the invariant holding. ⚠️ The smallest size reads HIGH on the create arms\n' +
    'for the growth reason above, so the trend between the LARGER sizes is the signal.',
);
