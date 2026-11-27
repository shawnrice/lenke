/**
 * Is a MULTI-COLUMN one-hop `RETURN DISTINCT` still correct after item 2423 admitted one hop to
 * `chainDistinctLevels`?
 *
 * WHY THIS NEEDS ITS OWN CHECK. `onehopagg-oracle-2416.mjs` projects exactly one column (`AS v`), so
 * the two-column DISTINCT is outside its sweep — and the suite's only complaint about it was a ROUTE
 * assertion (`one-hop multi-column DISTINCT -> hopDistinctProjection`), which is answer-equivalent by
 * construction and would say nothing about a wrong answer. `chainDistinctLevels` dispatches at
 * `clauses.ts`:1790, BEFORE `hopDistinctProjection` at 1916, so if it is willing it answers; the
 * question is whether it answers correctly with more than one column.
 *
 * The reference is the row form deduped in JS on the TUPLE of both columns, and the comparison is a
 * MULTISET because an unordered result's row order is unspecified ([[order-is-unspecified]]). Both
 * label modes, because item 2422 is the reminder that a route can change with vacuity.
 *
 *     bun distinct2-check-2423.ts
 */
import { Graph, type Vertex } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: reads SOURCE so a src edit under test is visible without a dist rebuild ([[fuzzers-read-built-dists]]).
import { query } from '../gql/src/index.ts';

const NODES = Number(process.env.NODES ?? 2000);

const build = (mixed: boolean): Graph => {
  const g = new Graph();
  const vs: Vertex[] = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        // `k` and `s` are deliberately NOT in lockstep: `k` has 97 values and `s` has 13, so the
        // TUPLE has more distinct values than either column. A rung that dedupes on one column
        // only would answer a smaller set and a single-column fixture could not see it.
        properties: { k: i % 97, s: `s${i % 13}`, n: i, nl: i % 5 === 0 ? null : i },
      }),
    );
  }

  for (let e = 0; e < NODES; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % NODES],
      labels: ['E'],
      properties: {},
    });
  }

  if (mixed) {
    g.addVertex({ id: 'off', labels: ['Z'], properties: {} });
  }

  return g;
};

const key = (r: Record<string, unknown>, cols: readonly string[]): string =>
  cols
    .map((c) => {
      const v = r[c];

      return `${typeof v}:${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`;
    })
    .join('\u0000');

const SHAPES: { name: string; distinct: string; rows: string; cols: string[] }[] = [
  {
    name: 'two columns, far end',
    distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k, x.s AS s',
    rows: 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k, x.s AS s',
    cols: ['k', 's'],
  },
  {
    name: 'two columns, MIXED ends',
    distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT a.k AS k, x.s AS s',
    rows: 'MATCH (a:P)-[:E]->(x:P) RETURN a.k AS k, x.s AS s',
    cols: ['k', 's'],
  },
  {
    name: 'three columns',
    distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k, x.s AS s, x.nl AS nl',
    rows: 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k, x.s AS s, x.nl AS nl',
    cols: ['k', 's', 'nl'],
  },
  {
    name: 'two columns with a NULL one',
    distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.nl AS nl, x.s AS s',
    rows: 'MATCH (a:P)-[:E]->(x:P) RETURN x.nl AS nl, x.s AS s',
    cols: ['nl', 's'],
  },
  {
    name: 'ONE column (the shape item 2423 moved on purpose)',
    distinct: 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.k AS k',
    rows: 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k',
    cols: ['k'],
  },
];

let pass = 0;
const fails: string[] = [];

for (const mixed of [false, true]) {
  const g = build(mixed);
  const mode = mixed ? 'MIXED' : 'homo';

  for (const sh of SHAPES) {
    const got = query(g, sh.distinct, {}) as unknown as Record<string, unknown>[];
    const rows = query(g, sh.rows, {}) as unknown as Record<string, unknown>[];
    const want = new Set(rows.map((r) => key(r, sh.cols)));
    const gotKeys = got.map((r) => key(r, sh.cols));
    const gotSet = new Set(gotKeys);

    // Three separate failures, because they are three different defects: a wrong SET, a DUPLICATE
    // row (which a set comparison alone would hide), and a missing/extra column.
    const sameSet = gotSet.size === want.size && [...gotSet].every((k) => want.has(k));
    const noDupes = gotKeys.length === gotSet.size;
    const sameCols = got.length === 0 || sh.cols.every((c) => Object.hasOwn(got[0], c));

    if (sameSet && noDupes && sameCols) {
      pass += 1;
    } else {
      const flags = [
        sameSet ? '' : 'WRONG SET',
        noDupes ? '' : 'DUPLICATES',
        sameCols ? '' : 'COLUMNS MISSING',
      ]
        .filter((f) => f !== '')
        .join(' ');

      fails.push(
        `${mode} ${sh.name}: got ${String(gotKeys.length)} rows / ${String(gotSet.size)} distinct, want ${String(want.size)}  ${flags}`,
      );
    }
  }
}

console.log(`# multi-column one-hop DISTINCT: ${String(pass)} pass / ${String(fails.length)} fail`);

for (const f of fails) {
  console.log(`  FAIL ${f}`);
}

if (fails.length > 0) {
  process.exitCode = 1;
}
