/*
 * Item 2505: NAME item 2504's structure, by DELETION rather than by reading.
 *
 * Item 2504 measured a one-time O(|V|) cost — ~73 B/vertex, 14.56 MiB at N=200,000 — paid by any
 * walk of TWO OR MORE hops, flat in depth, identical for element and scalar output, and absent from
 * a one-hop walk. The candidate came from the code: `hop-chain-values.ts` (the `readsPath = false`
 * multi-hop route) calls
 *
 *     const csrs = hops.map(([t, fwd]) => chainCsrFor(graph, fwd, [t]));
 *
 * with its own comment "One CSR per hop shape. They share a slot numbering" — which would explain
 * all three signatures at once: built per CHAIN (so a single hop never builds one), shared across
 * hops (so flat in depth), and topology-only (so blind to whether the tail emits elements or
 * scalars).
 *
 * ## READING THE CODE IS NOT EVIDENCE
 *
 * The claim is only confirmed if a shape that CANNOT take that route does NOT pay the cost. Each arm
 * below is a TWO-hop walk — same depth, same row count where possible — differing in one thing that
 * may or may not disqualify the chain route. A disqualified arm that still pays ~14.5 MiB refutes the
 * hypothesis; one that drops to the 1-hop floor (~0.08 MiB) confirms it.
 *
 * `path()` is the known-disqualified arm (`readsPath = true`, measured 0.14 MiB at item 2504) and
 * serves as the positive control for "disqualified means cheap". `out('E'),out('E')` is the negative
 * control and must read ~14.5, or the fixture is wrong and nothing else here is readable.
 *
 * One shape per PROCESS — item 2504's whole point is that a shared one-time cost is invisible to an
 * in-process sweep with per-arm baselines.
 *
 *     node csr-deletion-2505.mjs
 *     SWAP_N=200000 node csr-deletion-2505.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SWAP_N ?? 200000);
const STEP = Number(process.env.SWAP_STEP ?? 8192);

if (process.env.ARM === 'child') {
  const { V, dedupe, out, path, run, simplePath, traversal, values, where } =
    await import('@lenke/gremlin');
  const { Graph } = await import('@lenke/core');

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

  const plans = {
    /* NEGATIVE control: the plain chain. Must read ~14.5 MiB or the fixture is wrong. */
    chain2: () => traversal(V(), out('E'), out('E')),
    /* POSITIVE control: known disqualified at item 2504 (readsPath = true). Must read ~0.1. */
    withpath: () => traversal(V(), out('E'), out('E'), path()),
    /* The deletions. Each keeps TWO hops and changes one thing. */
    untyped: () => traversal(V(), out(), out()),
    midDedupe: () => traversal(V(), out('E'), dedupe(), out('E')),
    simple: () => traversal(V(), out('E'), out('E'), simplePath()),
    noSuchLabel: () => traversal(V(), out('E'), out('NOSUCH')),
    midValues: () => traversal(V(), out('E'), values('k')),
    midWhere: () => traversal(V(), out('E'), where(traversal(values('k'))), out('E')),
    /* The 1-hop floor, for the scale. */
    hop1: () => traversal(V(), out('E')),
  };

  const make = plans[process.env.SHAPE];

  global.gc();
  const baseHeap = process.memoryUsage().heapUsed;
  let worst = 0;
  let c = 0;

  for (const _row of run(make(), graph)) {
    c += 1;

    if (c % STEP === 0) {
      global.gc();
      const live = process.memoryUsage().heapUsed - baseHeap;

      if (live > worst) {
        worst = live;
      }
    }
  }

  global.gc();
  const after = process.memoryUsage().heapUsed - baseHeap;

  process.stdout.write(
    `${JSON.stringify({ rows: c, mib: Math.max(worst, after) / 1024 / 1024 })}\n`,
  );
  process.exit(0);
}

const SHAPES = [
  ['chain2', 'NEG ctl: out,out — must be ~14.5'],
  ['hop1', 'the 1-hop floor'],
  ['withpath', 'POS ctl: +path() (readsPath=true)'],
  ['untyped', 'out(),out() — no edge label'],
  ['midDedupe', 'out,dedupe,out'],
  ['simple', 'out,out,simplePath()'],
  ['noSuchLabel', "out('E'),out('NOSUCH')"],
  ['midValues', 'out,values — only ONE hop'],
  ['midWhere', 'out,where(values),out'],
];

const one = (shape) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', SHAPE: shape },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(`# chain-CSR DELETION test  N=${N} STEP=${STEP}  (one shape per process)`);
console.log(
  '# Hypothesis: the one-time ~73 B/vertex is the CHAIN CSR built by the multi-hop route.',
);
console.log('# A shape that cannot take that route must NOT pay it. PAYS => route taken.\n');
console.log('  shape          rows      MiB   pays?   what it is');

for (const [shape, what] of SHAPES) {
  const r = one(shape);
  /* Halfway between the 1-hop floor and the chain cost, in B/vertex terms. */
  const pays = r.mib / (N / 1024 / 1024) > 36 ? 'PAYS ' : '  -  ';

  console.log(
    `  ${shape.padEnd(13)} ${String(r.rows).padStart(7)} ${r.mib.toFixed(2).padStart(8)}  ${pays}  ${what}`,
  );
}

console.log('\n  Per-vertex bytes = MiB * 1048576 / N. The chain cost is ~73 B/vertex.');
console.log('  Any DISQUALIFIED arm that still PAYS refutes the chain-CSR hypothesis.');
