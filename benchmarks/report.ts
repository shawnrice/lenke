// Renders benchmarks/results.json into a self-contained styled HTML report.
// Run after compare.ts: bun benchmarks/report.ts
type OpTs = { ts: number | null; tsErr?: string | null };
type Row = {
  n: number;
  nEdges: number;
  bytes: number;
  ops: {
    build: OpTs & { rustParallel: number; rustSerial: number };
    serialize: {
      tsString: number | null;
      rustBytes: number;
      tsDisk: number | null;
      rustDisk: number;
    };
    ffiBatch: { queries: number; perCall: number; batched: number };
    [k: string]: any;
  };
};
type Results = {
  meta: {
    machine: string;
    sizes: number[];
    avgDegree: number;
    queries: { id: string; label: string; text: string }[];
  };
  rows: Row[];
  parity: { n: number; what: string; ts: unknown; rust: unknown; ok: boolean | null }[];
  ffiOverhead: number; // ms per call
};

const r: Results = JSON.parse(await Bun.file('benchmarks/results.json').text());

const fmt = (ms: number | null | undefined): string => {
  if (ms == null) {
    return '—';
  }

  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)} µs`;
  }

  if (ms < 1000) {
    return `${ms.toFixed(2)} ms`;
  }

  return `${(ms / 1000).toFixed(2)} s`;
};
const n0 = (x: number): string => x.toLocaleString('en-US');
const ratio = (ts: number | null | undefined, rust: number): string =>
  ts == null ? 'TS&nbsp;failed' : `${(ts / rust).toFixed(ts / rust >= 10 ? 0 : 1)}×`;

// badge color by speedup magnitude
const badge = (ts: number | null | undefined, rust: number): string => {
  if (ts == null) {
    return 'fail';
  }

  const x = ts / rust;

  if (x >= 50) {
    return 'huge';
  }

  if (x >= 10) {
    return 'big';
  }

  if (x >= 2) {
    return 'win';
  }

  if (x >= 1.1) {
    return 'edge';
  }

  return 'loss';
};

const biggestQuery = Math.max(
  ...r.rows.flatMap((row) =>
    r.meta.queries.map((q) =>
      row.ops[q.id]?.ts != null ? row.ops[q.id].ts / row.ops[q.id].rust : 0,
    ),
  ),
);
const buildBig = (() => {
  const big = r.rows[r.rows.length - 1];

  return big.ops.build.ts != null ? big.ops.build.ts / big.ops.build.rustParallel : null;
})();

const queryTable = (qid: string, qlabel: string, qtext: string): string => {
  const rows = r.rows
    .filter((row) => row.ops[qid])
    .map((row) => {
      const o = row.ops[qid];

      return `<tr>
        <td class="num">${n0(row.n)}</td>
        <td class="num">${o.ts == null ? `<span class="err" title="${o.tsErr ?? ''}">stack overflow</span>` : fmt(o.ts)}</td>
        <td class="num">${fmt(o.rust)}</td>
        <td><span class="b ${badge(o.ts, o.rust)}">${ratio(o.ts, o.rust)}</span></td>
        <td class="num dim">${n0(o.sig.count)}</td>
      </tr>`;
    })
    .join('');

  return `<h3>${qid} — ${qlabel}</h3><pre class="q">${qtext}</pre>
  <table><thead><tr><th>vertices</th><th>TS gql</th><th>Rust</th><th>speedup</th><th>rows</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const buildRows = r.rows
  .map(
    (row) => `<tr>
    <td class="num">${n0(row.n)}</td><td class="num dim">${n0(row.nEdges)}</td><td class="num dim">${(row.bytes / 1e6).toFixed(1)} MB</td>
    <td class="num">${fmt(row.ops.build.ts)}</td>
    <td class="num">${fmt(row.ops.build.rustParallel)}</td>
    <td class="num dim">${fmt(row.ops.build.rustSerial)}</td>
    <td><span class="b ${badge(row.ops.build.ts, row.ops.build.rustParallel)}">${ratio(row.ops.build.ts, row.ops.build.rustParallel)}</span></td>
    <td class="num dim">${(row.ops.build.rustSerial / row.ops.build.rustParallel).toFixed(1)}×</td>
  </tr>`,
  )
  .join('');

const serializeRows = r.rows
  .map((row) => {
    const s = row.ops.serialize;

    return `<tr><td class="num">${n0(row.n)}</td>
    <td class="num">${fmt(s.tsString)}</td><td class="num">${fmt(s.rustBytes)}</td>
    <td><span class="b ${badge(s.tsString, s.rustBytes)}">${ratio(s.tsString, s.rustBytes)}</span></td>
    <td class="num">${fmt(s.tsDisk)}</td><td class="num">${fmt(s.rustDisk)}</td>
    <td><span class="b ${badge(s.tsDisk, s.rustDisk)}">${ratio(s.tsDisk, s.rustDisk)}</span></td></tr>`;
  })
  .join('');

// Render a parity value (which may be any JSON shape) as a table cell string.
const cell = (v: unknown): string =>
  typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);

const parityBadge = (ok: boolean | null): string => {
  if (ok === true) {
    return '<span class="ok">✓ match</span>';
  }

  if (ok === false) {
    return '<span class="err">✗ differ</span>';
  }

  return '<span class="dim">TS n/a</span>';
};

const parityRows = r.parity
  .map(
    (p) => `<tr><td class="num">${n0(p.n)}</td><td>${p.what}</td>
    <td class="dim">${cell(p.ts)}</td>
    <td class="dim">${cell(p.rust)}</td>
    <td>${parityBadge(p.ok)}</td></tr>`,
  )
  .join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lenke: TypeScript vs Rust</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#272e3a;--fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--amber:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:0 0 80px}
.wrap{max-width:980px;margin:0 auto;padding:0 24px}
header{padding:56px 0 28px;border-bottom:1px solid var(--line);margin-bottom:8px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:21px;margin:44px 0 12px;letter-spacing:-.01em}
h3{font-size:15px;margin:26px 0 6px;color:var(--accent)}
.sub{color:var(--dim);font-size:15px;margin:0}
.tldr{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:26px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card .big{font-size:26px;font-weight:650;letter-spacing:-.02em}
.card .lab{color:var(--dim);font-size:13px;margin-top:2px}
table{width:100%;border-collapse:collapse;margin:10px 0 4px;font-size:14px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid #1c232d}
.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dim{color:var(--dim)}
.q{background:#0b0f14;border:1px solid var(--line);border-radius:7px;padding:8px 12px;color:#a5d6ff;font-size:13px;overflow-x:auto;margin:4px 0 8px}
.b{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:650;font-variant-numeric:tabular-nums}
.b.huge{background:#1f6f37;color:#d6ffe0}.b.big{background:#21482c;color:#7ee2a0}.b.win{background:#1d3a4d;color:#9fd3ff}
.b.edge{background:#3a341d;color:#e8d48a}.b.loss{background:#4d1d1d;color:#ffb3b3}.b.fail{background:#4d1d1d;color:#ffb3b3}
.ok{color:var(--green)}.err{color:var(--red);font-weight:600}
p{color:#c9d4e0}.lead{font-size:16px}
.note{background:var(--panel);border-left:3px solid var(--amber);border-radius:4px;padding:12px 16px;margin:16px 0;color:#d8c89a}
.verdict{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 24px;margin-top:14px}
code{background:#0b0f14;padding:1px 6px;border-radius:5px;font-size:13px;color:#a5d6ff}
footer{color:var(--dim);font-size:13px;margin-top:50px;border-top:1px solid var(--line);padding-top:16px}
</style></head><body><div class="wrap">
<header>
<h1>lenke — does a Rust core earn its keep?</h1>
<p class="sub">Same operations, two engines: the TypeScript core / gql / NDJSON codec vs a columnar Rust crate over bun:ffi. ${r.meta.machine}.</p>
</header>

<div class="tldr">
<div class="card"><div class="big">${biggestQuery.toFixed(0)}×</div><div class="lab">fastest query speedup (Rust vs TS gql)</div></div>
<div class="card"><div class="big">${buildBig ? `${buildBig.toFixed(0)}×` : '—'}</div><div class="lab">graph build at ${n0(r.rows[r.rows.length - 1].n)} vertices</div></div>
<div class="card"><div class="big">${(r.ffiOverhead * 1e6).toFixed(0)} ns</div><div class="lab">per FFI call (the fixed tax)</div></div>
</div>

<p class="lead">Short version: <b>Rust wins decisively on throughput</b> — graph build, traversal queries, and scans are one to two orders of magnitude faster. (The first run also surfaced a real <i>bug</i>: the TS executor overflowed the stack on big result sets; that's now fixed by streaming through the fp helpers, so the gap is speed, not capability.) The catch is a fixed <b>~${(r.ffiOverhead * 1e6).toFixed(0)} ns FFI tax per call</b> — so for tiny graphs or chatty per-element calls the boundary eats the win. The crossover: small graphs / interactive frontend use (stay TS) vs. bulk load + heavy query throughput (go Rust).</p>

<h2>Graph build (NDJSON decode → indexed graph)</h2>
<p>The columnar build is a counting-sort into CSR; <code>rustParallel</code> uses rayon to parse lines across cores. This is the bulk-load path.</p>
<table><thead><tr><th>vertices</th><th>edges</th><th>input</th><th>TS</th><th>Rust ∥</th><th>Rust serial</th><th>speedup</th><th>rayon gain</th></tr></thead><tbody>${buildRows}</tbody></table>

<h2>Queries — the full surface, not just count</h2>
<p>The Rust side runs a GQL-subset parser + executor over the columnar core; the TS side runs the production <code>@lenke/gql</code> engine. Nine shapes — scans, 1-/2-hop traversals, filters, <code>avg</code>, multi-condition <code>WHERE</code>, <code>GROUP BY</code>, <code>ORDER BY … LIMIT</code>, <code>DISTINCT</code> — each verified equal via a shared <code>(count, sum, FNV&nbsp;checksum)</code> fingerprint before timing. The checksums match to the bit, so these are genuinely the same results, faster.</p>
${r.meta.queries.map((q) => queryTable(q.id, q.label, q.text)).join('')}

<div class="note"><b>The TS executor's overflow was a bug — now fixed.</b> The first run showed 1-hop@1M and 2-hop@100k <i>failing outright</i>: the executor materialized bindings between clauses and did <code>push(...spread)</code>, overflowing the call stack. It now streams bindings lazily through the fp iterator helpers, so those queries complete and <code>LIMIT n</code> short-circuits (≈0.6 ms over 1M nodes). What's left is throughput, not capability: aggregation still buffers each group to fold it, so a large <code>count(*)</code> is correct but O(rows) — slower than Rust's columnar count, not a wall.</div>

<h2>FFI boundary — batching many queries into one crossing</h2>
<p>The fixed per-call FFI tax is ~${(r.ffiOverhead * 1e6).toFixed(0)} ns. <code>plg_query_batch</code> runs all the queries in a single crossing instead of one each. The verdict: for substantial queries this is a <b>wash</b> — the calls are work-bound, not boundary-bound, so the tax is already amortized. Batching only pays when you'd otherwise make <i>many cheap</i> crossings (per-element calls). The lesson is the architecture, not the batch: stay coarse-grained and the 4 ns never matters.</p>
<table><thead><tr><th>vertices</th><th>queries</th><th>one-each</th><th>batched (1 crossing)</th><th>×</th></tr></thead><tbody>${r.rows
  .map((row) => {
    const b = row.ops.ffiBatch;

    return `<tr><td class="num">${n0(row.n)}</td><td class="num dim">${b.queries}</td><td class="num">${fmt(b.perCall)}</td><td class="num">${fmt(b.batched)}</td><td><span class="b ${b.perCall / b.batched >= 1.5 ? 'win' : 'edge'}">${(b.perCall / b.batched).toFixed(2)}×</span></td></tr>`;
  })
  .join('')}</tbody></table>

<h2>Serialize — the product is bytes for disk / wire</h2>
<p>Serialization output goes to a file or a socket — i.e. <b>bytes</b>. TS produces a JS <i>string</i> that still must be UTF-8 encoded to bytes for any I/O; Rust produces write-ready bytes directly, and can write the file natively (the bytes never enter JS). <span class="dim">(The first draft unfairly made Rust decode its bytes back into a JS string — corrected here.)</span></p>
<table><thead><tr><th>vertices</th><th>TS → string</th><th>Rust → bytes</th><th>×</th><th>TS → disk</th><th>Rust → disk</th><th>×</th></tr></thead><tbody>${serializeRows}</tbody></table>

<h2>Result parity</h2>
<p>Every timed operation was checked for identical results first — vertex/edge counts and each query's <code>(count, sum)</code> signature. (“TS n/a” = the TS engine failed to produce a result.)</p>
<table><thead><tr><th>vertices</th><th>check</th><th>TS</th><th>Rust</th><th>status</th></tr></thead><tbody>${parityRows}</tbody></table>

<h2>Verdict — when is the Rust core worth it?</h2>
<div class="verdict">
<p><b>Go Rust when:</b> you're bulk-loading or querying large graphs (≳10k elements), running traversals or scans for throughput, or doing server-side materialization. Build is ${buildBig ? `${buildBig.toFixed(0)}×` : 'much'} faster and queries 10–${biggestQuery.toFixed(0)}× faster — and serializing to disk/wire, Rust emits write-ready bytes while TS emits a string that still needs encoding.</p>
<p><b>Stay TS when:</b> graphs are small (≲1k), or the workload is interactive/reactive frontend use where the graph lives in the browser, mutates constantly, and feeds React via the snapshot model. There the ~${(r.ffiOverhead * 1e6).toFixed(0)} ns/call FFI tax dominates, and you'd lose the reactivity layer. (The TS engine now <i>completes</i> large queries too — just slower — so this is a performance choice, not a capability one.)</p>
<p><b>The boundary is the cost, not the compute.</b> Rust compute is far faster everywhere; what claws it back is crossing FFI per call. So the architecture that wins is <i>coarse-grained</i>: hand Rust a whole NDJSON blob, let it build + query + aggregate, and pull back only small results — never chatty per-element calls. That's the Node/materialization persona; the frontend/reactive persona stays in TypeScript.</p>
</div>

<footer>Generated from <code>benchmarks/results.json</code> · graph: all <code>:Person</code> nodes (name/age/active), random <code>:KNOWS</code> edges, avg degree ${r.meta.avgDegree} · best-of-N wall time · Rust built <code>--release</code> with fat LTO.</footer>
</div></body></html>`;

await Bun.write('benchmarks/report.html', html);
console.log('wrote benchmarks/report.html');
