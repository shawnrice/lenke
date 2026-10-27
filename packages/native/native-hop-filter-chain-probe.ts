/**
 * Item 931: does the RUST engine have item 930's hop+filter-chain cliff, and if not, is there a
 * predicate shape that reinstates it?
 *
 * Item 930 found and fixed an 11.15x cliff on the TS Gremlin surface: `countShortcut` dispatched on
 * a STEP LIST and gated its hop+filter rung behind `mid.length !== 2`, so a second `has()` after a
 * hop fell off every rung. The native engine cannot have that bug in that form — it dispatches on
 * an `ir::Plan`, and `peel_endpoint_filter` peels a `Plan::Filter` rather than counting steps.
 *
 * BUT IT PEELS EXACTLY ONE. `peel_endpoint_filter` matches a single `Plan::Filter` whose predicate
 * reads only the endpoint slot; two stacked filters would leave an inner one behind. What normally
 * prevents that is the optimizer's filter-merge rule:
 *
 *     Filter(Filter(x, p_inner), p_outer)  ->  Filter(x, p_outer AND p_inner)
 *
 * so stacked endpoint filters collapse to the single-`Filter` shape the peel wants. **The merge is
 * DECLINED when the OUTER predicate `can_raise`** — because merged, both predicates are evaluated
 * on every row arriving at the filter (the `AND` is a vectorized three-valued fold, not control
 * flow), so a raising outer predicate would fault on rows the inner filter had removed.
 *
 * `can_raise` is true for `Expr::Arith`, `Expr::Call` and `Expr::Cast`, and for anything containing
 * one. So the PREDICTION this probe tests is specific: a hop count with two ordinary endpoint
 * conjuncts keeps its fast path, and the same count with an ARITHMETIC conjunct in the OUTER
 * position does not — same answer, same work, different cost. That is the equivalent-spelling shape
 * CLAUDE.md is named for, and every historical instance of it returned the right answer.
 *
 * `b.j + b.k` is deliberately NOT `b.j + 0`: a foldable arithmetic expression would be constant
 * folded, the `Arith` would vanish, and the probe would measure the merge happening rather than
 * being declined. Two slot reads cannot fold. Both are non-negative, so the conjunct is always
 * true and the arms hold their answer and selectivity constant.
 *
 * ONE SHAPE PER PROCESS (item 762), selected by A_SHAPE.
 *
 * Usage:  A_SHAPE=two bun run native-hop-filter-chain-probe.ts
 *         bun run probe:nativehopchain
 */
import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.A_N ?? 200_000);
const DEG = Number(process.env.A_DEG ?? 3);
const REPS = Number(process.env.A_REPS ?? 14);
const DROP = 3;

/** Every shape is always-true, so all hop arms answer N*DEG and all node arms answer N. */
const SHAPES: Record<string, { counts: 'edges' | 'nodes'; q: string }> = {
  // The single-filter hop count: one `Plan::Filter`, which `peel_endpoint_filter` takes.
  one: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.k > -1 RETURN count(*) AS c',
  },
  // Two ORDINARY conjuncts. Neither can raise, so the merge rule should fuse them into one
  // `Filter` with an `And` and the fast path should survive — flat against `one`.
  two: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.k > -1 AND b.j > -1 RETURN count(*) AS c',
  },
  // Three ordinary conjuncts, to show the merge is not two-at-a-time-only.
  three: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.k > -1 AND b.j > -1 AND b.m > -1 RETURN count(*) AS c',
  },
  // AN ARITHMETIC CONJUNCT. `Expr::Arith` makes `can_raise` true, which is what declines the
  // merge — so if the stacked form loses the count fast path, this is where it shows.
  arith: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.j + b.k > -1 AND b.k > -1 RETURN count(*) AS c',
  },
  // The SAME arithmetic conjunct, written the other way round. Only the OUTER predicate's ability
  // to raise declines the merge, and which conjunct becomes outer is the lowering's business, so
  // both orders are measured rather than reasoned about.
  arithRev: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.k > -1 AND b.j + b.k > -1 RETURN count(*) AS c',
  },
  // The arithmetic conjunct ALONE: one filter, so the merge rule never applies and `can_raise` is
  // irrelevant. This separates "arithmetic is expensive per row" from "the merge was declined",
  // which is the confound that would otherwise read as the cliff.
  arithOnly: {
    counts: 'edges',
    q: 'MATCH (a:P)-[:E]->(b) WHERE b.j + b.k > -1 RETURN count(*) AS c',
  },
  // CONTROL: a node scan with the same two conjuncts. It has no hop, so no hop fast path to lose;
  // if this moves with the hop arms, the reading is the machine or the predicate, not the route.
  nodeTwo: {
    counts: 'nodes',
    q: 'MATCH (a:P) WHERE a.k > -1 AND a.j > -1 RETURN count(*) AS c',
  },
  // CONTROL: the node scan with the arithmetic conjunct. Prices the arithmetic on a path that
  // cannot have a hop fast path, so the hop arms' arithmetic cost can be subtracted rather than
  // guessed at.
  nodeArith: {
    counts: 'nodes',
    q: 'MATCH (a:P) WHERE a.j + a.k > -1 AND a.k > -1 RETURN count(*) AS c',
  },
};

// Every vertex is `:P` so the label narrows nothing and the hop walks all of them — the question is
// the filter route, and a selective label would make the arms differ in scan size too.
const ndjson = (): string => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'vertex',
        id: `v${i}`,
        labels: ['P'],
        // All three non-negative, so every conjunct above is true for every row.
        properties: { k: i % 50, j: i % 37, m: i % 11 },
      }),
    );
  }

  // BOTH ENDPOINTS SCATTERED by different multipliers (items 164/286/287): with `from` in creation
  // order and `to` permuted, one adjacency map is walked sequentially and the other jumped around,
  // which made every from-driven spelling look ~2x faster than its twin.
  let e = 0;

  for (let i = 0; i < N * DEG; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${e++}`,
        from: `v${(i * 104729) % N}`,
        to: `v${(i * 15485863) % N}`,
        labels: ['E'],
        properties: {},
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

const name = process.env.A_SHAPE;

if (name !== undefined) {
  const shape = SHAPES[name];

  if (shape === undefined) {
    console.error(`unknown A_SHAPE ${name}; have ${Object.keys(SHAPES).join(',')}`);
    process.exit(2);
  }

  // Built OUTSIDE the timed region (item 824).
  const nat = graphFromNdjson(nativeBackend(), ndjson());
  const series: number[] = [];
  let answer = -1;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = nat.query(shape.q) as Array<{ c: number }>;

    series.push(performance.now() - t0);
    answer = Number(rows[0].c);
  }

  const expected = shape.counts === 'edges' ? N * DEG : N;

  if (answer !== expected) {
    throw new Error(
      `${name} answered ${answer}, expected ${expected} — a conjunct was not always true`,
    );
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);
  const median = plateau[Math.floor(plateau.length / 2)] ?? 0;

  console.log(`${name}\t${median.toFixed(3)}\t${answer}\t${shape.q}`);
} else {
  const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = picked.length > 0 ? picked : Object.keys(SHAPES);

  console.log(
    `# native hop+filter-chain, ${N} vertices / ${N * DEG} edges, median of ${REPS - DROP}`,
  );
  console.log('shape\tms\trows\tquery');

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
