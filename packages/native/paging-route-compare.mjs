/**
 * ONE question, both routes: top-10 by a property (item 1591).
 *
 *     GQL      MATCH (n) RETURN n.k AS k ORDER BY k LIMIT 10        1.247 ms
 *     Gremlin  V().values('k').order().limit(10)                    3.700
 *
 * 2.97x with GREMLIN on the slow side, and the biggest ABSOLUTE gap left in the cross-surface probe
 * (2.45 ms). Items 1574 and 1576 already took 2.97x cumulative out of this shape, so what remains is
 * not the obvious materialization.
 *
 * ⚠️ METHOD, from item 1590: PROFILE THE FAST SIDE. Five guesses at the slow side's mechanisms found
 * one win there; one profile of the fast side named the shortcut it had and the other lacked. Here
 * the fast side is GQL, so GQL is what gets profiled first.
 *
 *     ARM=gql  node --cpu-prof --cpu-prof-dir=DIR paging-route-compare.mjs
 *     ARM=grem node --cpu-prof --cpu-prof-dir=DIR paging-route-compare.mjs
 *     node paging-route-compare.mjs       # answers + timings, no profile
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const REPS = Number(process.env.REPS ?? 40);
const LIMIT = Number(process.env.LIMIT ?? 10);
const ARM = process.env.ARM ?? 'both';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  // `k` is deliberately LOW cardinality (97 values) and `n` unique, so the two can be compared:
  // a top-k over many ties is a different question from a top-k over distinct keys.
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

const GQL = `MATCH (n) RETURN n.k AS k ORDER BY k LIMIT ${LIMIT}`;
const PLAN = G.traversal(G.V(), G.values('k'), G.order(), G.limit(LIMIT));

const runGql = () => {
  const rows = query(g, GQL);

  return Array.isArray(rows) ? rows.length : null;
};
const runGrem = () => {
  const rows = G.toArray(PLAN, g);

  return Array.isArray(rows) ? rows.length : null;
};

/** The first row of each, so a route that returns the WRONG top-k cannot look fast. */
const firstOf = () => {
  const q = query(g, GQL);
  const r = G.toArray(PLAN, g);
  const qFirst = Array.isArray(q) ? Object.values(q[0] ?? {})[0] : null;
  const rFirst = Array.isArray(r) ? r[0] : null;

  return { qFirst, rFirst, agree: qFirst === rFirst };
};

const time = (fn) => {
  const s = [];

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    fn();
    s.push(performance.now() - t0);
  }

  const kept = s.slice(3).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)] ?? 0;
};

if (ARM === 'gql') {
  console.log(JSON.stringify({ arm: 'gql', rows: runGql(), ms: Number(time(runGql).toFixed(3)) }));
} else if (ARM === 'grem') {
  console.log(
    JSON.stringify({ arm: 'grem', rows: runGrem(), ms: Number(time(runGrem).toFixed(3)) }),
  );
} else {
  const { qFirst, rFirst, agree } = firstOf();
  const q1 = time(runGql);
  const r1 = time(runGrem);
  const r2 = time(runGrem);
  const q2 = time(runGql);
  const q = Math.min(q1, q2);
  const r = Math.min(r1, r2);

  console.log(
    JSON.stringify({
      limit: LIMIT,
      firstValuesAgree: agree,
      gqlFirst: qFirst,
      gremFirst: rFirst,
      gqlRows: runGql(),
      gremRows: runGrem(),
      gqlMs: Number(q.toFixed(3)),
      gremMs: Number(r.toFixed(3)),
      ratio: Number((r / q).toFixed(2)),
      slower: r > q ? 'gremlin' : 'gql',
    }),
  );
}
