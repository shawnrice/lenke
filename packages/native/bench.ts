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
 *   BENCH_ONLY='3-hop + end' bun run bench   # ONE case, isolated in its own process
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

/**
 * Force every element in a result to its MAP form, so the two engines are doing the same work.
 *
 * The pure-TS engine returns live `Vertex` / `Edge` instances and defers building the
 * `{id, labels, properties}` map to whoever serializes them; the native engine has already
 * built it. `toJSON()` is that map on a live element and absent on the native engine's plain
 * object, so applying it to both sides levels them without special-casing either (item 341).
 */
const materializeRows = (rows: unknown): number => {
  let n = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
    for (const v of Object.values(row)) {
      const j = (v as { toJSON?: () => unknown })?.toJSON;

      n += j === undefined ? 1 : Object.keys(j.call(v) as object).length;
    }
  }

  return n;
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
    //
    // NOTE THE FIXTURE: `nodesDoc` is 200,000 NODES AND NO EDGES, where the
    // `decode ndjson (5 edges/node)` row above decodes 1,200,000 elements. These rows are
    // therefore NOT comparable with it, and they carry no edge-path cost at all — see the
    // `(5 edges/node)` variants below, added at audit item 356, which are. Kept as-is rather
    // than repointed at `graphDoc`, so every figure recorded against this row name stays
    // comparable.
    setup: (e: Engine) => {
      const src = e.load(nodesDoc);
      const text = e.serialize(src, fmt);

      e.free(src);

      return text;
    },
    run: (e: Engine, text: unknown) => e.free(e.loadFormat(text as string, fmt)),
  })),
  // THE EDGE-BEARING TWIN of each decode row (item 356). The four rows above decode a NODES-ONLY
  // document, so each codec's edge path — endpoint resolution, edge-label indexing, the edge
  // property bag — was completely unmeasured, for every one of the three engines. That is
  // CLAUDE.md's "match the fixture to the claim" at its limit: not "one edge per node is sparse"
  // but ZERO edges per node, on the rows named for a whole-graph decode.
  //
  // It also removes a reading trap. `decode graphson` (nodes only) sits next to
  // `decode ndjson (5 edges/node)` in the output and invites the comparison, which is 200,000
  // elements against 1,200,000. Normalized per byte the two formats are within 1.2x; the apparent
  // 4.2x was 3.5x document verbosity (410 B/element against 117) and nothing else.
  ...DECODABLE.map((fmt) => ({
    name: `decode ${fmt} (5 edges/node)`,
    setup: (e: Engine) => {
      const src = e.load(graphDoc);
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
    // THE SHAPE THAT DOMINATES THE NATIVE CORPUS, and this harness had no row for it at all
    // (audit item 341). `query/perrow` prices `RETURN p` as the most expensive row in
    // `bench_all` — ~250-520 ns/row against 1.7 for a scalar — and the only place the two
    // engines are compared had never asked what it costs in TypeScript.
    //
    // READ THIS ROW WITH THE NEXT ONE OR NOT AT ALL. The two engines do not do the same work
    // here: the TS engine returns a LIVE `Vertex` instance (zero own keys, a `toJSON`), so it
    // materializes nothing and the cost lands on whoever serializes it later; the native engine
    // builds the whole `{id, labels, properties}` map eagerly and, across FFI/wasm, ships it
    // over the boundary. Both ultimately produce byte-identical output — checked — but at
    // different times. So this row answers "how long until the host HAS the rows", where the
    // laziness is a genuine advantage, and the `+ materialize` row below answers "what does
    // producing the maps cost", which is the comparable one.
    //
    // AND NEITHER RATIO IS ABOUT THE ENGINES' RENDERERS. Item 289 settled that the ts-vs-ffi
    // gap on any row-returning query is the JSON CARRIER: the same fixture with the same work
    // and ONE row out runs 30.8x the OTHER way. Anyone reading these four rows as a renderer
    // comparison should read `queryArrowIpc` and item 289 first. What they are good for is the
    // LAZINESS asymmetry — the difference between each pair — which is per-engine and so
    // carrier-free.
    name: 'query: project the element [ts lazy]',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN n'),
    ),
  },
  {
    // The same query with BOTH sides forced to materialize, which is the apples-to-apples
    // version: `toJSON()` on a live `Vertex` builds the same map the native engine already
    // built, and is a no-op on the plain object the native engine returns.
    name: 'query: project the element + materialize',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void materializeRows(e.query(g, 'MATCH (n:Person) RETURN n')),
    ),
  },
  {
    // The edge twin, lazy and forced. Native got a batch renderer for this at item 340.
    name: 'query: project the edge [ts lazy]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (:Person)-[r:KNOWS]->() RETURN r'),
    ),
  },
  {
    name: 'query: project the edge + materialize',
    ...onGraph(
      () => graphDoc,
      (e, g) => void materializeRows(e.query(g, 'MATCH (:Person)-[r:KNOWS]->() RETURN r')),
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
    // ISO's SELECT spelling of the row above, which is the same question written the way the
    // standard writes it: the PROPERTY in `GROUP BY`, with no `LET` to name. It reached the tally
    // only after item 199 — 69.5ms against the `LET` form's 4.1 — and `HAVING` is here because
    // it is the clause the SELECT form exists to carry, and because it is the half of item 199
    // that was measured first and turned out not to be the gap.
    name: 'query: select group + having',
    ...onGraph(
      () => nodesDoc,
      (e, g) =>
        void e.query(
          g,
          'SELECT n.age AS a, count(*) AS c FROM MATCH (n:Person) GROUP BY n.age HAVING count(*) > 2',
        ),
    ),
  },
  {
    // The `LET` row above measures the grouped-count SHORTCUT, not the general grouping path: a
    // property key plus `count(*)` is exactly the shape the tally answers, so it never
    // reached the code that groups bindings, and item 186's 1.7-2.9x there was invisible to
    // the whole corpus. Dropping the aggregate is enough to decline the tally (it wants two
    // projection items, one of them a count) while asking the same grouping question — so
    // this is the general path, and the pair of rows now covers both.
    name: 'query: group, no aggregate',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) LET a = n.age RETURN a GROUP BY a'),
    ),
  },
  {
    // `count(DISTINCT e)` is the SIZE of the dedup the walk already builds, and it went through
    // the general pipeline: 65.8ms against the rows walk's 5.1ms. The cost was the pipeline and
    // not the aggregate — `count(*)` forced down the same path is 84.3ms with no map, filter or
    // dedup in it at all — so item 196 gave it the walk.
    name: 'query: count distinct',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN count(DISTINCT n.age) AS c'),
    ),
  },
  {
    // The distinct far-end values over a HOP, with a sort. Item 194 made the start-keyed version
    // 2.86x by resolving the far vertex only when read; this shape still needs it, so item 195
    // asks the question from the FAR end instead — one adjacency lookup per far vertex rather
    // than an endpoint resolution per edge, 293.7ms to 90.4ms. The sort is load-bearing: it is
    // what makes the two walks' first-seen orders indistinguishable.
    name: 'query: distinct over a hop',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(f) RETURN DISTINCT f.age AS x ORDER BY x'),
    ),
  },
  {
    // The REVERSE spelling of the row above — one question, two arrows. It keys the dedup on the
    // pattern's START, which `farDrivenFits` refuses by design, so it takes the start-driven walk;
    // that walk resolved the far endpoint for EVERY edge (~190ns, item 194) only to test the other
    // end's label. 304 -> 92ns an edge via a break at the first qualifying edge plus a runtime
    // vacuous-label check, closing a 4.6x spelling gap to 1.33x (audit item 215).
    name: 'query: distinct over a reversed hop',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (f)<-[:KNOWS]-(a:Person) RETURN DISTINCT f.age AS x ORDER BY x'),
    ),
  },
  {
    // The same dedup with a WINDOW on it. Item 189 sorted the walk's output but left paging
    // with the general path, so adding `LIMIT 5` to the row below took it from 14.1ms back to
    // 142.1ms — a cheap addition undoing the fix. Item 191 takes the window too, applied AFTER
    // the sort. The pair of rows guards both halves.
    name: 'query: top distinct values',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN DISTINCT n.age AS a ORDER BY a LIMIT 10'),
    ),
  },
  {
    // Item 581. A plain `ORDER BY <col> LIMIT k` over a node scan had no row here, and no
    // shortcut either: it runs the general pipeline, which builds a binding per row and then
    // takes the sort key from it. The top-k itself is sound — it keeps only the top-k INPUT
    // bindings and projects just those (`orderNeedsOutput`), and the full sort is 294ms against
    // its 31 — but the per-row cost is 3.4x its own floor.
    //
    // THE ROW BELOW IS NOT A FLOOR — it is a PLAN comparison, and item 426 states the rule:
    // "a floor measured on a different PLAN is not a floor". `min(n.age)` runs on
    // `detectNodeProjection`'s FUSED SCAN (since item 420), a different row-production path from
    // `applyProjection`'s general binding stream, so the gap between these two rows prices that
    // plan difference and NOT the top-k. Item 426 attributed it with a constant sort key (all
    // ties, the heap never evicts): 25.6 of 35.5ms is the general stream plus the loop, which is
    // item 377's per-row `Binding`.
    //
    // The pair is still worth having — it is the cheapest way to see either side move — but read
    // it as "general stream against fused scan", not as "target against floor". At 200,000
    // vertices, one case per process, three interleaved rounds:
    //
    //   ORDER BY a LIMIT 1   ts 30.84-31.92ms   nv 0.70-0.71     FLAT in k (1, 5 and 100 alike)
    //   min(n.age)           ts  7.82-9.32      nv 0.41-0.44
    //   RETURN n.age (proj)  ts  9.33           nv 14.56         the 200,000-row projection
    //
    // Read the PAIR: a top-k that regresses toward the unbounded sort shows as this gap widening,
    // and the lower row moving tells you the fused scan changed rather than the top-k. The
    // single-key bounded heap itself shipped at item 425 (1.34-1.50x over six shapes) and item
    // 424 established the rung is NOT missing — 50.1ms against 485.1 unlimited.
    name: 'query: top-k by property',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN n.age AS a ORDER BY a LIMIT 5'),
    ),
  },
  {
    // THE SAME SORT WITHOUT THE WINDOW, which nothing watched until item 605. The row above has
    // a `LIMIT`, so it runs the top-k heap (item 425) and `detectNodeProjection` must decline it:
    // with a window the general path keeps bindings and projects only survivors, so projecting
    // everything first would raise on rows the query never emits (item 604 measured that on both
    // engines). Without the window every row is emitted, the projection shortcut can take the
    // sort, and this row is the watcher for that route.
    //
    // It is also the control FOR the row above: a change admitting the sort must move this one
    // and leave the top-k row alone.
    // THE WINDOWED TWIN (item 610). `top-k by property` above is the same sort with a `LIMIT` and
    // used to be the DECLINED case; a conservative cannot-fault check now lets it ride the
    // shortcut, so this row and that one move together while a FAULTING projection still
    // declines. Kept beside the unwindowed row so the two can be read against each other.
    name: 'query: ordered projection + limit',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN n.age AS a ORDER BY a LIMIT 5'),
    ),
  },
  {
    name: 'query: ordered projection [no window]',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN n.age AS a ORDER BY a'),
    ),
  },
  {
    // The ORDERED-SET aggregates, added once BOTH engines answered them with one order statistic
    // instead of a sort (native 9.5x at item 1162, TS 17.9x on the fold at item 1163). The corpus
    // had no percentile row at all, so the sweep that was supposed to catch a regression in them
    // could not see them — and a win with no row is a win that quietly comes undone.
    //
    // `disc` and `cont` BOTH, because they take different paths: `disc` is one selection, `cont`
    // is a selection plus a tail-minimum scan for the adjacent statistic, and a change can break
    // the interpolation while leaving the selection correct.
    name: 'query: percentile_disc [one order statistic]',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN percentile_disc(n.age, 0.5) AS a'),
    ),
  },
  {
    name: 'query: percentile_cont [interpolates two]',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN percentile_cont(n.age, 0.5) AS a'),
    ),
  },
  {
    name: 'query: min property [fused-scan aggregate]',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN min(n.age) AS a'),
    ),
  },
  {
    // `ORDER BY c DESC LIMIT n` over a grouped count is the top-categories-by-count shape, and
    // the tally declined every `ORDER BY` until item 190 — 65.0ms through the general path
    // against 8.6ms tallied, because the sort reorders the groups BEFORE the window and the
    // tally did not sort. Its output is one row per GROUP, so this row guards that the sort
    // stays over the groups rather than over the input.
    name: 'query: top groups by count',
    ...onGraph(
      () => nodesDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (n:Person) LET a = n.age RETURN a, count(*) AS c GROUP BY a ORDER BY c DESC LIMIT 5',
        ),
    ),
  },
  {
    // Adding `ORDER BY` to a dedup cost 12.6x until item 189 — 146.8ms to sort the NINETY rows
    // the query returns, because every dedup fast path declined on `orderBy.length > 0` and the
    // general path then materialized and sorted all 200,000 input rows. Sorting a dedup by its
    // own projected value is a sort of the ANSWER, so this row guards that it stays one.
    name: 'query: distinct + order by',
    ...onGraph(
      () => nodesDoc,
      (e, g) => void e.query(g, 'MATCH (n:Person) RETURN DISTINCT n.age AS a ORDER BY a'),
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
    // THE UNDIRECTED SPELLING of the row above, which NOTHING in this corpus measured (item 743).
    // `-[:KNOWS]-` is not `-[:KNOWS]->`: it is a third variant of the direction enum, and the two
    // engines treat it completely differently.
    //
    // TS has a dedicated `undirectedHopCount` shortcut with an O(1) route — per-type bucket sizes
    // and a self-loop tally, `2*|E_t| - loops(t)` — which a prior item took from 1352 ms to 0.0 at
    // this size. NATIVE's degree fast path gates on `matches!(dir, Dir::Out | Dir::In)` and so
    // declines `Dir::Both` outright.
    //
    // A direction enum with three variants, a fast path covering two of them, and no bench row on
    // the third is exactly the shape item 736 found for row-returning var-length: the uncovered
    // variant is where the unpriced cost lives.
    name: 'count 1-hop UNDIRECTED',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]-(x) RETURN count(*) AS c'),
    ),
  },
  {
    // THE MIRROR of `count 3-hop quantified [TRAIL]`, and the row that found item 744.
    //
    // `<-[:KNOWS]-{3}` is the same traversal read backwards and NOTHING measured it. TS's
    // var-length count detector refused `rel.direction !== 'out'`, so the mirror took no fast
    // path at all while its forward twin used the level recurrence: at 20,000 vertices it read
    // 682.2 ms against 14.4, a 47.4x penalty for the spelling, while native — whose gate accepts
    // `Dir::Out | Dir::In` — was 1.4 ms either way. Three alternated rounds after the fix: clean
    // 682.2/708.2/692.5 against 12.0/13.0/13.7, ~53x, disjoint, with the forward row and the whole
    // ffi column flat.
    //
    // KEPT as the guard for that route. It is the repo's named bug class — "the planner recognized
    // one spelling and scanned for another that meant exactly the same thing" — and the answers
    // were correct the whole time, so only a timing row can see it come back.
    name: 'count 3-hop quantified MIRROR [TRAIL]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)<-[:KNOWS]-{3}(y) RETURN count(*) AS c'),
    ),
  },
  // 🛑 AND THERE IS NO QUANTIFIED UNDIRECTED ROW, because the number is why (item 743).
  //
  // `MATCH (a:Person)-[:KNOWS]-{3}(y) RETURN count(*)` at 20,000 vertices: ts 4828.1 ms, ffi 99.0
  // — 48.78x — against the DIRECTED twin at the same N and depth, ts 14.4 and ffi 1.4 (item 732).
  // An undirected walk has twice the degree, so depth 3 visits 8x the paths; per PATH the
  // undirected spelling costs TS 41x more (5.8 -> 241 ns) and native 8.8x (0.56 -> 4.95).
  //
  // Native's refusal is DELIBERATE and reasoned: "from one node an undirected edge is traversable
  // two ways, so one edge-indexed traversal mask cannot represent both, and a self-loop sits in
  // both adjacency lists". What was never priced is what that refusal COSTS, and now it is.
  //
  // At the default N this row would be ~48 SECONDS on ts, so it stays out of the sweep for item
  // 732's reason: a regression sweep nobody runs catches nothing. Add it back temporarily to
  // re-price.
  {
    // A REAL adjacency walk: a predicate on the far endpoint defeats the bucket-size shortcut,
    // so every edge is visited, and the result is one row — so this measures traversal rather
    // than row materialization.
    //
    // The threshold was `> 500` until audit item 163, which matched NOTHING (ages are `i % 90`,
    // so 0..89) on the stated grounds that an empty result "does not reduce the work: the walk
    // and the predicate still happen for every edge". That is true of the TS engine and NOT of
    // native, and the ratio is this table's whole output. Measured across selectivities:
    //
    //            matches        ts   native    ratio
    //   > 500          0      95.3     1.47      65x
    //   > 85      44,440      94.4     1.51      63x
    //   > 45     488,840      92.6     1.51      61x
    //   >= 0     988,885     103.9     1.60      65x
    //
    // This row survives the correction — native is flat because it scans the `age` column once
    // either way — but its TWIN below did not, so both move to `> 45` to keep them comparable.
    name: 'traverse 1-hop + filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 45 RETURN count(*) AS c'),
    ),
  },
  {
    // The same question with the predicate on the START node instead of the far one. It looks
    // like a near-duplicate of the row above and is a different COST CLASS: a start-only
    // predicate can be decided once per vertex and multiplied by that vertex's degree, so it
    // scales with the vertex count where the row above scales with the edge count. The table had
    // no row of this shape, which is why the TS engine evaluated it per edge unnoticed (item
    // 114). Keep both: a change can help one and not the other.
    //
    // THIS is the row the `> 500` threshold was misreporting (audit item 163). Deciding a
    // start-only predicate per vertex and multiplying by degree means native's cost scales with
    // how many starts MATCH — so an empty predicate measured the cost of expanding nothing:
    //
    //            matches        ts   native    ratio
    //   > 500          0      81.8     0.20     409x
    //   > 85      44,440      82.6     0.41     201x
    //   > 45     488,840      73.7     2.39      31x
    //   >= 0     988,885    ~103.9     4.73     ~22x
    //
    // A 13x spread in the headline ratio from the threshold alone, and the empty end of it was
    // quoted as "the single widest gap in the cross-engine bench" (item 129). `> 45` keeps
    // roughly half the edges, so both engines do real work and the ratio means something.
    name: 'traverse 1-hop + start filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 45 RETURN count(*) AS c'),
    ),
  },
  {
    // The TWO-hop form of the row below. A correlated `COUNT{}` ran the general matcher per outer
    // row — 4943ns against 891 after item 212 answered it as a degree-of-degrees via `twoHopSide`,
    // the same helper item 206's two-hop walk uses for its far leg. Three or more segments still
    // decline, so this is the deepest shape the shortcut takes.
    name: 'query: 2-hop subquery item',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (n:Person) WHERE n.age > 60 RETURN COUNT { MATCH (n)-[:KNOWS]->(m)-[:KNOWS]->(f) } AS c',
        ),
    ),
  },
  {
    // A filtered node scan projecting a SUBQUERY. Item 204 applied one guard to both the
    // predicate and the items, so a subquery ITEM declined the node-scan path and took the
    // general pipeline — a whole-label scan to serve the surviving rows. The predicate must stay
    // strict (item 175 orders its conjuncts so a faulting subquery is never reached), but an item
    // is evaluated once per SURVIVING row on either path. 94.3ns a scanned vertex to 35.0, of
    // which a one-hop COUNT{} item showed only ~4ns was the subquery itself (audit item 208).
    name: 'query: subquery item',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (n:Person) WHERE n.age > 60 RETURN COUNT { MATCH (n)-[:KNOWS]->(x) } AS c',
        ),
    ),
  },
  {
    // A START-FILTERED one-hop PROJECTION. `carriedWhere` refused a clause `WHERE` that did not
    // read the far end, so this declined the fused walk entirely and went to the general path —
    // correct while the walk did not seed (item 177 measured the walk at 3966us against the
    // general path's 49.6 on an indexed graph), and wrong once it does. Item 207 seeds instead of
    // declining and gates per START VERTEX: 51.8ms to 17.0 on 20,000 users, with the indexed case
    // unchanged at 0.6ms.
    name: 'traverse 1-hop project + start filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 60 RETURN x.name AS n'),
    ),
  },
  {
    // A START-FILTERED two-hop count. `patternCountOf` declined any predicate on a two-segment
    // pattern, so this fell to the general pipeline while the one-hop form had had a per-vertex
    // walk since item 129: 52.6ms against 14.0 on 20,000 users (audit item 206). The filter is
    // selective on purpose — that is what the walk exploits, rejecting a start before it expands
    // the start's adjacency at all.
    // 🛑 THE UNGATED CONTROL, which did not exist until item 749 and is the row this family most
    // needed. `try_nhop_sweep_count` must NOT take an ungated shallow chain — item 301 measured
    // the sweep LOSING 1.50x to the three-segment product when there is nothing to filter, and
    // the code says so: "the tuned degree-product arms own the ungated shallow chains and this
    // must not steal them". There was no row for it, so a condition that admitted the ungated
    // case would have stolen it invisibly — which is exactly what item 749's first probe
    // (`2 => true`) did before this row caught it.
    // 🛑 THE `_ => true` ARM'S FIRST COVERAGE (item 750). `try_nhop_sweep_count` takes FOUR or
    // more hops unconditionally — gated or not — and no row exercised a fixed 4-chain at all; the
    // only 4-hop row in the corpus is the QUANTIFIED `->{4}`, which is different machinery.
    //
    // Unlike two and three hops, where the tuned degree-product arms own the ungated chain (items
    // 301/306, guarded by `count 2-hop`), at four the sweep SHOULD own it: routing this row to the
    // product arms instead costs **55.5 ms against 7.0 — a 7.9x loss** — while the gated row below
    // is unchanged at 4.9/5.0. So the arm is verified rather than assumed, and the two rows are
    // what would notice if that ownership ever flipped.
    name: 'count 4-hop',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d)-[:KNOWS]->(x) RETURN count(*) AS c',
        ),
    ),
  },
  {
    name: 'count 4-hop + start filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d)-[:KNOWS]->(x) WHERE a.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    name: 'count 2-hop',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c'),
    ),
  },
  {
    name: 'count 2-hop + start filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE a.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    // The MIDDLE-filtered sibling of the row above, and the cheaper question of the two: the
    // degree product already iterates middles, so this gates each one ONCE and multiplies the two
    // degrees of the survivors, where a start filter costs the product its start factor. It was
    // refused for the start case's reason and fell to the row pipeline — 2331.7ms, 1447ns a
    // counted path, the worst shape in the corpus (audit item 219).
    name: 'count 2-hop + mid filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE b.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    // The third position, and the one with no walk of its own: counting `a->b->c` is counting
    // `c<-b<-a`, so an END-filtered count is the START-filtered question written backwards and
    // the existing walk answers it once the planner reverses the pattern. The forward spelling was
    // 2363.5ms against the hand-reversed spelling's 118.1 — 20x for the same question and the same
    // answer (audit item 220).
    // THREE segments, which the count ladder stopped short of entirely — so this fell to the row
    // pipeline at 13.2 SECONDS, the slowest shape in the corpus, 529ns a counted path against the
    // two-segment tally's 21. The two-segment product iterates the middle VERTEX; one position
    // along the interior is an EDGE, and the count is the sum over middle edges of
    // indeg(b) x outdeg(c) (audit item 221).
    // The interior-filtered sibling, and the cheapest of the four filtered three-hop positions:
    // the product's walk ITERATES the second position, so a constraint there is gated once per
    // vertex and prunes before either degree is read. It fell to the row pipeline at 9360.5ms,
    // where the inline spelling of the same question took 3945.9 and the inline EQUALITY 560.7 —
    // three readings of one query, 13.3x apart (audit item 222).
    name: 'count 3-hop + interior filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE b.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    // The START of the same three-hop chain. Item 306 routed the END and left this ENUMERATING —
    // 141.3ms against 16.3 for the same chain unfiltered at 20,000 vertices, where native
    // answered it in 0.34, a 415x cross-engine gap on one position of one depth that no bench row
    // was looking at. Item 307 routes it (7.4x). An INTERIOR gate at this depth is deliberately
    // not routed: it makes the degree product faster than its own unfiltered self, which
    // `count 3-hop + interior filter` above is the row for.
    name: 'count 3-hop + start filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE a.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    // The END of the same three-hop chain, which NO degree product can carry: a product answers
    // its last hop as a weighted sum of DEGREES, and a degree cannot say which of a vertex's
    // edges land somewhere that passes. So this shape declined every count arm and ENUMERATED in
    // both engines — the cliff items 303 and 305 moved rather than closed, and the row that was
    // missing while they moved it. At 20,000 vertices of degree 3 it was ts 668.3ms against 19.5
    // for the same chain unfiltered, and native 4.21 against 0.32; item 306 routes it to the
    // way-count sweep instead (ts 14.6x, native 5.2x).
    name: 'count 3-hop + end filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE d.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    name: 'count 3-hop',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c',
        ),
    ),
  },
  {
    name: 'count 2-hop + end filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE c.age > 60 RETURN count(*) AS c',
        ),
    ),
  },
  {
    // VAR-LENGTH, the pair. Item 573 gave TS a degree-arithmetic rung for a bounded `{m,n}`
    // count and item 583 taught it to carry an endpoint PREDICATE; neither shipped a watcher, so
    // a regression on either would have shown up nowhere. The two rows are a PAIR for the reason
    // item 581's was: a filtered row alone cannot say whether a regression is the predicate or
    // the walk underneath it, and the GAP between them is the number that matters. They should
    // sit within ~2x of each other — the filtered one pays one predicate per reached endpoint
    // over the same degree product, and measured 429.35 against 200.25 here. Before 583 it was
    // 2446.99, because it declined the rung and enumerated all 6,000,000 paths: 5.7x, two
    // alternated rounds, with the unfiltered row as the control that stayed flat.
    //
    // Both rows are FLAT IN PATH COUNT, which is how you can tell from the table alone that the
    // rung is being taken: at 200,000 vertices they read 189 and 397 with 3 edges/node against
    // 187 and 379 with 5, where the path count went 2.4M to 6.0M. Enumeration would have tracked
    // the paths. THE ~2x BELOW IS HISTORY, AND SO IS THE LEVER IT NAMED (item 1083).
    //
    // Written at items 583/584, it said: the filtered row is ~2x the plain one because the LAST
    // hop can no longer be a degree — a degree cannot say which of a vertex's edges land
    // somewhere that passes — so it enumerates that hop; native pays 4.3 against 4.0 because it
    // precomputes a per-node passing out-degree (item 570's `node_pass_mask`), and doing the same
    // in TS was "the open lever this pair exists to watch".
    //
    // ITEM 585 LANDED IT. `varLengthDegreeCount` now accumulates the second hop BACKWARDS when
    // that is cheaper — for each passing `z`, every in-edge of `z` adds one to its source's
    // count, costing one visit per edge INTO a passing vertex, which scales with selectivity:
    // the property the forward walk lacks. Measured isolated, ONE ROW PER PROCESS, three rounds:
    //
    //   plain      144.3 / 145.0 / 149.1 ms
    //   + filter   146.9 / 151.1 / 148.3      ->  1.02-1.06x, NOT ~2x
    //
    // against the 189/397 and 187/379 recorded above. The PAIR still earns its place as a
    // regression watcher — a reopened 2x would mean the inversion stopped being chosen — but the
    // ratio to watch is ~1.0x, and reading ~2x as healthy would HIDE that regression.
    //
    // AND DO NOT READ THESE TWO FROM A FULL SWEEP — AND NOT THE RATIO EITHER (corrected at item
    // 1100). Item 1083 wrote that "the ratio survives it because both rows pay it", and the next
    // full sweep refuted that in one line: the two rows pay DIFFERENT inflation.
    //
    //                      isolated (3 rounds)   in-sweep   inflation
    //   plain                 144.2 143.8 142.4     225.9      1.58x
    //   + end filter          148.8 148.5 148.5     274.1      1.85x
    //   ratio                        1.04x           1.21x
    //
    // So a sweep reading of ~1.2x is this pair's HEALTHY value and ~1.0x is its isolated one. Read
    // it the wrong way round and a sweep's 1.21x looks like a regression that is not there, or a
    // real 1.2x regression looks like inflation. The filtered row pays more inflation because it
    // does strictly more work per rep (a predicate per reached endpoint), so it is the more
    // sensitive of the two to whatever the preceding rows did to the machine.
    //
    // THE RULE IS THE ONE CLAUDE.md ALREADY GIVES FOR THESE ROWS: isolate them. `BENCH_ONLY` is
    // one flag, and a ratio measured across two differently-inflated rows is not a ratio.
    name: 'count var-length 1-2 hops',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->{1,2}(y) RETURN count(*) AS c'),
    ),
  },
  {
    name: 'count var-length 1-2 hops + end filter',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(
          g,
          'MATCH (a:Person)-[:KNOWS]->{1,2}(y WHERE y.age > 60) RETURN count(*) AS c',
        ),
    ),
  },
  {
    // DEPTH, and the WALK mode that unlocks it (item 587). The degree algebra was bounded at
    // `max <= 2` by the trail correction; a WALK forbids nothing, so its count obeys a level
    // recurrence at any depth. This row is the watcher for that route — and WALK is the GREMLIN
    // mode, since `repeat()` lowers to `PathMode::Walk`, so a regression here would show up as
    // `g.V().repeat(out()).times(3)` getting slow rather than as an ISO-spelling curiosity.
    //
    // ⚠️ THE 38.87 -> 3.97 TABLE BELOW IS NATIVE BEFORE -> NATIVE AFTER, NOT ts-vs-native.
    // Item 1084 read it as a cross-engine pair because 38.87/3.97 = 9.79 matches the stated ratio
    // — but so does a before/after, the arithmetic cannot tell them apart, and item 587 is a RUST
    // change (`exec/fastpath.rs`). Its commit says what TS was on this row: **8362.9 ms**, "the TS
    // engine has no depth-3 rung at all, so it enumerates", against ffi 5.6 and wasm 11.7.
    //
    // So TS's history on this row is 8362.9 ms at item 587 -> ~141 ms isolated today (item 588 gave
    // it the level recurrence): a 59x IMPROVEMENT, and there is no regression here. Anyone comparing
    // a TS reading against 38.87 is comparing it to an old NATIVE number.
    //
    // Measured at 200,000 vertices / 600,000 edges, three alternated rounds, NATIVE before -> after:
    // WALK `{1,3}` 38.87ms -> 3.97 (9.8x), `{1,4}` 104.44 -> 5.01 (20.9x),
    // `repeat(out()).times(4).count()` 103.40 -> 4.39 (23.6x). Its PAIR is the depth-2 row above:
    // the two should stay within ~2x of each other, because the recurrence costs one pass per level,
    // and a gap that grows means the route stopped being taken. Isolated today that pair reads
    // 140.4/140.9/142.1 against 144.3/145.0/149.1 — 0.96x, so the route is being taken.
    name: 'count var-length 1-3 hops [WALK]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH WALK (a:Person)-[:KNOWS]->{1,3}(y) RETURN count(*) AS c'),
    ),
  },
  {
    // 🛑 THE ONLY VAR-LENGTH ROW HERE THAT ENUMERATES. Every `count(*)` var-length row above
    // takes a shortcut and never enters `trailEnds`'s flat walk — verified by throwing at its
    // entry (item 736): `{1,2}`, `{1,3}`, the end-filtered form and the WALK form all ANSWER.
    // A ROW-RETURNING var-length query enumerates at EVERY depth, which is the shape this row
    // covers and the one the whole corpus was missing.
    //
    // That absence cost something concrete: item 733 read its change as "neutral on the shallow
    // standing rows" when those rows cannot reach the code it changed — the unreachability null
    // of items 721-723, drawn in the very entry that cited them.
    //
    // START-FILTERED so it stays a bench row rather than a bulk dump: `age` is `i % 90`, so
    // `a.age = 7` takes ~N/90 sources, and `{1,3}` over degree 5 is 155 paths each — ~344k rows
    // at the default N. `y.age` is PRESENT on every node (unlike `name`, item 726), so this
    // prices a real property read and not an absent one.
    name: 'project var-length 1-3 hops + start filter [ENUMERATES]',
    ...onGraph(
      () => graphDoc,
      (e, g) =>
        void e.query(g, 'MATCH (a:Person WHERE a.age = 7)-[:KNOWS]->{1,3}(y) RETURN y.age AS c'),
    ),
  },
  {
    // THE DEFAULT SPELLING, which nothing watched until item 601. `parsePathMode` returns `trail`
    // when no mode keyword is given, so `-[:KNOWS]->{3}` — the natural way to write this — is a
    // TRAIL, and the row above is the only one the harness carried. The two are not the same
    // query: the trail forbids reusing an edge, so it answers FEWER paths, and at this depth it
    // had no rung at all in either engine (ts 1071.55ms against native 15.81 on a 20,000-vertex
    // degree-5 fixture, item 600).
    //
    // Kept at a FIXED depth rather than `{1,3}` so the row prices the depth-3 correction itself
    // rather than averaging it with two levels that were already fast.
    name: 'count 3-hop quantified [TRAIL, the default]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->{3}(y) RETURN count(*) AS c'),
    ),
  },
  {
    // DEPTH 4, the boundary of items 600-602's correction. Item 600 said plainly that "depth 4 is
    // measurement only; its terms are not derived"; items 687-689 derived them by reducing depth 4
    // to the depth-3 count plus one correction, item 692 built that in TYPESCRIPT and item 693
    // built it in RUST AND WASM.
    //
    // ⚠️ BOTH ENGINES NOW TAKE THE CLOSED FORM HERE. This row's comment claimed for a while that
    // "ffi still enumerates at ~82ms" and that "native is the open half", and the row was NAMED
    // "TS only" — all three outlived item 693 by describing the state item 692 left behind. At
    // 20,000 vertices the recorded figures are ts 3365.6 -> 18.3 (190x, item 692) and ffi
    // 82.4 -> 10.5 (7.8x, item 693), both reproduced at item 732 as ts 18.2-18.6 and ffi 10.6.
    //
    // ⚠️ AND THOSE FIGURES ARE AT 20,000 VERTICES, WHICH IS NOT WHAT THIS ROW RUNS. The bench
    // default is `BENCH_N=200000`, where the same two rows read ts 264.6 and ffi 122.7 (item 732).
    // A figure quoted in a row's comment is only comparable to a run at the N it was measured at;
    // pass `BENCH_N=20000` to compare against the numbers above.
    name: 'count 4-hop quantified [TRAIL]',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->{4}(y) RETURN count(*) AS c'),
    ),
  },
  // 🛑 THERE IS DELIBERATELY NO DEPTH-5 ROW, and the reason is the measurement itself.
  //
  // Depth 5 is the first depth neither engine has a closed form for — native refuses it in the
  // `deep_trail` gate (`fastpath.rs`) and says why: `u4` is four disjoint cases and what they
  // need from the adjacency is unpriced, which is item 686's rule. So its cost is the prize for
  // deriving `u4`, and item 732 priced it by adding this row, measuring, and taking it back out:
  //
  //   20,000 vertices    depth 4 (closed form)    depth 5 (enumerated)
  //   ts                 18.6 ms                  16,325.9     878x
  //   ffi                10.6 ms                  402.9         38x
  //
  // I carried the row for one measurement on item 692's precedent — its depth-4 row was carried
  // as "unbuilt" before the formula existed, which is what made 692/693 measurable the moment it
  // landed. That precedent does NOT transfer. Unbuilt depth 4 cost 82 ms on ffi; unbuilt depth 5
  // costs 16.3 SECONDS on ts at a tenth of this bench's default N, so at `BENCH_N=200000` over
  // five reps it would add something like a quarter-hour to a routine sweep. The corpus's slowest
  // row today is 13.2 s TOTAL. A regression sweep nobody runs because it takes a quarter-hour
  // catches nothing, so the number lives here and in item 732 instead of in the sweep.
  //
  // To re-price it, add the row back temporarily rather than reaching for `BENCH_N=200000`.
  {
    // The other half: the same walk, but PROJECTING an endpoint property, so 1,000,000 rows are
    // built. Traversal plus the row pipeline, which is the shape a user actually runs.
    // ⚠️ `x.name` IS ABSENT ON EVERY NODE OF `graphDoc` — its nodes carry only `age` (item 726).
    // So this row and the two below project a million NULLS, not a million strings: they price the
    // hop, the row plumbing and an absent-property read, NOT a property read.
    //
    // It matters most for `+ order by`, which therefore sorts a million IDENTICAL keys. Native
    // does that in ~1.4 ms (69.3 against 70.7 in an isolated probe) while TS pays ~155 — and the
    // 155 is NOT the comparisons: an all-equal short-circuit was built and measured 1.05x against
    // controls at 1.06-1.18x, because the real cost is being forced to MATERIALIZE a million rows
    // that the unordered row streams lazily. Read `+ order by` as "materialize + sort", and know
    // that its sort term is near zero on this fixture.
    //
    // Left pointing at `name` rather than repointed at `age`, so every figure recorded against
    // these row names stays comparable — the same call item 356 made about `decode ndjson`.
    name: 'traverse 1-hop project',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n'),
    ),
  },
  {
    // THE SAME HOP PROJECTION, SORTED (item 607). The row above is its unordered reference and
    // the control for it: a change admitting the sort must move this row and leave that one
    // alone. Sorting also forces the START-DRIVEN walk, because the far-driven one reorders rows
    // deliberately and tie order under `ORDER BY` is observable between the engines — so this row
    // additionally watches that the locality win is given up only where order matters.
    name: 'traverse 1-hop project + order by',
    ...onGraph(
      () => graphDoc,
      (e, g) => void e.query(g, 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n'),
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

/**
 * Minimum of `REPS` runs, in milliseconds.
 *
 * 🛑 THE SINGLE WARM CALL IS ADEQUATE HERE, AND IS NOT IN `bench-usage.ts` — do not carry item
 * 752's conclusion across (item 753). There the unit is ONE small operation, so one warm call
 * tiers up almost nothing, two index columns run in one process at different warmth, and
 * best-of-batches cannot absorb it because the bias is BETWEEN the cells being compared: a
 * parse-dominated row read 1.26-1.52x in the warmer column, which made indexing look like it
 * SPEEDS UP a write.
 *
 * Here the unit is a whole query over the fixture, so one call is a substantial warmup, and what
 * it leaves is absorbed by the min. Measured with `BENCH_REPS=1` against the default 5:
 *
 *   count 3-hop                        353.3 -> 312.5   (1.13x)
 *   query: project the element [ts lazy]  7.9 ->   6.6   (1.20x)
 *   traverse 1-hop + filter             44.6 ->  40.9   (1.09x)
 *
 * So the first timed run is 9-20% slow and the MIN discards it. The property that matters is not
 * the size of that residual but that **every column pays it identically** — each engine gets its
 * own warm call and its own min — so an engine-vs-engine ratio is not a warmth comparison. The
 * same holds for an A/B across two BUILDS, which runs each arm in its own process.
 */
const best = (f: () => void): number => {
  f(); // warm — see above for why one call is enough at this unit size

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

// ONE CASE PER PROCESS, which is what the repo's own rule asks for: "anything under ~10% needs
// its own isolated harness". Three separate items met that by hand before this existed, and item
// 307 needed it to attribute a 22% move on ONE row — a neighbour that runs first can warm the
// exact path the next case uses, so a multi-case probe cannot separate a regression from its
// neighbour's speedup (the `3 hop, count(d.k)` reading item 290 recorded).
// A trailing `$` makes it an EXACT match, which some rows need: `count 3-hop` is a substring of
// `count 3-hop + end filter` and two others, so there is no substring that selects it alone.
const ONLY = process.env.BENCH_ONLY;
const selectCases = (): typeof CASES => {
  if (ONLY === undefined) {
    return CASES;
  }

  if (ONLY.endsWith('$')) {
    const exact = ONLY.slice(0, -1);

    return CASES.filter((c) => c.name === exact);
  }

  return CASES.filter((c) => c.name.includes(ONLY));
};
const SELECTED = selectCases();

if (SELECTED.length === 0) {
  console.log(`BENCH_ONLY=${ONLY} matched no case`);
}

for (const c of SELECTED) {
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
