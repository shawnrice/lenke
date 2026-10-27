/**
 * Item 930: WHICH Gremlin count shapes reach `countShortcut`, and where the cliff's edge is.
 *
 * `hop-filter-ladder-probe.ts` measured a **+220.6 ms step** on the Gremlin surface between ONE
 * and TWO `has()` filters after `out()`, flat on either side of it (26.7 → 247.4 → 250.0 → 264.2 ms
 * over 600,000 edges), while the GQL twin pays 4.9 ms for the same second conjunct. A step that
 * large with a flat floor on both sides is a ROUTE being lost, not a cost being added.
 *
 * READING `executor/count-shortcut.ts` gives a candidate. `countShortcut` strips the source and the
 * terminal `count`, leaving `mid`, and tries rungs in order: a single vertex step, a filter CHAIN,
 * a START-filtered hop, a hop CHAIN — and then
 *
 *     if (mid.length !== 2) { return undefined; }
 *     return filteredHopCount(mid[0], mid[1], graph) ?? distinctHopCount(mid[0], mid[1], graph);
 *
 * so the hop+filter rung is reachable ONLY at exactly two mid steps. For
 * `V().hasLabel('P').out('E').has('k', …)` that holds only if `hasLabel` has been folded into the
 * source, leaving `[out, has]`; a second `has` makes it three and falls off the end to the general
 * traversal. THAT IS A HYPOTHESIS, and this probe is what decides it instead of assuming — item
 * 818's cause was refuted by reading, and item 925's by measuring, after each looked obvious.
 *
 * THE SHAPES AND WHAT EACH ONE DISCRIMINATES:
 *
 *   hop1          `V().hasLabel(P).out(E).has(k,>-1).count()`           the fast arm, for reference
 *   hop2          `… .has(k,>-1).has(k,>-2).count()`                    the slow arm
 *   hop1NoLabel   `V().out(E).has(k,>-1).count()`                       is `hasLabel` folded away?
 *   filters2      `V().hasLabel(P).has(k,>-1).has(k,>-2).count()`       does a 2-filter CHAIN (no
 *                                                                       hop) keep its shortcut?
 *   filters3      `… .has(k,>-1).has(k,>-2).has(k,>-3).count()`         and a 3-filter chain?
 *
 * If `filters2`/`filters3` stay fast while `hop2` does not, the missing capability is specific to
 * **hop + MORE THAN ONE filter**, and `filterChainCount` already proves the chain-folding shape is
 * acceptable in this file. If `filters2` is ALSO slow, the limit is filter chaining in general and
 * the fix is a different one.
 *
 * Every shape keeps EVERY row (all bounds are always true against `k = i % 50`), so each arm's row
 * count is asserted against its own expectation — `N` for the node-filter shapes, `N * EDGES_PER`
 * for the hop shapes. An arm that dropped rows would be measuring selectivity.
 *
 * ONE SHAPE PER PROCESS (item 762), selected by A_SHAPE.
 *
 * Usage:  A_SHAPE=hop2 bun run hop-filter-route-map-probe.ts
 *         bun run probe:hopmap
 */
import { Graph } from '@lenke/core';
import { V, count, gt, has, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.A_N ?? 200_000);
const REPS = Number(process.env.A_REPS ?? 14);
const DROP = 3;
const EDGES_PER = 3;

type Shape = {
  /** `edges` when the shape counts traversed edges, `nodes` when it counts vertices. */
  readonly counts: 'edges' | 'nodes';
  readonly text: string;
  readonly run: (g: Graph) => number;
};

const SHAPES: Record<string, Shape> = {
  hop1: {
    counts: 'edges',
    text: 'V().hasLabel(P).out(E).has(k,>-1).count()',
    run: (g) =>
      toArray(traversal(V(), hasLabel('P'), out('E'), has('k', gt(-1)), count()), g)[0] as number,
  },
  hop2: {
    counts: 'edges',
    text: 'V().hasLabel(P).out(E).has(k,>-1).has(k,>-2).count()',
    run: (g) =>
      toArray(
        traversal(V(), hasLabel('P'), out('E'), has('k', gt(-1)), has('k', gt(-2)), count()),
        g,
      )[0] as number,
  },
  hop1NoLabel: {
    counts: 'edges',
    text: 'V().out(E).has(k,>-1).count()',
    run: (g) => toArray(traversal(V(), out('E'), has('k', gt(-1)), count()), g)[0] as number,
  },
  filters2: {
    counts: 'nodes',
    text: 'V().hasLabel(P).has(k,>-1).has(k,>-2).count()',
    run: (g) =>
      toArray(
        traversal(V(), hasLabel('P'), has('k', gt(-1)), has('k', gt(-2)), count()),
        g,
      )[0] as number,
  },
  filters3: {
    counts: 'nodes',
    text: 'V().hasLabel(P).has(k,>-1).has(k,>-2).has(k,>-3).count()',
    run: (g) =>
      toArray(
        traversal(
          V(),
          hasLabel('P'),
          has('k', gt(-1)),
          has('k', gt(-2)),
          has('k', gt(-3)),
          count(),
        ),
        g,
      )[0] as number,
  },
};

const build = (): Graph => {
  const g = new Graph();
  const made: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < N; i += 1) {
    made.push(
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50, s: `s${i % 7}` } }),
    );
  }

  for (let e = 0; e < N * EDGES_PER; e += 1) {
    g.addEdge({ labels: ['E'], from: made[(e * 104729) % N], to: made[(e * 15485863) % N] });
  }

  return g;
};

const name = process.env.A_SHAPE;

if (name !== undefined) {
  const shape = SHAPES[name];

  if (shape === undefined) {
    console.error(`unknown A_SHAPE ${name}; have ${Object.keys(SHAPES).join(',')}`);
    process.exit(2);
  }

  const g = build();
  const series: number[] = [];
  let answer = -1;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = shape.run(g);

    series.push(performance.now() - t0);
    answer = got;
  }

  const expected = shape.counts === 'edges' ? N * EDGES_PER : N;

  if (answer !== expected) {
    throw new Error(
      `${name} kept ${answer} rows, expected ${expected} — a bound was not always true`,
    );
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(`${name}\t${median.toFixed(3)}\t${answer}\t${shape.text}`);
} else {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = names.length > 0 ? names : Object.keys(SHAPES);

  console.log(
    `# gremlin count-route map, ${N} vertices / ${N * EDGES_PER} edges, median of ${REPS - DROP}`,
  );
  console.log('shape\tms\trows\ttext');

  for (const n of selected) {
    const r = Bun.spawnSync({
      cmd: [process.argv[0] ?? 'bun', import.meta.path],
      env: { ...process.env, A_SHAPE: n },
      stdout: 'pipe',
      stderr: 'inherit',
    });

    if (!r.success) {
      console.error(`ARM FAILED ${n} exit ${r.exitCode}`);
      process.exit(1);
    }

    process.stdout.write(new TextDecoder().decode(r.stdout));
  }
}
