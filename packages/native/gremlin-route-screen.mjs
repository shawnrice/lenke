/**
 * WHICH GREMLIN SHAPES FALL THROUGH EVERY SHORTCUT? (item 1855)
 *
 * ⚠️ THE GQL TWIN FOUND A 27.7x GAP AND THIS SURFACE HAS NO EQUIVALENT SCREEN. Item 1854 could ask
 * `compileLinear` directly which detectors claim a shape, because the GQL planner hands back a
 * `CLinear` whose fields ARE the routes. Gremlin has no such object: `run` is a ladder of
 * shortcuts, each returning early, and a plan that matches none of them simply falls through to
 * the generic traverser pipeline. So "which rung claimed this?" cannot be read off a value.
 *
 * ⚠️ SO THE SIGNAL IS `applyStep`, THE GENERIC PIPELINE'S SINGLE ENTRY. Every step the generic
 * path executes goes through it; a whole-plan shortcut returns before the loop is reached. Patching
 * that ONE function to count its calls therefore separates "a shortcut answered this" from "the
 * traverser pipeline ran", which is exactly the route question — and it reports the STEP KINDS it
 * saw, so a plan that is partly fused reads differently from one that is wholly generic.
 *
 * ⚠️ IT IS A MUTATION RUN, so it keeps a pristine copy under `target/` and restores in a `finally`
 * — an interrupted run must not leave an instrumented engine in the tree. The instrumented build is
 * asserted present before any shape is measured, because a silently-unpatched build would report
 * every shape as "shortcut" and look like very good news.
 *
 * ⚠️ AND A GENERIC ROUTE IS NOT AUTOMATICALLY A DEFECT. Most Gremlin steps have no shortcut and
 * never will; the pipeline IS the implementation. What this screen is for is the shape whose
 * NEIGHBOUR is fused while it is not — `out().values()` fused but `out().out().values()` not, say.
 * So the output groups by base and marks the shapes whose siblings differ.
 *
 * ⚠️⚠️ **THE SCAN FAMILY'S DISAGREEMENTS ARE MOSTLY ALREADY ANSWERED — read this before pricing
 * one again (item 1868).** At `hop1:` nearly everything is fused, so the depth-0 `scan:` rows look
 * like a cliff and the screen flags six of them. Five are settled:
 *
 *     scan: order values   NOT a gap. Item 1574/1576 took `values(k).order().limit(10)` 55.2 ->
 *                          18.6 ms (2.97x cumulative) and kept the FULL sort as a deliberately
 *                          flat control: 66.2 / 67.8 / 72.0 across those items. A full sort of
 *                          200,000 values is a full sort.
 *     scan: fold           FLAT. Item 1585 measured `values(k).fold()` at 2.189 against
 *                          `values(k)`'s 2.181.
 *     scan: limit values   TINY. Item 1660 measured `values(k).limit(10)` drain-all at 0.073 ms.
 *     scan: has values     DECLINED at item 1858, ~1.3x, with the reason: it visits the same
 *                          200,000 vertices and emits 7x fewer rows, so the per-ROW figure
 *                          overstates it badly.
 *     scan: id             DECLINED at item 1858, ~1.6x.
 *
 * ~~The one still open is `scan: dedupe values`, priced at item 1868: **11.96 ms** producing 997
 * rows from 200,000 values, against the fused floor's 5.81 ms for emitting all 200,000. A fused
 * walk accumulating into a `Set` emits 200x fewer rows, so ~2.4x looks available.~~
 * ✅ **TAKEN AT ITEM 1869 — 2.20x, and this screen's own output has reported it `fused` ever since.
 * Struck at item 1970.** ⚠️ It was closed by the item IMMEDIATELY after the one that priced it,
 * which is CLAUDE.md's measured pattern (22 of 40 stale lines in one sweep were closed by the very
 * next item) — and a header that says "read this before pricing one again" pointing at a closed
 * target is the exact cost that rule exists to prevent. **So: all six `scan:` disagreements are now
 * settled, and none of them is open.**
 *
 * ⚠️ AND THE PARAMETER-AXIS GAP ITEM 1867 FIXED ON THE GQL SIDE HAS NO TWIN HERE. A Gremlin
 * traversal is an OBJECT with literal numbers — there is no `Params` type anywhere in
 * `packages/gremlin/src` — so "a literal page routes and a parameterized one does not" cannot
 * arise on this surface. Checked rather than assumed.
 *
 *     bun gremlin-route-screen.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/dispatch.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1855-dispatch.ts`;
const MARKER = 'ROUTE_SCREEN_1855';

const ANCHOR = `export const applyStep = (`;

/** Each traversal, as the source a child will evaluate. Grouped so siblings sit together. */
const SHAPES = {
  'scan: values': "traversal(V(), values('k'))",
  'scan: hasLabel values': "traversal(V(), hasLabel('T'), values('k'))",
  'scan: count': 'traversal(V(), count())',
  'scan: dedupe values': "traversal(V(), values('k'), dedupe())",
  'scan: order values': "traversal(V(), values('k'), order())",
  'scan: limit values': "traversal(V(), values('k'), limit(10))",
  'scan: has count': "traversal(V(), has('k', 3), count())",
  'scan: has values': "traversal(V(), has('k', 3), values('k'))",
  'scan: fold': "traversal(V(), values('k'), fold())",
  'scan: id': 'traversal(V(), id())',
  /*
   * ⚠️ THE COMBINATIONS ITEMS 2021 AND 2025 CREATED. Each of those widened the scan-values gate from
   * one side — 2021 for a TRAILING residual, 2025 for a LEADING existence filter — so the rows that
   * matter now are the ones that need BOTH, which neither rung admits on its own. Added as a census
   * rather than assumed: the screen's job is to say which route answers a shape.
   */
  'scan: where values': "traversal(V(), where(traversal(out('E'))), values('k'))",
  'scan: where values order': "traversal(V(), where(traversal(out('E'))), values('k'), order())",
  'scan: where values count': "traversal(V(), where(traversal(out('E'))), values('k'), count())",
  'scan: where values dedupe': "traversal(V(), where(traversal(out('E'))), values('k'), dedupe())",
  'scan: values order limit': "traversal(V(), values('k'), order(), limit(10))",
  'scan: values min': "traversal(V(), values('k'), min())",
  'hop1: values': "traversal(V(), out('E'), values('k'))",
  'hop1: count': "traversal(V(), out('E'), count())",
  'hop1: id': "traversal(V(), out('E'), id())",
  'hop1: dedupe count': "traversal(V(), out('E'), dedupe(), count())",
  'hop1: has count': "traversal(V(), out('E'), has('k', 3), count())",
  'hop1: order values': "traversal(V(), out('E'), values('k'), order())",
  'hop1: limit values': "traversal(V(), out('E'), values('k'), limit(10))",
  'hop1: min': "traversal(V(), out('E'), values('k'), min())",
  // ⚠️ THE STRING-KEY TWIN (item 1919). `values('s').min()` measures 199.92 ms against the numeric
  // twin's 78.50 and against its OWN floor (`values('s')`) at 76.74 — and the string comparison is
  // only ~11 ms of that, measured. A route difference is the remaining candidate, so the screen
  // needs the row.
  'hop1: min STRING': "traversal(V(), out('E'), values('s'), min())",
  'hop1: values STRING': "traversal(V(), out('E'), values('s'))",
  'hop1: fold': "traversal(V(), out('E'), values('k'), fold())",
  'hop1: both': "traversal(V(), both('E'), count())",
  'hop1: outE inV': "traversal(V(), outE('E'), inV(), count())",
  'hop2: values': "traversal(V(), out('E'), out('E'), values('k'))",
  'hop2: count': "traversal(V(), out('E'), out('E'), count())",
  'hop2: dedupe count': "traversal(V(), out('E'), out('E'), dedupe(), count())",
  'hop2: order values': "traversal(V(), out('E'), out('E'), values('k'), order())",
  'hop2: min': "traversal(V(), out('E'), out('E'), values('k'), min())",
  'hop2: has count': "traversal(V(), out('E'), out('E'), has('k', 3), count())",
  'hop2: mid filter count': "traversal(V(), out('E'), has('k', 3), out('E'), count())",
  'hop3: values': "traversal(V(), out('E'), out('E'), out('E'), values('k'))",
  'hop3: count': "traversal(V(), out('E'), out('E'), out('E'), count())",
  'hop3: dedupe count': "traversal(V(), out('E'), out('E'), out('E'), dedupe(), count())",
  'agg: values sum': "traversal(V(), values('k'), sum())",
  'agg: hop values sum': "traversal(V(), out('E'), values('k'), sum())",
  'agg: groupCount cfg': "traversal(V(), groupCount({ by: 'k' }))",
  'agg: groupCount mod': "traversal(V(), groupCount().by('k'))",
  'agg: hop groupCount cfg': "traversal(V(), out('E'), groupCount({ by: 'k' }))",
  'agg: hop groupCount mod': "traversal(V(), out('E'), groupCount().by('k'))",
  'agg: hop2 groupCount mod': "traversal(V(), out('E'), out('E'), groupCount().by('k'))",
  'seed: V(id) values': "traversal(V('v7'), values('k'))",
  'seed: V(id) hop count': "traversal(V('v7'), out('E'), count())",
  'seed: hasId values': "traversal(V(), hasId('v7'), values('k'))",
  'seed: hasId hop count': "traversal(V(), hasId('v7'), out('E'), count())",
  'edge: E count': 'traversal(E(), count())',
  'edge: E values': "traversal(E(), values('w'))",
  'edge: outE count': "traversal(V(), outE('E'), count())",
  // ⚠️ THE EDGE-PROPERTY FILTER FAMILY, added at item 1882 because the screen had no row for it and
  // item 1881 consequently nominated one of these shapes as "already fused" when it is not. An edge
  // predicate between a hop's two halves (`outE(L).has(w, …).inV()`) is an entirely ordinary
  // traversal and the single biggest absolute on the Gremlin workload screen.
  'edgef: outE has inV values': "traversal(V(), outE('E'), has('w', gt(3)), inV(), values('k'))",
  'edgef: outE has inV count': "traversal(V(), outE('E'), has('w', gt(3)), inV(), count())",
  'edgef: outE has count': "traversal(V(), outE('E'), has('w', gt(3)), count())",
  'edgef: outE has values': "traversal(V(), outE('E'), has('w', gt(3)), values('w'))",
  'edgef: outE eq inV values': "traversal(V(), outE('E'), has('w', 3), inV(), values('k'))",
  'edgef: inE has outV values': "traversal(V(), inE('E'), has('w', gt(3)), outV(), values('k'))",
  'edgef: bothE has otherV count': "traversal(V(), bothE('E'), has('w', gt(3)), otherV(), count())",
  'edgef: outE inV values': "traversal(V(), outE('E'), inV(), values('k'))",
  // ⚠️ THE LIST-SHAPED AND SIDE-EFFECT FAMILY, added at item 1909. Item 1898 added
  // `aggregate`+`cap` to the WORKLOAD screen and it came out the largest shape that is NOT
  // path-gated (123 ms for ONE row of 800,000 elements) — but nothing asked which ROUTE it takes,
  // and the isolated split says the side effect is only 1.09x `fold`: the cost is collecting
  // 800,000 elements into one list, where the same hop with NO projection is 4.48 ms.
  // ⚠️ `scan: fold` above is FLAT (item 1585, `values(k).fold()`); these fold ELEMENTS after a HOP,
  // which is a different shape and was never screened.
  'list: hop fold': "traversal(V(), out('E'), fold())",
  'list: hop values fold': "traversal(V(), out('E'), values('k'), fold())",
  'list: hop aggregate cap': "traversal(V(), out('E'), aggregate('x'), cap('x'))",
  'list: hop store cap': "traversal(V(), out('E'), store('x'), cap('x'))",
  'list: hop count': "traversal(V(), out('E'), count())",

  // ⚠️ THE DEDUPED-VALUES FAMILY, added at item 1899, and the rows exist because that item's bug was
  // INVISIBLE to a screen keyed on answers: `byKey` tested `typeof by === 'string'` where the AST
  // holds `{kind: 'key'}`, so the `by` spelling silently kept the generic pipeline at 4.4x the fused
  // one while every test passed. ⚠️ BOTH SPELLINGS GET A ROW — they are one question and must route
  // alike — and the near misses are here beside them: a differing `by` key, a labelled dedupe and a
  // multi-key projection are each a DIFFERENT question and must stay generic.
  'ded: values then dedupe': "traversal(V(), out('E'), values('k'), dedupe())",
  'ded: dedupe by then values': "traversal(V(), out('E'), dedupe().by('k'), values('k'))",
  'ded: in values then dedupe': "traversal(V(), in_('E'), values('k'), dedupe())",
  'ded: deduped then limit': "traversal(V(), out('E'), values('k'), dedupe(), limit(3))",
  'ded: by key differs': "traversal(V(), out('E'), dedupe().by('k'), values('w'))",
  'ded: labelled dedupe': "traversal(V(), out('E'), dedupe('x'), values('k'))",
  'ded: multi key values': "traversal(V(), out('E'), values('k', 'w'), dedupe())",

  // ⚠️ THE OPTIONAL FAMILY, added at item 1884 — the screen had no `optional` row either, and the
  // left-join idiom was the workload screen's largest shape once item 1883 landed. `optional-hop.ts`
  // fuses the STEP (items 1480/1483/1628); these rows ask whether the PLAN is fused.
  'opt: optional values': "traversal(V(), optional(traversal(out('E'))), values('k'))",
  'opt: optional id': "traversal(V(), optional(traversal(out('E'))), id())",
  'opt: optional bare': "traversal(V(), optional(traversal(out('E'))))",
  'opt: optional count': "traversal(V(), optional(traversal(out('E'))), count())",
  'opt: optional two hops': "traversal(V(), optional(traversal(out('E'), out('E'))), values('k'))",
  /*
   * ⚠️⚠️ **THE RECONVERGING FAMILIES HAD NO CENSUS ROWS AT ALL** until item 2028, despite gaining
   * rungs at items 1998 (`coalesce`), 1999 and 2014 (`choose`) and 2015 (`branch`). A rung with no
   * route row cannot have its gaps seen — which is how item 2027's `count` gap sat unapplied in the
   * `optional` rung for ~70 items after the edge-filter rung closed it at 1956. The `count` column
   * is the one that found that, so every family gets one.
   */
  'coal: two hops values':
    "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), values('k'))",
  'coal: two hops id': "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), id())",
  'coal: two hops bare': "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))))",
  'coal: two hops count':
    "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), count())",
  'cho: filter two hops values':
    "traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))), values('k'))",
  'cho: filter two hops bare':
    "traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))))",
  'cho: filter two hops count':
    "traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))), count())",
  'cho: hop test consts': "traversal(V(), choose(traversal(out('E')), values('k'), constant('x')))",
  'cho: hop test consts count':
    "traversal(V(), choose(traversal(out('E')), values('k'), constant('x')), count())",
  'br: two options':
    "traversal(V(), branch(traversal(values('k'))).option(3, traversal(out('E'))).option(5, traversal(in_('E'))).none(traversal(identity())))",
  /*
   * ⚠️⚠️ **THESE THREE RUNGS HAD NO ROW ANYWHERE UNTIL ITEM 2046**, which a V8-coverage audit found
   * mechanically: of 37 exported Gremlin rungs, 40 benchmark shapes entered only 30. `allHopExistence`
   * and `hopExistenceCombinedStep` (sub-plan-existence.ts, the and/or/not forms — the bare `where`
   * was covered) and `twoHopDenseShape` (count-shortcut.ts, reachable only via the COUNT form) were
   * never executed by any screen or census. Item 1870 is why that matters: a 678x regression sat in a
   * shipped rung invisibly because nothing asserted it still claimed its shape.
   */
  'exist: and two hops':
    "traversal(V(), and(traversal(out('E')), traversal(out('F'))), values('k'))",
  'exist: or two hops': "traversal(V(), or(traversal(out('E')), traversal(out('F'))), values('k'))",
  'exist: not one hop': "traversal(V(), not(traversal(out('E'))), values('k'))",
  'exist: where and count':
    "traversal(V(), where(and(traversal(out('E')), traversal(out('F')))), count())",
  'dense: two hop count': "traversal(V(), out('E'), out('E'), count())",
  'dense: mixed type count': "traversal(V(), out('E'), out('F'), count())",
  'resid: hop order': "traversal(V(), out('E'), values('n'), order())",
  'resid: hop fold': "traversal(V(), out('E'), values('n'), fold())",
  'resid: hop max': "traversal(V(), out('E'), values('n'), max())",
  'resid: optional order': "traversal(V(), optional(traversal(out('E'))), values('n'), order())",
  'resid: optional fold': "traversal(V(), optional(traversal(out('E'))), values('n'), fold())",
  'resid: optional max': "traversal(V(), optional(traversal(out('E'))), values('n'), max())",
  'resid: coalesce order':
    "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), values('n'), order())",
  'resid: coalesce fold':
    "traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), values('n'), fold())",
  'resid: choose order':
    "traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))), values('n'), order())",
  'br: two options count':
    "traversal(V(), branch(traversal(values('k'))).option(3, traversal(out('E'))).option(5, traversal(in_('E'))).none(traversal(identity())), count())",
};

const IMPORTS =
  "import { E, V, aggregate, both, bothE, cap, count, dedupe, fold, groupCount, gt, has, hasId, hasLabel, id, inE, inV, in_, limit, min, optional, order, otherV, out, outE, outV, store, and, branch, choose, coalesce, constant, fold, identity, max, not, or, order, sum, toArray, traversal, values, where } from '@lenke/gremlin';";

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerInDist = () =>
  readFileSync(`${ROOT}/packages/gremlin/dist/esm/index.mjs`, 'utf8').includes(MARKER);

const measure = (src) => {
  /*
   * ⚠️⚠️ **MIXED=1 APPENDS ONE ISOLATED OFF-LABEL VERTEX** (item 2036). Gremlin's
   * `dropVacuousLabels` REMOVES a vacuous `hasLabel` step from the plan, so one vertex lacking the
   * label makes the step SURVIVE — and a rung whose gate expects an exact step shape may then
   * decline. That would be a ROUTE cliff, which only a census can see. NO Gremlin fixture in this
   * repo has ever been label-mixed; on the GQL side the same blindness hid 7.47x (item 2032).
   *
   * ⚠️ THE PROSE LIVES OUT HERE, NOT IN THE GENERATED SOURCE: the fixture is a template literal, so
   * a backticked identifier inside it terminates the template. `node --check` caught that.
   */
  const MIXED = process.env.MIXED === '1';
  const code = `
import { Graph } from '@lenke/core';
${IMPORTS}
const N = 2000;
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['T'], properties: { k: i % 7, s: 's' + (i % 7) } });
}
${MIXED ? "g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { k: -1, s: 'off' } });" : ''}
for (let i = 0; i < N; i += 1) {
  g.addEdge({ id: 'e' + i, from: g.getVertexById('v' + i), to: g.getVertexById('v' + ((i * 7 + 3) % N)), labels: ['E'], properties: { w: [1, 2, 3, 4, 5, 7, 9][i % 7] } });
}
globalThis.${MARKER} = [];
toArray(${src}, g);
const kinds = [...new Set(globalThis.${MARKER})].sort();
process.stdout.write(JSON.stringify({ calls: globalThis.${MARKER}.length, kinds }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', code], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

copyFileSync(SRC, PRISTINE);

try {
  const s = readFileSync(PRISTINE, 'utf8');

  if (s.split(ANCHOR).length - 1 !== 1) {
    throw new Error('applyStep anchor not found exactly once — the probe needs updating');
  }

  writeFileSync(
    SRC,
    s.replace(
      `${ANCHOR}
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {`,
      `${ANCHOR}
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  const ${MARKER}_sink = (globalThis as Record<string, unknown>).${MARKER};

  if (Array.isArray(${MARKER}_sink)) {
    ${MARKER}_sink.push(step.kind);
  }
`,
    ),
  );
  build();

  if (!markerInDist()) {
    throw new Error('ARM ASSERTION FAILED: the instrumented build does not carry the marker');
  }

  console.log('# gremlin-route-screen — `applyStep` calls mean the GENERIC pipeline ran\n');
  console.log('# 0 calls = a whole-plan shortcut answered it\n');

  const rows = [];

  for (const [name, src] of Object.entries(SHAPES)) {
    const r = measure(src);

    rows.push([name, r]);
    console.log(
      `  ${r.calls === 0 ? 'SHORTCUT' : 'generic '}  ${name.padEnd(24)} ${String(r.calls).padStart(7)} applyStep call(s)${r.kinds.length > 0 ? `   [${r.kinds.join(' ')}]` : ''}`,
    );
  }

  // Siblings that disagree: same base, one fused and one not.
  const byBase = new Map();

  for (const [name, r] of rows) {
    const [base] = name.split(':');

    byBase.set(base, [...(byBase.get(base) ?? []), [name, r.calls === 0]]);
  }

  const split = [...byBase].filter(([, v]) => new Set(v.map(([, fused]) => fused)).size > 1);

  console.log(
    '\n# bases whose shapes DISAGREE on the route (a fused sibling beside a generic one):',
  );

  for (const [base, v] of split) {
    console.log(
      `  ${base}: ${v.map(([n, fused]) => `${n.split(': ')[1]}=${fused ? 'fused' : 'generic'}`).join(', ')}`,
    );
  }

  console.log(
    '\n# ⚠️ A generic route is NOT a defect on its own — most steps have no shortcut and never ' +
      'will. The candidates are the DISAGREEMENTS above, and each still needs pricing against its ' +
      'own sibling before it is a finding (item 1854: a route difference is not always a cost one).',
  );
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('# restored and rebuilt');
}
