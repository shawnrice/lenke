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
