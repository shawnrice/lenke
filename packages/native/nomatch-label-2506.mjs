/*
 * Item 2506: price item 2505's oddity. A chain whose second hop names an edge label that MATCHES
 * NOTHING retained 25.90 MiB and returned ZERO rows, against 14.56 MiB for the 200,000-row
 * productive chain. Memory is priced; TIME is not, and neither surface has been compared.
 *
 * ## WHAT IS ASKED, IN ORDER
 *
 *   (a) Is the TIME as bad as the memory, or does the walk short-circuit once the second hop finds
 *       nothing? Memory says both CSRs get built; time would say whether anything is then iterated.
 *   (b) Does the GQL surface have the same shape, or does its planner notice the empty label first?
 *       These are two independent planners over one store, so there is no reason to assume.
 *   (c) Is a pre-build check even available? `Graph.ts` exposes `edgeLabels` and `labelCount`, and
 *       NO executor consults them for this — `labelExists`/`hasEdgeLabel`/`knownEdgeLabel` appear
 *       nowhere in the tree. So the information exists and is unused.
 *
 * ## THE CONTROLS THAT MAKE IT READABLE
 *
 *   - `chain2` is the productive two-hop chain: the thing a no-match chain should never cost more
 *     than.
 *   - `hop1nomatch` is a ONE-hop walk on the missing label. It returns zero rows too, and item 2505
 *     showed a single hop never builds a chain CSR — so it is the floor for "returns nothing", and
 *     the gap between it and `chain2nomatch` is what the chain route adds for no rows.
 *   - `chain2sameNomatch` names the MISSING label at BOTH hops. If the cost really is one CSR per
 *     DISTINCT hop shape, this must cost about HALF of `chain2nomatch` (one shared numbering), which
 *     is a prediction item 2505's arithmetic makes and this arm tests.
 *
 * Time is min-of-N over repeated runs in one process per shape; memory is the peak-retained sampler
 * from the same run. One shape per process (item 2504).
 *
 *     node nomatch-label-2506.mjs
 *     SWAP_N=200000 REPS=5 node nomatch-label-2506.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SWAP_N ?? 200000);
const STEP = Number(process.env.SWAP_STEP ?? 8192);
const REPS = Number(process.env.REPS ?? 5);

if (process.env.ARM === 'child') {
  const { V, out, run, traversal } = await import('@lenke/gremlin');
  const { Graph } = await import('@lenke/core');
  const { query } = await import('@lenke/gql');

  const graph = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let i = 0; i < N; i += 1) {
    graph.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i + 1) % N],
      labels: ['E'],
      properties: {},
    });
  }

  const gremlinPlans = {
    chain2: () => traversal(V(), out('E'), out('E')),
    chain2nomatch: () => traversal(V(), out('E'), out('NOSUCH')),
    chain2sameNomatch: () => traversal(V(), out('NOSUCH'), out('NOSUCH')),
    hop1nomatch: () => traversal(V(), out('NOSUCH')),
    hop1: () => traversal(V(), out('E')),
  };

  const gqlSrc = {
    gqlChain2: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS n',
    gqlChain2nomatch: 'MATCH (a:P)-[:E]->(b:P)-[:NOSUCH]->(c:P) RETURN count(*) AS n',
    gqlHop1nomatch: 'MATCH (a:P)-[:NOSUCH]->(b:P) RETURN count(*) AS n',
    /*
     * ROW-RETURNING GQL ARMS, because the three `count(*)` arms above are NOT a fair comparison with
     * Gremlin's row-producing walk and reading them as one would have been the error. `count(*)`
     * takes a counting shortcut that never materializes a row — it answered 200,000 rows in 0.3 ms
     * and 0.35 MiB, which is a closed form, not a walk. Within the GQL column the no-match arm still
     * matches its control, but that only says GQL does not PENALIZE the empty label on that route.
     * These two return actual rows, so they sit on the same side of the comparison as the Gremlin
     * arms.
     */
    gqlRowsChain2: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k',
    gqlRowsChain2nomatch: 'MATCH (a:P)-[:E]->(b:P)-[:NOSUCH]->(c:P) RETURN c.k AS k',
  };

  const shape = process.env.SHAPE;
  const isGql = shape.startsWith('gql');

  /* Peak retained on the FIRST run, then min-of-REPS for time on the rest. */
  global.gc();
  const baseHeap = process.memoryUsage().heapUsed;
  let worst = 0;
  let rows = 0;

  if (isGql) {
    const r = query(graph, gqlSrc[shape]);

    /* A count arm returns ONE row holding the count; a row arm returns the rows themselves. */
    rows = shape.startsWith('gqlRows') ? r.length : Number(Object.values(r[0] ?? {})[0] ?? 0);
    global.gc();
    worst = process.memoryUsage().heapUsed - baseHeap;
  } else {
    let c = 0;

    for (const _row of run(gremlinPlans[shape](), graph)) {
      c += 1;

      if (c % STEP === 0) {
        global.gc();
        const live = process.memoryUsage().heapUsed - baseHeap;

        if (live > worst) {
          worst = live;
        }
      }
    }

    rows = c;
    global.gc();
    worst = Math.max(worst, process.memoryUsage().heapUsed - baseHeap);
  }

  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    if (isGql) {
      query(graph, gqlSrc[shape]);
    } else {
      let c = 0;

      for (const _row of run(gremlinPlans[shape](), graph)) {
        c += 1;
      }
    }

    const ms = performance.now() - t0;

    if (ms < best) {
      best = ms;
    }
  }

  process.stdout.write(`${JSON.stringify({ rows, mib: worst / 1024 / 1024, ms: best })}\n`);
  process.exit(0);
}

const SHAPES = [
  ['chain2', 'gremlin: out(E),out(E)                PRODUCTIVE ctl'],
  ['hop1', 'gremlin: out(E)                      1-hop ctl'],
  ['chain2nomatch', 'gremlin: out(E),out(NOSUCH)          THE FINDING'],
  ['chain2sameNomatch', 'gremlin: out(NOSUCH),out(NOSUCH)     same label twice'],
  ['hop1nomatch', 'gremlin: out(NOSUCH)                 zero-row FLOOR'],
  ['gqlChain2', 'gql:     -[:E]->-[:E]->               PRODUCTIVE ctl'],
  ['gqlChain2nomatch', 'gql:     -[:E]->-[:NOSUCH]->          same shape in GQL'],
  ['gqlHop1nomatch', 'gql:     -[:NOSUCH]->                 zero-row FLOOR'],
  ['gqlRowsChain2', 'gql ROWS: -[:E]->-[:E]-> RETURN c.k   PRODUCTIVE ctl'],
  ['gqlRowsChain2nomatch', 'gql ROWS: -[:NOSUCH]-> RETURN c.k    the fair comparison'],
];

const one = (shape) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', SHAPE: shape },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(`# no-match edge label: TIME and MEMORY  N=${N} REPS=${REPS} (one shape per process)`);
console.log(
  '# A chain naming an empty label returns NO rows. Does it cost more than one that works?\n',
);
console.log('  shape                rows        MiB        ms   what');

for (const [shape, what] of SHAPES) {
  const r = one(shape);

  console.log(
    `  ${shape.padEnd(18)} ${String(r.rows).padStart(7)} ${r.mib.toFixed(2).padStart(9)} ` +
      `${r.ms.toFixed(1).padStart(9)}   ${what}`,
  );
}

console.log(
  '\n  Compare each nomatch arm against BOTH its productive control and the zero-row floor.',
);
console.log('  `chain2sameNomatch` tests the one-CSR-per-DISTINCT-shape prediction: expect ~half.');
