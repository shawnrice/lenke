/**
 * ITEM 2220 — does a MID-PATTERN filter prune the second hop, or is it applied after the walk?
 *
 * THE TEST IS SELECTIVITY, NOT A PROFILE: if the engine prunes at `b`, time scales with how many
 * middles survive. If it walks all paths and filters late, time is FLAT in selectivity.
 *
 * Rows are printed too, because a shape whose ANSWER is invariant to the thing being varied cannot
 * validate anything (CLAUDE.md, item 702).
 */
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = 4;
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 100, n: i } });
}

for (let k = 0; k < NODES * FANOUT; k += 1) {
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

/** The hand-rolled floor: prune at the middle, then walk only the survivors' second hop. */
const floor = (pred: (k: number) => boolean): { k: unknown }[] => {
  const out: { k: unknown }[] = [];

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e1 of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      if (!pred(e1.to.properties.k as number)) {
        continue;
      }

      for (const e2 of g.edgesFromByLabel.get(e1.to.id)?.get('E') ?? []) {
        out.push({ k: e2.to.properties.k });
      }
    }
  }

  return out;
};

/*
 * **CONSUME CHEAPLY: `JSON.stringify` INSIDE THE TIMED LOOP DILUTES THE RATIO TOWARD 1.0** (item 2227).
 * A large cost identical in both arms is added to numerator and denominator alike — stringifying 80,000
 * rows per iteration halved a measured gap (1.35x against the true 2.35x). It is the mirror of item
 * 2200's dead-code trap: consuming NOTHING lets the JIT delete the work, consuming EXPENSIVELY swamps it.
 */
const consume = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v) || 1);

const ms = (fn: () => unknown): number => {
  let sink = 0;

  for (let w = 0; w < 3; w += 1) {
    sink += consume(fn());
  }

  const t0 = performance.now();
  const I = 8;

  for (let i = 0; i < I; i += 1) {
    sink += consume(fn());
  }

  return sink > 0 ? (performance.now() - t0) / I : 0;
};

const CASES: ReadonlyArray<readonly [string, string, (k: number) => boolean]> = [
  ['b.k = 5          (1%)', 'b.k = 5', (k) => k === 5],
  ['b.k < 10        (10%)', 'b.k < 10', (k) => k < 10],
  ['b.k < 50        (50%)', 'b.k < 50', (k) => k < 50],
  ['b.k >= 0       (100%)', 'b.k >= 0', (k) => k >= 0],
];

/* TWO PASSES IN OPPOSITE ORDER: an in-process table charges the FIRST row for JIT warm-up (item 2214). */
for (const pass of [CASES, [...CASES].reverse()]) {
  console.log(
    `\n  ${'mid filter'.padEnd(24)} ${'engine ms'.padStart(10)} ${'floor ms'.padStart(9)} ${'vs floor'.padStart(9)} ${'rows'.padStart(8)}`,
  );

  for (const [label, where, pred] of pass) {
    const q = `MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE ${where} RETURN c.k AS k`;
    const eng = ms(() => {
      const r = tsQuery(g, q) as unknown as { rows?: unknown[] };

      return r.rows ?? r;
    });
    const fl = ms(() => floor(pred));
    /*
     * **THE FIRST VERSION READ `.rows ?? []` AND PRINTED 0 FOR EVERY CASE** — the result of this query
     * IS an array, so `.rows` was undefined and the fallback swallowed it. A row count that is invariant to
     * the thing being varied cannot validate the table (CLAUDE.md, item 702), which is exactly what the
     * zeros announced.
     */
    const out = tsQuery(g, q) as unknown as { rows?: unknown[] };
    const rows = (out.rows ?? (out as unknown as unknown[])).length;

    console.log(
      `  ${label.padEnd(24)} ${eng.toFixed(1).padStart(10)} ${fl.toFixed(1).padStart(9)} ${`${(eng / fl).toFixed(2)}x`.padStart(9)} ${String(rows).padStart(8)}`,
    );
  }
}
