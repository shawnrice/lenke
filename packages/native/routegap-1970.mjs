// Item 1970 — PRICING THE GREMLIN ROUTE DISAGREEMENTS. `gremlin-route-screen.mjs` lists 23 generic
// routes and then says the useful part itself:
//
//     "⚠️ A generic route is NOT a defect on its own — most steps have no shortcut and never will.
//      The candidates are the DISAGREEMENTS above, and each still needs pricing against its own
//      sibling before it is a finding (item 1854: a route difference is not always a cost one)."
//
// So this prices every disagreement: a GENERIC shape beside the FUSED sibling it differs from, at
// scale, in one process per pair. A pair whose two arms cost the same is a route difference with no
// cost — exactly what item 1854 recorded, and exactly what a list of generic routes cannot tell you.
//
// 🔑 THE PAIRS ARE CHOSEN SO THE TWO ARMS ANSWER COMPARABLE QUESTIONS. Where a terminal differs the
// row counts differ too (a `count()` returns one row), so the figure reported is **ns per ELEMENT
// VISITED** — the scan or hop both arms perform — never per row. Item 1858 declined a target for
// reading a per-row ratio on exactly this kind of pair.
//
//     bun routegap-1970.mjs
//     PAIR=aggsum bun routegap-1970.mjs    # one pair per process, for an A/B
import { Graph } from '@lenke/core';
import { count, dedupe, optional, out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const ONLY = process.env.PAIR;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: i % 12, k: `s${String(i % 97)}`, w: i % 31 },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const HOP = NODES * FANOUT;

/*
 * Each entry: [name, visits, generic traversal, fused SIBLING traversal].
 * The sibling is the shape the route screen reports as fused on the same base, so the pair isolates
 * the one step that differs.
 */
/*
 * ⚠️ ONLY THE DISAGREEMENTS THAT ARE NOT ALREADY PRICED, AND ONLY WHERE THE TWO ARMS ARE
 * COMPARABLE. The route screen's header settles the whole `scan:` family — `order values` NOT a gap
 * (1574/1576), `fold` FLAT (1585), `limit values` TINY (1660), `has values` and `id` DECLINED (1858),
 * `dedupe values` TAKEN (1869) — so measuring those is re-deriving five closed results.
 *
 * ⚠️⚠️ AND MY FIRST CUT PAIRED SHAPES THAT ASK DIFFERENT QUESTIONS, which the control caught: `both`
 * against `out` read 5.00x where both are fused, because `both` visits 2,000,000 elements and `out`
 * 1,000,000. Three of the five `ded:` rows have the same defect by construction — `values('k','w')`
 * emits two values per element, `dedupe()` over elements yields 200,000 rows where `dedupe()` over
 * values yields 12 — so a ratio between them is a ratio between two questions. Only the pairs below
 * vary ONE thing, and the definitions are copied from the route screen rather than reconstructed.
 */
const PAIRS = {
  /*
   * 🔑 THE ONE CLEAN SINGLE-VARIABLE PAIR on this surface. Both arms hop, both `dedupe().by('k')`,
   * both emit one value per surviving element — the ONLY difference is whether the projected key is
   * the DEDUPE KEY or a different one, and the route screen reports the first fused and the second
   * generic.
   */
  bykey: [
    'ded: dedupe.by(k).values(w) vs .values(k)',
    HOP,
    () => traversal(V(), out('E'), dedupe().by('k'), values('w')),
    () => traversal(V(), out('E'), dedupe().by('k'), values('k')),
  ],
  // Comparable: same visits, same terminal arity, `optional` either way.
  optcount: [
    'opt: optional count vs optional values',
    HOP,
    () => traversal(V(), optional(traversal(out('E'))), count()),
    () => traversal(V(), optional(traversal(out('E'))), values('k')),
  ],
  /*
   * THE CONTROL, rebuilt so it is actually a control: two FUSED arms over the SAME visits, differing
   * only in which property they read. It must read ~1.0x, and if it does not the instrument is
   * measuring something other than the route.
   */
  control: [
    'CONTROL out.values(k) vs out.values(w) (both fused)',
    HOP,
    () => traversal(V(), out('E'), values('k')),
    () => traversal(V(), out('E'), values('w')),
  ],
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (build) => {
  const ts = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = toArray(build(), g);

    ts.push(performance.now() - t0);
    rows = got.length;
  }

  return { ms: med(ts), rows };
};

const entries = Object.entries(PAIRS).filter(([k]) => ONLY === undefined || k === ONLY);

console.log(`NODES=${String(NODES)} FANOUT=${String(FANOUT)} REPS=${String(REPS)} median`);
console.log('# ns/visit is per ELEMENT VISITED by both arms, never per row\n');
console.log('pair                                  generic   fused   ratio   rows g/f');

for (const [, [name, visits, gen, fus]] of entries) {
  const a = time(gen);
  const b = time(fus);

  console.log(
    `${name.padEnd(36)} ${((a.ms * 1e6) / visits).toFixed(0).padStart(7)} ${((b.ms * 1e6) / visits).toFixed(0).padStart(7)} ${(a.ms / b.ms).toFixed(2).padStart(7)}x  ${String(a.rows)}/${String(b.rows)}`,
  );
}
