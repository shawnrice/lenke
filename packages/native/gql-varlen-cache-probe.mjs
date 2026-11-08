/**
 * WHAT DOES A REPEATED BOUNDED VAR-LENGTH COUNT PAY TO REBUILD ITS CSR? Item 1571 instrumented the
 * route and found 86.3% of the answer going into a flattened adjacency that is thrown away when the
 * query returns, so the second identical query pays the whole cost again.
 *
 * The route is `walkLevelCount` in `executor/var-length-count.ts`, reached by
 * `MATCH (x:L)-[:T]->{1,k}(y:M) RETURN count(*)`. Its own ablation (item 589) splits the cost:
 *
 *     BUILD a CSR once (E map lookups)   18.28 ms     one level's worth, paid once
 *     dense read from the built CSR       0.10 ms     per level
 *
 * so the build dominates at every depth, and a cache keyed on a synchronous topology signal turns
 * the second and later calls into the dense read alone.
 *
 * ⚠️ THE ARMS THAT MATTER ARE THE ONES A CACHE CANNOT HELP, and they are here as controls:
 *
 *   repeated          the same query N times, no writes       the cache's best case
 *   writeInterleaved  a 1-edge write between each query       every call misses, so this prices
 *                     the COST of the cache rather than its win
 *   depth2            `{1,2}`, two levels                     the shape with least to amortize
 *   scanControl       a node scan, a different route           must not move at all
 *
 * ⚠️ FIXTURE: the targets are split on the REPEAT INDEX, not on `k` alone. `to = (a*k + b) % N` is
 * invariant under `k -> k + N`, so a loop over `k < N*FANOUT` gives one vertex's FANOUT edges the
 * same target every time — a FUNCTIONAL graph whose k-hop count is `F^k * N` by construction, with
 * perfect-looking degree statistics. The distinct-endpoint count is asserted below, which is the one
 * line that catches it.
 *
 * ⚠️ SWEEP THE SIZE, AND THE DEFAULT N UNDERSTATES THIS CACHE BY AN ORDER OF MAGNITUDE. At the
 * default 50,000/150,000 the cache measures 2.45x; the repo's own `bun run bench` fixture
 * (200,000/1,000,000) measures the same rows at 3.8x to 27.2x. The two do not disagree — the thing
 * the cache ELIMINATES and the thing it LEAVES scale differently:
 *
 *     the build    a V-entry `Map` plus E map lookups    7.6 ms at 50k   ->  124-196 ms at 200k
 *     the residual a dense Int32Array read per level     ~5.0 ms at 50k  ->  7-30 ms at 200k
 *
 * The build's `idx.get` per edge falls out of cache across precisely the 200,000-to-1,000,000
 * transition this repo documents, while a sequential typed-array read does not. So the win GROWS
 * with the fixture, and a 50,000-vertex reading is the floor rather than the answer. Run both sizes.
 *
 * (Shape matters much less than size: at 200k, warm, a labelled endpoint reads 29.89 ms/call, an
 * unlabelled one 27.63 — 1.08x — and `MATCH WALK` with an unlabelled endpoint 14.76, 2.0x. That is
 * the whole spread across spellings, against the 16-26x the fixture size is worth.)
 *
 *   node gql-varlen-cache-probe.mjs
 *   N=200000 FANOUT=5 CALLS=5 REPS=7 node gql-varlen-cache-probe.mjs   # the bench's fixture
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const CALLS = Number(process.env.CALLS ?? 20);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  let e = 0;

  for (let r = 0; r < FANOUT; r += 1) {
    for (let i = 0; i < N; i += 1) {
      // Split on `r`, the repeat index — see the fixture note above.
      const to = (i * 7919 + r * 104_729 + 13) % N;
      g.addEdge({ id: `e${e}`, from: vs[i], to: vs[to], labels: ['E'], properties: {} });
      e += 1;
    }
  }

  return g;
};

/** ⚠️ The one line that catches a functional fixture. */
const assertBranches = (g) => {
  const seen = new Set();
  let sampled = 0;

  for (let i = 0; i < Math.min(N, 2000); i += 1) {
    const v = g.getVertexById(`v${i}`);
    const outs = v.adjFrom?.get('E') ?? [];

    for (const edge of outs) {
      seen.add(edge.toId);
      sampled += 1;
    }
  }

  const ratio = seen.size / sampled;

  if (ratio < 0.5) {
    throw new Error(
      `FIXTURE IS DEGENERATE: ${sampled} sampled out-edges land on only ${seen.size} distinct ` +
        `endpoints (${(ratio * 100).toFixed(1)}%). A functional graph makes every k-hop count ` +
        `F^k*N by construction — see the fixture note.`,
    );
  }

  return { sampled, distinct: seen.size };
};

const DEPTH3 = 'MATCH (x:P)-[:E]->{1,3}(y:P) RETURN count(*) AS c';
// ⚠️ `{1,1}` AND A PLAIN ONE-HOP COUNT BOTH READ 0.0 ms AND WERE REMOVED AS CONTROLS. Each takes an
// O(1) shortcut rung rather than `walkLevelCount`, so neither can show perturbation and neither
// prices the route. The depth-2 arm replaces `{1,1}` as the shape with least to amortize, and a node
// scan replaces the one-hop count as a control that is measurable and cannot reach the CSR at all.
const DEPTH2 = 'MATCH (x:P)-[:E]->{1,2}(y:P) RETURN count(*) AS c';
const SCAN_CONTROL = 'MATCH (x:P) WHERE x.k > 25000 RETURN count(*) AS c';

const ARMS = {
  repeated: (g) => () => {
    for (let i = 0; i < CALLS; i += 1) {
      query(g, DEPTH3);
    }
  },
  writeInterleaved: (g) => {
    let n = 0;

    return () => {
      for (let i = 0; i < CALLS; i += 1) {
        query(g, DEPTH3);
        const a = g.getVertexById('v0');
        const b = g.getVertexById('v1');
        g.addEdge({ id: `probe-e${n}`, from: a, to: b, labels: ['E'], properties: {} });
        n += 1;
      }
    };
  },
  depth2: (g) => () => {
    for (let i = 0; i < CALLS; i += 1) {
      query(g, DEPTH2);
    }
  },
  scanControl: (g) => () => {
    for (let i = 0; i < CALLS; i += 1) {
      query(g, SCAN_CONTROL);
    }
  },
};

const drain = () => new Promise((resolve) => setImmediate(resolve));

const timed = async (make) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    // A fresh graph per rep, so the write-interleaved arm does not grow without bound and every
    // arm sees the same N. The drain lets the previous one be collected.
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
  const { sampled, distinct } = assertBranches(g);
  const answer = Number(query(g, DEPTH3)[0].c);
  const suspect = answer === N * FANOUT ** 3 ? '  ⚠️ EXACTLY F^k*N — suspect' : '';

  console.log(
    `\nfixture: ${N} vertices, ${N * FANOUT} edges, ${distinct}/${sampled} distinct endpoints sampled; depth-3 count = ${answer}${suspect}`,
  );
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

console.log(
  `\nREPEATED VAR-LENGTH COUNT — ${CALLS} calls per rep, ${REPS} reps, 3 order-alternated rounds\n`,
);
console.log('arm                   ms      ms/call');

for (const nm of names) {
  console.log(
    `${nm.padEnd(18)} ${best[nm].toFixed(1).padStart(7)}  ${(best[nm] / CALLS).toFixed(2).padStart(9)}`,
  );
}

console.log('\nper-rep series (the summary is not the measurement — see the bimodality note):');

for (const nm of names) {
  console.log(`  ${nm.padEnd(18)} ${seriesOf[nm].map((x) => x.toFixed(0)).join(' ')}`);
}
