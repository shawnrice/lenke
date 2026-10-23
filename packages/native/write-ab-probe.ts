// Item 631's A/B: the pre-change and post-change `@lenke/gql` dists, in ONE process,
// ALTERNATED round by round.
//
// Two processes would not do, and the first attempt at this showed why: the read-only CONTROL
// moved 505 -> 550 us between runs, which is the whole size of some of the effects being
// claimed. Both dists are imported here, rounds alternate, each side keeps its own minimum.
//
//   cd packages/native && bun write-ab-probe.ts
//   PROBE_N=80000 bun write-ab-probe.ts
import { Graph } from '@lenke/core';
import { query as postQuery } from '@lenke/gql';

const PRE =
  process.env.PRE_DIST ??
  '/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad/wt-pre631';
const { query: preQuery } = (await import(`${PRE}/packages/gql/dist/esm/index.mjs`)) as {
  query: typeof postQuery;
};

const N = Number(process.env.PROBE_N ?? 20_000);
const OPS = Number(process.env.PROBE_OPS ?? 120);
const REPS = Number(process.env.PROBE_REPS ?? 5);
const WARMUP = 2;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i++) {
    g.addVertex({
      id: `u${i}`,
      labels: ['User'],
      properties: { name: `user${i}`, score: i % 1000, city: `c${i % 8}` },
    });
  }

  return g;
};

const READ = 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s';
const WRITE = 'MATCH (u:User) WHERE u.name = $n SET u.score = $v';
const WRITE_CMP = 'MATCH (u:User) WHERE u.score > $v SET u.city = $c';
const WRITE_WHERE_FN = 'MATCH (u:User) WHERE upper(u.name) = $n SET u.score = $v';
// Two more predicates that cannot lift to the element-direct lists, to tell whether the cost
// on such shapes is specific to a function call or general: an OR (not a conjunction of
// compares) and a property-vs-property compare (no closed value side).
const WRITE_OR = 'MATCH (u:User) WHERE u.score > $hi OR u.score < $lo SET u.city = $c';
const WRITE_PROP_PROP = 'MATCH (u:User) WHERE u.score = u.other SET u.city = $c';

type Q = typeof postQuery;
type Case = { name: string; run: (q: Q, g: Graph, i: number) => void };

const cases: Case[] = [
  {
    // The CONTROL the change cannot reach: a read of this shape claims a fast-path rung and
    // never enters the general matcher at all (instrumented: 0 `matchNode` calls).
    name: 'read (control)',
    run: (q, g, i) => void [...(q(g, READ, { n: `user${i % N}` }) as Iterable<unknown>)],
  },
  {
    name: 'write, eq predicate',
    run: (q, g, i) =>
      void [...(q(g, WRITE, { n: `user${i % N}`, v: i % 1000 }) as Iterable<unknown>)],
  },
  {
    name: 'write, 0 rows matched',
    run: (q, g, i) =>
      void [...(q(g, WRITE, { n: `nobody${i}`, v: i % 1000 }) as Iterable<unknown>)],
  },
  {
    // An ORDERING comparison, which rides `cmpProps` rather than `eqProps`. Selective on
    // purpose (score > 998) so almost every candidate is rejected.
    name: 'write, cmp predicate',
    run: (q, g, i) => void [...(q(g, WRITE_CMP, { v: 998, c: `x${i % 8}` }) as Iterable<unknown>)],
  },
  {
    name: 'write, OR predicate (control)',
    run: (q, g, i) =>
      void [...(q(g, WRITE_OR, { hi: 998, lo: 1, c: `y${i % 8}` }) as Iterable<unknown>)],
  },
  {
    name: 'write, prop=prop (control)',
    run: (q, g, i) => void [...(q(g, WRITE_PROP_PROP, { c: `z${i % 8}` }) as Iterable<unknown>)],
  },
  {
    // A predicate that CANNOT lift to the element-direct lists (a function call wraps the
    // property), so it still binds every candidate. The second control: this row must not
    // move, or the pre-check is firing where it has no right to.
    name: 'write, fn predicate (control)',
    run: (q, g, i) =>
      void [...(q(g, WRITE_WHERE_FN, { n: `USER${i % N}`, v: i % 1000 }) as Iterable<unknown>)],
  },
];

// Each (case, side) pair gets its OWN graph: a shared one would let one side's writes change
// what the other side scans.
const graphs = cases.map(() => [build(), build()] as [Graph, Graph]);
const best = new Map<string, [number, number]>();

for (let round = 0; round < REPS + WARMUP; round++) {
  for (const [side, q] of [
    [0, preQuery],
    [1, postQuery],
  ] as [number, Q][]) {
    for (const [c, kase] of cases.entries()) {
      const pair = graphs[c];
      const g = pair[side];
      const t = performance.now();

      for (let i = 0; i < OPS; i++) {
        kase.run(q, g, round * OPS + i);
      }

      const us = ((performance.now() - t) * 1000) / OPS;

      if (round >= WARMUP) {
        const cur = best.get(kase.name) ?? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];

        cur[side] = Math.min(cur[side], us);
        best.set(kase.name, cur);
      }
    }
  }
}

console.log(`\n=== TS write path: pre vs post, ${N} users, min of ${REPS} ALTERNATED ===`);
console.log(
  `${'case'.padEnd(32)}${'pre us'.padStart(10)}${'post us'.padStart(10)}${'ratio'.padStart(8)}`,
);

for (const kase of cases) {
  const [pre, post] = best.get(kase.name) ?? [Number.NaN, Number.NaN];

  console.log(
    `${kase.name.padEnd(32)}${pre.toFixed(1).padStart(10)}${post.toFixed(1).padStart(10)}${(pre / post).toFixed(2).padStart(7)}x`,
  );
}
