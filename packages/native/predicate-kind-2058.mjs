/*
 * Item 2058 — IS THE ~40 ns A VERTEX THE RANGE PREDICATE, OR THE GENERIC ROUTE IT FORCES?
 *
 * Item 2057 measured, with row emissions held equal at 200,000:
 *
 *     V().values(n)                   32 ns a vertex   FUSED
 *     V().has('k', gte(0)).values(n)  72 ns a vertex   generic
 *
 * — and could NOT separate the predicate's own evaluation from the route, because in that fixture
 * `k` is `i % 50`, so **no equality predicate keeps every vertex** and the two always moved together.
 * It said what instrument would settle it: a CONSTANT-VALUED property, so an equality can keep all.
 *
 * **THE THREE ARMS, each scanning 200,000 vertices and emitting 200,000 rows:**
 *
 *     A  V().values(n)                 no predicate at all      -> the fused floor
 *     B  V().has('c', 1).values(n)     EQUALITY, keeps all      -> A + route + equality eval
 *     C  V().has('k', gte(0)).values(n) RANGE, keeps all        -> A + route + range eval
 *
 *   B - A  = having a `has` at all (route + the cheapest predicate)
 *   C - B  = what a RANGE predicate costs over an EQUALITY one, route held constant
 *
 * ITS OWN FIXTURE, NOT THE SHARED SCREEN'S. Adding a property to `gremlin-workload-screen.mjs`
 * would change every row's memory footprint and perturb rows this item has no business touching.
 *
 * EMISSIONS ARE ASSERTED EQUAL. Item 2057's first reading was 1.15x because one arm emitted 50x
 * fewer rows and the route cost hid inside the materialization it saved.
 *
 *     bun predicate-kind-2058.mjs
 */
import { Graph } from '@lenke/core';
import { gte, has, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['T'],
    // `c` is CONSTANT, which is the whole point: `has('c', 1)` is an equality that keeps every vertex.
    properties: { n: i, k: i % 50, c: 1 },
  });
}

const ARMS = {
  'A no predicate   (fused)': () => traversal(V(), values('n')),
  'B has(c,1)       equality': () => traversal(V(), has('c', 1), values('n')),
  'C has(k,gte(0))  range': () => traversal(V(), has('k', gte(0)), values('n')),
  /*
   * ARM D IS THE ONE THAT ACTUALLY ISOLATES PREDICATE KIND. B and C differ in TWO things — the
   * predicate kind AND the property read (`c` against `k`) — so `C - B` is not a predicate-kind
   * figure. D is a RANGE over the SAME constant property B reads, so `D - B` varies kind alone.
   */
  'D has(c,gte(0))  range': () => traversal(V(), has('c', gte(0)), values('n')),
  /*
   * ARMS E AND F EXIST BECAUSE ITEM 2058 COULD NOT TELL "PER SCANNED VERTEX" FROM "PER EMITTED
   * ROW" — every arm above scans 200,000 AND emits 200,000, so the two counts are the same number
   * and ~47 ns was attributed to the scan. The workload screen's `point: has(k,v)` scans 200,000 and
   * emits 4,000, and item 2059's fusion left it FLAT while lifting B by ~3x. These arms vary the
   * surviving fraction while holding the scan at 200,000, which is what separates the two.
   *
   * THEY BREAK THE `rows === NODES` ASSERTION ON PURPOSE, so the check below is per-arm.
   */
  'E has(k,gte(25)) half': () => traversal(V(), has('k', gte(25)), values('n')),
  'F has(k,7)       1-in-50': () => traversal(V(), has('k', 7), values('n')),
};

/** Arms A-D emit one row per vertex; E and F deliberately do not. */
const EMITS_ALL = new Set(['A', 'B', 'C', 'D']);

/*
 * **ONE ARM PER PROCESS IS THE RULE, AND RUNNING ALL FOUR TOGETHER BROKE IT.** CLAUDE.md: "In the
 * PRE arm every query shape funnels through one dispatch site; in the POST arm some are routed
 * elsewhere… The fix is **one shape per PROCESS**, so no other shape pollutes the dispatch." All four
 * arms here share `filterStream`'s callback site and the specialized-closure call inside it, so each
 * arm makes that site more polymorphic for the ones after it. The in-process run reported a RANGE
 * predicate beating an EQUALITY by 14-23 ns a vertex — with near-identical specialized closures
 * (`v === b` against `typeof v === 'number' && v >= b`) and the same declining rung, which is not a
 * believable route difference. `ARM=B` runs exactly one.
 */
const ONLY_ARM = process.env.ARM;
const ms = {};

for (const [name, mk] of Object.entries(ARMS)) {
  if (ONLY_ARM !== undefined && !name.startsWith(ONLY_ARM)) {
    continue;
  }

  const rows = toArray(mk(), g).length;

  if (EMITS_ALL.has(name[0]) && rows !== NODES) {
    throw new Error(
      `${name} emitted ${rows} rows, expected ${NODES} — the arms are not comparable`,
    );
  }

  if (!EMITS_ALL.has(name[0]) && rows >= NODES) {
    throw new Error(
      `${name} emitted ${rows} rows — it is meant to be SELECTIVE, so this proves nothing`,
    );
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    toArray(mk(), g);
    series.push(performance.now() - t0);
  }

  // Median of the plateau; the first reps are visibly V8 tiering up (items 2043-2045).
  const plateau = series.slice(3).sort((a, b) => a - b);
  const m = plateau[Math.floor(plateau.length / 2)];

  ms[name] = m;
  console.log(
    `  ${name.padEnd(28)} ${m.toFixed(2).padStart(8)} ms  ${String(rows).padStart(7)} rows  ${((m * 1e6) / NODES).toFixed(1).padStart(6)} ns/scan  ${((m * 1e6) / rows).toFixed(1).padStart(6)} ns/row`,
  );
}

if (ONLY_ARM !== undefined) {
  // One arm per process: the differences are computed across processes, by the caller.
  process.exit(0);
}

const ns = (m) => (m * 1e6) / NODES;
const A = ns(ms['A no predicate   (fused)']);
const B = ns(ms['B has(c,1)       equality']);
const C = ns(ms['C has(k,gte(0))  range']);
const D = ns(ms['D has(c,gte(0))  range']);

console.log(
  `\n  ${NODES} vertices, every arm emitting ${NODES} rows\n` +
    `\n  B - A = ${(B - A).toFixed(1)} ns/vertex   <- having a \`has\` AT ALL (route + a predicate)` +
    `\n  D - B = ${(D - B).toFixed(1)} ns/vertex   <- PREDICATE KIND ALONE: range vs equality, SAME property \`c\`` +
    `\n  C - D = ${(C - D).toFixed(1)} ns/vertex   <- PROPERTY ALONE: \`k\` vs \`c\`, both range` +
    `\n  C - B = ${(C - B).toFixed(1)} ns/vertex   NOT a predicate-kind figure — kind AND property both differ\n`,
);
