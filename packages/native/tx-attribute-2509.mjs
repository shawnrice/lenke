/*
 * Item 2509: WHICH of the three scaling transaction structures holds the ~162/273 B per write?
 *
 * Item 2508 measured the floor and named the three that scale — `txUndo` (one inverse op per write),
 * `txEvents` (one buffered event per write) and `txTokens` (a flat `string[]`, TWO entries per create
 * and one per update). It did NOT say how the bytes divide between them, and that division is the
 * number any reduction would need.
 *
 * ## THE METHOD: CLEAR ONE, READ THE DROP
 *
 * For each structure in turn: run the writes inside a transaction, sample, clear THAT structure,
 * force a collection, sample again. The drop is what it was holding. This deliberately breaks
 * rollback — the probe measures bytes and never commits, so correctness is not in question here and
 * the result is not a proposal.
 *
 * **The all-three arm is the one that makes it readable.** If the individual drops SUM to the
 * all-three drop, the structures partition the cost and each is independently reducible. If the
 * all-three drop is much LARGER than the sum, they hold references to the same objects and no single
 * one can be removed for its apparent share — the shared objects die only when the last reference
 * goes. That distinction is question (c) of item 2508 and it decides whether "reducible" means
 * anything.
 *
 * One shape per PROCESS, `global.gc()` before every sample (item 2457: occupancy without a
 * collection counts garbage and inverted a family once).
 *
 *     node tx-attribute-2509.mjs
 *     TX_N=200000 node tx-attribute-2509.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.TX_N ?? 100000);

if (process.env.ARM === 'child') {
  const { Graph } = await import('@lenke/core');
  const kind = process.env.KIND;
  const clear = process.env.CLEAR;
  const graph = new Graph();
  const seeded = [];

  if (kind === 'set') {
    for (let i = 0; i < N; i += 1) {
      seeded.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
    }
  }

  global.gc();
  const base = process.memoryUsage().heapUsed;

  graph.beginTransaction();

  if (kind === 'set') {
    for (let i = 0; i < N; i += 1) {
      seeded[i].setProperty('k', i + 1);
    }
  } else {
    for (let i = 0; i < N; i += 1) {
      graph.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
    }
  }

  global.gc();
  const held = process.memoryUsage().heapUsed - base;

  /* Breaks rollback ON PURPOSE: this process measures bytes and never commits. */
  if (clear === 'undo' || clear === 'all') {
    graph.txUndo = [];
  }

  if (clear === 'events' || clear === 'all') {
    graph.txEvents = [];
  }

  if (clear === 'tokens' || clear === 'all') {
    graph.txTokens = [];
  }

  global.gc();
  const after = process.memoryUsage().heapUsed - base;

  process.stdout.write(
    `${JSON.stringify({ heldMiB: held / 1024 / 1024, afterMiB: after / 1024 / 1024 })}\n`,
  );
  process.exit(0);
}

const one = (kind, clear) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', KIND: kind, CLEAR: clear },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(`# Attributing the per-write transaction cost  N=${N}  (one shape per process)`);
console.log('# Clear ONE structure, force a collection, and the drop is what it was holding.');
console.log('# If the individual drops SUM to the all-three drop they partition the cost;');
console.log('# if all-three drops MORE than the sum, they share references and none is');
console.log('# independently removable for its apparent share.\n');

for (const kind of ['add', 'set']) {
  console.log(`  ${kind === 'add' ? 'addVertex' : 'setProperty'}`);
  console.log('    cleared      held MiB    after MiB      drop      B/write');

  const drops = {};

  for (const clear of ['none', 'undo', 'events', 'tokens', 'all']) {
    const r = one(kind, clear);
    const drop = r.heldMiB - r.afterMiB;

    drops[clear] = drop;

    const cols = [
      clear.padEnd(10),
      r.heldMiB.toFixed(2).padStart(10),
      r.afterMiB.toFixed(2).padStart(12),
      drop.toFixed(2).padStart(9),
      ((drop * 1024 * 1024) / N).toFixed(1).padStart(11),
    ];

    console.log(`    ${cols.join(' ')}`);
  }

  const sum = drops.undo + drops.events + drops.tokens;
  const verdict =
    drops.all > sum * 1.25 ? 'SHARED references (all > sum)' : 'they PARTITION the cost';

  console.log(
    `    sum of the three = ${sum.toFixed(2)} MiB, all-three = ${drops.all.toFixed(2)} => ${verdict}`,
  );
  console.log();
}
