// Item 1983 — DOES THE FIRST ASK PAY ANYTHING? The control the whole change rests on.
//
// The dense slot route is gated on `seenBefore`, item 1889's second-ask policy, and the safety
// argument is entirely about what a NON-repeated query pays:
//
//   - a ONE-SHOT query never reaches a second ask, so it must cost exactly what it cost before;
//   - a WRITE-EVERY-READ workload never reaches a second ask ON ANY ONE topologyVersion, so it must
//     also cost exactly what it cost before.
//
// ⚠️⚠️ **THOSE ARE THE CLAIMS THAT MAKE ITEM 1695's CRITERION SURVIVABLE, so they are measured
// rather than asserted.** `bench:gremlin` cannot test either one: it runs min-of-5 after 3 warm-up
// reps in a process where earlier rows have already warmed the same CSR entry, which is the
// REPEATED case by construction. A regression on the first ask would be invisible there and is
// exactly what item 1889's own numbers warn about ("hop COLD 0.61x — a 1.64x REGRESSION, first
// query" before that policy existed).
//
// ⚠️ ONE ARM PER PROCESS, because the quantity under test is "the first ask on a fresh graph" and a
// second measurement in the same process is no longer a first ask.
//
//     MODE=oneshot bun twohop-coldask-1983.mjs    # one ask, one fresh graph
//     MODE=write   bun twohop-coldask-1983.mjs    # write, ask, write, ask — never a second ask
//     MODE=repeat  bun twohop-coldask-1983.mjs    # the case that should WIN
import { Graph } from '@lenke/core';
import { count, hasLabel, out, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const MODE = process.env.MODE ?? 'oneshot';

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${String(i)}`, labels: ['P'], properties: { k: i % 97 } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    // Split on the REPEAT INDEX — CLAUDE.md's generator rule.
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(`v${String(i)}`),
      to: g.getVertexById(`v${String((i * 7 + 3 + hop * 2_654_435_761) % NODES)}`),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const PLAN = traversal(V(), hasLabel('P'), out('E'), out('E'), count());
const ask = (g) => toArray(PLAN, g)[0];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const series = [];
let answer;

if (MODE === 'repeat') {
  /*
   * ⚠️ ONE GRAPH, ASKED MANY TIMES — the only mode where the dense route can fire. The FIRST ask is
   * dropped from the series on purpose: it is the one that arms `seenBefore`, and including it would
   * average the two routes together, which is how a second-ask policy gets mis-measured.
   */
  const g = build();

  ask(g);

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    answer = ask(g);
    series.push(performance.now() - t0);
  }
} else {
  for (let r = 0; r < REPS; r += 1) {
    // A FRESH GRAPH PER REP for `oneshot`, so every measured ask is genuinely a first ask. The build
    // is outside the timer.
    const g = build();

    if (MODE === 'write') {
      // Arm `seenBefore`, then invalidate it with a topology write before the timed ask — the
      // write-every-read shape. The ask must take the walk, not the dense route.
      ask(g);
      g.addEdge({
        id: 'extra',
        from: g.getVertexById('v0'),
        to: g.getVertexById('v1'),
        labels: ['E'],
        properties: {},
      });
    }

    const t0 = performance.now();

    answer = ask(g);
    series.push(performance.now() - t0);
  }
}

console.log(
  `MODE=${MODE} NODES=${String(NODES)} FANOUT=${String(FANOUT)} REPS=${String(REPS)} answer=${String(answer)}`,
);
console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
console.log(`  median ${med(series).toFixed(2)} ms   min ${Math.min(...series).toFixed(2)}`);
