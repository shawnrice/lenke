/**
 * WHERE DOES THE ENGINE SPEND TIME ON A MIXED REALISTIC WORKLOAD? (item 1865)
 *
 * ⚠️ A DIFFERENT QUESTION FROM THE SCREEN, which this reuses the fixture and generators of.
 * `workload-perf-screen.mjs` runs ONE CHILD PROCESS PER FAMILY and reports wall time per family —
 * so it answers "which family is expensive" and can answer nothing about frames. Every profile in
 * this stretch has then profiled ONE shape (items 1843, 1859, 1862). Neither asks what a user
 * actually experiences: a MIX of shapes through one engine, where a frame shared by six families
 * matters more than the slowest family's own hot loop.
 *
 * ⚠️ `multi-pattern` IS EXCLUDED, and that is the point of running this now. It is 97% of the
 * screen's wall time and item 1864 closed it as NOT ADDRESSABLE — its cost is a genuine cross
 * product whose row count is its answer. Profiling with it in would hand back its binding loop and
 * nothing else. Excluded, the remaining sixteen families are the addressable workload.
 *
 * ⚠️ AND IT IS ONE PROCESS DELIBERATELY, which item 762's rule normally forbids. That rule is about
 * an A/B whose two arms redistribute call sites — here there is no A/B and no arm, only an
 * attribution of one workload's own time, so sharing a process is what makes the question
 * answerable at all. Nothing below is a ratio.
 */
import { readFileSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/**
 * ⚠️ THE QUERY LIST COMES FROM A FILE, AND THAT IS NOT A STYLE CHOICE. The generators live in
 * `src/workload-queries.ts`; bun resolves a `.js` specifier to that `.ts` source and node does
 * not, and the profiler is node (`--cpu-prof`). Rather than fork the generators — which is how two
 * instruments drift apart — `gen-mixed-workload-1865.ts` runs under bun and writes the list, and
 * this reads it. One source of truth, two runtimes.
 */
const WORK_FILE =
  process.env.WORK_FILE ??
  (() => {
    throw new Error('WORK_FILE is required — generate it with gen-mixed-workload-1865.ts');
  })();

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);
const ROUNDS = Number(process.env.ROUNDS ?? 6);

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

// Byte-for-byte the screen's fixture, so a frame seen here is a frame of the shapes it measures.
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const labels = i % 6 === 2 ? ['T', 'U'] : ['T'];
    const properties = {
      n: N_POOL[i % N_POOL.length],
      x: X_POOL[i % X_POOL.length],
      s: S_POOL[i % S_POOL.length],
      nu: i % 3 === 1 ? null : (i % 9) + 1,
      d: { '@date': DATES[i % DATES.length] },
      m: { k: i % 7, j: `q${i % 5}` },
    };

    if (i % 3 === 0) {
      properties.st = `p${i % 11}`;
    }

    g.addVertex({ id: String(i + 1), labels, properties });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: hop % 4 === 3 ? ['F'] : ['E'],
      properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
    });
  }

  return g;
};

const g = build();

const work = JSON.parse(readFileSync(WORK_FILE, 'utf8'));
const families = [...new Set(work.map((w) => w.name))];

console.log(
  `# mixed workload: ${String(work.length)} queries over ${String(families.length)} families, ${String(ROUNDS)} rounds`,
);
console.log(`# families: ${families.join(',')}`);
console.log(`# vertices=${String(g.vertexCount)} edges=${String(g.edgeCount)}`);

let rows = 0;
let errs = 0;
const t0 = performance.now();

for (let round = 0; round < ROUNDS; round += 1) {
  for (const w of work) {
    try {
      rows += query(g, w.text, w.params).length;
    } catch {
      errs += 1;
    }
  }
}

const ms = performance.now() - t0;

console.log(
  `# ${ms.toFixed(0)} ms, ${String(rows)} rows, ${String(errs)} errors, ` +
    `${((ms * 1e6) / (work.length * ROUNDS)).toFixed(0)} ns/query`,
);

// ⚠️ A WORKLOAD THAT ERRORS ON MOST QUERIES WOULD PROFILE THE ERROR PATH. Loud, not silent.
if (errs > work.length * ROUNDS * 0.05) {
  throw new Error(`${String(errs)} of ${String(work.length * ROUNDS)} queries threw`);
}
