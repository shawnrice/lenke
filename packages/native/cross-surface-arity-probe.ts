/**
 * Item 932: a GENERATED cross-surface matrix over FILTER ARITY AND POSITION, because item 930's
 * cliff was found by accident and its cause is a shape a generator can enumerate.
 *
 * WHY THIS AXIS AND NOT A BLIND SWEEP. The TS engines are two independent implementations over one
 * `@lenke/core` Graph — `@lenke/gremlin` and `@lenke/gql` are siblings, neither depends on the
 * other, and there is no shared plan. Each hand-builds its own fast-path table (`countShortcut`'s
 * rungs against `shortcuts.ts`'s `tallyHopCount` family), so the claim that equivalent spellings
 * cost the same has **no structural guarantee in TS** — only measurement. And the asymmetry runs
 * BOTH ways, which is what says this is two tables with different coverage rather than one bad
 * path: filtered node count is GQL 1.80-1.85x SLOWER (929), the filtered hop at one conjunct is GQL
 * 2.14x slower, at two conjuncts GQL was ~4x FASTER (930 pre-fix), and `project one property` is GQL
 * 3.20x faster (929).
 *
 * Item 930's cause was specifically an **ARITY GATE ON A STEP LIST** — `countShortcut` gated its
 * hop+filter rung behind `mid.length !== 2`, so a second `has()` fell off every rung and cost
 * 11.15x. That is enumerable: vary how many consecutive filters sit at each position relative to
 * the hop. `probe:surface` carries 5 hand-written pairs and found 930's cliff only because item 929
 * happened to add an edge-walking pair for an unrelated reason.
 *
 * THE MATRIX. Four positions x arities, both surfaces, one shape per process:
 *
 *   node:1,2,3      filters on a node scan, no hop        (control axis: no hop route to lose)
 *   pre:1,2,3       filters BEFORE the hop                (`startFilteredHopCount`'s territory)
 *   post:1,2,3      filters AFTER the hop                 (`filteredHopCount`, widened at 930)
 *   both:1+1,2+1,1+2  filters on BOTH sides               (930's named OPEN gap)
 *
 * `both` is in because item 930 left it open and said why: `V().has(x,p).out(E).has(k,q)` gives
 * `mid = [has, out, has]`, and `filteredHopCount` needs the hop FIRST, `startFilteredHopCount`
 * needs it LAST, and `filterChainCount` rejects the `out` — so the hop sits in the middle where no
 * rung reaches it. Predicted to be the matrix's worst cell; measured here rather than assumed.
 *
 * EVERY FILTER IS TRUE FOR EVERY ROW, so arity and position are the only things that vary. `k`, `j`
 * and `m` are all non-negative, the bounds are `> -1` and DISTINCT per key so neither engine can
 * dedupe a ladder to one test, and each arm's row count is asserted against its own expectation
 * (200,000 for the node arms, 600,000 for every arm with a hop, since every start passes and the
 * degree sum is the whole edge set). An arm that dropped rows would be measuring selectivity.
 *
 * THIS IS A SCREEN, NOT A MEASUREMENT (item 737's distinction). One round, one process per arm, to
 * find cells worth isolating. Any cell it flags gets its own alternated-round A/B before a number is
 * believed — item 924's rule, and item 928 is what happens without it.
 *
 * Usage:  A_CELL=post:2 A_SURFACE=grm bun run cross-surface-arity-probe.ts
 *         bun run probe:arity
 *         bun run probe:arity post both      # only cells whose name contains a substring
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gt, has, hasLabel, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.A_N ?? 200_000);
const DEG = Number(process.env.A_DEG ?? 3);
const REPS = Number(process.env.A_REPS ?? 14);
const DROP = 3;

/** Three always-true keys, so an arity-3 ladder needs no repeated key. */
const KEYS = ['k', 'j', 'm', 'w'] as const;

type Cell = {
  /** Filters on the start/scanned node. */
  readonly pre: number;
  /** Filters on the far end of the hop. */
  readonly post: number;
  readonly hop: boolean;
};

const CELLS: Record<string, Cell> = {
  'node:1': { pre: 1, post: 0, hop: false },
  'node:2': { pre: 2, post: 0, hop: false },
  'node:3': { pre: 3, post: 0, hop: false },
  'pre:1': { pre: 1, post: 0, hop: true },
  'pre:2': { pre: 2, post: 0, hop: true },
  'pre:3': { pre: 3, post: 0, hop: true },
  'post:1': { pre: 0, post: 1, hop: true },
  'post:2': { pre: 0, post: 2, hop: true },
  'post:3': { pre: 0, post: 3, hop: true },
  // Arity 4 exists to locate the cliff AFTER a width unroll, not to be unrolled in turn. Item 934
  // unrolled width 2 and wrote "the third filter costs ~1.5 ns a row, so there is nothing there to
  // unroll for" — true of the code BEFORE that change and false after it, because the unroll moved
  // the step from 1->2 to 2->3 (item 993). A width arm must therefore be measured one arity BEYOND
  // the one it adds, or its own justification is written against the code it replaced.
  'post:4': { pre: 0, post: 4, hop: true },
  'both:1+1': { pre: 1, post: 1, hop: true },
  'both:2+1': { pre: 2, post: 1, hop: true },
  'both:1+2': { pre: 1, post: 2, hop: true },
};

const conjuncts = (slot: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${slot}.${KEYS[i]} > -1`);

const gqlOf = (c: Cell): string => {
  const where = [...conjuncts('a', c.pre), ...conjuncts('b', c.post)];
  const pattern = c.hop ? '(a:P)-[:E]->(b)' : '(a:P)';
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  return `MATCH ${pattern}${clause} RETURN count(*) AS c`;
};

const grmOf = (c: Cell, g: Graph): number => {
  const pre = Array.from({ length: c.pre }, (_, i) => has(KEYS[i], gt(-1)));
  const post = Array.from({ length: c.post }, (_, i) => has(KEYS[i], gt(-1)));
  const steps = c.hop
    ? [V(), hasLabel('P'), ...pre, out('E'), ...post, count()]
    : [V(), hasLabel('P'), ...pre, count()];

  return Number(toArray(traversal(...(steps as Parameters<typeof traversal>)), g)[0]);
};

const grmTextOf = (c: Cell): string => {
  const pre = Array.from({ length: c.pre }, (_, i) => `has(${KEYS[i]},>-1)`).join('.');
  const post = Array.from({ length: c.post }, (_, i) => `has(${KEYS[i]},>-1)`).join('.');
  const head = `V().hasLabel(P)${pre ? `.${pre}` : ''}`;

  return c.hop ? `${head}.out(E)${post ? `.${post}` : ''}.count()` : `${head}.count()`;
};

const build = (): Graph => {
  const g = new Graph();
  const made: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < N; i += 1) {
    made.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: { k: i % 50, j: i % 37, m: i % 11, w: i % 7 },
      }),
    );
  }

  // BOTH ENDPOINTS SCATTERED by different multipliers (items 164/286/287): with `from` in creation
  // order and `to` permuted, one adjacency map is walked sequentially and the other jumped around,
  // which made every from-driven spelling look ~2x faster than its twin — here it would read as a
  // surface difference, which is exactly what this probe reports.
  for (let e = 0; e < N * DEG; e += 1) {
    g.addEdge({ labels: ['E'], from: made[(e * 104729) % N], to: made[(e * 15485863) % N] });
  }

  return g;
};

const cellName = process.env.A_CELL;

if (cellName !== undefined) {
  const cell = CELLS[cellName];
  const surface = process.env.A_SURFACE;

  if (cell === undefined) {
    console.error(`unknown A_CELL ${cellName}; have ${Object.keys(CELLS).join(',')}`);
    process.exit(2);
  }

  if (surface !== 'gql' && surface !== 'grm') {
    console.error(`A_SURFACE must be gql or grm — got ${surface}`);
    process.exit(2);
  }

  const g = build();
  const series: number[] = [];
  let answer = -1;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = surface === 'gql' ? Number(query(g, gqlOf(cell))[0].c) : grmOf(cell, g);

    series.push(performance.now() - t0);
    answer = got;
  }

  const expected = cell.hop ? N * DEG : N;

  if (answer !== expected) {
    throw new Error(
      `${cellName}/${surface} answered ${answer}, expected ${expected} — a filter was not always true`,
    );
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(`${cellName}\t${surface}\t${median.toFixed(3)}\t${answer}`);
} else {
  const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = Object.keys(CELLS).filter(
    (n) => picked.length === 0 || picked.some((p) => n.includes(p)),
  );
  const order = (process.env.A_ORDER ?? 'gql,grm').split(',');

  if (order.length !== 2 || !order.includes('gql') || !order.includes('grm')) {
    console.error(`A_ORDER must be a permutation of gql,grm — got ${order.join(',')}`);
    process.exit(2);
  }

  console.log(
    `# cross-surface filter arity x position, ${N} vertices / ${N * DEG} edges, median of ${REPS - DROP}`,
  );
  console.log(`# order=${order.join(',')}`);
  console.log('cell\tsurface\tms\trows');

  for (const n of names) {
    for (const surface of order) {
      const r = Bun.spawnSync({
        cmd: [process.argv[0] ?? 'bun', import.meta.path],
        env: { ...process.env, A_CELL: n, A_SURFACE: surface },
        stdout: 'pipe',
        stderr: 'inherit',
      });

      if (!r.success) {
        console.error(`ARM FAILED ${n}/${surface} exit ${r.exitCode}`);
        process.exit(1);
      }

      process.stdout.write(new TextDecoder().decode(r.stdout));
    }
  }

  console.log('# spellings:');

  for (const n of names) {
    console.log(`#   ${n.padEnd(9)} gql  ${gqlOf(CELLS[n])}`);
    console.log(`#   ${''.padEnd(9)} grm  ${grmTextOf(CELLS[n])}`);
  }
}
