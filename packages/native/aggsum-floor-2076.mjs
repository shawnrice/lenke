/*
 * Item 2076 — WHAT DOES ONE `sum(n.n)` COST, against a hand loop over the same vertices?
 *
 * The probe reads `MATCH (n:P) RETURN sum(n.n) AS s` at 73.1 ms over 200,000 vertices — 365 ns a
 * vertex for one running addition. Item 2067 priced a bare `v.properties.k` read at 6.7 ns, so the
 * aggregate path is ~55x a property read, which is implausible enough to need a floor.
 *
 * THE FLOOR MUST ANSWER THE SAME NUMBER, or it prices a different query. `sum(n.n)` over
 * `n = 0 … N-1` is the triangular number, which is also the probe's own guard.
 *
 * AND THE ARMS ARE SEPARATED SO ONE TERM MOVES AT A TIME:
 *     label + read + add   what the query asks for
 *     read + add           no label test
 *     add only             the loop's own floor, reading nothing
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

const want = (NODES * (NODES - 1)) / 2;

const engine = () => Number([...query(g, 'MATCH (n:P) RETURN sum(n.n) AS s')][0].s);

const handLabelled = () => {
  let t = 0;

  for (const v of g.vertices) {
    if (v.labels.has('P')) {
      t += v.properties.n;
    }
  }

  return t;
};

const handUnlabelled = () => {
  let t = 0;

  for (const v of g.vertices) {
    t += v.properties.n;
  }

  return t;
};

const handLoopOnly = () => {
  let t = 0;

  for (const v of g.vertices) {
    t += v.id.length;
  }

  return t;
};

/*
 * AN OBJECT ARRAY, NOT A TUPLE ARRAY. `[['engine', engine], …]` infers each element as
 * `(string | (() => number))[]`, so `label` is a union and interpolating it fails the lint — which is
 * a real signal that the shape was wrong, not noise to silence with a cast.
 */
for (const { label, fn } of [
  { label: 'engine', fn: engine },
  { label: 'hand labelled', fn: handLabelled },
  { label: 'hand unlabelled', fn: handUnlabelled },
]) {
  if (fn() !== want) {
    throw new Error(
      `${label} answered ${String(fn())}, expected ${String(want)} — it prices a different query`,
    );
  }
}

const time = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(3).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(
    `  ${label.padEnd(22)} ${ms.toFixed(2).padStart(8)} ms   ${((ms * 1e6) / NODES).toFixed(1).padStart(6)} ns/vertex`,
  );

  return ms;
};

console.log(`\n  ${NODES} vertices; every summing arm answers ${want}\n`);
const e = time('engine sum(n.n)', engine);
const hl = time('hand labelled', handLabelled);
const hu = time('hand unlabelled', handUnlabelled);
const lo = time('loop only (no read)', handLoopOnly);

console.log(
  `\n  engine / hand labelled   = ${(e / hl).toFixed(2)}x` +
    `\n  the label test costs       ${(hl - hu).toFixed(2)} ms (${(((hl - hu) * 1e6) / NODES).toFixed(1)} ns a vertex)` +
    `\n  the read + add costs       ${(hu - lo).toFixed(2)} ms\n`,
);
