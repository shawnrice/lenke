/**
 * THE GREMLIN ANALOGUE OF ITEMS 1499-1502: what does a traversal cost BEFORE it touches the graph?
 *
 * GQL's per-call overhead was parse+plan, and item 1502 removed most of it for interpolating callers
 * by making the cache key stable. Gremlin has no text to parse — a traversal is built from host
 * calls — so the question looks inapplicable. It is not: `toArray` runs `effectivePlan` on every
 * call, and that is SEVEN rewrite passes (`fuseLocal`, `fuseValuesIsCount`, `flattenFilterWrappers`,
 * `fuseEdgeHop`, `fuseUnionBoth`, `fuseUnionSameDir`, `dropVacuousLabels`) with no cache between
 * them and the next call.
 *
 * ⚠️ THE FIXTURE IS DELIBERATELY TINY. Every other probe here uses 200,000+ elements, which is
 * right when measuring a walk and wrong when measuring a per-call constant: at bench scale the
 * graph work swamps it and the answer rounds to zero. These arms use a graph small enough that
 * per-call overhead is the majority of the reading, which is also the regime a serving workload
 * lives in (`bench:usage`'s rows are small operations against a warm graph).
 *
 * Three arms, each adding one thing:
 *
 *   work      the traversal with a plan built ONCE, reused every call — so this is the graph work
 *             plus whatever `toArray` re-does per call
 *   rebuilt   + rebuilding the plan each call, which is what a real application does when it
 *             constructs the traversal inside the request handler
 *   floor     the same answer by hand, with no plan and no engine
 *
 *     NODES=200 REPS=20000 node gremlin-plan-overhead-probe.mjs
 *     SHAPE=count node gremlin-plan-overhead-probe.mjs
 */
import { Graph } from '@lenke/core';
import { V, count, gt, has, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200);
const REPS = Number(process.env.REPS ?? 20_000);
const DROP = Number(process.env.DROP ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ONLY = process.env.SHAPE;

const graph = new Graph();
const ids = [];

for (let i = 0; i < NODES; i += 1) {
  ids.push(`v${i}`);
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 7, n: i } });
}

for (let e = 0; e < NODES; e += 1) {
  graph.addEdge({
    id: `e${e}`,
    labels: ['E'],
    from: graph.getVertexById(ids[e % NODES]),
    to: graph.getVertexById(ids[(e * 7 + 1) % NODES]),
  });
}

/** Each shape: how to BUILD the plan, and a hand-written floor that answers the same thing. */
const SHAPES = {
  count: {
    build: () => traversal(V(), count()),
    floor: () => graph.verticesById.size,
  },
  filtered: {
    build: () => traversal(V(), has('k', gt(3)), count()),
    floor: () => {
      let n = 0;

      for (const v of graph.verticesById.values()) {
        const x = v.properties.k;

        if (typeof x === 'number' && x > 3) {
          n += 1;
        }
      }

      return n;
    },
  },
  hop: {
    build: () => traversal(V(), out('E'), count()),
    floor: () => graph.edgesById.size,
  },
  vals: {
    build: () => traversal(V(), values('n'), count()),
    floor: () => graph.verticesById.size,
  },
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const timeRound = (fn) => {
  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    fn();
  }

  return ((performance.now() - t0) * 1e6) / REPS;
};

const names = ONLY === undefined ? Object.keys(SHAPES) : [ONLY];

for (const n of names) {
  if (SHAPES[n] === undefined) {
    throw new Error(`unknown SHAPE ${n}; have ${Object.keys(SHAPES).join(',')}`);
  }
}

console.log(
  `\nGREMLIN PER-CALL OVERHEAD — NODES=${NODES} REPS=${REPS} ROUNDS=${ROUNDS} (ns per call)\n`,
);
console.log(
  `${'shape'.padEnd(10)}${'floor'.padStart(9)}${'work'.padStart(9)}${'rebuilt'.padStart(9)}` +
    `${'toArray/floor'.padStart(15)}${'rebuild cost'.padStart(14)}`,
);

for (const name of names) {
  const { build, floor } = SHAPES[name];
  const prebuilt = build();
  // ⚠️ Every arm must agree, including the floor — an arm that answers a different question prices
  // a different question, which is the error items 1479/1485/1488 each made.
  const want = toArray(prebuilt, graph);
  const got = floor();
  const wantNum = Array.isArray(want) ? want[0] : want;

  if (wantNum !== got) {
    throw new Error(
      `SHAPE ${name}: engine says ${String(wantNum)}, floor says ${String(got)} — different questions.`,
    );
  }

  const arms = {
    floor: () => timeRound(() => floor()),
    work: () => timeRound(() => toArray(prebuilt, graph)),
    rebuilt: () => timeRound(() => toArray(build(), graph)),
  };
  const out_ = {};

  for (const [arm, fn] of Object.entries(arms)) {
    const rounds = [];

    for (let r = 0; r < ROUNDS; r += 1) {
      rounds.push(fn());
    }

    out_[arm] = med(rounds.slice(DROP));
  }

  const ratio = `${(out_.work / out_.floor).toFixed(1)}x`;
  const rebuild = `${(out_.rebuilt - out_.work).toFixed(0)}ns`;

  console.log(
    name.padEnd(10) +
      out_.floor.toFixed(0).padStart(9) +
      out_.work.toFixed(0).padStart(9) +
      out_.rebuilt.toFixed(0).padStart(9) +
      ratio.padStart(15) +
      rebuild.padStart(14),
  );
}

console.log();
