// TS-vs-Rust comparison harness. Runs identical operations on the TS engine
// (@pl-graph/core + gql + serialization) and the native Rust crate (via
// bun:ffi), asserts result-parity via a shared (count, sum, checksum)
// fingerprint, then times both. Writes results.json for the report.
import { writeFileSync } from 'node:fs';

import { Graph } from '@pl-graph/core';

import { query as gqlQuery } from '../packages/gql/src/index.js';
import { ndjsonCodec } from '../packages/serialization/src/index.js';
import { genNdjson } from './datagen.ts';
import * as rust from './rust.ts';

type Sig = rust.Sig; // { count, sum, checksum: bigint }

const QUERIES = [
  { id: 'Q1', label: 'label scan count', text: 'MATCH (a:Person) RETURN count(*)', maxN: Infinity },
  {
    id: 'Q2',
    label: 'filter + project',
    text: 'MATCH (a:Person) WHERE a.age > 50 RETURN a.age',
    maxN: Infinity,
  },
  {
    id: 'Q3',
    label: '1-hop traversal count',
    text: 'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN count(*)',
    maxN: Infinity,
  },
  {
    id: 'Q4',
    label: '2-hop traversal count',
    text: 'MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN count(*)',
    maxN: 100_000,
  },
  { id: 'Q5', label: 'avg aggregate', text: 'MATCH (a:Person) RETURN avg(a.age)', maxN: Infinity },
  {
    id: 'Q6',
    label: 'multi-condition WHERE',
    text: 'MATCH (a:Person) WHERE a.age > 30 AND a.active = true RETURN count(*)',
    maxN: Infinity,
  },
  { id: 'Q7', label: 'GROUP BY', text: 'MATCH (a:Person) RETURN a.dept, count(*)', maxN: Infinity },
  {
    id: 'Q8',
    label: 'ORDER BY + LIMIT',
    text: 'MATCH (a:Person) RETURN a.age ORDER BY a.age DESC LIMIT 100',
    maxN: Infinity,
  },
  { id: 'Q9', label: 'DISTINCT', text: 'MATCH (a:Person) RETURN DISTINCT a.dept', maxN: Infinity },
] as const;

// ---- FNV-1a fingerprint, byte-identical to the Rust executor ----
const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;
const te = new TextEncoder();
const i64 = new DataView(new ArrayBuffer(8));

const fnvBytes = (h: bigint, bytes: Uint8Array): bigint => {
  let acc = h;

  for (const b of bytes) {
    acc = (acc ^ BigInt(b)) & MASK64;
    acc = (acc * FNV_PRIME) & MASK64;
  }

  return acc;
};
const hashRow = (values: unknown[]): bigint => {
  let h = FNV_OFFSET;

  for (const v of values) {
    if (typeof v === 'string') {
      h = fnvBytes(h, te.encode(v));
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      i64.setBigInt64(0, BigInt(v), true);
      h = fnvBytes(h, new Uint8Array(i64.buffer.slice(0)));
    }
  }

  return h;
};
const tsFingerprint = (rows: Record<string, unknown>[]): Sig => {
  let sum = 0;
  let checksum = 0n;

  for (const row of rows) {
    const values = Object.values(row);

    for (const v of values) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
      }
    }

    checksum = (checksum + hashRow(values)) & MASK64;
  }

  return { count: rows.length, sum, checksum };
};
const sigEq = (a: Sig, b: Sig): boolean =>
  a.count === b.count && Math.abs(a.sum - b.sum) < 1e-3 && a.checksum === b.checksum;
const sigStore = (s: Sig | null) => (s ? { count: s.count, sum: s.sum } : null);

const bench = (reps: number, fn: () => void): number => {
  fn();
  let best = Infinity;

  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }

  return best;
};
const safeBench = (reps: number, fn: () => void): { ms: number | null; error: string | null } => {
  try {
    return { ms: bench(reps, fn), error: null };
  } catch (e) {
    return { ms: null, error: String(e).split('\n')[0] };
  }
};

const repsFor = (n: number): number => {
  if (n >= 1_000_000) {
    return 2;
  }

  if (n >= 100_000) {
    return 5;
  }

  return 20;
};

// Format a benchmark milliseconds value, or `ERR` when the measurement failed.
const bn = (x: number | null) => (x === null ? 'ERR' : x.toFixed(1));

const SIZES = [1_000, 10_000, 100_000, 1_000_000];
const AVG_DEGREE = 4;

const results: any = {
  meta: {
    machine: 'aarch64, target-cpu=native',
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
  console.log(
    `=== ${n.toLocaleString()} vertices, ${(n * AVG_DEGREE).toLocaleString()} edges (reps=${reps}) ===`,
  );
  const ds = genNdjson(n, AVG_DEGREE);
  const bytes = new TextEncoder().encode(ds.ndjson);

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

  const tg = ndjsonCodec.decode(ds.ndjson, new Graph());
  const rh = rust.loadGraph(bytes, true);

  const tsV = [...tg.vertices].length;
  const tsE = [...tg.edges].length;
  results.parity.push({
    n,
    what: 'vertexCount',
    ts: tsV,
    rust: rust.vertexCount(rh),
    ok: tsV === rust.vertexCount(rh),
  });
  results.parity.push({
    n,
    what: 'edgeCount',
    ts: tsE,
    rust: rust.edgeCount(rh),
    ok: tsE === rust.edgeCount(rh),
  });

  const row: any = { n, nEdges: ds.nEdges, bytes: bytes.length, ops: {} };
  row.ops.build = {
    ts: tsBuild.ms,
    tsErr: tsBuild.error,
    rustParallel: rustBuildPar,
    rustSerial: rustBuildSer,
  };

  for (const q of QUERIES) {
    if (n > q.maxN) {
      continue;
    }

    const rSig = rust.runQuery(rh, q.text);
    let tSig: Sig | null = null;

    try {
      tSig = tsFingerprint(gqlQuery(tg, q.text) as Record<string, unknown>[]);
    } catch {
      // TS engine couldn't produce the result — recorded below.
    }

    const ok = tSig ? sigEq(tSig, rSig) : null;
    results.parity.push({
      n,
      what: `${q.id} fingerprint`,
      ts: sigStore(tSig),
      rust: sigStore(rSig),
      ok,
    });

    if (ok === false) {
      console.log(
        `  !! PARITY MISMATCH ${q.id}: ts=${JSON.stringify(sigStore(tSig))}/${tSig?.checksum} rust=${JSON.stringify(sigStore(rSig))}/${rSig.checksum}`,
      );
    }

    const tsT = safeBench(reps, () => {
      tsFingerprint(gqlQuery(tg, q.text) as Record<string, unknown>[]);
    });
    const rustT = bench(reps, () => {
      rust.runQuery(rh, q.text);
    });
    row.ops[q.id] = {
      label: q.label,
      ts: tsT.ms,
      tsErr: tsT.error,
      rust: rustT,
      sig: sigStore(rSig),
    };
    const ratio = tsT.ms === null ? 'TS-FAILED' : `${(tsT.ms / rustT).toFixed(1)}x`;
    console.log(
      `  ${q.id} ${q.label}: ts=${tsT.ms === null ? `ERR` : `${tsT.ms.toFixed(3)}ms`} rust=${rustT.toFixed(3)}ms (${ratio})`,
    );
  }

  // ---- FFI boundary: all queries in ONE crossing vs N crossings ----
  const allQ = QUERIES.filter((q) => n <= q.maxN).map((q) => q.text);
  const perCall = bench(reps, () => {
    for (const t of allQ) {
      rust.runQuery(rh, t);
    }
  });
  const batched = bench(reps, () => {
    rust.runQueryBatch(rh, allQ);
  });
  row.ops.ffiBatch = { queries: allQ.length, perCall, batched };
  console.log(
    `  FFI batch: ${allQ.length} queries — perCall=${perCall.toFixed(3)}ms batched=${batched.toFixed(3)}ms (${(perCall / batched).toFixed(2)}x)`,
  );

  // ---- serialize: product is bytes for disk/wire ----
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
  console.log(
    `  build: ts=${bn(tsBuild.ms)}ms rustPar=${rustBuildPar.toFixed(1)}ms rustSer=${rustBuildSer.toFixed(1)}ms`,
  );
  console.log(
    `  serialize→string: ts=${bn(tsString.ms)} rust→bytes=${rustBytes.toFixed(1)} | →disk: ts=${bn(tsDisk.ms)} rust=${rustDisk.toFixed(1)}\n`,
  );

  rust.freeGraph(rh);
  results.rows.push(row);
}

results.ffiOverhead =
  bench(100, () => {
    for (let i = 0; i < 1000; i++) {
      rust.abiVersion();
    }
  }) / 1000;
console.log(`per-FFI-call overhead: ${(results.ffiOverhead * 1e6).toFixed(1)} ns`);

await Bun.write('benchmarks/results.json', JSON.stringify(results, null, 2));
console.log('\nwrote benchmarks/results.json');
