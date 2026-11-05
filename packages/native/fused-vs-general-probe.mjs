/**
 * HOW MUCH FASTER IS THE FUSED SOURCE-ANCHORED WALK THAN THE GENERAL TRAVERSER PIPELINE, for the
 * SAME one hop and the SAME row count?
 *
 * This number has been the basis of three items and has never been measured directly. Items 1480 and
 * 1483 both compared a sub-plan hop against `V().out(T).values(k).count()` and called the ratio the
 * opportunity — but that plan rides `hopValuesShortcut`, which emits bare VALUES and never
 * materializes a vertex traverser at all. So the floor does strictly less work than the thing being
 * floored, and the ratio is an upper bound on the opportunity rather than its size. (Item 1479 hit
 * the same trap one level down, where a bare `count()` tail was answered by a chain count.)
 *
 * ⚠️ THE TRICK IS A PROJECTION THE SHORTCUT DOES NOT RECOGNISE. `hopValuesShortcut` accepts exactly
 * three third steps — `values(k)` (one key), `id()`, or nothing — and DECLINES anything else, falling
 * back to the full pipeline. So `label()` after the hop gives the general route over the identical
 * hop and the identical row count, where `values(k)` gives the fused one. Both read one thing per
 * far vertex.
 *
 * ⚠️ IT IS NOT A PERFECT PAIR and that is stated rather than hidden: a property read
 * (`props[key]`) is not a label read (first of a `Set`). It is the closest pair available without a
 * second engine build, and the two reads are the same order of cost — so a ~1.5x result would mean
 * the file's own comments are right, and a ~6x result would mean the fused walk's advantage is much
 * bigger than those comments say.
 *
 *     NODES=50000 FANOUT=5 REPS=9 node fused-vs-general-probe.mjs
 */
import { Graph } from '@lenke/core';
import { V, count, id, label, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);

/**
 * ⚠️ THE STRIDE IS THE WHOLE BALLGAME HERE, which is why it is a knob and not a constant.
 *
 * `sequential` gives every vertex exactly FANOUT out-edges, added in vertex order, so the walk reads
 * adjacency in the order it was built. `scattered` draws the source from `(e * 7919) % NODES`, as
 * `runtime-profile-gremlin-probe.mjs` does — out-degree then varies and the adjacency is touched in
 * random order, which is what a real graph looks like.
 *
 * Item 1486: the two instruments disagreed 3.4x on `rows id()` (28 ns/row against 94) and the fixture
 * was the entire reason. Worse, the id-vs-values RATIO depends on it too — so a property-read
 * "target" measured on a sequential fixture can be an artefact of the fixture.
 */
const STRIDE = process.env.STRIDE ?? 'sequential';

if (STRIDE !== 'sequential' && STRIDE !== 'scattered') {
  throw new Error(`STRIDE must be sequential|scattered, got ${STRIDE}`);
}

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: vs[STRIDE === 'scattered' ? (e * 7919) % NODES : i],
    to: vs[
      STRIDE === 'scattered' ? (e * 104_729) % NODES : (i * 7 + 3 + hop * 2_654_435_761) % NODES
    ],
    labels: ['E'],
  });
}

// ⚠️ TWO FAMILIES, because a trailing `count()` can be answered WITHOUT materializing the rows.
// The first reading of this probe (item 1484) used the `count()` forms and reported `values(k)` at 35
// ns/row against `id()`'s 117 on the same walk — a 3.3x that made no sense. It was not the pick: a
// `count()` tail lets the engine skip producing the values at all, which the no-count forms below
// show directly (`values(k)` WITHOUT count costs MORE per row than with it). Item 1485.
//
// The ROWS family is the honest one for "what does one hop plus a per-row projection cost", because
// every arm must actually produce its rows.
const ARMS = {
  // --- rows actually materialized (no count tail) ---
  'rows values(k)': traversal(V(), out('E'), values('k')),
  'rows id()': traversal(V(), out('E'), id()),
  'rows label()': traversal(V(), out('E'), label()),
  // --- the same three with a count tail, kept so the confound stays VISIBLE ---
  'count values(k)': traversal(V(), out('E'), values('k'), count()),
  'count id()': traversal(V(), out('E'), id(), count()),
  'count label()': traversal(V(), out('E'), label(), count()),
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

console.log(
  `\nFUSED vs GENERAL — STRIDE=${STRIDE} NODES=${NODES} FANOUT=${FANOUT} REPS=${REPS} DROP=${DROP}\n`,
);

const results = {};

for (const [name, plan] of Object.entries(ARMS)) {
  const reps = [];
  let answer;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const out_ = toArray(plan, g);

    reps.push(performance.now() - t0);
    // a count arm answers one row holding the tally; a rows arm answers the rows themselves
    answer = name.startsWith('count')
      ? Number(Array.isArray(out_) ? out_[0] : out_)
      : [...out_].length;
  }

  const ms = med(reps.slice(DROP));

  results[name] = ms;
  console.log(
    `${name.padEnd(18)} ${ms.toFixed(2).padStart(9)} ms   rows=${answer}   ${((ms * 1e6) / (NODES * FANOUT)).toFixed(0)} ns/row`,
  );
}

// ⚠️ EVERY ARM MUST COVER THE SAME ROWS, or a ratio is between two different questions.
console.log(
  `\nROWS (honest):  label/values = ${(results['rows label()'] / results['rows values(k)']).toFixed(2)}x` +
    `   label/id = ${(results['rows label()'] / results['rows id()']).toFixed(2)}x` +
    `   id/values = ${(results['rows id()'] / results['rows values(k)']).toFixed(2)}x`,
);
console.log(
  `COUNT (confounded): label/values = ${(results['count label()'] / results['count values(k)']).toFixed(2)}x` +
    `   label/id = ${(results['count label()'] / results['count id()']).toFixed(2)}x` +
    `   id/values = ${(results['count id()'] / results['count values(k)']).toFixed(2)}x\n`,
);
