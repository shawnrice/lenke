/**
 * WHAT DOES THE WASM ENGINE COST IN MEMORY, and does it grow with the walk? The instrument none of
 * items 2416-2419 could provide.
 *
 * ## WHY THIS NEEDED A NEW INSTRUMENT RATHER THAN A NEW SHAPE
 *
 * Items 2416-2419 built four memory instruments — churn, retained bytes, GC share, peak live and the
 * minimum-heap bisection — and every one of them reads the JS heap. **`process.memoryUsage()` is
 * BLIND to wasm linear memory, measured:** growing an instance's memory from 1.3 MB to 66.8 MB moved
 * `arrayBuffers` by ZERO (flat at 4,688,816) and `external` by 0.1 MB. So the wasm engine has had no
 * memory coverage of any kind, while `CLAUDE.md` records that the CLI is wasm-only and that a wasm
 * OOM surfaces as a bare `RuntimeError: unreachable`. That is the worst combination available: the
 * engine most likely to run out of memory was the one nothing could measure.
 *
 * ## AND IT IS THE BEST-POSED MEMORY INSTRUMENT IN THE REPO
 *
 * wasm linear memory NEVER SHRINKS. So `memory.buffer.byteLength` after a query is an EXACT
 * high-water mark — none of the compromises the JS side carries:
 *
 *     JS peak (item 2419)                          wasm peak (here)
 *       a LOWER BOUND, sampled at GC points          EXACT, monotonic by construction
 *       accurate to one nursery (~1-16 MiB)          accurate to one PAGE (64 KiB)
 *       needs a forced GC, then discounts it         needs nothing
 *       a process-wide mark buries a small phase     scoped to the instance
 *
 * The cost is that it measures the engine's own allocator rather than a query's live set: memory
 * freed inside wasm stays owned by the instance, so this reports the HIGH WATER the instance ever
 * needed, which is exactly the number an OOM is about.
 *
 *     bun wasmmem-2425.mjs                 # calibrate, then every shape
 *     NODES=200000 bun wasmmem-2425.mjs
 *     SHAPE=hop1 bun wasmmem-2425.mjs
 */
import { readFileSync } from 'node:fs';

import { createWasmEngineParts } from './src/backend-wasm-engine.js';
import { graphFromNdjson } from './src/graph.js';

const WASM =
  '../../crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm';
const NODES = Number(process.env.NODES ?? 50_000);
/**
 * FANOUT, and it is what makes a query's figure visible at all.
 *
 * The first run of this probe reported **0 pages for every shape** while the LOAD grew 37.19 MiB:
 * at FANOUT=1 a k-hop walk returns |V| rows whatever k is, so every query fits inside the slack the
 * load already reserved and the instrument correctly reports nothing. A query only moves the high
 * water when it needs MORE than the graph build did — which is the OOM condition, and which needs
 * the row count to outgrow the element count. Above fanout 1 a k-hop returns `|V| * F^k`.
 */
const FANOUT = Number(process.env.FANOUT ?? 1);
const SHAPE = process.env.SHAPE ?? 'all';
const PAGE = 65_536;
const MIB = 1024 * 1024;

const SHAPES = {
  rows: 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k',
  hop1sum: 'MATCH (a:P)-[:E]->(x:P) RETURN sum(x.k) AS s',
  hop1count: 'MATCH (a:P)-[:E]->(x:P) RETURN count(*) AS c',
  hop1distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k',
  hop2: 'MATCH (a:P)-[:E]->(x:P)-[:E]->(y:P) RETURN y.k AS k',
  hop2sum: 'MATCH (a:P)-[:E]->(x:P)-[:E]->(y:P) RETURN sum(y.k) AS s',
  // THREE hops, which at FANOUT>1 returns `|V| * F^3` rows — the shape that can outgrow the graph
  // and so the one that can force the instance to grow.
  hop3: 'MATCH (a:P)-[:E]->(x:P)-[:E]->(y:P)-[:E]->(z:P) RETURN z.k AS k',
  hop3sum: 'MATCH (a:P)-[:E]->(x:P)-[:E]->(y:P)-[:E]->(z:P) RETURN sum(z.k) AS s',
};

/** An NDJSON graph, which is how the wasm engine is loaded (there is no host object graph). */
const ndjson = (nodes) => {
  const lines = [];

  for (let i = 0; i < nodes; i += 1) {
    lines.push(
      JSON.stringify({ type: 'node', id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }),
    );
  }

  for (let e = 0; e < nodes * FANOUT; e += 1) {
    const i = e % nodes;
    const hop = Math.floor(e / nodes);

    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${e}`,
        from: `v${i}`,
        // Splits on the REPEAT INDEX — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
        to: `v${(i * 7 + 3 + hop * 2_654_435_761) % nodes}`,
        labels: ['E'],
        properties: {},
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

const fresh = async () => {
  // A FRESH INSTANCE PER MEASUREMENT, and that is load-bearing: linear memory never shrinks, so a
  // reused instance reports the high water of every shape that ran before it. One shape per
  // instance is this repo's "one shape per process" rule, at the granularity wasm needs.
  const bytes = readFileSync(new URL(WASM, import.meta.url));

  return createWasmEngineParts(bytes);
};

const show = (label, before, after, extra = '') => {
  const grew = after - before;

  console.log(
    `  ${label.padEnd(14)} ${(before / MIB).toFixed(2).padStart(7)} -> ` +
      `${(after / MIB).toFixed(2).padStart(7)} MiB   grew ${(grew / MIB).toFixed(2).padStart(7)} MiB ` +
      `(${String(grew / PAGE)} pages)${extra}`,
  );
};

// ── CALIBRATION ─────────────────────────────────────────────────────────────────────────────────

const { linearMemoryBytes } = await fresh();
const base = linearMemoryBytes();

console.log(`# CALIBRATION  a fresh instance starts at ${(base / MIB).toFixed(2)} MiB`);
console.log(
  '#   the reader must track a DELIBERATE grow exactly, or nothing below is a measurement',
);

// Not reachable through the backend, so the calibration instantiates one directly: the claim being
// checked is that the reader reports what the instance actually holds.
{
  const bytes = readFileSync(new URL(WASM, import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const mem = instance.exports.memory;
  const b0 = mem.buffer.byteLength;

  mem.grow(160);

  const b1 = mem.buffer.byteLength;
  const want = 160 * PAGE;
  const got = b1 - b0;

  console.log(
    `  grow(160 pages)  reported ${(got / MIB).toFixed(2)} MiB against ${(want / MIB).toFixed(2)} ` +
      `expected  ${got === want ? 'EXACT' : 'WRONG — do not read the rows below'}`,
  );
}

// ── THE SHAPES ──────────────────────────────────────────────────────────────────────────────────

const text = ndjson(NODES);
const names = SHAPE === 'all' ? Object.keys(SHAPES) : [SHAPE];

console.log(
  `\n# wasm linear memory per shape, NODES=${String(NODES)} FANOUT=${String(FANOUT)} (a FRESH instance each)`,
);

// The LOAD is measured on its own, because it dwarfs every query and a shape's figure is only
// meaningful as the growth ON TOP of a loaded graph.
{
  const parts = await fresh();
  const before = parts.linearMemoryBytes();

  const loaded = graphFromNdjson(parts.backend, text);

  show(
    'LOAD the graph',
    before,
    parts.linearMemoryBytes(),
    `  ${String(NODES)} nodes, F=${String(FANOUT)}`,
  );
  loaded.free();
}

for (const name of names) {
  const q = SHAPES[name];

  if (q === undefined) {
    throw new Error(`unknown SHAPE ${name}; have ${Object.keys(SHAPES).join('|')}`);
  }

  const parts = await fresh();
  const g = graphFromNdjson(parts.backend, text);
  const before = parts.linearMemoryBytes();
  let rows = 0;

  try {
    const out = g.query(q);

    rows = Array.isArray(out) ? out.length : 0;
  } catch (err) {
    // A TRAP IS THE MEASUREMENT, not a failure: `CLAUDE.md` records that a wasm OOM surfaces as
    // `RuntimeError: unreachable`, and the growth up to that point is how much it got through.
    show(name, before, parts.linearMemoryBytes(), `  THREW: ${String(err.message).slice(0, 44)}`);
    g.free();
    continue;
  }

  show(name, before, parts.linearMemoryBytes(), `  rows ${String(rows)}`);
  g.free();
}

console.log(
  '#   growth is the EXACT high water the instance needed for that query — linear memory never\n' +
    '#   shrinks, so this is a mark and not a sample. A shape that grows nothing fits in what the\n' +
    '#   load already reserved.',
);
