/**
 * ITEM 2227 — `MATCH (n:P) RETURN n.k AS k`, the plainest shape in the cliff finder, and the only one
 * whose `vs floor` ratio rises MONOTONICALLY with size (1.52 → 1.88 → 3.04x, item 2226).
 *
 * 🔑 THE LADDER adds one piece of the engine's machinery per rung, so a rung that closes the gap names the
 * cause — and if that cause is already closed, there is no target (items 2216/2217).
 *
 * ⚠️ ONE ARM PER PROCESS (`ARM=`), because shapes timed in sequence pollute each other's dispatch (items
 * 762, 2172-2175) and item 2214 measured a 2.6x that was purely first-row JIT warm-up.
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 80_000);
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 100, n: i, s: `s${i % 1000}` } });
}

/*
 * ⚠️⚠️ **EDGES ARE PART OF THE FIXTURE EVEN THOUGH THIS SHAPE IS A NODE SCAN**, because the cliff finder's
 * fixture has them and the first version of this probe did not — and the two instruments then disagreed
 * 2x (3.04x against 1.4x). A node scan touches no edge, but 320,000 of them change the heap the scan walks.
 * `EDGES=0` reproduces the edgeless arm.
 */
if (process.env.EDGES !== '0') {
  for (let k = 0; k < NODES * 4; k += 1) {
    const from = k % NODES;
    const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

    if (to === from) {
      continue;
    }

    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`u${from}`)!,
      to: g.getVertexById(`u${to}`)!,
      labels: ['E'],
      properties: {},
    });
  }
}

const Q = 'MATCH (n:P) RETURN n.k AS k';

/** Rung 0 — the floor: iterate the label bucket, read the property, build the row. */
const floor = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];

  for (const v of g.verticesByLabel.get('P') ?? []) {
    out.push({ k: v.properties.k });
  }

  return out;
};

/** Rung 1 — plus a per-row binding `Map` write, which [[binding-allocation-is-closed]] refused twice. */
const withBinding = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];
  const binding = new Map<string, unknown>();

  for (const v of g.verticesByLabel.get('P') ?? []) {
    binding.set('n', v);
    out.push({ k: (binding.get('n') as { properties: Record<string, unknown> }).properties.k });
  }

  return out;
};

/** Rung 2 — plus the projection read through a COMPILED closure, as a lowered plan does. */
const readK = (b: Map<string, unknown>): unknown =>
  (b.get('n') as { properties: Record<string, unknown> }).properties.k;

const withClosure = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];
  const binding = new Map<string, unknown>();

  for (const v of g.verticesByLabel.get('P') ?? []) {
    binding.set('n', v);
    out.push({ k: readK(binding) });
  }

  return out;
};

/** Rung 3 — plus a per-row object built by COMPUTED key, which is what `projectRow` does. */
const withComputedKey = (): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const binding = new Map<string, unknown>();
  const name = 'k';

  for (const v of g.verticesByLabel.get('P') ?? []) {
    binding.set('n', v);

    const row: Record<string, unknown> = {};

    row[name] = readK(binding);
    out.push(row);
  }

  return out;
};

const arm = process.env.ARM ?? 'engine';

const run = (): unknown => {
  if (arm === 'floor') {
    return floor();
  }

  if (arm === 'bind') {
    return withBinding();
  }

  if (arm === 'closure') {
    return withClosure();
  }

  if (arm === 'computed') {
    return withComputedKey();
  }

  const r = tsQuery(g, Q) as unknown as { rows?: unknown[] };

  return r.rows ?? r;
};

/*
 * ⚠️⚠️ **CONSUME THE RESULT CHEAPLY. `JSON.stringify` INSIDE THE TIMED LOOP DILUTES EVERY RATIO TOWARD
 * 1.0**, because it is a large cost IDENTICAL in both arms: the first version of this probe read the engine
 * at 1.3x the floor where the cliff finder read 3.04x, and stringifying 80,000 rows per iteration was the
 * whole difference.
 *
 * 🔑 It is the mirror of the dead-code trap (item 2200): consuming NOTHING lets the JIT delete the work,
 * consuming EXPENSIVELY swamps it. A length read is enough to keep the array alive.
 */
let sink = 0;

for (let w = 0; w < 4; w += 1) {
  sink += (run() as unknown[]).length;
}

const t0 = performance.now();
const I = Number(process.env.ITER ?? 25);

for (let i = 0; i < I; i += 1) {
  sink += (run() as unknown[]).length;
}

const got = run() as unknown[];

console.log(
  `  ${arm.padEnd(9)} ${(((performance.now() - t0) * 1000) / I).toFixed(0).padStart(8)} us   rows=${got.length}  (sink ${sink > 0 ? 'ok' : 'ZERO'})`,
);
