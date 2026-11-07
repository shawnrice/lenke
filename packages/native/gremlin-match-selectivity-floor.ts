/**
 * DOES `match()` DRIVE FROM THE SELECTIVE PATTERN? (item 1656)
 *
 * ⚠️ WHY THIS IS A DIFFERENT QUESTION FROM THE FOUR ITEMS BEFORE IT. The solver has been optimised
 * four times — item 1478 (`tupleKey`, 1.10x), items 1559/1560 (the tag snapshot, 1.16-1.23x) and
 * item 1627 (the adjacency read, 1.08-1.11x) — every one a CONSTANT FACTOR, and item 1559's
 * 5.68x "ceiling" turned out to be a pruned search. This asks whether the solver's WORK is
 * asymptotically right, which no constant-factor item can answer.
 *
 * The shape: two chained patterns where the SECOND hop is rare.
 *
 * ```text
 *   match(as(a).out(T).as(b), as(b).out(S).as(c))     T on every vertex, S on 1 in `rarity`
 * ```
 *
 * Driving from the stream costs |V| x deg(T) candidate `b`s, almost all of which fail the `S` test.
 * Driving from `S` costs |S edges| x in-deg(T). The engine HAS the index for the second route —
 * `edgesByLabel.get('S')` is how `adjacentCount` already answers a global edge count — so this is a
 * question about the solver's ENTRY CHOICE, not about a missing structure.
 *
 * ⚠️ THE FLOOR IS A HAND ROUTE, AND IT ASSERTS THE SAME ANSWER. A floor that answered something
 * else would make the ratio meaningless (item 1465), and this corpus has shipped that error twice
 * this session alone.
 *
 * ⚠️ AND THE GAP IS SWEPT OVER SELECTIVITY, because a constant factor and an algorithmic gap look
 * identical at one point. If the ratio grows as `S` gets rarer, the solver's work is driven by the
 * wrong pattern; if it is flat, it is a constant factor and these four items already own it.
 *
 *     bun gremlin-match-selectivity-floor.ts
 *     NODES=5000 bun gremlin-match-selectivity-floor.ts
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { V, as_, count, match, out, pipe } from '@lenke/gremlin';
import { traversal } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal executor entry point, read pre-build
import { toArray } from '../gremlin/src/executor/index.js';

const NODES = Number(process.env.NODES ?? 3000);
const DEG = Number(process.env.DEG ?? 10);
const REPS = Number(process.env.REPS ?? 5);

/** Every vertex gets `DEG` T-edges; one vertex in `rarity` gets a single S-edge. */
const build = (rarity: number): { graph: Graph; sEdges: number } => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: {} });
  }

  const v = (i: number): Vertex => g.getVertexById(`v${i}`) as Vertex;

  for (let i = 0; i < NODES; i += 1) {
    for (let j = 1; j <= DEG; j += 1) {
      const to = (i * 7919 + j * 104_729) % NODES;

      if (to !== i) {
        g.addEdge({ id: `t${i}_${j}`, from: v(i), to: v(to), labels: ['T'], properties: {} });
      }
    }
  }

  let sEdges = 0;

  for (let i = 0; i < NODES; i += rarity) {
    const to = (i * 31 + 7) % NODES;

    if (to !== i) {
      g.addEdge({ id: `s${i}`, from: v(i), to: v(to), labels: ['S'], properties: {} });
      sEdges += 1;
    }
  }

  return { graph: g, sEdges };
};

const selective = traversal(
  V(),
  match(pipe(as_('a'), out('T'), as_('b')), pipe(as_('b'), out('S'), as_('c'))),
  count(),
);

/**
 * The hand route the solver could take: for each `S` edge, its SOURCE is a `b` that satisfies the
 * second pattern, and the first pattern's `a`s are that b's incoming `T` neighbours. The solution
 * count is the sum of those in-degrees — one solution per (a, b, c) triple.
 */
const handRoute = (g: Graph): number => {
  let n = 0;

  for (const e of g.edges) {
    if (!e.labels.has('S')) {
      continue;
    }

    n += g.inDegree(e.from, 'T');
  }

  return n;
};

const timeOf = (f: () => unknown): number => {
  f();

  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    f();
    series.push(performance.now() - t0);
  }

  return Math.min(...series);
};

const rows: string[] = [];

for (const rarity of [1, 5, 25, 100, 500]) {
  const { graph, sEdges } = build(rarity);
  const viaSolver = toArray(selective, graph) as number[];
  const viaHand = handRoute(graph);

  // ⚠️ THE ANSWER ASSERTION IS THE GATE ON THE WHOLE ROW.
  if (viaSolver[0] !== viaHand) {
    throw new Error(`rarity ${rarity}: solver ${viaSolver[0]} !== hand ${viaHand}`);
  }

  const solverMs = timeOf(() => toArray(selective, graph));
  const handMs = timeOf(() => handRoute(graph));

  rows.push(
    JSON.stringify({
      rarity,
      sEdges,
      solutions: viaHand,
      solverMs: Number(solverMs.toFixed(2)),
      handMs: Number(handMs.toFixed(3)),
      ratio: Number((solverMs / handMs).toFixed(1)),
    }),
  );
}

console.log(`NODES=${NODES} DEG=${DEG}`);

for (const r of rows) {
  console.log(r);
}
