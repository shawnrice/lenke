/**
 * Does the OPT-IN edge-type index actually cancel the post-write stale-CSR penalty? (item 1041)
 *
 * CLAUDE.md records the penalty at length and it is the largest documented cliff in the repo:
 * `rebuild_csr` runs only at LOAD, every adjacency write clears `csr_fresh` with nothing to re-arm
 * it, so ONE `add_edge` demotes EVERY later read for the rest of the session — and the size of it
 * is proportional to how SELECTIVE the queried edge type is (1.96x at 1 edge in 2, 2.93x at 1 in
 * 10, **24.07x at 1 in 50**).
 *
 * Reading the code for the consumer of `out_type_idx` turns up the other half of that story, which
 * the note does not mention: `exec.rs:4417` consults the opt-in edge-type index precisely WHEN THE
 * CSR OVERLAY IS STALE — "the CSR overlay is stale (an adjacency write since the last rebuild); the
 * incrementally-maintained index still answers." It is the only non-test consumer of
 * `out_typed`/`in_typed` in the engine.
 *
 * So the mitigation exists and is opt-in. This probe asks whether it works, as a 2x2:
 *
 *                      FRESH (just loaded)      STALE (after one add_edge)
 *   no index                 arm 1                      arm 2
 *   edge-type index          arm 3                      arm 4
 *
 * Arm 2 / arm 1 reproduces the documented cliff. Arm 4 / arm 3 is the question. Arm 3 against arm 1
 * is the CONTROL that says declaring the index does not itself cost the fresh path anything.
 *
 *   cd packages/native && bun stale-csr-probe.ts
 *   STALE_N=100000 STALE_SEL=50 bun stale-csr-probe.ts
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

const N = Number(process.env.STALE_N ?? 50_000);
/** One edge in `SEL` carries the queried type — the axis the penalty scales with. */
const SEL = Number(process.env.STALE_SEL ?? 50);
const REPS = Number(process.env.STALE_REPS ?? 14);

const doc = (): Uint8Array => {
  const lines: string[] = [];

  for (let i = 0; i < N; i++) {
    lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"n":${i}}}`);
  }

  // Three edges a node, so the degree is realistic rather than 1:1 — CLAUDE.md's "match the
  // fixture to the claim": a per-edge cost scales with the edge:node ratio.
  for (let e = 0; e < N * 3; e++) {
    const t = e % SEL === 0 ? 'WANTED' : `OTHER${e % 7}`;

    lines.push(
      `{"type":"edge","id":"e${e}","labels":["${t}"],"from":"v${(e * 104729) % N}","to":"v${(e * 7919) % N}","properties":{"w":${e % 5}}}`,
    );
  }

  return new TextEncoder().encode(lines.join('\n'));
};

const BYTES = doc();
const backend = createFfiEngineBackend(LIB);
const Q = 'MATCH ()-[:WANTED]->(b) RETURN count(*) AS c';

const time = (label: string, g: RustGraph): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();

    answer = g.query(Q)[0]?.c;
    series.push(performance.now() - t);
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? 0;

  console.log(
    `  ${label.padEnd(34)} ${median.toFixed(3).padStart(9)} ms   answer=${String(answer)}`,
  );
};

/** One `add_edge`, which is all it takes to clear `csr_fresh` for the rest of the session. */
const dirty = (g: RustGraph): void => {
  g.query('INSERT (:P {n: -1})-[:OTHER0 {w: 0}]->(:P {n: -2})');
};

console.log(
  `\n# ${N} nodes, ${N * 3} edges, 1 in ${SEL} is WANTED, median of the warm reps of ${REPS}\n`,
);

for (const indexed of [false, true]) {
  const label = indexed ? 'edge-type index DECLARED' : 'no index';

  using fresh = graphFromNdjson(backend, BYTES);

  if (indexed) {
    fresh.createIndex({ on: 'edge', kind: 'type' });
  }

  time(`${label}, FRESH`, fresh);

  using stale = graphFromNdjson(backend, BYTES);

  if (indexed) {
    stale.createIndex({ on: 'edge', kind: 'type' });
  }

  dirty(stale);
  time(`${label}, STALE (after 1 write)`, stale);
}
