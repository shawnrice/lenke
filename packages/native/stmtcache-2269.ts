/**
 * ⚠️⚠️⚠️ **A SESSION WHOSE QUERY TEXT KEEPS CHANGING (item 2269).** Every screen row and bench row in this
 * repo runs ONE statement repeatedly, so the parse/plan caches are always WARM. A real application issues
 * many different statements. Item 2268's prior-art check found `parseCache` (34 mentions), `plan cache`
 * (38) and `LRU` (14) all worked — but **"cache eviction" and "distinct queries" appear ZERO times.**
 *
 * 🔑 **THE FIXTURE IS DELIBERATELY TINY.** To measure parse/plan behaviour, EXECUTION must be cheap —
 * otherwise the per-statement cost is swamped by the walk and the arms become indistinguishable. 200
 * vertices, no edges.
 *
 * **THREE ARMS, EACH DOING IDENTICAL WORK, DIFFERING ONLY IN TEXT:**
 *
 *     same      the SAME text every time                  — the warm case every screen measures
 *     literal   `WHERE n.k >= <i>` varies the LITERAL      — auto-param SHOULD make these share a plan
 *     alias     `RETURN n.k AS a<i>` varies the ALIAS      — cannot share; defeats the cache by design
 *
 * ⚠️ `literal` is the interesting arm. [[gql-perf-fastpaths]] records that auto-param lifts literals, so
 * `n.k >= 5` and `n.k >= 6` ought to reach ONE cache entry. **If `literal` costs what `alias` costs, the
 * cache is being defeated by ordinary literal variation** — which is what an application does constantly.
 *
 * ⚠️ Every arm's predicate matches ALL rows (`k >= -i` with k >= 0), so selectivity is constant and the
 * arms cannot differ in execution. The row count is asserted for exactly that reason.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200);
const STMTS = Number(process.env.STMTS ?? 2000);
const REPS = Number(process.env.REPS ?? 7);
const ARM = process.env.ARM ?? 'same';
/*
 * ⚠️⚠️ **DISTINCT IS THE KNOB THAT MATTERS, AND THE FIRST VERSION FIXED IT AT 500 — A FLAW.** With 500
 * texts over 7 reps each text is seen ~28 times, so the later reps may run a WARM cache rather than misses.
 * Item 2045 measured cache-MISSING statements and found the cost declines 198x with warm-up, concluding
 * parse/plan is not a target. 🔑 So the real question is the cache's CAPACITY: sweep the number of distinct
 * texts and a jump locates it. Below capacity the arms should converge on `same`; above it they thrash.
 */
const DISTINCT = Number(process.env.DISTINCT ?? 500);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97 } });
}

const textFor = (i: number): string => {
  if (ARM === 'literal') {
    /* The literal varies; the predicate still matches every row, so the WORK is identical. */
    return `MATCH (n:T) WHERE n.k >= ${-1 - (i % DISTINCT)} RETURN n.k AS a`;
  }

  if (ARM === 'alias') {
    return `MATCH (n:T) WHERE n.k >= -1 RETURN n.k AS a${i % DISTINCT}`;
  }

  return 'MATCH (n:T) WHERE n.k >= -1 RETURN n.k AS a';
};

/* Pre-build the texts so the timed loop measures the engine, not string construction (item 1969's lesson). */
const TEXTS = Array.from({ length: STMTS }, (_, i) => textFor(i));

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const series: number[] = [];

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  let rows = 0;

  for (let i = 0; i < STMTS; i += 1) {
    rows += query(g, TEXTS[i], {}).length;
  }

  series.push(performance.now() - t);

  /* ⚠️ Every arm must return N rows per statement, or the arms are not doing the same work. */
  if (rows !== STMTS * N) {
    throw new Error(`${ARM}: ${rows} rows, expected ${STMTS * N} — the arms differ in WORK`);
  }
}

const m = med(series.slice(2));

console.log(
  `  ARM=${ARM.padEnd(8)} ${STMTS} statements  ${m.toFixed(1).padStart(8)} ms   ${((m * 1e6) / STMTS).toFixed(0).padStart(7)} ns/statement   distinct texts=${new Set(TEXTS).size}`,
);
