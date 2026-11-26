/**
 * WHICH INDIVIDUAL QUERY IN EACH WORKLOAD FAMILY OWNS THE FAMILY'S MILLISECONDS? (item 1880)
 *
 * THE GENERAL VERSION OF WHAT ITEM 1879 DID BY HAND. The workload screen reports ONE number per
 * family, but a family is a generator: `var-length` draws seven bodies crossed with four bounds, and
 * splitting it showed **one bound was ~70% of the family** — `{2,3}` at 45.1 ms against its `{1,3}`
 * twin's 0.8, same eight rows. A per-family total cannot show that, so every family's number is a
 * blended average hiding whatever its worst shape is.
 *
 * IT DRIVES THE REAL GENERATOR rather than restating the bodies. `WORKLOAD_FAMILIES` is the
 * source of truth the screen and the differential fuzzer both use; a hand-copied shape list is one
 * more thing that silently goes stale, which this file would then measure instead of the corpus.
 * Many seeds are drawn, the realized TEXTS are deduped per family, and each distinct text is timed.
 *
 * AND THE OUTPUT IS SORTED BY ABSOLUTE MILLISECONDS, not by a ratio — item 1878's lesson, which
 * cost a whole item: a 4.7x that turned out to be 2 microseconds. A shape is worth looking at when it
 * owns real time, and the only way to see that is to print the time.
 *
 *     bun family-split-1880.ts                  # every family
 *     FAMILY=optional bun family-split-1880.ts  # one
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { WORKLOAD_FAMILIES } from './src/workload-queries.js';

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);
const SEEDS = Number(process.env.SEEDS ?? 400);
const FAMILY = process.env.FAMILY ?? '';
const TOP = Number(process.env.TOP ?? 4);

const rng = (seed: number): (() => number) => {
  let t = seed >>> 0;

  return () => {
    t += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// The screen's own fixture and value domain, so a literal selects the fraction it is meant to.
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  const properties: Record<string, unknown> = {
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

  g.addVertex({ id: String(i + 1), labels: i % 6 === 2 ? ['T', 'U'] : ['T'], properties });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)) as never,
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)) as never,
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
  });
}

/** Draw many seeds and keep each family's DISTINCT texts, with one params bag per text. */
const byFamily = new Map<string, Map<string, Record<string, unknown>>>();

for (const gen of WORKLOAD_FAMILIES) {
  for (let s = 0; s < SEEDS; s += 1) {
    const w = gen(rng(0x9e37 + s * 7919)) as unknown as {
      family: string;
      text: string;
      params?: Record<string, unknown>;
    };

    if (FAMILY !== '' && w.family !== FAMILY) {
      continue;
    }

    const m = byFamily.get(w.family) ?? new Map<string, Record<string, unknown>>();

    if (!m.has(w.text)) {
      m.set(w.text, w.params ?? {});
    }

    byFamily.set(w.family, m);
  }
}

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[s.length >> 1];
};

console.log(
  `# ${NODES} vertices / ${NODES * FANOUT} edges, ${SEEDS} seeds a family, median of ${REPS}`,
);
console.log('# SORTED BY ABSOLUTE ms. A family total hides its worst shape — item 1879.\n');

const families = [...byFamily.keys()].sort();
const summary: [string, number, number, number][] = [];

for (const family of families) {
  const texts = byFamily.get(family) as Map<string, Record<string, unknown>>;
  const rows: [number, number, string][] = [];

  for (const [text, params] of texts) {
    const series: number[] = [];
    let n = 0;

    for (let r = 0; r < REPS + 2; r += 1) {
      const t0 = performance.now();

      try {
        n = query(g, text, params as never).length;
      } catch {
        n = -1;
      }

      const ms = performance.now() - t0;

      if (r >= 2) {
        series.push(ms);
      }
    }

    rows.push([med(series), n, text]);
  }

  rows.sort((a, b) => b[0] - a[0]);

  const total = rows.reduce((acc, [ms]) => acc + ms, 0);
  const [worst] = rows;
  // The share of the family's distinct-shape time that its single worst shape owns.
  const share = total === 0 ? 0 : (100 * worst[0]) / total;

  summary.push([family, worst[0], share, rows.length]);
  console.log(`${family}  —  ${rows.length} distinct shapes, worst owns ${share.toFixed(0)}%`);

  for (const [ms, n, text] of rows.slice(0, TOP)) {
    console.log(`  ${ms.toFixed(1).padStart(7)} ms ${String(n).padStart(7)} rows  ${text}`);
  }

  console.log('');
}

summary.sort((a, b) => b[1] - a[1]);
console.log('# worst single shape per family, by absolute ms:');

for (const [family, ms, share, n] of summary) {
  console.log(
    `#   ${family.padEnd(16)} ${ms.toFixed(1).padStart(7)} ms   ${share.toFixed(0).padStart(3)}% of ${String(n)} shapes`,
  );
}
