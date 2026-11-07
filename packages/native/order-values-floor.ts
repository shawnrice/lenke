/**
 * THE FLOOR for `V().out(T).values(k).order()` — the UNCAPPED global sort over a fused hop walk
 * (item 1630), priced BEFORE building anything (item 1465's rule).
 *
 * ⚠️ READ ITEM 1394 FIRST: it closed this row. `sortByBys` carries its accounting — `evalBy` plus
 * `project` REFUTED at 0.1%, the comparator ~4.3%, `[...stream]` ~5.0%, and 36% of what the sort
 * adds over a bare hop being far-vertex locality with no per-row lever. **Nothing on that list is
 * re-attempted here.** What has changed since is the MECHANISM, not the accounting: item 1586 built
 * the values fusion and item 1591 extended it to a CAPPED `order()`, explicitly leaving the uncapped
 * one ("the UNCAPPED `order()` row 387.4 against 383.5" — flat, by design).
 *
 * A fresh WINDOWED profile at 200,000 vertices says the feeding chain is now the row:
 *
 * ```text
 *    values  23.7%   pick 18.4%   unwrap 10.1%   get properties 8.6%
 *    startTraverser 1.6%   toArray 1.1%   (anonymous) in run 1.3%      = 64.8%
 *    sortByBys 18.8%   cmp1 4.1%   orderStep 3.5%   its closures 3.0%  = 29.4%
 * ```
 *
 * `pick` and `unwrap` are both LARGER than item 1394's accounting recorded, and the reason is
 * structural: `hopValuesShortcut` consumes `[V, hop, values]` and hands back `rest = [order]`, so
 * `run` wraps a million raw values into traversers one at a time, `orderStep` spreads them back into
 * an array, and `sortByBys` allocates a `{item, key}` wrapper per element and runs three more passes
 * over it. The walk already produces exactly the array the sort wants.
 *
 * So the floor is: the eager walk (what `values.drain()` already does) into an array, then
 * `Array.prototype.sort` with a comparator of compareTotal's shape. If the engine is close to that,
 * item 1394 still stands and this is a reject.
 *
 *     bun order-values-floor.ts
 *     NODES=200000 REPS=9 bun order-values-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, out, toArray, traversal, values, order, limit } from '@lenke/gremlin';

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

/**
 * A comparator of `compareTotal`'s SHAPE, not a numeric specialization — item 1513 measured a
 * numeric-specialized `order()` comparator at exactly nothing, and a floor that used `(a, b) => a -
 * b` would flatter the floor by exactly the amount that item refuted.
 */
const cmpTotal = (a: unknown, b: unknown): number => {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;

  if (aNull && bNull) {
    return 0;
  }

  if (aNull || bNull) {
    return aNull ? -1 : 1;
  }

  if (typeof a === 'number' && typeof b === 'number') {
    const aNaN = Number.isNaN(a);
    const bNaN = Number.isNaN(b);

    if (aNaN && bNaN) {
      return 0;
    }

    if (aNaN || bNaN) {
      // NaN is the GREATEST value in this order, mirroring the Rust `gcmp_total`.
      return aNaN ? 1 : -1;
    }

    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  // The fixture is numeric throughout, so this arm only keeps the comparator total.
  const sa = typeof a === 'string' ? a : JSON.stringify(a);
  const sb = typeof b === 'string' ? b : JSON.stringify(b);

  if (sa < sb) {
    return -1;
  }

  return sa > sb ? 1 : 0;
};

/** The walk `values.drain()` already performs: eager, one bucket per vertex, no generator. */
const handWalk = (key: string): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket as Iterable<Edge>) {
      const value = e.to.properties[key];

      if (value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

/** The same walk with the SORT, which is the whole floor for the target row. */
const handWalkSorted = (key: string): unknown[] => {
  const acc = handWalk(key);

  acc.sort(cmpTotal);

  return acc;
};

/**
 * ⚠️ THE SCAFFOLDING THE ENGINE PAYS AND THE FLOOR DOES NOT, measured rather than argued: the same
 * array sorted through a `{item, key}` wrapper per element plus the filter and map passes
 * `sortByBys` runs. If THIS lands on the engine's number then the wrapper is the gap; if it lands on
 * the floor's then it is not, and the gap is the traverser round trip instead.
 */
const handWalkSortedWrapped = (key: string): unknown[] => {
  const keyed = handWalk(key).map((item) => ({ item, key: item }));
  const live = keyed.filter((k) => k.key !== undefined);

  live.sort((a, b) => cmpTotal(a.key, b.key));

  return live.map((k) => k.item);
};

type Arm = { name: string; run: () => number };

const ARMS: Arm[] = [
  // ── THE TARGET and its two reference points ────────────────────────────────────────────────────
  {
    name: 'engine hop+values+ORDER  (target)',
    run: () => toArray(traversal(V(), out('E'), values('k'), order()), g).length,
  },
  { name: 'HAND  walk + sort        (FLOOR)', run: () => handWalkSorted('k').length },
  { name: 'HAND  walk + WRAPPED sort', run: () => handWalkSortedWrapped('k').length },
  // The unordered twin rides the fused walk with `rest.length === 0`, so it is already at its floor
  // and the pair prices what the `order()` adds.
  {
    name: 'engine hop+values        (fused, no sort)',
    run: () => toArray(traversal(V(), out('E'), values('k')), g).length,
  },
  { name: 'HAND  walk               (FLOOR, no sort)', run: () => handWalk('k').length },
  // ── CONTROLS the change cannot reach ───────────────────────────────────────────────────────────
  // A bare hop: same fused walk, `rest` empty, no sort. Moves only if the walk itself was perturbed.
  {
    name: 'engine bare hop          (control)',
    run: () => toArray(traversal(V(), out('E')), g).length,
  },
  // The CAPPED order, which item 1591 routes through `fusedValuesTopK` only when the `values` step
  // survives to the loop — here `hopValuesShortcut` consumes it, so this is the same `rest=[order]`
  // round trip with a bound. Included to see whether the capped spelling is in the same hole.
  {
    name: 'engine hop+values+order+LIMIT 10',
    run: () => toArray(traversal(V(), out('E'), values('k'), order(), limit(10)), g).length,
  },
  // The NO-HOP spelling, which never reaches `hopValuesShortcut` at all: the control for "is this
  // the hop fusion's gap or `order()`'s own".
  {
    name: 'engine values+ORDER      (no hop, control)',
    run: () => toArray(traversal(V(), values('k'), order()), g).length,
  },
];

console.log(
  `${'arm'.padEnd(44)} ${'ms/rep'.padStart(9)} ${'rows'.padStart(9)} ${'ns/row'.padStart(8)}`,
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

  console.log(
    `${arm.name.padEnd(44)} ${best.toFixed(2).padStart(9)} ${String(rows).padStart(9)} ${((best * 1e6) / Math.max(rows, 1)).toFixed(1).padStart(8)}`,
  );
}
