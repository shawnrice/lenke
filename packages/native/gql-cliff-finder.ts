/**
 * A CLIFF FINDER for GQL's fast-path rungs — the twin of `gremlin-cliff-finder.ts` (item 1618).
 *
 * That instrument found four items in a row (1613, 1614, 1615, 1617) by asking a question no
 * absolute benchmark asks: take a family of shapes that differ by ONE clause, ask the engine which
 * rung answers each, and time them all. A shape whose NEIGHBOUR is answered in closed form and which
 * is itself orders slower is a CLIFF — two near-identical questions costing wildly different
 * amounts, the defect class this engine is named after. Item 1612's 214x sat next to a 464 us closed
 * form and no absolute reading would have flagged it.
 *
 * ⚠️ THE GQL SIDE CAN DO BETTER THAN A BOOLEAN. `compileLinear` returns a record of ~22 NAMED rungs,
 * so this prints WHICH ones fire rather than merely whether any did. That matters because of
 * `rung-precedence-decides-speed`: a willing rung can be starved by a broader one above it in
 * `runLinear`'s chain (1.80-6.00x at item 1583), and the fired-rung SET is the only thing that shows
 * it. Timing cannot tell "declined" from "more work" — item 1602's lesson, where a 157 ns/traverser
 * row looked like a constant until the rung was asked directly.
 *
 * The rung reader is `deferred-hop-order.test.ts`' `routes` helper, including its warning: a rung is
 * a FUNCTION, so filtering on `typeof v === 'function'` is what keeps it honest as `CLinear` grows.
 * Excluding fields by name let item 1510's `writes: boolean` register as a rung and fail 13 tests.
 *
 *     bun gql-cliff-finder.ts
 *     FAMILY=proj bun gql-cliff-finder.ts
 *     NODES=50000 REPS=20 bun gql-cliff-finder.ts
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal entry point, read pre-build
import { query } from '../gql/src/index.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point, read pre-build
import { parse } from '../gql/src/parser.ts';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 30);
const FAMILY = process.env.FAMILY ?? 'all';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['P'],
    properties: { team: `t${i % 50}`, k: i % 100, n: i, s: `s${i % 1000}` },
  });
}

/**
 * ⚠️ SPLIT THE TARGET ON THE REPEAT INDEX. `to = (a * k + b) % N` is INVARIANT under `k -> k + N`,
 * so a loop over `k < NODES * FANOUT` gives every one of a vertex's FANOUT edges the SAME target:
 * degree counts look perfect while the graph is FUNCTIONAL (CLAUDE.md, items 1516/1518).
 */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`) as Vertex,
    to: g.getVertexById(`u${to}`) as Vertex,
    labels: ['E'],
    properties: { w: k % 7 },
  });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS AND THE BRANCHING before trusting any number off this fixture.
const targets = new Set<string>();
const degree = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
}

const branching = [...degree.values()].filter((d) => d > 1).length;

if (targets.size < NODES * 0.5 || branching < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed; see the comment above');
}

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${branching} branching\n`,
);

/** The fast-path rungs that fire for `src`, by NAME — `deferred-hop-order.test.ts`' helper. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  // ⚠️ A RUNG IS A FUNCTION — see the header. Excluding fields by name is what let a boolean in.
  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/**
 * A shape, and optionally THE HONEST FLOOR FOR IT (item 2211).
 *
 * ⚠️⚠️ **FLOORS CAUSED THREE WRONG CALLS IN FOUR ITEMS (2206, 2208/2209, 2210), so the convention lives
 * HERE rather than in my head.** A `floor` is a hand-rolled arm that does **THE SAME WORK** as the query,
 * including work the query's clauses imply:
 *
 *   - a sorted shape's floor MUST SORT. Item 698 states it: the honest floor for an `ORDER BY` is *the
 *     unordered query PLUS a bare sort of its own rows*, and comparing against the unordered query alone
 *     **overstates by ~1.9x**. Item 2210 made exactly that error and withdrew a 3.5x "target".
 *   - a filtered shape's floor must apply the filter.
 *   - ⚠️ a floor may NOT use a cheaper ORDER than the engine is allowed to. The far-driven walk reorders
 *     rows and tie order is observable between the engines (item 605), so a streamed top-k is sound only
 *     where ties are identical rows.
 *
 * 🔑 **`vs floor` IS THE VERDICT; the neighbour-pair ratios below are a hint.** A shape with no floor
 * prints `-` and is explicitly unpriced rather than implicitly compared to something irrelevant.
 */
type Shape = {
  family: string;
  name: string;
  q: string;
  floor?: { label: string; run: () => unknown };
};

/**
 * ⚠️ EVERY FAMILY VARIES ONE CLAUSE AT A TIME, and each has a member the engine is known to answer
 * in closed form. A family of uniformly-slow shapes says nothing: the signal is the DISAGREEMENT
 * between neighbours, which is why the pairs at the bottom are declared rather than inferred.
 */
/* --- hand-rolled floors (item 2211): each does THE SAME WORK as its query ------------------- */

/** Every `P` vertex's `k`, as rows — the work a `RETURN n.k` must do. */
const scanRows = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];

  for (const v of g.verticesByLabel.get('P') ?? []) {
    out.push({ k: v.properties.k });
  }

  return out;
};

/** Every `(a:P)-[:E]->(b:P)` path's `b.k`, as rows — the work a one-hop `RETURN b.k` must do. */
const hopRows = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      out.push({ k: e.to.properties.k });
    }
  }

  return out;
};

const byK = (x: { k: unknown }, y: { k: unknown }): number => (x.k as number) - (y.k as number);

/** Every two-hop path's far `k` — the work a `hop2` `RETURN c.k` must do. */
const hop2Rows = (): { k: unknown }[] => {
  const out: { k: unknown }[] = [];

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e1 of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      for (const e2 of g.edgesFromByLabel.get(e1.to.id)?.get('E') ?? []) {
        out.push({ k: e2.to.properties.k });
      }
    }
  }

  return out;
};

/** One walk, accumulating BOTH aggregates — the floor for a two-aggregate shape. */
const hopAcc = (): { sum: number; min: number } => {
  let sum = 0;
  let min = Infinity;

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      sum += e.to.properties.n as number;
      min = Math.min(min, e.to.properties.k as number);
    }
  }

  return { sum, min };
};

/** One walk, tallying by `k` — the floor for a grouped hop count. */
const hopTally = (): Map<unknown, number> => {
  const by = new Map<unknown, number>();

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      const { k } = e.to.properties;

      by.set(k, (by.get(k) ?? 0) + 1);
    }
  }

  return by;
};

/**
 * Count the `(a:P)-[:E]->(b:P)` paths, optionally keeping only `k === want`.
 *
 * ⚠️ A COUNT'S FLOOR MUST NOT MATERIALIZE ROWS — that would charge the engine for allocation its own
 * closed form avoids, which is the mirror image of item 698's mistake (a floor doing LESS work than the
 * query overstates; one doing MORE understates and hides a real gap).
 */
const hopCount = (want?: number): number => {
  let n = 0;

  for (const a of g.verticesByLabel.get('P') ?? []) {
    for (const e of g.edgesFromByLabel.get(a.id)?.get('E') ?? []) {
      if (want === undefined || e.to.properties.k === want) {
        n += 1;
      }
    }
  }

  return n;
};

const SHAPES: Shape[] = [
  // --- node scans: the family items 1607/1609/1610/1611 worked on, kept as the CONTROL -------
  {
    family: 'node',
    name: 'count',
    q: 'MATCH (n:P) RETURN count(*) AS c',
    floor: {
      label: 'label bucket size',
      run: () => (g.verticesByLabel.get('P') ?? new Set()).size,
    },
  },
  { family: 'node', name: 'count + where', q: 'MATCH (n:P) WHERE n.k = 5 RETURN count(*) AS c' },
  {
    family: 'node',
    name: 'rows',
    q: 'MATCH (n:P) RETURN n.k AS k',
    floor: { label: 'scan + read k', run: scanRows },
  },
  { family: 'node', name: 'rows + where', q: 'MATCH (n:P) WHERE n.k = 5 RETURN n.k AS k' },

  // --- one hop, count then rows then aggregates ---------------------------------------------
  {
    family: 'hop',
    name: 'count',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
    floor: { label: 'walk + count', run: () => hopCount() },
  },
  {
    family: 'hop',
    name: 'count + far where',
    q: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 5 RETURN count(*) AS c',
  },
  {
    family: 'hop',
    name: 'rows',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k',
    floor: { label: 'walk + read k', run: hopRows },
  },
  {
    family: 'hop',
    name: 'rows + far where',
    q: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 5 RETURN b.k AS k',
  },
  {
    family: 'hop',
    name: 'sum',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN sum(b.n) AS s',
    floor: { label: 'walk + sum n', run: () => hopAcc().sum },
  },
  {
    family: 'hop',
    name: 'two aggregates',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN sum(b.n) AS s, min(b.k) AS m',
    floor: { label: 'walk + sum + min', run: () => hopAcc() },
  },
  {
    family: 'hop',
    name: 'distinct count',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN count(DISTINCT b) AS c',
  },
  {
    family: 'hop',
    name: 'distinct rows',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.k AS k',
    floor: { label: 'walk + Set of k', run: () => [...new Set(hopRows().map((r) => r.k))] },
  },

  // --- two hops, the family the Gremlin side just closed ------------------------------------
  {
    family: 'hop2',
    name: 'count',
    q: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c',
  },
  {
    family: 'hop2',
    name: 'rows',
    q: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k',
    floor: { label: 'two-hop walk + read k', run: hop2Rows },
  },
  {
    family: 'hop2',
    name: 'rows + trailing where',
    q: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE c.k = 5 RETURN c.k AS k',
  },
  {
    family: 'hop2',
    name: 'rows + mid where',
    q: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE b.k = 5 RETURN c.k AS k',
  },
  {
    family: 'hop2',
    name: 'count + trailing where',
    q: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE c.k = 5 RETURN count(*) AS c',
  },

  // --- grouping, ordering, paging: one clause apart from a plain projection ------------------
  { family: 'page', name: 'grouped count', q: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c' },
  {
    family: 'page',
    name: 'grouped hop count',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k, count(*) AS c',
    floor: { label: 'walk + Map tally', run: hopTally },
  },
  {
    family: 'page',
    name: 'ordered rows',
    q: 'MATCH (n:P) RETURN n.k AS k ORDER BY k',
    /* ⚠️ THE SORT IS PART OF THE FLOOR — item 698. */
    floor: { label: 'scan + sort', run: () => scanRows().sort(byK) },
  },
  {
    family: 'page',
    name: 'topk',
    q: 'MATCH (n:P) RETURN n.k AS k ORDER BY k LIMIT 10',
    floor: { label: 'scan + sort + slice', run: () => scanRows().sort(byK).slice(0, 10) },
  },
  {
    family: 'page',
    name: 'topk over a hop',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k ORDER BY k LIMIT 10',
    /*
     * ⚠⚠ **THE FLOOR THAT ITEM 2210 GOT WRONG.** A streamed bounded top-10 reads 2,068 us and is NOT
     * the floor: it never sorts, and it walks in far-driven order, which would reorder ties (item 605).
     * The honest floor walks, keys, SORTS and slices — and against it the engine is 1.20-1.66x at every
     * degree, inside item 698's measured band.
     */
    floor: { label: 'hop + sort + slice', run: () => hopRows().sort(byK).slice(0, 10) },
  },
  {
    family: 'page',
    name: 'collect',
    q: 'MATCH (n:P) RETURN collect(n.k) AS ks',
    floor: { label: 'scan + collect', run: () => scanRows().map((r) => r.k) },
  },
  {
    family: 'page',
    name: 'collect over a hop',
    q: 'MATCH (a:P)-[:E]->(b:P) RETURN collect(b.k) AS ks',
    floor: { label: 'hop + collect', run: () => hopRows().map((r) => r.k) },
  },
];

const picked = FAMILY === 'all' ? SHAPES : SHAPES.filter((s) => s.family === FAMILY);

/** Min-of-REPS for a hand-rolled floor, timed exactly as the query is. */
const floorNs = (run: () => unknown): number => {
  for (let i = 0; i < 3; i += 1) {
    run();
  }

  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    run();
    best = Math.min(best, performance.now() - t0);
  }

  return best * 1e6;
};

console.log(
  `${'family'.padEnd(6)} ${'shape'.padEnd(24)} ${'ns/op'.padStart(11)} ${'floor'.padStart(11)} ${'vs floor'.padStart(9)} ${'rows'.padStart(7)}  rungs`,
);

const timings = new Map<string, number>();

for (const s of picked) {
  const fired = routes(s.q);

  for (let i = 0; i < 3; i += 1) {
    query(g, s.q);
  }

  const rows = query(g, s.q).length;
  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    query(g, s.q);
    best = Math.min(best, performance.now() - t0);
  }

  const ns = best * 1e6;

  timings.set(`${s.family}/${s.name}`, ns);

  const fl = s.floor === undefined ? undefined : floorNs(s.floor.run);
  /*
   * 🔑 Flag on the FLOOR ratio, which is the only one that says a win is reachable — **AND on an absolute
   * size**, which item 2212 added after `node/count` flagged at 17.63x for 1,410 ns against an 80 ns
   * `Set.size` read. A big ratio between two trivial numbers is arithmetic, not a target; 50 us is roughly
   * where this repo's ~10%-of-something-real threshold starts to mean anything.
   */
  const over =
    fl === undefined ? '' : `${(ns / fl).toFixed(2)}x${ns / fl > 2 && ns > 50_000 ? ' <--' : ''}`;

  console.log(
    `${s.family.padEnd(6)} ${s.name.padEnd(24)} ${ns.toFixed(0).padStart(11)} ${(fl === undefined ? '-' : fl.toFixed(0)).padStart(11)} ${over.padStart(9)} ${String(rows).padStart(7)}  ${
      fired.length === 0 ? 'PIPELINE' : fired.join(' ')
    }`,
  );
}

/**
 * NEIGHBOUR PAIRS: each differs by ONE clause. ⚠️ A ratio is a SUSPECT, not a verdict — the filtered
 * or deeper member can legitimately do more work. What makes it a cliff is the rung column: a
 * neighbour answered by a named rung while this one reads `PIPELINE`, or a rung SET that shrinks
 * when a clause is added.
 */
const PAIRS: readonly [string, string][] = [
  ['node/count', 'node/count + where'],
  ['node/rows', 'node/rows + where'],
  ['node/count', 'node/rows'],
  ['hop/count', 'hop/count + far where'],
  ['hop/rows', 'hop/rows + far where'],
  ['hop/count', 'hop/rows'],
  ['hop/sum', 'hop/two aggregates'],
  ['hop/distinct count', 'hop/distinct rows'],
  ['hop2/count', 'hop2/rows'],
  ['hop2/rows', 'hop2/rows + trailing where'],
  ['hop2/rows', 'hop2/rows + mid where'],
  ['hop2/count', 'hop2/count + trailing where'],
  ['page/grouped count', 'page/grouped hop count'],
  ['page/ordered rows', 'page/topk'],
  ['page/topk', 'page/topk over a hop'],
  ['page/collect', 'page/collect over a hop'],
];

console.log(
  '\nNEIGHBOUR PAIRS (one clause apart). A large ratio beside a NAMED rung on the cheap side is a cliff.',
);

for (const [a, b] of PAIRS) {
  const x = timings.get(a);
  const y = timings.get(b);

  if (x === undefined || y === undefined) {
    continue;
  }

  const ratio = y / x;

  console.log(
    `  ${a.padEnd(26)} -> ${b.padEnd(30)} ${ratio.toFixed(2)}x${ratio > 5 ? '  <-- SUSPECT' : ''}`,
  );
}
