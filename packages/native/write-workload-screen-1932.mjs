// Item 1932 — THE SHAPE EVERY SCREEN IS MISSING: A WRITE.
//
// ALL THREE EXISTING SCREENS ARE READ-ONLY. `gql-coverage-screen-1901.mjs`,
// `workload-perf-screen.mjs` and `gremlin-workload-screen.mjs` carry 100+ shapes between them and
// not one of them mutates the graph — a grep for INSERT/SET/REMOVE/DELETE across all three matches
// only `OFFSET` and `CONTROL SET` in prose. So writes have never been screened, on either surface,
// while the read side has been screened to its floor (items 1930/1931).
//
// THAT IS THE COVERAGE MOVE THAT HAS PAID TWICE BEFORE: item 1898 asked what the Gremlin screen
// did NOT ask and found all five of the surface's biggest shapes among the answers; item 1927 asked
// which SPELLINGS a rewrite never saw and found 11 of 13 stranded. Asking what a screen omits beats
// re-pricing what it carries.
//
// A WRITE SCREEN NEEDS A FRESH GRAPH PER REPETITION, which is what makes it different from every
// read screen here. A read is idempotent, so min-of-N over one fixture is honest; a write is not —
// the second INSERT runs against a bigger graph than the first, and a DELETE run twice has nothing
// to delete the second time. So each rep rebuilds, and the BUILD IS EXCLUDED from the timing.
//
// AND THE PER-REP REBUILD IS WHY THE DEFAULT SIZE IS SMALL. At 200,000 vertices the rebuild
// dominates wall clock and the whole screen takes minutes per row; the question here is per-write
// cost, not bulk ingest (which `ts-ingest-is-constant-factor` already closed). Raise NODES
// deliberately for a cache-residency sweep.
//
//     bun write-workload-screen-1932.mjs
//     NODES=50000 REPS=5 bun write-workload-screen-1932.mjs
//     SHAPE='set one prop' bun write-workload-screen-1932.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { addE, addV, drop, out, property, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);
const ONLY = process.env.SHAPE;

/**
 * A fresh graph. Rebuilt PER REPETITION and excluded from the timing, because a write is not
 * idempotent and timing it over a graph the previous rep already mutated measures a different
 * question each time.
 */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: ['T'],
      properties: { n: i % 97, k: `s${String(i)}`, w: i % 7 },
    });
  }

  // `_MERGE` is a KEYED upsert and refuses without a unique constraint on the key, so the fixture
  // declares one — otherwise those two rows measure an exception, not a write.
  g.createUniqueConstraint('T', 'k');

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      // SPLIT ON THE REPEAT INDEX — `to = (a*k + b) % N` is invariant under `k -> k + N`, so a
      // flat loop would send one vertex's whole fanout to the SAME target and the graph would come
      // out FUNCTIONAL while every degree count looked right (CLAUDE.md; items 1516/1518).
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: { w: e % 7 },
    });
  }

  return g;
};

/*
 * `rows` IS MEANINGLESS FOR A WRITE, which the first smoke run of this screen demonstrated: a
 * GQL write with no `RETURN` answers an EMPTY array, so nine of twenty rows reported 0 and a `SET`
 * that updated every vertex was indistinguishable from one that matched nothing. The read screens'
 * rule ("a shape returning 0 rows measures a miss") does not transfer.
 *
 * SO EVERY SHAPE CARRIES A `verify`, run ONCE OUTSIDE THE TIMER, that counts what actually
 * changed — a post-write query, or the graph's own element counts. A row whose `work` is 0 is a
 * broken row, and now it says so.
 */
/** `[label, {run(graph), verify(graph) -> workDone}]`. */
const SHAPES_RUN = {
  // ——— INSERT: one, and many ———
  'gql: insert one node': (g) => query(g, 'INSERT (:W {n: 1})', {}).length,
  'gql: insert node + RETURN': (g) =>
    query(g, 'INSERT (:W {n: 1}) RETURN count(*) AS c', {}).length,
  'gremlin: addV one': (g) => toArray(traversal(addV('W'), property('n', 1)), g).length,

  // ——— SET: the shape `ts-set-is-o-width` prices at 3 O(K) passes a write ———
  'gql: set one prop, all rows': (g) => query(g, 'MATCH (n:T) SET n.n = 1', {}).length,
  'gql: set one prop, one row': (g) =>
    query(g, 'MATCH (n:T) WHERE n.k = $k SET n.n = 1', { k: 's17' }).length,
  'gql: set two props, all rows': (g) => query(g, 'MATCH (n:T) SET n.n = 1, n.w = 2', {}).length,
  // A NEW property, not an overwrite — a write that WIDENS the row rather than replacing a value
  // in it, which is the axis `ts-set-is-o-width` says the cost scales on.
  'gql: set NEW prop, all rows': (g) => query(g, 'MATCH (n:T) SET n.fresh = 1', {}).length,
  'gremlin: property all': (g) => toArray(traversal(V(), property('n', 1)), g).length,

  // ——— REMOVE / DELETE ———
  'gql: remove prop, all rows': (g) => query(g, 'MATCH (n:T) REMOVE n.w', {}).length,
  'gql: detach delete one': (g) =>
    query(g, 'MATCH (n:T) WHERE n.k = $k DETACH DELETE n', { k: 's17' }).length,
  'gremlin: drop one': (g) => toArray(traversal(V(String(17)), drop()), g).length,

  // ——— edges ———
  'gql: insert edge between matched': (g) =>
    query(g, 'MATCH (a:T), (b:T) WHERE a.k = $x AND b.k = $y INSERT (a)-[:F]->(b)', {
      x: 's1',
      y: 's2',
    }).length,
  'gremlin: addE between two': (g) => toArray(traversal(V('1'), addE('F').to(V('2'))), g).length,

  // ——— _MERGE, the keyed upsert ———
  'gql: _MERGE hit': (g) => query(g, '_MERGE (:T {k: $k})', { k: 's17' }).length,
  'gql: _MERGE miss': (g) => query(g, '_MERGE (:T {k: $k})', { k: 'absent-key' }).length,

  // ——— INTERLEAVED, which is the shape CLAUDE.md says costs ~2.5x and UNDERSTATES it ———
  // "ONE add_edge clears csr_fresh with nothing to re-arm it, so it demotes EVERY later read for
  // the rest of the session". That is a NATIVE note; whether the TS engine has the same cliff has
  // never been screened, and these two rows are the pair that answers it.
  'gql: read after write': (g) => {
    query(g, 'INSERT (:W {n: 1})', {});

    return query(g, 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x', {}).length;
  },
  'gql: read, no write (CONTROL)': (g) =>
    query(g, 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x', {}).length,
  'gremlin: read after write': (g) => {
    toArray(traversal(addV('W'), property('n', 1)), g);

    return toArray(traversal(V(), out('E'), values('n')), g).length;
  },
  'gremlin: read, no write (CONTROL)': (g) =>
    toArray(traversal(V(), out('E'), values('n')), g).length,
};

/**
 * What each shape actually CHANGED, counted after the fact. Run once, outside the timer.
 *
 * A `work` of 0 means the row is BROKEN — the write matched nothing, or the shape is wrong — and
 * the screen prints it as such rather than as a fast write.
 */
const VERIFY = {
  'gql: insert one node': (g) => query(g, 'MATCH (n:W) RETURN count(*) AS c', {})[0].c,
  'gql: insert node + RETURN': (g) => query(g, 'MATCH (n:W) RETURN count(*) AS c', {})[0].c,
  'gremlin: addV one': (g) => query(g, 'MATCH (n:W) RETURN count(*) AS c', {})[0].c,
  'gql: set one prop, all rows': (g) =>
    query(g, 'MATCH (n:T) WHERE n.n = 1 RETURN count(*) AS c', {})[0].c,
  'gql: set one prop, one row': (g) =>
    query(g, 'MATCH (n:T) WHERE n.k = $k AND n.n = 1 RETURN count(*) AS c', { k: 's17' })[0].c,
  'gql: set two props, all rows': (g) =>
    query(g, 'MATCH (n:T) WHERE n.n = 1 AND n.w = 2 RETURN count(*) AS c', {})[0].c,
  'gql: set NEW prop, all rows': (g) =>
    query(g, 'MATCH (n:T) WHERE n.fresh = 1 RETURN count(*) AS c', {})[0].c,
  'gremlin: property all': (g) =>
    query(g, 'MATCH (n:T) WHERE n.n = 1 RETURN count(*) AS c', {})[0].c,
  // A REMOVE is verified by what is GONE, so the count that proves it is the complement.
  'gql: remove prop, all rows': (g) =>
    NODES - query(g, 'MATCH (n:T) WHERE n.w IS NOT NULL RETURN count(*) AS c', {})[0].c,
  'gql: detach delete one': (g) => NODES - g.vertexCount,
  'gremlin: drop one': (g) => NODES - g.vertexCount,
  'gql: insert edge between matched': (g) =>
    query(g, 'MATCH (a:T)-[:F]->(b:T) RETURN count(*) AS c', {})[0].c,
  'gremlin: addE between two': (g) =>
    query(g, 'MATCH (a:T)-[:F]->(b:T) RETURN count(*) AS c', {})[0].c,
  // A HIT must not add a vertex; a MISS must add exactly one. Both are "work", in opposite
  // directions — so each verifies the thing its own name claims.
  'gql: _MERGE hit': (g) => (g.vertexCount === NODES ? 1 : 0),
  'gql: _MERGE miss': (g) => g.vertexCount - NODES,
  'gql: read after write': (g) => query(g, 'MATCH (n:W) RETURN count(*) AS c', {})[0].c,
  'gql: read, no write (CONTROL)': () => 1,
  'gremlin: read after write': (g) => query(g, 'MATCH (n:W) RETURN count(*) AS c', {})[0].c,
  'gremlin: read, no write (CONTROL)': () => 1,
};

const names = Object.keys(SHAPES_RUN).filter((n) => ONLY === undefined || n.includes(ONLY));
const rows = [];

for (const name of names) {
  const fn = SHAPES_RUN[name];
  const series = [];
  let work = 0;
  let err = '';

  for (let r = 0; r < REPS + 2; r += 1) {
    // FRESH GRAPH, OUTSIDE THE TIMER — a write is not idempotent, so timing it over a graph the
    // previous rep already mutated measures a different question each time.
    const g = build();
    const t0 = performance.now();

    try {
      fn(g);
    } catch (e) {
      err = String(e).slice(0, 34);
      work = -1;
    }

    const ms = performance.now() - t0;

    if (r >= 2) {
      series.push(ms);
    }

    // The work count comes from the LAST rep's graph, after the timer has stopped.
    if (err === '' && r === REPS + 1) {
      try {
        work = Number(VERIFY[name](g));
      } catch (e) {
        err = `verify: ${String(e).slice(0, 24)}`;
        work = -1;
      }
    }
  }

  series.sort((a, b) => a - b);
  rows.push([series[series.length >> 1], work, name, err]);
}

rows.sort((a, b) => b[0] - a[0]);

console.log(
  `# ${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS}, FRESH GRAPH PER REP.\n` +
    '# `work` is what the write actually CHANGED, counted after the timer. A work of 0 or -1 is a\n' +
    '#   BROKEN ROW, not a fast write — `rows` cannot say this, because a GQL write with no RETURN\n' +
    '#   answers an empty array whether it updated every vertex or matched nothing.\n',
);
console.log('      ms     work   shape');
console.log('-'.repeat(62));

for (const [ms, n, name, err] of rows) {
  const note = err === '' ? '' : `  ${err}`;

  console.log(`${ms.toFixed(2).padStart(8)} ${String(n).padStart(8)}   ${name}${note}`);
}
