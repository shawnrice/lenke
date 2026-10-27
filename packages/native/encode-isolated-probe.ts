/**
 * Item 1000: the isolated harness `encode pg-json`'s ~0.89x needs before it is believed.
 *
 * Item 999 found the Rust core LOSING to TypeScript on `encode pg-json` and established the
 * reading survives repetition — 0.88 / 0.90 / 0.89 across four samples, with a stable ffi arm —
 * while its sibling `encode ndjson` swings 0.90 to 1.95 and cannot be called at all. It filed the
 * result as a CANDIDATE rather than a finding for one reason: **0.89x is an 11-12% effect and
 * CLAUDE.md requires anything under ~10% to have its own isolated harness.** This is that harness.
 *
 * WHAT `bun run bench` CANNOT DO, and why a flag on it would not have been enough:
 *
 *   - It runs every selected engine IN ONE PROCESS, so the arms share a heap and a JIT. Here each
 *     process runs ONE arm (`A_ARM=ts` or `ffi`), which is CLAUDE.md's "one shape per PROCESS".
 *   - It runs five encode rows and four decode rows before and after this one, so the arm is
 *     measured after whatever the neighbours left behind. Here nothing else runs.
 *   - It reports min-of-5 and nothing else. `ts-closure-size-is-load-bearing` and the TS spelling
 *     probe both record that the TS path can be BIMODAL, where `min` reports the rare fast mode
 *     and hides the distribution. Here the whole per-rep series is printed.
 *
 * THE ESTIMATOR: 30 reps, DROP THE FIRST THREE as warm-up (they are visibly the JIT tiering up),
 * take the MEDIAN of the rest. Round 1 of item 999's sweep was a cold-start outlier on every ts
 * row at once, which is exactly what dropping warm-up reps exists to remove.
 *
 * **30, not the 14 this file shipped with (item 1001).** BOTH arms here are MULTIMODAL — ts at
 * ~32 and ~40, ffi at ~28, ~33.5 and ~39 — and at 14 reps the MEDIAN ITSELF is unstable, because
 * which mode it lands in depends on the draw. Six consecutive 14-rep ffi medians read 27.8-28.3
 * and looked like a tight distribution; they were six samples of one mode of three. A median is
 * only a summary when the sample is large enough to see every mode.
 *
 * THE CONTROL IS IN THE SAME RUN: `encode csv` goes through the same `serialize` entry point on
 * both engines and measured consistently native-favourable (1.09-1.30x) while pg-json did not.
 * If an isolated pg-json still reads ~0.89x while csv still reads ~1.2x, the effect is in the
 * pg-json encoder and not in the harness, the carrier, or the call.
 *
 * Usage:  A_ARM=ts bun encode-isolated-probe.ts
 *         A_ARM=ffi A_REPS=20 bun encode-isolated-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import {
  deserialize as tsDeserialize,
  serialize as tsSerialize,
  type FormatName,
} from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson, type GraphFormat } from './src/graph.js';

// The same resolution `bench.ts` uses, so both instruments load the same cdylib.
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  win32: 'dll',
};
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const N = Number(process.env.A_N ?? 200_000);
const REPS = Number(process.env.A_REPS ?? 30);
const WARMUP = Number(process.env.A_WARMUP ?? 3);
const ARM = process.env.A_ARM ?? 'ts';
const FORMATS = (process.env.A_FORMATS ?? 'pg-json,csv').split(',');

// The SAME document `bench.ts` builds for its encode rows, so the two instruments are measuring
// the same workload and the numbers are comparable.
const nodesDoc = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"name":"person${i}","city":"Springfield","age":${i % 90}}}`,
).join('\n');

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[s.length >> 1];
};

type Arm = {
  readonly load: () => unknown;
  readonly encode: (g: unknown, fmt: string) => string;
  readonly free: (g: unknown) => void;
};

const arm = (): Arm => {
  if (ARM === 'ts') {
    return {
      load: () => tsDeserialize(nodesDoc, 'ndjson', new TsGraph()),
      encode: (g, fmt) => tsSerialize(g as TsGraph, fmt as FormatName),
      free: () => {},
    };
  }

  const backend = createFfiEngineBackend(LIB);

  return {
    load: () => graphFromNdjson(backend, nodesDoc),
    encode: (g, fmt) =>
      (g as { serialize: (f: GraphFormat) => string }).serialize(fmt as GraphFormat),
    free: (g) => (g as { free: () => void }).free(),
  };
};

const a = arm();
const g = a.load();

for (const fmt of FORMATS) {
  const series: number[] = [];
  let bytes = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const out = a.encode(g, fmt);

    series.push(performance.now() - t0);
    bytes = out.length;
  }

  const kept = series.slice(WARMUP);

  // Printed in full: a summary of a bimodal series is a summary of nothing, and the one thing
  // `bun run bench` could not show is the distribution.
  console.log(
    `${ARM}\t${fmt}\tmedian ${median(kept).toFixed(2)}\tmin ${Math.min(...kept).toFixed(2)}\tbytes ${bytes}\n` +
      `  series: ${series.map((x) => x.toFixed(1)).join(' ')}`,
  );
}

a.free(g);
