/**
 * Does re-arming the CSR after N stale reads pay, and where is the crossover? (item 1122)
 *
 * Item 851 excluded a LAZY rebuild (the read accessors take `&self` and return borrows into the
 * arrays a rebuild replaces). Item 852 refused an UNCONDITIONAL rebuild-at-commit hook because "the
 * policy it would need depends on a future read count the store does not have". Item 1121 then
 * measured the break-even at **1.97-2.23 reads** across a 10x fixture range — and the store CAN
 * know the PAST read count, which is the standard proxy for the future one.
 *
 * So `Store::rearm_if_warranted` rebuilds at the QUERY BOUNDARY once two reads have been served on
 * a stale overlay, and this measures the shape that decides whether that is right: ONE write
 * followed by k reads, swept over k.
 *
 *   PRE  (no re-arm): k x stale
 *   POST (re-arm):    one stale read, then the rebuild, then k-1 fresh
 *
 * A k of 1 must not regress — that is the write-heavy workload, and the threshold of 2 is what
 * protects it. The crossover should land near k = 1 + rebuild/penalty.
 *
 *   cd packages/native && bun rearm-probe.ts
 *   REARM_N=400000 REARM_EDGES=400000 bun rearm-probe.ts
 */
import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson, type RustGraph } from './src/graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  win32: 'dll',
};
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const N = Number(process.env.REARM_N ?? 200_000);
const EDGES = Number(process.env.REARM_EDGES ?? 80_000);
const REPS = Number(process.env.REARM_REPS ?? 5);
// The shape item 1120 priced: an endpoint predicate, which no maintained count can answer, so the
// query needs the per-type adjacency and is the one that still pays for staleness.
const Q = 'MATCH (a)-[:F]->(b) WHERE b.age >= 77 RETURN count(*) AS c';

const ndjson = (): string => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"age":${i % 100}}}`);
  }

  // A deterministic LCG in integer math — `Math.imul`, not f64 multiplication, which item 702
  // records collapsing to an ~11k period.
  let s = 12_345;

  for (let e = 0; e < EDGES; e += 1) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    const a = s % N;

    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    const b = s % N;

    lines.push(
      `{"type":"edge","id":"f${e}","labels":["F"],"from":"v${a}","to":"v${b}","properties":{}}`,
    );
  }

  return lines.join('\n');
};

const backend = createFfiEngineBackend(LIB);
const text = ndjson();

/** One write, then `k` reads, timed together — the whole cycle is what a serving loop repeats. */
const cycle = (g: RustGraph, k: number): number => {
  const t = performance.now();

  g.query('INSERT (:P {age: 1})');

  for (let i = 0; i < k; i += 1) {
    g.query(Q);
  }

  return performance.now() - t;
};

console.log(`\n# ${N} nodes / ${EDGES} F edges, one write then k reads, min of ${REPS}\n`);
console.log('   k     cycle_ms    per_read_ms');

for (const k of [1, 2, 3, 5, 10, 20]) {
  let best = Infinity;

  for (let r = 0; r < REPS; r += 1) {
    using g = graphFromNdjson(backend, text);

    // Warm: the first query of a session pays plan/parse caches the rest do not.
    g.query(Q);

    const ms = cycle(g, k);

    if (ms < best) {
      best = ms;
    }
  }

  console.log(
    `  ${String(k).padStart(2)}   ${best.toFixed(1).padStart(9)}   ${(best / k).toFixed(2).padStart(11)}`,
  );
}
