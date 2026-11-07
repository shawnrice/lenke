/**
 * ONE LOOP FOR ANY DEPTH, OR A SPECIALIZATION PER DEPTH? Priced before building either (item 1617).
 *
 * `hopChainValuesShortcut` fuses exactly TWO hops with literal nested loops, and item 1614 left
 * three hops open with a number: the hand floor is **59.12 ms against the pipeline's 381.37 at
 * 1,279,840 rows, 6.45x**. Taking it two ways:
 *
 *   - ANOTHER SPECIALIZATION — a third nested level, written twice (lazy and eager) like the first
 *     two. That is four copies of a nested loop in one file, which is the duplication
 *     `hop-values.ts` keeps paying for (item 1527 refused forking its four walks for this reason).
 *   - ONE GENERIC WALK over a STACK of iterators, any depth. `hop-values.ts`' `pairTypes` note says
 *     a loop over N hoisted locals IS the per-vertex array it measured as the whole cost of the
 *     general form — so the generic shape is the one with a prior against it, and that prior was
 *     measured on a different question (per-vertex bucket arrays, not an iterator stack).
 *
 * This probe is the only thing that can settle it. Both are written by hand, outside the engine, so
 * neither inherits the other's inlining (items 1413/1440 measured an in-file A/B moving unrelated
 * branches ~16% in an arbitrary direction, which is why the pricing happens here).
 *
 *     bun hop-chain-depth-floor.ts
 *     NODES=50000 FANOUT=3 REPS=8 bun hop-chain-depth-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 10);

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

/** Literal nesting at depth 2 — what the engine ships. */
const nested2 = (): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    for (const e0 of b0 as Iterable<Edge>) {
      const b1 = e0.to.adjFrom?.get('E');

      if (b1 === undefined) {
        continue;
      }

      for (const e1 of b1 as Iterable<Edge>) {
        const value = e1.to.properties.k;

        if (value !== undefined) {
          acc.push(value);
        }
      }
    }
  }

  return acc;
};

/** Literal nesting at depth 3 — what a third specialization would be. */
const nested3 = (): unknown[] => {
  const acc: unknown[] = [];

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    for (const e0 of b0 as Iterable<Edge>) {
      const b1 = e0.to.adjFrom?.get('E');

      if (b1 === undefined) {
        continue;
      }

      for (const e1 of b1 as Iterable<Edge>) {
        const b2 = e1.to.adjFrom?.get('E');

        if (b2 === undefined) {
          continue;
        }

        for (const e2 of b2 as Iterable<Edge>) {
          const value = e2.to.properties.k;

          if (value !== undefined) {
            acc.push(value);
          }
        }
      }
    }
  }

  return acc;
};

/**
 * THE GENERIC WALK: a stack of iterators, any depth. One `next()` per level per advance, and the
 * only per-row work above the literal form is the depth bookkeeping — no per-vertex array, which is
 * what `pairTypes`' prior was actually about.
 */
const stacked = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  // Hoisted ONCE, reused across source vertices — not allocated per vertex, which is the whole
  // difference from the shape item 1441 priced.
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const far = step.value.to;

      if (d === depth - 1) {
        const value = far.properties.k;

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const next = far.adjFrom?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

/**
 * ⚠️ THREE ABLATION ARMS (item 1634), separating the two things the ENGINE's stacked walk does per
 * EDGE that `stacked` above does not. The engine measures 1218.36 ms against `stacked`'s 984.85 at
 * 50,000/5 — **1.24x** — and its windowed profile splits as `walk` 57.9%, `pick` 19.0%,
 * `get properties` 15.6%. The two candidates:
 *
 *   BOOKKEEPING — per edge the engine reads `const [, fwd] = hops[d]` (a destructure of a
 *     plan-constant array), `const gates = runs[d + 1]` (an index), and `gates.length > 0` (a load
 *     and compare). All three are constant for the whole walk at a given depth.
 *   PICK AS A CALL — the engine calls a `pick` closure chosen once per plan; the floor inlines
 *     `far.properties.k`. `pick` is its own 19.0% frame, so this is not free.
 *
 * Measuring them separately is the point: a combined arm that lands on the engine's number would
 * confirm the total without saying which half to fix, and the fixes are completely different (hoist
 * flat arrays vs specialize the emit site).
 */
const FWDS = [true, true, true, true];
const RUNS: (readonly ((v: Vertex) => boolean)[])[] = [[], [], [], []];
const PICK = (far: Vertex): unknown => far.properties.k;

/** The hand stack PLUS only the engine's per-edge bookkeeping. `pick` stays inlined. */
const stackedBookkeeping = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      // The engine's three per-edge reads, verbatim in shape.
      const fwd = FWDS[d];
      const far = fwd ? step.value.to : step.value.from;
      const gates = RUNS[d + 1];

      if (gates.length > 0) {
        continue;
      }

      if (d === depth - 1) {
        const value = far.properties.k;

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const fwdn = FWDS[d + 1];
      const next = (fwdn ? far.adjFrom : far.adjTo)?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

/** The hand stack PLUS only the `pick` CALL. No bookkeeping. */
const stackedPickCall = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const far = step.value.to;

      if (d === depth - 1) {
        const value = PICK(far);

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const next = far.adjFrom?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

/** BOTH, which should land on the engine's number if the two account for the 1.24x. */
const stackedBoth = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get('E');

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const fwd = FWDS[d];
      const far = fwd ? step.value.to : step.value.from;
      const gates = RUNS[d + 1];

      if (gates.length > 0) {
        continue;
      }

      if (d === depth - 1) {
        const value = PICK(far);

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const fwdn = FWDS[d + 1];
      const next = (fwdn ? far.adjFrom : far.adjTo)?.get('E');

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

/**
 * ⚠️ TWO MORE ABLATIONS (item 1634), because the first three REFUTED both candidates. Bookkeeping is
 * +4.8%, the `pick` CALL is +0.0% — V8 inlines a monomorphic closure called once per row — and both
 * together are +6.0% against the ENGINE's +23.4%. So ~17 points were unexplained, and the profile
 * naming `pick` at 19.0% was a nomination that priced at nothing (item 1104, in reverse).
 *
 * What is left, read off the engine rather than guessed again:
 *
 *   SINK CALLBACK — the engine's walk is `walk(sink)` and calls `sink(value)` per ROW, so the eager
 *     arm pays a closure call for every one of 6,249,740 rows. The floor pushes to `acc` directly.
 *     This is a different question from the `pick` call: `pick` is called at the same site, but the
 *     sink is called THROUGH a parameter, which is a megamorphic-by-design site (the lazy and eager
 *     halves pass different sinks).
 *   VARIABLE MAP KEY — the engine does `.get(t0)` with the edge type in a variable; the floor does
 *     `.get('E')` with a literal. A constant key lets V8 specialize the lookup.
 */
const T0 = 'E';

/** The hand stack with the emit going THROUGH A SINK PARAMETER, as the engine's walk does. */
const stackedSink = (depth: number): unknown[] => {
  const acc: unknown[] = [];

  const walk = (sink: (value: unknown) => void): void => {
    const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

    for (const v of g.vertices) {
      const b0 = v.adjFrom?.get('E');

      if (b0 === undefined) {
        continue;
      }

      its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

      let d = 0;

      while (d >= 0) {
        const step = its[d]!.next();

        if (step.done === true) {
          its[d] = undefined;
          d -= 1;
          continue;
        }

        const far = step.value.to;

        if (d === depth - 1) {
          const value = far.properties.k;

          if (value !== undefined) {
            sink(value);
          }

          continue;
        }

        const next = far.adjFrom?.get('E');

        if (next === undefined) {
          continue;
        }

        d += 1;
        its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
      }
    }
  };

  walk((value) => acc.push(value));

  return acc;
};

/** The hand stack with the bucket key in a VARIABLE instead of a literal. */
const stackedVarKey = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  for (const v of g.vertices) {
    const b0 = v.adjFrom?.get(T0);

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const far = step.value.to;

      if (d === depth - 1) {
        const value = far.properties.k;

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const next = far.adjFrom?.get(T0);

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

/**
 * ⚠️ THE SIXTH ABLATION, and it exists because five accounted for only 7.8 of the engine's 21.7
 * points. The `BOOKKEEPING` arm above under-modelled the engine: it reads `FWDS[d]`, a FLAT boolean
 * array, where the engine destructures a NESTED TUPLE — `const [, fwd] = hops[d]` with
 * `hops: readonly (readonly [string, boolean])[]`. That is a load of an inner array, then an indexed
 * read out of it, per edge, and the engine does it TWICE per descend (`hops[d]` and `hops[d + 1]`).
 *
 * This arm is the engine's shape verbatim. If it lands on the engine's number, the fix is to flatten
 * `hops` into parallel arrays once per plan — which is the same lever the flat `FWDS` arm already
 * shows costs only 5.1%, so the DELTA between the two arms is what flattening would recover.
 */
const HOPS: readonly (readonly [string, boolean])[] = [
  ['E', true],
  ['E', true],
  ['E', true],
  ['E', true],
];

/** The hand stack with the engine's NESTED-TUPLE bookkeeping, and nothing else. */
const stackedTuple = (depth: number): unknown[] => {
  const acc: unknown[] = [];
  const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

  // Hoisted exactly as the engine does it (`const [[t0, fwd0]] = hops`).
  const [[t0, fwd0]] = HOPS;

  for (const v of g.vertices) {
    const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

    if (b0 === undefined) {
      continue;
    }

    its[0] = (b0 as Iterable<Edge>)[Symbol.iterator]();

    let d = 0;

    while (d >= 0) {
      const step = its[d]!.next();

      if (step.done === true) {
        its[d] = undefined;
        d -= 1;
        continue;
      }

      const [, fwd] = HOPS[d];
      const far = fwd ? step.value.to : step.value.from;
      const gates = RUNS[d + 1];

      if (gates.length > 0) {
        continue;
      }

      if (d === depth - 1) {
        const value = far.properties.k;

        if (value !== undefined) {
          acc.push(value);
        }

        continue;
      }

      const [tn, fwdn] = HOPS[d + 1];
      const next = (fwdn ? far.adjFrom : far.adjTo)?.get(tn);

      if (next === undefined) {
        continue;
      }

      d += 1;
      its[d] = (next as Iterable<Edge>)[Symbol.iterator]();
    }
  }

  return acc;
};

type Arm = { name: string; run: () => number };

const ARMS: Arm[] = [
  { name: 'depth 2  LITERAL nesting (ships)', run: () => nested2().length },
  { name: 'depth 2  ITERATOR STACK', run: () => stacked(2).length },
  {
    name: 'depth 2  the ENGINE (fused at 1614)',
    run: () => toArray(traversal(V(), out('E'), out('E'), values('k')), g).length,
  },
  { name: 'depth 3  LITERAL nesting', run: () => nested3().length },
  { name: 'depth 3  ITERATOR STACK', run: () => stacked(3).length },
  { name: 'depth 3  stack + BOOKKEEPING only', run: () => stackedBookkeeping(3).length },
  { name: 'depth 3  stack + PICK CALL only', run: () => stackedPickCall(3).length },
  { name: 'depth 3  stack + BOTH', run: () => stackedBoth(3).length },
  { name: 'depth 3  stack + SINK callback', run: () => stackedSink(3).length },
  { name: 'depth 3  stack + VARIABLE map key', run: () => stackedVarKey(3).length },
  { name: 'depth 3  stack + NESTED-TUPLE bookkeeping', run: () => stackedTuple(3).length },
  {
    name: 'depth 3  the ENGINE (STACKED at 1617)',
    run: () => toArray(traversal(V(), out('E'), out('E'), out('E'), values('k')), g).length,
  },
];

console.log(
  `${'arm'.padEnd(40)} ${'ms/rep'.padStart(9)} ${'rows'.padStart(10)} ${'ns/row'.padStart(8)}`,
);

for (const arm of ARMS) {
  let rows = 0;

  for (let i = 0; i < 3; i += 1) {
    rows = arm.run();
  }

  let best = Infinity;

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    rows = arm.run();
    best = Math.min(best, performance.now() - t0);
  }

  console.log(
    `${arm.name.padEnd(40)} ${best.toFixed(2).padStart(9)} ${String(rows).padStart(10)} ${((best * 1e6) / rows).toFixed(1).padStart(8)}`,
  );
}
