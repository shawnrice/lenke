/*
 * THE SECOND-ASK POLICY, RE-PRICED (item 2438) — because item 2436 changed its INPUT.
 *
 * `csrAskedBefore` (csr-cache.ts) decides whether a CSR is worth building for this topology version.
 * With a cold prior the bar is `AMORTIZE_ASKS = 6` asks WITHIN the version, so a workload reading
 * ONCE per write never builds and runs the O(V) Map-in-the-loop fallback instead (item 2437 proved
 * that decline by ablation). The trade was priced when a rebuild cost ~35 ms; item 2436's
 * `vertexIndexFor` split cut it to ~22 ms by keeping `order`/`idx` across edge writes.
 *
 * THREE CASES, because a policy change that only measures the case it helps is not measured at all:
 *
 *   interleave   ONE read per write. What the policy declines today, and what item 2436 may have
 *                flipped: pay ~22 ms to save ~36.
 *   coldOneShot  A FRESH graph read exactly ONCE. This is what the policy EXISTS to protect —
 *                item 1889 measured the no-policy trade at 0.61x here. Each rep needs its own
 *                graph, or the second rep is a second ask and the case evaporates.
 *   readHeavy    Many reads per write. Both arms should build, so this is the CONTROL: if it moves,
 *                the measurement is picking up something other than the policy.
 *
 * One case per process (CASE=...), N=200000 by default because the route is SIZE-GATED — item 2437
 * measured a 2,000-vertex fixture where NEITHER shape built a CSR, which would read as "the route is
 * never taken".
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.ASK_N ?? 200000);
const REPS = Number(process.env.ASK_REPS ?? 7);
const CASE = process.env.CASE ?? 'interleave';

/** The shape item 2437 localized: a plain projection, which declines the CSR at a 1:1 ratio. */
const Q = 'MATCH (a:P)-[:E]->(x:P) RETURN x.k AS k';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[s.length >> 1];
};

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let e = 0; e < N; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % N],
      labels: ['E'],
      properties: {},
    });
  }

  return { g, vs };
};

/**
 * Kept at module scope so a graph under measurement is never collected mid-run — the trap
 * [[graph-pinned-until-microtask-drain]] describes from the other side.
 *
 * A one-slot `const` holder rather than a bare `let`: the binding is deliberately write-only, and a
 * `let` reads as dead to the linter while an exported `let` is a mutable export. Assigning into a
 * `const` object is both honest and lint-clean.
 */
const KEEP = { graph: undefined };

const cases = {
  /* ONE read per write — the declined case. */
  interleave: () => {
    const { g, vs } = build();

    KEEP.graph = g;

    for (let i = 0; i < 3; i += 1) {
      query(g, Q, {});
    }

    const ts = [];
    let z = 0;

    for (let i = 0; i < REPS; i += 1) {
      g.addEdge({
        id: `z${z}`,
        from: vs[0],
        to: vs[1],
        labels: ['E'],
        properties: {},
      });
      z += 1;

      const t = performance.now();

      query(g, Q, {});
      ts.push(performance.now() - t);
    }

    return ts;
  },

  /*
   * A FRESH graph read exactly ONCE — the case the policy protects. A forced build pays here and
   * gets nothing back, which is item 1889's 0.61x.
   */
  coldOneShot: () => {
    const ts = [];

    for (let i = 0; i < Math.min(REPS, 4); i += 1) {
      const { g } = build();

      KEEP.graph = g;

      const t = performance.now();

      query(g, Q, {});
      ts.push(performance.now() - t);
    }

    return ts;
  },

  /* Many reads per write — both arms build, so this is the control that must NOT move. */
  readHeavy: () => {
    const { g, vs } = build();

    KEEP.graph = g;

    for (let i = 0; i < 3; i += 1) {
      query(g, Q, {});
    }

    const ts = [];
    let z = 0;

    for (let i = 0; i < REPS; i += 1) {
      g.addEdge({
        id: `z${z}`,
        from: vs[0],
        to: vs[1],
        labels: ['E'],
        properties: {},
      });
      z += 1;

      // Twelve reads per write: comfortably over AMORTIZE_ASKS, so the live policy builds too.
      for (let r = 0; r < 11; r += 1) {
        query(g, Q, {});
      }

      const t = performance.now();

      query(g, Q, {});
      ts.push(performance.now() - t);
    }

    return ts;
  },
};

const run = cases[CASE];

if (run === undefined) {
  throw new Error(`unknown CASE=${CASE}; expected one of ${Object.keys(cases).join(', ')}`);
}

const ts = run();

console.log(
  `   ${CASE.padEnd(12)} N=${N}  median ${median(ts).toFixed(2)} ms   series ${ts
    .map((x) => x.toFixed(1))
    .join(' ')}`,
);
