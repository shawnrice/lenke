/**
 * Does the re-arm reach the PREPARED surface? (item 1128, closing item 1127's gap)
 *
 * Item 1122 hooked `rearm_if_warranted` into `lnk_query` and measured 1.68x at ten reads per write
 * and 2.74x at twenty. Item 1127 found the scope claim was wrong: `prepared_run` lives in
 * `lnk_command` and never touched the counter, so a host serving reads through prepared statements
 * got none of it — and NEITHER probe behind 1122 could have caught that, because both drive
 * `g.query(…)`, which is `lnk_query`.
 *
 * This is the same one-write-then-k-reads sweep as `rearm-probe.ts`, through `prepare` +
 * `preparedQueryRows` instead. It is the instrument that was missing.
 *
 *   cd packages/native && bun rearm-prepared-probe.ts
 */
import { createFfiEngineBackend } from './src/backend-ffi-engine.js';

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
// The shape item 1120 priced: an endpoint predicate, which no maintained count can answer.
const Q = 'MATCH (a)-[:F]->(b) WHERE b.age >= $t RETURN count(*) AS c';

const ndjson = (): string => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"age":${i % 100}}}`);
  }

  // Integer math, not the f64 LCG item 702 records collapsing to an ~11k period.
  let s = 12_345;

  for (let e = 0; e < EDGES; e += 1) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    const a = s % N;

    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    lines.push(
      `{"type":"edge","id":"f${e}","labels":["F"],"from":"v${a}","to":"v${s % N}","properties":{}}`,
    );
  }

  return lines.join('\n');
};

const backend = createFfiEngineBackend(LIB);
const text = new TextEncoder().encode(ndjson());

console.log(
  `\n# ${N} nodes / ${EDGES} F edges, PREPARED surface, one write then k reads, min of ${REPS}\n`,
);
console.log('   k     cycle_ms    per_read_ms');

for (const k of [1, 2, 3, 5, 10, 20]) {
  let best = Infinity;

  for (let r = 0; r < REPS; r += 1) {
    // The BACKEND handle, as `backend-engine.test.ts` uses it — `preparedQueryRows` takes the
    // graph itself, not a `.handle` field, which the first version of this probe got wrong.
    const g = backend.graphFromNdjson(text);
    const p = backend.prepare(Q);

    // Warm: the first call of a session pays caches the rest do not.
    backend.preparedQueryRows(p, g, '{"t":77}');

    const t0 = performance.now();

    backend.queryRows(g, 'INSERT (:P {age: 1})');

    for (let i = 0; i < k; i += 1) {
      backend.preparedQueryRows(p, g, '{"t":77}');
    }

    const ms = performance.now() - t0;

    backend.preparedFree(p);
    backend.graphFree(g);

    if (ms < best) {
      best = ms;
    }
  }

  console.log(
    `  ${String(k).padStart(2)}   ${best.toFixed(1).padStart(9)}   ${(best / k).toFixed(2).padStart(11)}`,
  );
}
