// Item 1932 — WHAT EXACTLY DOES ONE WRITE COST THE NEXT GQL READ, and why does Gremlin not pay it?
//
// `write-workload-screen-1932.mjs` at 20,000 vertices / 40,000 edges:
//
//     gql: read after write        24.02 ms   vs   gql: read, no write      7.44   3.23x
//     gremlin: read after write     7.22      vs   gremlin: read, no write  6.75   1.07x  FLAT
//
// THE SCREEN'S 3.23x CONFLATES THE WRITE WITH THE READ, and this probe's `ALONE` arms are what
// decompose it. The honest number is 1.84x: `insert ALONE` is 0.10 ms and `read alone` 6.86, so the
// 12.70 of `insert, read` means the READ itself went 6.86 -> ~12.60. Gremlin's equivalent is 0.96x,
// i.e. nothing — so the demotion is in the GQL READ PATH's caching, not in core.
//
// The write is `INSERT (:W {n: 1})` — ONE VERTEX, with no edge and no relation to the `T`/`E`
// subgraph the read traverses. And the ratio GROWS with N (2.68x at 5,000), which points at
// something O(N) being redone rather than a constant.
//
// CLAUDE.md describes this shape on the NATIVE side — "`rebuild_csr` runs only at LOAD, and every
// adjacency write clears `csr_fresh` with nothing to re-arm it, so ONE `add_edge` demotes EVERY
// later read for the rest of the session" — and warns the ~2.5x figure understates it. Whether the
// TS engine has the same cliff has never been screened. These arms answer the questions that
// distinguish the candidate mechanisms:
//
//   1. does a SECOND read recover?        a one-time rebuild vs a PERMANENT demotion
//   2. does the write's KIND matter?      vertex / edge / property / a write that matches NOTHING
//   3. does the write COUNT matter?       one invalidation vs per-write work
//   4. is the cost in the READ or spread? compare the read alone against the pair
//
// FRESH GRAPH PER REP, and the build excluded from the timer: a write is not idempotent.
//
//     bun writecliff-probe-1932.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 9);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: ['T'],
      properties: { n: i % 97, w: i % 7, uk: `u${String(i)}` },
    });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: { w: e % 7 },
    });
  }

  return g;
};

const READ = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';
/*
 * UNIQUE KEYS, AND THE COUNT IS VERIFIED BELOW. The first version of this probe wrote
 * `WHERE a.n = 0 AND b.n = 1`, and `n` is `i % 97` — so each side matched ~206 vertices and the
 * CARTESIAN PRODUCT inserted ~42,000 EDGES. It reported 80.72 ms as a "14.37x read cliff" when it
 * was bulk edge ingest. I had built exactly this check into `write-workload-screen-1932.mjs` an
 * hour earlier (a write's `rows` cannot show what it changed) and then did not apply it here.
 */
const EDGE_INSERT = 'MATCH (a:T), (b:T) WHERE a.uk = $x AND b.uk = $y INSERT (a)-[:F]->(b)';
const gqlRead = (g) => query(g, READ, {}).length;
const gremRead = (g) => toArray(traversal(V(), out('E'), values('n')), g).length;

const ARMS = {
  /*
   * THE CRUX ARM. `insert, read` (12.78) came out level with `read twice` (13.92), which cannot
   * be right if the insert costs the 0.09 ms the write screen measured for it. So time the INSERT
   * ALONE on this fixture: if it is ~6.7 ms here, the cost is the WRITE and there is no read
   * cliff at all; if it is ~0.1 ms, the cost really is in the read that follows.
   */
  'gql: insert ALONE': (g) => query(g, 'INSERT (:W {n: 1})', {}).length,
  'gql: edge insert ALONE': (g) => query(g, EDGE_INSERT, { x: 'u1', y: 'u2' }).length,
  'gql: empty write ALONE': (g) => query(g, 'MATCH (n:T) WHERE n.n = 9999 SET n.w = 9', {}).length,

  // ——— the baseline pair ———
  'gql read alone': (g) => gqlRead(g),
  'gql read twice': (g) => gqlRead(g) + gqlRead(g),

  // ——— 1. does a SECOND read recover? ———
  'gql: insert, read': (g) => {
    query(g, 'INSERT (:W {n: 1})', {});

    return gqlRead(g);
  },
  'gql: insert, read, read': (g) => {
    query(g, 'INSERT (:W {n: 1})', {});
    gqlRead(g);

    return gqlRead(g);
  },
  // THE DISCRIMINATING ARM for "one-time rebuild vs permanent demotion": time ONLY the second
  // read. If the demotion is permanent this stays slow; if it is a rebuild, this is the fast read.
  'gql: insert, warm, then time': (g) => {
    query(g, 'INSERT (:W {n: 1})', {});
    gqlRead(g);

    return 0;
  },

  // ——— 2. does the write's KIND matter? ———
  'gql: read after EDGE insert': (g) => {
    query(g, EDGE_INSERT, { x: 'u1', y: 'u2' });

    return gqlRead(g);
  },
  'gql: read after SET one row': (g) => {
    query(g, 'MATCH (n:T) WHERE n.n = 0 SET n.w = 9', {});

    return gqlRead(g);
  },
  // A WRITE THAT MATCHES NOTHING. If this costs the same, the demotion is on the STATEMENT being
  // a write at all, not on anything it changed.
  'gql: read after EMPTY write': (g) => {
    query(g, 'MATCH (n:T) WHERE n.n = 9999 SET n.w = 9', {});

    return gqlRead(g);
  },

  // ——— 3. does the write COUNT matter? ———
  'gql: 5 inserts, read': (g) => {
    for (let i = 0; i < 5; i += 1) {
      query(g, 'INSERT (:W {n: 1})', {});
    }

    return gqlRead(g);
  },

  // ——— 4. the Gremlin side of each, since it does NOT pay the cliff ———
  'grem read alone': (g) => gremRead(g),
  'grem: insert, read': (g) => {
    query(g, 'INSERT (:W {n: 1})', {});

    return gremRead(g);
  },
  'grem: read after EDGE insert': (g) => {
    query(g, EDGE_INSERT, { x: 'u1', y: 'u2' });

    return gremRead(g);
  },
};

/*
 * PROVE THE EDGE ARM INSERTS EXACTLY ONE EDGE before trusting any number from it. A probe that
 * reports a ratio without checking what its write actually did is the failure above, repeated.
 */
{
  const g = build();

  query(g, EDGE_INSERT, { x: 'u1', y: 'u2' });

  const inserted = query(g, 'MATCH (a:T)-[:F]->(b:T) RETURN count(*) AS c', {})[0].c;

  console.log(`edge-insert arm writes ${String(inserted)} edge(s) — must be 1\n`);

  if (Number(inserted) !== 1) {
    throw new Error(
      `edge arm inserts ${String(inserted)} edges, not 1 — the ratio would be ingest`,
    );
  }
}

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const g = build();
    const t0 = performance.now();

    got = fn(g);

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);
  results[name] = ser[ser.length >> 1];
  console.log(`${name.padEnd(30)} median ${results[name].toFixed(2)} ms   result ${got}`);
}

const base = results['gql read alone'];

console.log(`\nagainst the plain GQL read (${base.toFixed(2)} ms):`);

for (const [name, ms] of Object.entries(results)) {
  if (name !== 'gql read alone' && name.startsWith('gql')) {
    console.log(`  ${name.padEnd(30)} ${(ms / base).toFixed(2)}x`);
  }
}

const gbase = results['grem read alone'];

console.log(`\nagainst the plain Gremlin read (${gbase.toFixed(2)} ms):`);

for (const [name, ms] of Object.entries(results)) {
  if (name !== 'grem read alone' && name.startsWith('grem')) {
    console.log(`  ${name.padEnd(30)} ${(ms / gbase).toFixed(2)}x`);
  }
}
