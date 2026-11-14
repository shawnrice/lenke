/**
 * WHAT DOES `ORDER BY` COST, PER WORKLOAD FAMILY? (items 1866/1867)
 *
 * The deletion test from the other side: for every family, time its sorted queries AS WRITTEN and
 * again with `ORDER BY` stripped. The difference is what the sort costs that family.
 *
 * ⚠️ IT IS NOT A SORT BENCHMARK — it is how item 1866 found a ROUTE gap. Two rows did not add up:
 * `var-length` paid 34.1 ms of "sort" over **78 rows**, and `projection` 28.6 ms at **10.5x** the
 * query that produced its rows. Sorting 78 rows cannot cost 34 ms, so the difference was not
 * sorting at all — `ORDER BY` was declining a rung. Reading the per-family rows against the ROW
 * COUNTS is what makes that visible; a single total would have read as "sorting is expensive".
 *
 * ⚠️ READ THE ROW COUNT BESIDE THE MILLISECONDS, ALWAYS. A family whose sort cost is large and
 * whose row count is tiny is a route gap. A family whose cost scales with its rows (`chain-rows`,
 * 188.7 ms over 1.4M) is a real sort and nothing here will help it.
 *
 * ⚠️ AND THE NOISE FLOOR IS VISIBLE IN THE OUTPUT: `grouped` reads NEGATIVE (-2.4 ms), which is
 * this instrument telling you ~2 ms is indistinguishable from zero. Anything under that is not a
 * finding.
 *
 * Usage: generate the workload with `gen-mixed-workload-1865.ts`, then
 *   WORK_FILE=<that json> bun sort-cost-by-family-1867.mjs
 */
import { readFileSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const { WORK_FILE } = process.env;

if (WORK_FILE === undefined) {
  throw new Error('WORK_FILE is required — generate it with gen-mixed-workload-1865.ts');
}

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);
const ROUNDS = Number(process.env.ROUNDS ?? 6);

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

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
// ⚠️ The strip stops at a trailing LIMIT/OFFSET so the WINDOW survives and only the ORDER goes —
// removing the page too would change how many rows each arm produces and compare two workloads.
const strip = (t) => t.replace(/ ORDER BY [^]*?(?= (LIMIT|OFFSET) |$)/, '');

const time = (list, texts) => {
  let best = Infinity;

  for (let r = 0; r < ROUNDS; r += 1) {
    const t0 = performance.now();

    for (let i = 0; i < list.length; i += 1) {
      try {
        query(g, texts[i], list[i].params);
      } catch {
        /* a family may legitimately raise; the arms raise identically */
      }
    }

    best = Math.min(best, performance.now() - t0);
  }

  return best;
};

const sorted = work.filter((w) => / ORDER BY /.test(w.text));
const byFamily = new Map();

for (const w of sorted) {
  const c = byFamily.get(w.name) ?? [];

  c.push(w);
  byFamily.set(w.name, c);
}

const out = [];

for (const [name, list] of byFamily) {
  const withSort = time(
    list,
    list.map((w) => w.text),
  );
  const without = time(
    list,
    list.map((w) => strip(w.text)),
  );
  let rows = 0;

  for (const w of list) {
    try {
      rows += query(g, w.text, w.params).length;
    } catch {
      /* ignored */
    }
  }

  out.push({ name, n: list.length, withSort, without, sort: withSort - without, rows });
}

out.sort((a, b) => b.sort - a.sort);

const total = out.reduce((s, o) => s + o.sort, 0);

console.log('family           n   withORDER  without     sort  %sort       rows   ns/row');
console.log('-----------------------------------------------------------------------------');

for (const o of out) {
  const nsRow = o.rows === 0 ? '—' : ((o.sort * 1e6) / o.rows).toFixed(0);

  console.log(
    `${o.name.padEnd(14)} ${String(o.n).padStart(3)} ${o.withSort.toFixed(1).padStart(10)} ${o.without
      .toFixed(1)
      .padStart(
        8,
      )} ${o.sort.toFixed(1).padStart(8)} ${((100 * o.sort) / total).toFixed(1).padStart(5)}% ${String(
      o.rows,
    ).padStart(10)} ${nsRow.padStart(8)}`,
  );
}

console.log(`TOTAL sort cost ${total.toFixed(1)} ms`);
console.log('');
console.log(
  '# ⚠️ A LARGE `sort` WITH FEW `rows` IS A ROUTE GAP, NOT A SORT. That is how item 1866',
);
console.log('#    found the parameterized page falling off every projection rung.');
