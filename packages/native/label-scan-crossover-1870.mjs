/**
 * IS `nodeValuesShortcut` NET-NEGATIVE FOR A LABELLED SCAN, AND WHERE IS THE CROSSOVER? (item 1870)
 *
 * Item 1869 refused a `hasLabel` in its new deduped rung after measuring the labelled arm at 2.3x
 * SLOWER than the pipeline — the pipeline SEEDS from the label index and visits only the labelled
 * vertices, where a whole-graph walk visits all of them and tests `labels.some(...)` on each. The
 * same item noticed that `nodeValuesShortcut`, which SHIPS, accepts a `hasLabel` and walks
 * `graph.vertices`, and read 9.22 ms for 66,667 rows against 8.32 for 200,000 unlabelled — more
 * cost, 3x fewer rows. **Evidence, not a measurement**: it compared two different questions.
 *
 * SO THIS IS A KILL SWITCH, ONE ARM PER BUILD. `LABEL_OFF=1` is the arm where
 * `nodeValuesShortcut` refuses a label and the shape falls to the pipeline; the default arm is the
 * shipped rung. Same query, same fixture, two routes — which is what "net-negative" requires and
 * item 1869 did not have.
 *
 * AND THE AXIS IS SELECTIVITY, because the answer cannot be a single number. The rung's cost is
 * a FULL SCAN whatever the label matches; the pipeline's scales with the label's size. So the rung
 * must win when a label covers nearly everything and lose when it is selective, and the useful
 * output is WHERE that crosses — a rung that refuses every label would give back the case it wins.
 *
 * THE UNLABELLED SHAPE IS THE CONTROL and must not move between arms: the kill switch touches
 * only the labelled branch, so a bare `V().values(k)` reading differently would mean the arms
 * differ by something other than the thing under test.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);

/** One vertex in `every` carries `S` as a second label; all carry `T`. */
const build = (every) => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: i % every === 0 ? ['T', 'S'] : ['T'],
      properties: { k: i % 997 },
    });
  }

  return g;
};

const median = (plan, g) => {
  const s = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    const got = toArray(plan, g);
    const ms = performance.now() - t0;

    if (r >= 2) {
      s.push(ms);
    }

    rows = got.length;
  }

  s.sort((a, b) => a - b);

  return { ms: s[s.length >> 1], rows };
};

/**
 * `CONTROL_FIRST=1` RUNS THE UNLABELLED CONTROL BEFORE THE SWEEP, AND IT EXISTS BECAUSE THE
 * ORDER CHANGED THE ANSWER. With the control LAST, arm A read it at 12.01 ms and the post-change
 * arm at ~4.9 — which looked like a 2.5x win on `V().values(k)` and is not one. In arm A the six
 * labelled rows run the rung's generator with `labels` DEFINED and the control then inherits that
 * polymorphic state; once the rung refuses labels, nothing pollutes it. That is item 762's trap
 * one level in: not two arms sharing a process, but two ROWS.
 */
if (process.env.CONTROL_FIRST === '1') {
  const c = build(3);
  const r = median(traversal(V(), values('k')), c);

  console.log(`CONTROL FIRST V().values(k)  ${r.ms.toFixed(2)} ms  ${String(r.rows)} rows`);
}

console.log(`${N} vertices, median of ${REPS} after 2 warm-ups`);
console.log(`arm: ${process.env.LABEL_OFF === '1' ? 'LABEL REFUSED (pipeline)' : 'SHIPPED RUNG'}`);
console.log('');
console.log('label covers        ms      rows   ns/row');
console.log('------------------------------------------');

for (const every of [1, 2, 3, 10, 100, 1000]) {
  const g = build(every);
  const { ms, rows } = median(traversal(V(), hasLabel('S'), values('k')), g);

  console.log(
    `1 in ${String(every).padEnd(6)} ${ms.toFixed(2).padStart(9)} ${String(rows).padStart(9)} ${(
      (ms * 1e6) /
      Math.max(rows, 1)
    )
      .toFixed(0)
      .padStart(8)}`,
  );
}

// THE CONTROL: unlabelled, which the kill switch does not touch.
const g = build(3);
const { ms, rows } = median(traversal(V(), values('k')), g);

console.log('');
console.log(`CONTROL V().values(k)  ${ms.toFixed(2)} ms  ${String(rows)} rows  (must not move)`);
