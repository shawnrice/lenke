/**
 * DOES A REPEATED GREMLIN CHAIN COUNT REBUILD ITS ADJACENCY MEMO, AND IS THAT WORTH CACHING?
 *
 * The GQL twin of this question was item 1571/1676: `walkLevelCount` built a flattened CSR per
 * query and threw it away, and caching it on `graph.topologyVersion` measured 3.8x to 27.2x.
 * `slotChainCount` (`gremlin/src/executor/count-shortcut.ts`) has the same shape — `slotOf`, `vtx`
 * and a flat `SlotMemo` allocated per call and discarded on return — so the obvious question is
 * whether the same cache applies.
 *
 * ⚠️ BUT IT IS NOT THE SAME SITUATION, AND THIS PROBE EXISTS TO SETTLE WHICH IT IS BEFORE ANYTHING
 * IS BUILT. The GQL CSR is EAGER over the whole graph, so the whole build is saved. Gremlin's memo is
 * LAZY — `len[slot] === undefined` means "not resolved yet" — so its per-call cost is already
 * proportional to what the traversal touched, not to the graph. There may be far less to save, and
 * `check-the-blocker-still-holds` cuts the other way too: "it is lazy so there is nothing there" is a
 * claim about the numbers, not a substitute for them.
 *
 * ⚠️ THE ROUTE HAS TWO ADMISSION CONDITIONS and a probe that misses either measures a different arm:
 *
 *     oneWalkThroughout(hops) && seeds.length > max(vertexCount >> 4, 1024)
 *
 * so every hop must walk the SAME index with the SAME labels, and the seed set must be WIDE. A
 * 2-hop unfiltered count also never gets here — it is answered by the degree inner product (7.73 ms
 * against a 37.65 ms CSR build, item 590), so the chain walk starts at THREE hops.
 *
 * Arms:
 *
 *   chain3/4/5   `V().hasLabel('P').out('E')xN.count()`, repeated   the candidate
 *   hop2         the 2-hop count                                    the ALGEBRAIC route, must not move
 *   valuesCtl    `V().values('k')`, a route with no adjacency        the control
 *
 *   node gremlin-chain-memo-probe.mjs
 *   N=200000 FANOUT=5 node gremlin-chain-memo-probe.mjs
 */
import { Graph } from '@lenke/core';
import { count, hasLabel, out, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const CALLS = Number(process.env.CALLS ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  let e = 0;

  // ⚠️ TWO SEPARATE FIXTURE TRAPS ARE AVOIDED HERE, and the second one caught the first draft of
  // this probe.
  //
  // 1. SPLIT ON THE REPEAT INDEX `r`. `(a*i + b) % N` is invariant under `i -> i + N`, so a single
  //    loop over `i < N*FANOUT` would give one vertex's edges the SAME target every time — a
  //    functional graph, with flawless degree statistics.
  //
  // 2. ⚠️ THE OUT-DEGREE MUST VARY, which a fixed FANOUT does not do, and no endpoint-distinctness
  //    check can detect. For an OUT-REGULAR graph the number of k-walks from every vertex is exactly
  //    `F^k` whatever the structure, so the whole count is `N * F^k` by arithmetic — the first draft
  //    read 6,400,000 / 25,600,000 / 102,400,000 at 100,000 x 4, exactly `N*F^3,4,5`, while its
  //    distinct-endpoint check passed at 8000/8000. A count that a one-line formula predicts cannot
  //    validate anything about the traversal that produced it. So the degree is spread over
  //    1..2*FANOUT-1 with mean FANOUT, which keeps the edge count while making the walk counts a
  //    property of the graph rather than of its regularity.
  for (let i = 0; i < N; i += 1) {
    const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

    for (let r = 0; r < deg; r += 1) {
      g.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[(i * 7919 + r * 104_729 + 13) % N],
        labels: ['E'],
        properties: {},
      });
      e += 1;
    }
  }

  return g;
};

/**
 * ⚠️ CHECKS DEGREE **VARIANCE**, NOT JUST DISTINCT ENDPOINTS, and the first draft of this probe is
 * why. Distinct endpoints rule out a FUNCTIONAL graph; they say nothing about an OUT-REGULAR one,
 * whose k-walk count is `N * F^k` by arithmetic. Both have to be excluded for a walk count to be
 * evidence about the walk.
 */
const assertBranches = (g) => {
  const seen = new Set();
  const degrees = [];
  let sampled = 0;

  for (let i = 0; i < Math.min(N, 2000); i += 1) {
    const outs = g.getVertexById(`v${i}`).adjFrom?.get('E') ?? [];
    let d = 0;

    for (const edge of outs) {
      seen.add(edge.toId);
      sampled += 1;
      d += 1;
    }

    degrees.push(d);
  }

  if (seen.size / sampled < 0.5) {
    throw new Error(
      `FIXTURE IS FUNCTIONAL: ${sampled} out-edges land on ${seen.size} distinct endpoints`,
    );
  }

  const distinctDeg = new Set(degrees).size;

  if (distinctDeg < 3) {
    throw new Error(
      `FIXTURE IS OUT-REGULAR: only ${distinctDeg} distinct out-degrees, so every k-walk count is ` +
        `N*F^k by arithmetic and cannot validate the traversal`,
    );
  }

  return { sampled, distinct: seen.size, distinctDeg };
};

const chain = (hops) => {
  const steps = [V(), hasLabel('P')];

  for (let i = 0; i < hops; i += 1) {
    steps.push(out('E'));
  }

  steps.push(count());

  return traversal(...steps);
};

const PLANS = {
  hop2: chain(2),
  chain3: chain(3),
  chain4: chain(4),
  chain5: chain(5),
  valuesCtl: traversal(V(), values('k')),
};

const ARMS = Object.fromEntries(
  Object.entries(PLANS).map(([name, plan]) => [
    name,
    (g) => () => {
      for (let i = 0; i < CALLS; i += 1) {
        toArray(plan, g);
      }
    },
  ]),
);

const drain = () => new Promise((resolve) => setImmediate(resolve));

const timed = async (make) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    // A fresh graph per rep, drained between — a discarded Graph is retained in full by its pending
    // mutation-drain microtask, so a synchronous build-and-discard loop OOMs.
    const g = build();
    const fn = make(g);

    fn();

    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
    await drain();
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return { median: warm[Math.floor(warm.length / 2)], series };
};

const names = Object.keys(ARMS);
const best = {};
const seriesOf = {};

{
  const g = build();
  const { sampled, distinct, distinctDeg } = assertBranches(g);
  const answers = Object.fromEntries(
    Object.entries(PLANS).map(([n, p]) => [n, Number(toArray(p, g)[0] ?? 0)]),
  );

  console.log(
    `\nfixture: ${N} vertices, ${g.edgeCount} edges, ${distinct}/${sampled} distinct endpoints, ` +
      `${distinctDeg} distinct out-degrees`,
  );
  console.log(`answers: ${JSON.stringify(answers)}`);

  for (const h of [3, 4, 5]) {
    if (Number(answers[`chain${h}`]) === N * FANOUT ** h) {
      console.log(`⚠️ chain${h} is EXACTLY N*F^${h} — fixture suspect`);
    }
  }
}

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    const { median, series } = await timed(ARMS[nm]);

    if (median < (best[nm] ?? Infinity)) {
      best[nm] = median;
      seriesOf[nm] = series;
    }
  }
}

console.log(`\nGREMLIN CHAIN COUNT — ${CALLS} calls per rep, ${REPS} reps, 3 rounds\n`);
console.log('arm              ms      ms/call');

for (const nm of names) {
  console.log(
    `${nm.padEnd(12)} ${best[nm].toFixed(1).padStart(8)}  ${(best[nm] / CALLS).toFixed(2).padStart(9)}`,
  );
}

console.log('\nper-rep series:');

for (const nm of names) {
  console.log(`  ${nm.padEnd(12)} ${seriesOf[nm].map((x) => x.toFixed(0)).join(' ')}`);
}
