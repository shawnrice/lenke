// TS-vs-Rust comparison harness. For each graph size it runs identical
// operations on the TS engine (@pl-graph/core + gql + serialization) and the
// native Rust crate (via bun:ffi), asserts result-parity, then times both.
// Writes results.json for the report generator.
import { writeFileSync } from 'node:fs';
import { Graph } from '@pl-graph/core';
import { query as gqlQuery } from '../packages/gql/src/index.js';
import { ndjsonCodec } from '../packages/serialization/src/index.js';
import { genNdjson } from './datagen.ts';
import * as rust from './rust.ts';

type Sig = { count: number; sum: number };

const QUERIES = [
  { id: 'Q1', label: 'label scan count', text: 'MATCH (a:Person) RETURN count(*)', kind: 'count', maxN: Infinity },
  { id: 'Q2', label: 'filter + project (SIMD-able)', text: 'MATCH (a:Person) WHERE a.age > 50 RETURN a.age', kind: 'project', key: 'a.age', maxN: Infinity },
  { id: 'Q3', label: '1-hop traversal count', text: 'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN count(*)', kind: 'count', maxN: Infinity },
  { id: 'Q4', label: '2-hop traversal count', text: 'MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN count(*)', kind: 'count', maxN: 100_000 },
] as const;

const tsSig = (rows: Record<string, unknown>[], q: (typeof QUERIES)[number]): Sig => {
  if (q.kind === 'count') {
    const v = rows.length ? Number(Object.values(rows[0]!)[0]) : 0;
    return { count: v, sum: 0 };
  }
  let sum = 0;
  for (const r of rows) {
    sum += Number((r as Record<string, unknown>)[(q as { key: string }).key] ?? 0);
  }
  return { count: rows.length, sum };
};

const sigEq = (a: Sig, b: Sig): boolean => a.count === b.count && Math.abs(a.sum - b.sum) < 1e-3;

const bench = (reps: number, fn: () => void): number => {
  fn(); // warm
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

// Catches engine failures (e.g. the TS executor's stack overflow on large
// result sets) so one blown op doesn't abort the whole sweep — the failure is
// itself a recorded result.
const safeBench = (reps: number, fn: () => void): { ms: number | null; error: string | null } => {
  try {
    return { ms: bench(reps, fn), error: null };
  } catch (e) {
    return { ms: null, error: String(e).split('\n')[0] };
  }
};

const repsFor = (n: number): number => (n >= 1_000_000 ? 2 : n >= 100_000 ? 5 : 20);

const SIZES = [1_000, 10_000, 100_000, 1_000_000];
const AVG_DEGREE = 4;

const results: any = {
  meta: {
    machine: 'Apple M3 Max',
    sizes: SIZES,
    avgDegree: AVG_DEGREE,
    queries: QUERIES.map((q) => ({ id: q.id, label: q.label, text: q.text })),
  },
  rows: [],
  parity: [],
};

console.log(`ABI v${rust.abiVersion()} loaded\n`);

for (const n of SIZES) {
  const reps = repsFor(n);
  console.log(`=== ${n.toLocaleString()} vertices, ${(n * AVG_DEGREE).toLocaleString()} edges (reps=${reps}) ===`);
  const ds = genNdjson(n, AVG_DEGREE);
  const bytes = new TextEncoder().encode(ds.ndjson);

  // ---- build / load ----
  const tsBuild = safeBench(reps, () => {
    ndjsonCodec.decode(ds.ndjson, new Graph());
  });
  const rustBuildPar = bench(reps, () => {
    const h = rust.loadGraph(bytes, true);
    rust.freeGraph(h);
  });
  const rustBuildSer = bench(reps, () => {
    const h = rust.loadGraph(bytes, false);
    rust.freeGraph(h);
  });

  // persistent graphs for the query/encode phase
  const tg = ndjsonCodec.decode(ds.ndjson, new Graph());
  const rh = rust.loadGraph(bytes, true);

  // ---- parity: counts ----
  const tsV = [...tg.vertices].length;
  const tsE = [...tg.edges].length;
  results.parity.push({ n, what: 'vertexCount', ts: tsV, rust: rust.vertexCount(rh), ok: tsV === rust.vertexCount(rh) });
  results.parity.push({ n, what: 'edgeCount', ts: tsE, rust: rust.edgeCount(rh), ok: tsE === rust.edgeCount(rh) });

  const row: any = { n, nEdges: ds.nEdges, bytes: bytes.length, ops: {} };
  row.ops.build = { ts: tsBuild.ms, tsErr: tsBuild.error, rustParallel: rustBuildPar, rustSerial: rustBuildSer };

  // ---- queries ----
  for (const q of QUERIES) {
    if (n > q.maxN) {
      continue;
    }
    const rSig = rust.runQuery(rh, q.text);
    let tSig: Sig | null = null;
    try {
      tSig = tsSig(gqlQuery(tg, q.text) as Record<string, unknown>[], q);
    } catch {
      // TS engine couldn't produce the result (e.g. stack overflow) — recorded below.
    }
    const ok = tSig ? sigEq(tSig, rSig) : null;
    results.parity.push({ n, what: `${q.id} signature`, ts: tSig, rust: rSig, ok });
    if (ok === false) {
      console.log(`  !! PARITY MISMATCH ${q.id}: ts=${JSON.stringify(tSig)} rust=${JSON.stringify(rSig)}`);
    }
    const tsT = safeBench(reps, () => {
      tsSig(gqlQuery(tg, q.text) as Record<string, unknown>[], q);
    });
    const rustT = bench(reps, () => {
      rust.runQuery(rh, q.text);
    });
    row.ops[q.id] = { label: q.label, ts: tsT.ms, tsErr: tsT.error, rust: rustT, sig: rSig };
    const ratio = tsT.ms === null ? 'TS-FAILED' : `${(tsT.ms / rustT).toFixed(1)}x`;
    console.log(
      `  ${q.id} ${q.label}: ts=${tsT.ms === null ? `ERR(${tsT.error})` : `${tsT.ms.toFixed(3)}ms`} rust=${rustT.toFixed(3)}ms (${ratio})`,
    );
  }

  // ---- predicate scan: Rust scalar vs NEON, plus a JS baseline ----
  const ages: number[] = [];
  for (const v of tg.vertices) {
    const a = (v.properties as { age?: number }).age;
    if (typeof a === 'number') {
      ages.push(a);
    }
  }
  const jsScan = bench(reps, () => {
    let c = 0;
    let s = 0;
    for (const a of ages) {
      if (a > 50) {
        c++;
        s += a;
      }
    }
    if (c < 0) throw 0;
  });
  const rScalar = bench(reps, () => rust.predicateScan(rh, 'age', 50, false));
  const rNeon = bench(reps, () => rust.predicateScan(rh, 'age', 50, true));
  row.ops.predicateScan = { jsLoop: jsScan, rustScalar: rScalar, rustNeon: rNeon };
  console.log(`  predicate-scan age>50: js=${jsScan.toFixed(3)} rustScalar=${rScalar.toFixed(3)} rustNeon=${rNeon.toFixed(3)} (neon ${(rScalar / rNeon).toFixed(2)}x scalar)`);

  // ---- serialize: the product is bytes destined for disk or wire ----
  // TS produces a JS string (which still must be UTF-8 encoded to bytes for any
  // I/O); Rust produces write-ready bytes directly, and can write the file
  // natively without the bytes ever entering JS.
  const tsString = safeBench(reps, () => {
    ndjsonCodec.encode(tg);
  });
  const rustBytes = bench(reps, () => {
    rust.encodeBytes(rh);
  });
  const tsDisk = safeBench(reps, () => {
    writeFileSync('/tmp/plg-ts.ndjson', ndjsonCodec.encode(tg));
  });
  const rustDisk = bench(reps, () => {
    rust.writeNdjson(rh, '/tmp/plg-rust.ndjson');
  });
  row.ops.serialize = {
    tsString: tsString.ms,
    tsStringErr: tsString.error,
    rustBytes,
    tsDisk: tsDisk.ms,
    tsDiskErr: tsDisk.error,
    rustDisk,
  };
  const bn = (x: number | null) => (x === null ? 'ERR' : x.toFixed(1));
  console.log(`  build: ts=${bn(tsBuild.ms)}ms rustPar=${rustBuildPar.toFixed(1)}ms rustSer=${rustBuildSer.toFixed(1)}ms`);
  console.log(
    `  serialize→string: ts=${bn(tsString.ms)} rust→bytes=${rustBytes.toFixed(1)} | →disk: ts=${bn(tsDisk.ms)} rust=${rustDisk.toFixed(1)}\n`,
  );

  rust.freeGraph(rh);
  results.rows.push(row);
}

// ---- FFI call overhead (the fixed tax per crossing) ----
results.ffiOverhead = bench(100, () => {
  for (let i = 0; i < 1000; i++) {
    rust.abiVersion();
  }
}) / 1000;
console.log(`per-FFI-call overhead: ${(results.ffiOverhead * 1e6).toFixed(1)} ns`);

await Bun.write('benchmarks/results.json', JSON.stringify(results, null, 2));
console.log('\nwrote benchmarks/results.json');
