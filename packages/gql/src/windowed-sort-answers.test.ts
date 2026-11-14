import { describe, expect, test } from 'bun:test';

/**
 * A WINDOWED sort on the deeper ordered rungs — item 1852.
 *
 * `ORDER BY … LIMIT n` used to decline every ordered rung past one hop, so it cost **10.1x the
 * same query with no window** — and 8x the FULL SORT it is a prefix of, which is the giveaway that
 * no amount of work justified it. `detectNodeProjection` and `detectHopProjection` had shipped the
 * windowed form at depth 0 and 1 since items 1062 and 701; this is the same behaviour at depth 2+.
 *
 * ⚠️ TIES ARE THE WHOLE RISK, so the fixture is built to produce them. With `k` taking three
 * values over sixty vertices, `ORDER BY k LIMIT 5` has to choose among many rows that compare
 * equal — and WHICH of them survives is the one thing sort-then-slice could get wrong relative to
 * the general path. A fixture of distinct keys would make every one of these tests pass against
 * any implementation.
 *
 * ⚠️ THE ORACLE IS AN UNREAD EDGE VARIABLE ON THE FIRST SEGMENT. It leaves the columns, the rows
 * and the order untouched, and the CHAIN rungs still refuse a named rel outright — item 1850
 * admitted one only on the OPTIONAL rung, so this device still works here. Each case asserts the
 * oracle declines, because an oracle that stopped declining would make every comparison vacuous.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const build = (): Graph => {
  const g = new Graph();
  const n = 60;

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 3, u: i } });
  }

  for (let h = 0; h < 2; h += 1) {
    for (let i = 0; i < n; i += 1) {
      const from = g.getVertexById(`v${i}`);
      const to = g.getVertexById(`v${(i * 7 + 3 + h) % n}`);

      if (from === null || to === null) {
        throw new Error('fixture is broken');
      }

      g.addEdge({ id: `e${h * n + i}`, from, to, labels: ['E'] });
    }
  }

  return g;
};

/** The row SEQUENCE — with a window the order IS the answer, so nothing here sorts. */
const seq = (g: Graph, text: string, params: Record<string, unknown> = {}): string[] =>
  query(g, text, params).map((r) => Object.values(r).map(String).join('/'));

/** The same question with an unread edge variable, which the chain rungs refuse. */
const viaGeneral = (text: string): string => text.replace('-[:E]->(b:T)', '-[z:E]->(b:T)');

const CHAINS: [string, string][] = [
  ['two segments', '(a:T)-[:E]->(b:T)-[:E]->(c:T)'],
  ['three segments', '(a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T)'],
];

const TAILS = [
  'ORDER BY x LIMIT 5',
  'ORDER BY x SKIP 3',
  'ORDER BY x SKIP 2 LIMIT 4',
  'ORDER BY x, y LIMIT 7',
  'ORDER BY x DESC LIMIT 5',
  // Past `boundedTopRows`' crossover, so the full sort runs and the window is a plain slice.
  'ORDER BY x LIMIT 100000',
  // A window that selects nothing by skipping past the end.
  'ORDER BY x SKIP 100000',
];

describe('a windowed sort on the deeper ordered rungs', () => {
  test('produces the same SEQUENCE as the route that declines it', () => {
    const g = build();

    for (const [, chain] of CHAINS) {
      const far = chain.includes('(d:T)') ? 'd' : 'c';

      for (const tail of TAILS) {
        const text = `MATCH ${chain} RETURN ${far}.k AS x, ${far}.u AS y ${tail}`;

        expect(seq(g, text)).toEqual(seq(g, viaGeneral(text)));
      }
    }
  });

  test('the rung fires for each, and the oracle does not', () => {
    for (const [, chain] of CHAINS) {
      const far = chain.includes('(d:T)') ? 'd' : 'c';
      const rung = chain.includes('(d:T)') ? 'chainOrderedProjection' : 'hop2OrderedProjection';

      for (const tail of TAILS) {
        const text = `MATCH ${chain} RETURN ${far}.k AS x, ${far}.u AS y ${tail}`;

        expect(routes(text)).toContain(rung);
        expect(routes(viaGeneral(text))).not.toContain(rung);
      }
    }
  });

  /**
   * ⚠️ THE TIES ARE REAL, asserted rather than assumed. If `k` happened to be unique per row this
   * whole file would be testing nothing, so the fixture's own premise is checked: the first five
   * rows of `ORDER BY x LIMIT 5` must all share the same `x`.
   */
  test('the fixture actually produces ties', () => {
    const g = build();
    const rows = seq(
      g,
      'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.k AS x, c.u AS y ORDER BY x LIMIT 5',
    );

    expect(rows.length).toBe(5);
    expect(new Set(rows.map((r) => r.split('/')[0])).size).toBe(1);
  });

  /**
   * ⚠️ `LIMIT 0` DECLINES, and that is pre-existing rather than this item's doing — it declined
   * before the window was admitted too, so it is recorded here rather than changed. The answer is
   * what matters and it is checked.
   */
  test('a zero limit declines, and answers empty', () => {
    const g = build();
    const text = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.k AS x ORDER BY x LIMIT 0';

    expect(routes(text)).not.toContain('hop2OrderedProjection');
    expect(seq(g, text)).toEqual([]);
  });

  /**
   * ⚠️ ~~A parameterised window declines~~ — **ADMITTED SINCE ITEM 1867.** "Its value is unknown
   * when the route is chosen" is true and was the wrong conclusion: the route here is
   * sort-then-slice either way, and `sortRowsByColumns` chooses heap-vs-sort at RUN time against
   * the real row count, so nothing decided at compile time depends on the bound. Only the number
   * waits for `params`. It cost 10.5x on the `projection` family of the workload screen, measured
   * at item 1866.
   */
  test('a parameterised window takes the rung, and answers the same', () => {
    const g = build();
    const text = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.k AS x ORDER BY x LIMIT $n';

    expect(routes(text)).toContain('hop2OrderedProjection');
    expect(query(g, text, { n: 4 }).length).toBe(4);
    // The ROWS, not just how many — see the sibling note in `optional-ordered-answers`.
    expect(seq(g, text, { n: 4 })).toEqual(seq(g, viaGeneral(text), { n: 4 }));
  });
});
