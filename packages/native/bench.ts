/**
 * Cross-engine benchmark harness: pure-TS vs native (ffi) vs wasm.
 *
 * Two reasons this exists rather than another Rust example.
 *
 * The Rust benchmarks in `crates/lenke-engine/examples` measure the NATIVE build
 * and only the native build. They compile for `wasm32-unknown-unknown` but
 * cannot run there — `Instant::now()` panics (that target has no clock), there
 * is no stdout, and there is no runner. A green `cargo build --target
 * wasm32-unknown-unknown --example …` proves nothing.
 *
 * And the pure-TS engine is a separate implementation that no Rust benchmark can
 * reach at all. It is what runs wherever a native artifact cannot ship, so a
 * regression there is invisible to every other measurement in this repo.
 *
 * Both are reachable from here, through one set of workloads:
 *
 *   bun run bench                       # every engine that is available
 *   BENCH_ENGINES=ts,wasm bun run bench
 *   BENCH_N=1000000 bun run bench       # bigger workload (default 200k)
 *   BENCH_REPS=7 bun run bench          # more samples
 *
 * Reports the MINIMUM of N runs, not the mean: it is the sample least polluted
 * by whatever else the machine was doing. A cache-resident workload answers a
 * different question than one that spills, so vary BENCH_N before drawing a
 * conclusion.
 *
 * READING THE RATIOS. They are against the first engine listed. Decode is
 * single-threaded on every build (the graph algorithms are the only opt-in
 * multicore path), so the decode rows are codegen/allocation differences, not a
 * threading asymmetry.
 */
import { existsSync } from 'node:fs';

import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import {
  deserialize as tsDeserialize,
  serialize as tsSerialize,
  type FormatName,
} from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { createWasmEngineBackend } from './src/backend-wasm-engine.js';
import type { Backend } from './src/backend.js';
import { graphFromFormat, graphFromNdjson, type GraphFormat } from './src/graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;
const WASM = new URL(
  '../../crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm',
  import.meta.url,
).pathname;

const N = Number(process.env.BENCH_N ?? 200_000);
const REPS = Number(process.env.BENCH_REPS ?? 5);
const WANTED = new Set(
  (process.env.BENCH_ENGINES ?? 'ts,ffi,wasm').split(',').map((s) => s.trim()),
);

/**
 * What a workload needs from an engine.
 *
 * The two implementations have genuinely different shapes — the Rust engine is a
 * handle behind a backend and must be freed, the TS core is an ordinary
 * GC-managed object — so workloads are written against this rather than against
 * either one.
 */
type Engine = {
  name: string;
  load: (doc: string) => unknown;
  loadFormat: (doc: string, format: string) => unknown;
  serialize: (g: unknown, format: string) => string;
  query: (g: unknown, text: string) => unknown;
  /** A no-op where the runtime collects for you. */
  free: (g: unknown) => void;
};

type NativeGraph = {
  serialize: (f: GraphFormat) => string;
  query: (t: string) => unknown;
  free: () => void;
};

const nativeEngine = (name: string, backend: Backend): Engine => ({
  name,
  load: (doc) => graphFromNdjson(backend, doc),
  loadFormat: (doc, format) => graphFromFormat(backend, doc, { format: format as GraphFormat }),
  serialize: (g, format) => (g as NativeGraph).serialize(format as GraphFormat),
  query: (g, text) => (g as NativeGraph).query(text),
  free: (g) => (g as NativeGraph).free(),
});

const tsEngine: Engine = {
  name: 'ts',
  load: (doc) => tsDeserialize(doc, 'ndjson', new TsGraph()),
  loadFormat: (doc, format) => tsDeserialize(doc, format as FormatName, new TsGraph()),
  serialize: (g, format) => tsSerialize(g as TsGraph, format as FormatName),
  query: (g, text) => tsQuery(g as TsGraph, text),
  free: () => {},
};

/** The workload documents, built once and shared by every engine. */
const nodesDoc = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"name":"person${i}","city":"Springfield","age":${i % 90}}}`,
).join('\n');
const graphDoc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
  );

  // Five edges per node, endpoints scattered, every edge carrying an id — the
  // shape a reloaded snapshot actually has. A sparse or id-less fixture
  // understates everything on the edge path.
  for (let k = 0; k < N * 5; k++) {
    lines.push(
      `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${(k * 104_729) % N}","properties":{"w":${k % 7}}}`,
    );
  }

  return lines.join('\n');
})();

const FORMATS = ['ndjson', 'pg-json', 'graphson', 'pg-text', 'csv'];
// `ndjson` has its own two dedicated decode rows above, so it is not repeated here. `csv` was
// absent with no reason recorded, which left the only format still on the engine's `GraphData`
// bridge in BOTH directions completely unmeasured.
const DECODABLE = ['pg-json', 'graphson', 'pg-text', 'csv'];

/**
 * One row. `setup` runs ONCE outside the timed region and its result is handed to `run`;
 * only `run` is timed; `teardown` releases afterwards.
 *
 * THE SETUP SPLIT IS THE WHOLE POINT. Every row here except the two `decode ndjson` ones
 * used to load a graph INSIDE the timed body, so each one measured a decode plus the thing
 * it was named for — and the decode dominated. `query: 1-hop traversal` read ts 3894.7 /
 * ffi 764.3, a 5.1x ratio, while `decode ndjson (5 edges/node)` on its own was ts 2863.3 /
 * ffi 755.8: about three quarters of the ts row and essentially ALL of the ffi row was the
 * load they shared. The traversal underneath was ~1031ms against ~8.5ms. An `encode` row was
 * ~76% decode, and a `decode <fmt>` row timed an ndjson decode AND an encode AND the decode
 * it was named for, two of which are separate rows already.
 *
 * So the ratios this file printed were decode ratios wearing other rows' names, and they are
 * where the "Rust is 1.5-4x pure-TS" range in CLAUDE.md came from. Numbers from before this
 * change are not comparable with numbers after it.
 */
type Case = {
  name: string;
  setup?: (e: Engine) => unknown;
  run: (e: Engine, ctx: unknown) => void;
  teardown?: (e: Engine, ctx: unknown) => void;
};

/** A row that loads `doc` once, then times `fn` against that one warm graph. */
const onGraph = (doc: () => string, fn: (e: Engine, g: unknown) => void): Omit<Case, 'name'> => ({
  setup: (e) => e.load(doc()),
  run: (e, g) => fn(e, g),
  teardown: (e, g) => e.free(g),
});

const CASES: Case[] = [
  { name: 'decode ndjson (nodes)', run: (e) => e.free(e.load(nodesDoc)) },
  { name: 'decode ndjson (5 edges/node)', run: (e) => e.free(e.load(graphDoc)) },
  ...FORMATS.map((fmt) => ({
    name: `encode ${fmt}`,
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.serialize(g, fmt),
    ),
  })),
  ...DECODABLE.map((fmt) => ({
    name: `decode ${fmt}`,
    // The source text is produced in SETUP — timing it would make this row an ndjson decode
    // plus an encode plus the decode it is named for, which is what it used to be.
    setup: (e: Engine) => {
      const src = e.load(nodesDoc);
      const text = e.serialize(src, fmt);

      e.free(src);

      return text;
    },
    run: (e: Engine, text: unknown) => e.free(e.loadFormat(text as string, fmt)),
  })),
  {
    name: 'query: count',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN count(*) AS c'),
    ),
  },
  {
    name: 'query: project 3 columns',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN n.name AS n, n.city AS c, n.age AS a'),
    ),
  },
  {
    name: 'query: group + aggregate',
    // `GROUP BY` takes a BOUND NAME, not a RETURN alias, so this needs the `LET`. Written
    // with the alias it raised `variable \`a\` is not defined` on BOTH engines and the harness
    // printed a bare `n/a`, so this workload measured nothing at all.
    ...onGraph(
      () => nodesDoc,
      (e, g) =>
        void e.query(g, 'MATCH (n:Person) LET a = n.age RETURN a, count(*) AS c GROUP BY a'),
    ),
  },
  {
    // NOT a traversal measurement any more, and the name said otherwise for a while. Both
    // engines now answer this from the edge bucket's size without walking anything (the 1-hop
    // count shortcut), so it reads ~0ms on both. Kept, renamed, as the GUARD for that shortcut:
    // if it ever returns to hundreds of ms the shortcut has stopped firing.
    name: 'count 1-hop [shortcut]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c'),
    ),
  },
  {
    // A REAL adjacency walk: a predicate on the far endpoint defeats the bucket-size shortcut,
    // so every edge is visited, and the result is one row — so this measures traversal rather
    // than row materialization. `age > 500` matches nothing (ages are 0..89), which does not
    // reduce the work: the walk and the predicate still happen for every edge.
    name: 'traverse 1-hop + filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 500 RETURN count(*) AS c'),
    ),
  },
  {
    // The other half: the same walk, but PROJECTING an endpoint property, so 1,000,000 rows are
    // built. Traversal plus the row pipeline, which is the shape a user actually runs.
    name: 'traverse 1-hop project',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'),
    ),
  },
];

const engines: Engine[] = [];

if (WANTED.has('ts')) {
  engines.push(tsEngine);
}

if (WANTED.has('ffi')) {
  if (existsSync(LIB)) {
    engines.push(nativeEngine('ffi', createFfiEngineBackend(LIB)));
  } else {
    console.warn(`skipping ffi: ${LIB} not found — run \`bun run build:rust\``);
  }
}

if (WANTED.has('wasm')) {
  if (existsSync(WASM)) {
    engines.push(
      nativeEngine('wasm', await createWasmEngineBackend(await Bun.file(WASM).arrayBuffer())),
    );
  } else {
    console.warn(`skipping wasm: ${WASM} not found — run \`bun run build:wasm\``);
  }
}

if (engines.length === 0) {
  console.error('no engines available');
  process.exit(1);
}

/** Minimum of `REPS` runs, in milliseconds. */
const best = (f: () => void): number => {
  f(); // warm

  let ms = Infinity;

  for (let i = 0; i < REPS; i++) {
    const t = Bun.nanoseconds();

    f();
    ms = Math.min(ms, (Bun.nanoseconds() - t) / 1e6);
  }

  return ms;
};

const base = engines[0].name;

console.log(
  `\n${N} nodes, ${REPS} reps, best of each. Engines: ${engines.map((e) => e.name).join(', ')}`,
);
console.log(`Ratios are how many times faster each engine is than ${base}.\n`);

// `ts/<engine>` — how many times FASTER that engine is than ts. The other direction
// (`<engine>/ts`) printed `0.00x` for every row where the gap is large, which is exactly
// where the number matters: once the shared decode came out of the timed region, the count
// and traversal rows went to 0.0-1.1ms against ts's 94-633ms and the ratio column said
// nothing at all.
const ratioHeads = engines
  .slice(1)
  .map((e) => `${base}/${e.name}`.padStart(12))
  .join('');
const header = `${['workload'.padEnd(30), ...engines.map((e) => e.name.padStart(11))].join('')}  ${ratioHeads}`;

console.log(header);
console.log('-'.repeat(header.length));

for (const c of CASES) {
  // REPORT the reason, do not just blank the cell. `n/a` on its own cannot tell an engine
  // that does not support a workload from a workload that is simply BROKEN — the group +
  // aggregate row sat at `n/a` on every engine because its query was invalid, which looked
  // exactly like "not supported here" and so measured nothing for as long as it was there.
  const failures: string[] = [];
  const times = engines.map((e) => {
    let ctx: unknown;

    try {
      ctx = c.setup?.(e);

      return best(() => c.run(e, ctx));
    } catch (err) {
      failures.push(`${e.name}: ${(err as Error).message.trim().split('\n')[0]}`);

      return Number.NaN;
    } finally {
      try {
        c.teardown?.(e, ctx);
      } catch {
        // a teardown failure must not be reported as a measurement failure
      }
    }
  });
  const cells = times.map((t) => (Number.isNaN(t) ? 'n/a' : t.toFixed(1)).padStart(11));
  const ratios = times.slice(1).map((t) =>
    Number.isNaN(t) || Number.isNaN(times[0])
      ? ''.padStart(12)
      : // A floored divisor: a row that lands under the clock's resolution would otherwise
        // divide by zero and print `Infinityx`.
        `${(times[0] / Math.max(t, 0.001)).toFixed(2)}x`.padStart(12),
  );

  console.log(`${c.name.padEnd(30)}${cells.join('')}  ${ratios.join('')}`);

  for (const f of failures) {
    console.log(`${' '.repeat(30)}  ! ${f}`);
  }
}
