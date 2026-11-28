/*
 * Item 2508: WHAT DOES AN OPEN TRANSACTION RETAIN PER WRITE?
 *
 * Every memory instrument in this repo measures the READ side — `peakmem-2419` sweeps GQL walks,
 * `retained-2457` sweeps Gremlin steps, `bare-hop-retain-2504` the chain CSR. **The write side has
 * never been measured at all**: `undo log` appears 13 times in `CLOSED.md` and ZERO times in
 * `PROBES.md`, so it is discussed and uninstrumented.
 *
 * It is the same question as the read-side one and it has a sharper edge: a transaction must hold
 * enough to undo itself, so **how large a transaction can run before the process dies** is a hard
 * limit on batch size, import size and any "apply these N changes atomically" feature. `Graph`
 * carries SEVEN per-transaction structures — `txUndo`, `txMarks`, `txEvents`, `txTokens`,
 * `txTouched`, `txTouchedEdges`, `txDepth` — and a priori any of them could be the one that scales.
 *
 * ## THE DESIGN
 *
 *   - **A self-controlling pair**: the SAME writes, run once with and once without the transaction
 *     wrapper. The difference is the transaction's own bookkeeping, with no modelling needed.
 *   - **Per-write bytes, swept over N**, so a per-write cost separates from a fixed one. A
 *     transaction that holds O(1) is a different product from one that holds O(writes).
 *   - **Direct ATTRIBUTION instead of inference**: the probe reads the lengths/sizes of all seven
 *     structures at peak. Item 2505 named a cost by deletion because nothing exposed it; here the
 *     engine exposes the candidates, so there is no reason to guess which one it is.
 *   - **One shape per PROCESS** (item 2504), and `global.gc()` before each sample — occupancy
 *     without a collection counts garbage and inverted a whole family once (item 2457).
 *
 * TWO WRITE KINDS, because they have different undo shapes: `addVertex` creates (undo = delete) and
 * `setProperty` mutates (undo = restore the OLD value, which must be captured and held).
 *
 *     node tx-retain-2508.mjs
 *     TX_N=200000 node tx-retain-2508.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const SIZES = (process.env.TX_SIZES ?? '25000,50000,100000').split(',').map(Number);

/** Length, size, or the number itself — the seven tx structures are a mix of arrays, Sets and ints. */
const sizeOf = (x) => {
  if (x === undefined || x === null) {
    return 0;
  }

  if (typeof x === 'number') {
    return x;
  }

  return x.length ?? x.size ?? 0;
};

if (process.env.ARM === 'child') {
  const { Graph } = await import('@lenke/core');
  const n = Number(process.env.TX_N);
  const shape = process.env.SHAPE;
  const inTx = shape.startsWith('tx');
  const isSet = shape.endsWith('set');

  const graph = new Graph();

  /* For the `set` arms the vertices must already exist, and they are NOT part of what is measured. */
  const seeded = [];

  if (isSet) {
    for (let i = 0; i < n; i += 1) {
      seeded.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
    }
  }

  const writes = () => {
    if (isSet) {
      for (let i = 0; i < n; i += 1) {
        seeded[i].setProperty('k', i + 1);
      }

      return;
    }

    for (let i = 0; i < n; i += 1) {
      graph.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
    }
  };

  global.gc();
  const base = process.memoryUsage().heapUsed;
  let structs = {};
  let peak = 0;

  if (inTx) {
    graph.beginTransaction();
    writes();
    /* Read the bookkeeping BEFORE committing — after the commit it is all released. */
    structs = {
      txUndo: sizeOf(graph.txUndo),
      txMarks: sizeOf(graph.txMarks),
      txEvents: sizeOf(graph.txEvents),
      txTokens: sizeOf(graph.txTokens),
      txTouched: sizeOf(graph.txTouched),
      txTouchedEdges: sizeOf(graph.txTouchedEdges),
      txDepth: sizeOf(graph.txDepth),
    };
    global.gc();
    peak = process.memoryUsage().heapUsed - base;

    graph.commitTransaction();
  } else {
    writes();
    global.gc();
    peak = process.memoryUsage().heapUsed - base;
  }

  process.stdout.write(
    `${JSON.stringify({ n, mib: peak / 1024 / 1024, vtx: graph.vertexCount, structs })}\n`,
  );
  process.exit(0);
}

const one = (shape, n) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', SHAPE: shape, TX_N: String(n) },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(
  '# What an OPEN TRANSACTION retains per write  (one shape per process, gc before sample)',
);
console.log('# The pair is the SAME writes with and without the transaction wrapper.');
console.log('# A per-write cost separates from a fixed one by sweeping N.\n');

for (const kind of ['add', 'set']) {
  console.log(
    `  ${kind === 'add' ? 'addVertex (undo = delete)' : 'setProperty (undo = old value)'}`,
  );
  console.log('       N      no tx        in tx      delta   B/write');

  for (const n of SIZES) {
    const plain = one(`plain_${kind}`, n);
    const tx = one(`tx_${kind}`, n);
    const delta = tx.mib - plain.mib;

    const cols = [
      String(n).padStart(7),
      `${plain.mib.toFixed(2).padStart(9)} MiB`,
      `${tx.mib.toFixed(2).padStart(9)} MiB`,
      delta.toFixed(2).padStart(9),
      ((delta * 1024 * 1024) / n).toFixed(1).padStart(8),
    ];

    console.log(`  ${cols.join(' ')}`);
  }

  const probe = one(`tx_${kind}`, SIZES[SIZES.length - 1]);

  console.log(`    structures at N=${probe.n}: ${JSON.stringify(probe.structs)}`);
  console.log();
}

console.log('  A structure whose size EQUALS N is the one that scales; read them, do not guess.');
