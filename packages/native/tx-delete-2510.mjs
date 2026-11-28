/*
 * Item 2510: IS THE UNDO OF A DELETE O(1) OR O(DEGREE)?
 *
 * Items 2508/2509 measured and attributed the per-write cost of an open transaction — ~162 B for a
 * create, ~273 B for an update, linear in the write count. **Both of those arms are per-write by
 * construction and neither is a DELETE.** Applying this session's own method to my own instrument:
 * `tx-retain-2508.mjs`'s shape table has `add` and `set` and nothing else, `removeVertex` has ZERO
 * mentions in `PROBES.md`, and "delete in a transaction" appears nowhere in either store.
 *
 * It matters because a delete is the one write whose undo is not obviously bounded. `removeVertex`
 * CASCADES to the incident edges, so rolling it back has to restore the vertex AND every edge that
 * went with it. If the undo entry holds those edges, **a transaction's memory stops being a function
 * of the write COUNT and becomes a function of the DEGREE of what it deletes** — and nothing in the
 * headroom budget from item 2508 accounts for that.
 *
 * ## THE AXIS IS DEGREE, AND THAT IS THE WHOLE DESIGN
 *
 * Every arm deletes the SAME NUMBER of vertices from a graph of the same size; only the out-degree of
 * the fixture changes. So:
 *
 *   - B/delete FLAT across degree  => the undo is O(1) and item 2508's budget holds for deletes too.
 *   - B/delete LINEAR in degree    => the undo is O(degree), and the budget needs a second term.
 *
 * `B/delete/degree` is printed beside it: that column is the one that goes flat in the O(degree) case,
 * which is the cross-check that the growth is really per-edge and not per-something-else.
 *
 * A no-transaction control runs at every degree too. A delete FREES memory outside a transaction, so
 * the control is expected to read NEGATIVE or near zero — and the arm minus the control is the
 * bookkeeping. (Item 2509's rule: an all-structures arm tells partition from shared references; here
 * the equivalent is that the control tells releasing from retaining.)
 *
 * One shape per PROCESS, `global.gc()` before every sample.
 *
 *     node tx-delete-2510.mjs
 *     TX_DEGREES=1,4,16,64 node tx-delete-2510.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

/** Vertices in the fixture. */
const N = Number(process.env.TX_N ?? 50000);
/** How many of them each arm deletes — the SAME for every arm, so only degree varies. */
const DELETES = Number(process.env.TX_DELETES ?? 10000);
const DEGREES = (process.env.TX_DEGREES ?? '1,4,16').split(',').map(Number);

if (process.env.ARM === 'child') {
  const { Graph } = await import('@lenke/core');
  const deg = Number(process.env.DEG);
  const inTx = process.env.IN_TX === '1';
  const graph = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  let e = 0;

  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < deg; j += 1) {
      /* Spread the targets so the deleted vertices are not all each other's neighbours. */
      graph.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[(i * 7919 + j * 104_729 + 1) % N],
        labels: ['E'],
        properties: {},
      });
      e += 1;
    }
  }

  global.gc();
  const base = process.memoryUsage().heapUsed;

  if (inTx) {
    graph.beginTransaction();
  }

  for (let i = 0; i < DELETES; i += 1) {
    graph.removeVertex(vs[i]);
  }

  global.gc();
  const peak = process.memoryUsage().heapUsed - base;
  const structs = inTx
    ? { txUndo: graph.txUndo?.length ?? 0, txEvents: graph.txEvents?.length ?? 0 }
    : {};

  process.stdout.write(
    `${JSON.stringify({ mib: peak / 1024 / 1024, edges: e, left: graph.vertexCount, structs })}\n`,
  );
  process.exit(0);
}

const one = (deg, inTx) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', DEG: String(deg), IN_TX: inTx ? '1' : '0' },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(`# Is the undo of a DELETE O(1) or O(degree)?  |V|=${N}, ${DELETES} deletes per arm`);
console.log('# Every arm deletes the SAME COUNT; only the fixture out-degree changes.');
console.log('# FLAT B/delete => O(1) and item 2508 covers deletes. LINEAR => the budget needs a');
console.log('# second term, and B/delete/degree is the cross-check that it is really per-EDGE.\n');
console.log('  deg    no tx MiB     in tx MiB       delta    B/delete   B/del/deg   txUndo');

for (const deg of DEGREES) {
  const plain = one(deg, false);
  const tx = one(deg, true);
  const delta = tx.mib - plain.mib;
  const perDelete = (delta * 1024 * 1024) / DELETES;

  const cols = [
    String(deg).padStart(5),
    plain.mib.toFixed(2).padStart(11),
    tx.mib.toFixed(2).padStart(12),
    delta.toFixed(2).padStart(11),
    perDelete.toFixed(1).padStart(11),
    (perDelete / deg).toFixed(1).padStart(11),
    String(tx.structs.txUndo ?? 0).padStart(8),
  ];

  console.log(`  ${cols.join(' ')}`);
}

console.log('\n  A no-tx control may read NEGATIVE: outside a transaction a delete FREES memory.');
console.log('  The arm minus the control is the transaction bookkeeping.');
