/**
 * THE FLOOR for a SELECTIVE FAR FILTER on a yielding hop (item 1631), priced BEFORE building
 * anything (item 1465's rule).
 *
 * The cliff finder at 200,000 vertices / 5 fanout reported the oddity this prices:
 *
 * ```text
 *    hop values                  132.8 ms   999,996 rows
 *    hop + far has, values       188.2      20,000 rows     <- 1.42x the cost for 50x FEWER rows
 *    hop id                       59.5      999,996
 *    hop + far has, id           186.9      20,000          <- 3.14x
 * ```
 *
 * A far filter runs ONE TEST PER EDGE, so its cost scales with edges while its saving scales with
 * rows removed — but the saving here is the whole row-production cost of 980,000 rows, and the
 * filter still comes out ahead on the bill. The windowed profile says where:
 *
 * ```text
 *    hopfarhasvalues   (anonymous) in compileGates 45.5%   get properties 26.1%   drain 25.4%
 *    hopvaluesn (ctl)  pick 40.8%                          get properties 25.1%   drain 31.8%
 * ```
 *
 * ⚠️ `start-filtered-hop-values.ts` ALREADY RECORDS A REFUTATION NEARBY, and it is a different
 * shape. Its header prices `hasLabel(Q).out(E).values(k)` — a filter on the START side, 200,000
 * visits — and measured the gate at ~40 ns a visit, with compiled gates, per-plan materialization
 * and a single-gate loop all refuted (732 → 738, 757.7, 731). This is the FAR side: the test count
 * is 1M rather than 200k, and the profile attributes 138 ns per edge to the gate closure rather
 * than 40. Nothing on that list is re-attempted here; the question is whether 138 is real.
 *
 * ⚠️ AND `has(k, ALWAYS-TRUE)` IS THE CONTROL THAT SEPARATES THE TWO EFFECTS (item 570's rule:
 * `WHERE true` is THE control for "why is the filtered version slower"). It runs the identical 1M
 * tests and removes NO rows, so:
 *
 *   - always-true vs unfiltered          = what the gate machinery costs, rows held constant
 *   - selective vs always-true           = what dropping 99% of the rows saves
 *
 *     bun far-filter-values-floor.ts
 *     NODES=200000 REPS=9 bun far-filter-values-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, eq, gt, has, id, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 97, n: i } });
}

/** ⚠️ Split on the REPEAT INDEX — items 1516/1518; a linear `(a*k+b)%N` makes the graph functional. */
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
    properties: {},
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
  throw new Error('DEGENERATE FIXTURE — the generator collapsed');
}

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${branching} branching\n`,
);

/** The walk with NO filter: the shape the fused route already serves at `rest.length === 0`. */
const handWalk = (): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket as Iterable<Edge>) {
      const value = e.to.properties.n;

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

/** The same walk with the far test INLINE — one property read and one compare per edge. */
const handWalkFiltered = (want: number): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket as Iterable<Edge>) {
      const far = e.to;

      if (far.properties.k !== want) {
        continue;
      }

      const value = far.properties.n;

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

/**
 * The ALWAYS-TRUE hand arm: the identical per-edge test that rejects nothing, so it produces the
 * unfiltered row count while paying the filtered walk's test count. The floor's own twin of the
 * `WHERE true` control.
 */
const handWalkAlwaysTrue = (): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket as Iterable<Edge>) {
      const far = e.to;
      const { k } = far.properties;

      if (typeof k !== 'number' || !(k > -1)) {
        continue;
      }

      const value = far.properties.n;

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

type Arm = { name: string; run: () => number };

const ARMS: Arm[] = [
  // ── The target, its always-true control, and the unfiltered neighbour ─────────────────────────
  {
    name: 'engine far has eq (SELECTIVE, target)',
    run: () => toArray(traversal(V(), out('E'), has('k', eq(1)), values('n')), g).length,
  },
  {
    name: 'engine far has gt(-1) (ALWAYS TRUE)',
    run: () => toArray(traversal(V(), out('E'), has('k', gt(-1)), values('n')), g).length,
  },
  {
    name: 'engine NO filter (neighbour)',
    run: () => toArray(traversal(V(), out('E'), values('n')), g).length,
  },
  // ── The hand floors for each of the three ─────────────────────────────────────────────────────
  { name: 'HAND  far test eq     (FLOOR)', run: () => handWalkFiltered(1).length },
  { name: 'HAND  far test always (FLOOR)', run: () => handWalkAlwaysTrue().length },
  { name: 'HAND  no filter       (FLOOR)', run: () => handWalk().length },
  // ── The `id()` twin, 3.14x its neighbour in the cliff finder ──────────────────────────────────
  {
    name: 'engine far has eq, id()',
    run: () => toArray(traversal(V(), out('E'), has('k', eq(1)), id()), g).length,
  },
  {
    name: 'engine NO filter, id() (neighbour)',
    run: () => toArray(traversal(V(), out('E'), id()), g).length,
  },
];

console.log(
  `${'arm'.padEnd(40)} ${'ms/rep'.padStart(9)} ${'rows'.padStart(9)} ${'ns/edge'.padStart(8)}`,
);

for (const arm of ARMS) {
  let rows = 0;

  for (let i = 0; i < 2; i += 1) {
    rows = arm.run();
  }

  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    rows = arm.run();
    best = Math.min(best, performance.now() - t0);
  }

  // ns per EDGE, not per row: a far filter's work scales with edges visited, and comparing per-row
  // across arms that return 10,000 and 1,000,000 rows would be meaningless.
  console.log(
    `${arm.name.padEnd(40)} ${best.toFixed(2).padStart(9)} ${String(rows).padStart(9)} ${((best * 1e6) / edges).toFixed(1).padStart(8)}`,
  );
}
