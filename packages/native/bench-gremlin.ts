// The cross-engine bench has no GREMLIN rows at all, so the TS Gremlin engine —
// a separate implementation of the repo's second surface language, with its own
// executor and steps — has never been measured against native. Every
// optimization of this pass (audit items 112-129) was GQL-only.
//
// Same fixture and shapes as the GQL bench, expressed as traversals. The TS side
// runs a builder plan through `toArray`; native takes the same plan serialized by
// `planToGremlin`, so both engines answer the identical query.
//
//   cd packages/native && bun run bench:gremlin
//   PROBE_N=50000 bun run bench:gremlin
//
// The answers column is a sanity check, not a conformance gate — it truncates, and
// the differential fuzzer (`bun run fuzz gremlin`) is what actually compares the
// two engines. Three harness traps, each of which cost a round here: `groupCount`
// takes a CONFIG OBJECT (`{ by }`), a Map needs converting before
// `JSON.stringify`, and `@lenke/gremlin` is a BUILT DIST, so a source edit needs
// `nx build @lenke/gremlin` first.
import { Graph as TsGraph } from '@lenke/core';
import {
  E,
  V,
  count,
  dedupe,
  groupCount,
  eq,
  gt,
  has,
  hasLabel,
  id,
  order,
  out,
  planToGremlin,
  repeat,
  toArray,
  traversal,
  values,
  within,
} from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const LIB = new URL('../../crates/lenke-engine/target/release/liblenke_engine.so', import.meta.url)
  .pathname;
const N = Number(process.env.PROBE_N ?? 200_000);
const REPS = Number(process.env.PROBE_REPS ?? 5);

const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N * 5; k++) {
  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${(k * 104_729) % N}","properties":{"w":${k % 7}}}`,
  );
}

const doc = lines.join('\n');
const backend = createFfiEngineBackend(LIB);
const tsG = tsDeserialize(doc, 'ndjson', new TsGraph());
const natG = graphFromNdjson(backend, doc);

const SHAPES: [string, Plan][] = [
  ['V().count()', traversal(V(), count())],
  ['V().hasLabel.count()', traversal(V(), hasLabel('Person'), count())],
  ['V().has(age,gt).count()', traversal(V(), has('age', gt(44)), count())],
  ['E().count()', traversal(E(), count())],
  // ADDED AT ITEM 877. This row did not exist, which is why a 89,800x gap went unmeasured:
  // `E().hasLabel(T).count()` lowers to `Aggregate{Filter{EdgeScan, IsLabeled}}`, which no
  // fast path claimed, while GQL's `MATCH ()-[:T]->() RETURN count(*)` answered the same
  // question from a CSR partition length. Keep both — the unlabelled row above cannot see it.
  ['E().hasLabel().count()', traversal(E(), hasLabel('KNOWS'), count())],
  ['V().out().count()', traversal(V(), out('KNOWS'), count())],
  ['V().out().values(age)', traversal(V(), out('KNOWS'), values('age'))],
  // ADDED AT ITEM 881, for the reason item 877 records: the corpus had no BARE-hop row, so a
  // 2.23x gap sat unmeasured. `V().out()` and `V().out().id()` had no fused walk while
  // `V().out().values(k)` did, which made ADDING a step 1.9x faster (item 880). The
  // `.count()` row above cannot see it — that one is answered by a shortcut.
  //
  // ⚠️ THE `[bare]` ROW'S ts/native RATIO IS NOT LIKE-FOR-LIKE (item 882). It reads ~0.6, i.e.
  // native "slower", and that is a difference in what the two RETURN rather than in how fast they
  // are: TS hands back references to vertices already in its graph, while native materializes an
  // OWNED element value per row — external id, sorted labels and a property map. Measured in
  // process (no FFI), native is 266.98 ms for 1,000,000 elements against 4.95 for the same rows as
  // a property, and that render loop is already item 828's column-major rewrite with a further
  // hoist REFUTED at item 829. Read this row for regressions in the TS column; the cross-engine
  // ratio on it is a category difference.
  ['V().out() [bare]', traversal(V(), out('KNOWS'))],
  ['V().out().id()', traversal(V(), out('KNOWS'), id())],
  // THE SAME TRAVERSAL WITH A TRAILING STEP (item 608). `hopValuesShortcut` matched a plan of
  // EXACTLY three steps, so this was four and dropped the whole query onto the traverser
  // pipeline. The row above is its reference and its control: a change letting a residual ride
  // the shortcut must move this row and leave that one alone.
  ['V().out().values(age).order()', traversal(V(), out('KNOWS'), values('age'), order())],
  ['V().out().has().count()', traversal(V(), out('KNOWS'), has('age', gt(44)), count())],
  // ⚠️ A FAR FILTER ON A YIELDING HOP, WHICH THIS SWEEP HAD NO ROW FOR (item 1631). The row above
  // is the same filter with `count()`, which a closed-form rung answers without yielding, and
  // `V().out().out().has().values(age)` below is TWO hops; the one-hop yielding shape — the
  // commonest real traversal there is, "walk and keep the far ends that match" — was measured by
  // neither. Its cost is one test per EDGE where a start filter pays one per VERTEX, which is why
  // `start-filtered-hop-values.ts`' header refuting three start-side levers does not settle it.
  //
  // THE PAIR IS ALSO AN EQUIVALENT-COST GUARD. A selective filter must not cost MORE than the
  // unfiltered walk it is a subset of: the cliff finder reported exactly that (188.2 ms for 20,000
  // rows against 132.8 for 999,996) and it turned out to be an instrument artifact, but nothing in
  // the sweep would have caught it had it been real.
  [
    'V().out().has(eq).values(age)',
    traversal(V(), out('KNOWS'), has('age', eq(30)), values('age')),
  ],
  ['V().groupCount(age)', traversal(V(), groupCount({ by: 'age' }))],
  ['V().out().dedupe().count()', traversal(V(), out('KNOWS'), dedupe(), count())],
  // A FILTER CHAIN, which no row here had — and its absence is why item 537's 4-6x was
  // invisible: `countShortcut` answered `V()` plus ONE step and a chain fell to the traverser
  // pipeline at ~40-50 ns a vertex PER STEP. Every vertex carries `Person`, so the label
  // excludes nothing and the pair is an EQUIVALENT-SPELLING guard as much as a perf row: these
  // two ask the same question and must stay close.
  ['V().hasLabel().has().count()', traversal(V(), hasLabel('Person'), has('age', gt(44)), count())],
  // ⚠️ THE PRESENCE FORM, AND ITS ABSENCE IS WHY A 3.0x GAP SURVIVED (item 1283). Every `has` row
  // above passes a VALUE predicate, so none of them exercises `has('k')` with ONE argument — which
  // builds a different step (`{kind:'hasKey'}`) and reached only one of six count rungs. The row
  // read 7.543 ms against the value-predicate form's 2.573 at 200,000 vertices, both keeping every
  // row, and nothing in this file was looking. Same shape as item 1312: the gap survived because
  // the harness had no row for it.
  //
  // KEPT AS A PAIR with the row above, which is the control: they answer different counts but take
  // the same rung, so a change that helps one and not the other shows up here as a split.
  ['V().hasLabel().has(k) [presence]', traversal(V(), hasLabel('Person'), has('age'), count())],
  ['V().has().has().count()', traversal(V(), has('age', gt(44)), has('age', gt(-1)), count())],
  // ITEM 1349's MEMBERSHIP ROW, and it exists for an ANSWER-EQUIVALENT mutant.
  //
  // `within` evaluated its list with `pred.values.some((x) => valueEq(value, x))`, whose arrow
  // CAPTURES `value` and so allocated a closure per ELEMENT. Item 1348 priced the consequence as an
  // equivalent-spelling gap: `has('age', within(1))` cost 8.84 ms against `has('age', 1)`'s 2.27,
  // 3.90x, for a question reaching the same `valueEq` through the same step. Item 1349 replaced it
  // with a named function taking `value` as a parameter: 3.44x on one value, 3.90x on three.
  //
  // Putting `.some()` back is SEMANTICALLY INERT — same comparator, same order, same short-circuit
  // — so all 21 cases in `within-membership.test.ts` and all four mutants pass either way. Only a
  // number can see it, which is item 1177's lesson and the same reason item 1345 shipped a bench
  // row beside its degree gate.
  //
  // READ IT AGAINST THE EQUALITY ROW BELOW, not alone: the claim is PARITY between the two
  // spellings, so the pair diverging is the regression, not either row moving on its own.
  [
    'V().has(k, within(3 vals)).count()',
    traversal(V(), hasLabel('Person'), has('age', within(3, 17, 61)), count()),
  ],
  ['V().has(k, eq) [within ctl]', traversal(V(), hasLabel('Person'), has('age', 3), count())],
  // The ROW-RETURNING twin of the row above, which item 538 is about: a chain tally cannot help
  // a terminal that emits rows, so the fix there was to make a single-label `hasLabel` SEED its
  // bucket and drop the step. Without a row here that is unguarded.
  [
    'V().hasLabel().has().values(age)',
    traversal(V(), hasLabel('Person'), has('age', gt(44)), values('age')),
  ],
  // A START-FILTERED hop count (item 539), the worst cliff this surface had: `V().out().count()`
  // above is an O(1) bucket read and the same question with a VACUOUS label in front of it ran
  // 500,000 traversers. The pair is the equivalent-spelling guard.
  ['V().hasLabel().out().count()', traversal(V(), hasLabel('Person'), out('KNOWS'), count())],
  // Item 574. A CHAIN of hops before `count()` had no rung: TS ran one traverser per path where
  // native answers from degrees. 93.81/97.39/98.04 -> 24.99/31.65/29.85ms over three alternated
  // rounds at 40,000 vertices / 120,000 edges. `repeat(out).times(k)` IS the k-fold chain —
  // TinkerPop 3.7.3 confirms it on a fixture with a self-loop and a parallel pair — so an
  // eligible repeat expands to the chain and takes the same rung: 113.76/110.56/100.61 ->
  // 22.48/28.10/25.05. `times(3)` RAISED "repeat() exceeded the trail budget" before and now
  // answers, because a closed form enumerates nothing.
  //
  // The `emit()` twin is REFUSED (it sums over depths rather than taking the k-fold product) and
  // is deliberately NOT a row here: at this fixture's 1,000,000 edges it raises "repeat()
  // exceeded the traversal budget" on the TS side, where native answers — the
  // budget-bounds-a-count divergence that `times(k)` just escaped and `emit()` has not. A row
  // that always errors measures nothing, so the refusal is pinned in
  // `gremlin-hop-chain-count.test.ts` instead, where both engines answer.
  [
    'V().out().out().count()',
    traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), count()),
  ],
  [
    'V().repeat(out).times(2).count()',
    traversal(V(), hasLabel('Person'), repeat(traversal(out('KNOWS'))).times(2), count()),
  ],
  ['V().has().out().count()', traversal(V(), has('age', gt(44)), out('KNOWS'), count())],
  // THREE AND FOUR HOPS, which no row reached before item 1107. Every chain row above stops at
  // TWO, and two hops from every vertex is answered by the DEGREE INNER PRODUCT (item 590) — one
  // pass over vertices, no edge walk at all. So the arm that carries three hops and up, the
  // per-vertex MULTIPLICITY WALK in `hopChainCount`, had no bench row: the whole `Map<Vertex,
  // number>` propagation and its weighted-degree tail were unpriced.
  //
  // That arm is the Gremlin twin of the GQL way-count sweep item 1106 made 1.69x faster, and it
  // is NOT the same cost: this one keys its frontier by VERTEX OBJECT, with `w` read straight off
  // the edge, where the GQL sweep interns a string id per edge — the lookup item 1105 ablated at
  // 24% of its row. These rows are what says whether the same memo is worth porting.
  [
    'V().out().out().out().count()',
    traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), out('KNOWS'), count()),
  ],
  [
    'V().out()x4.count()',
    traversal(
      V(),
      hasLabel('Person'),
      out('KNOWS'),
      out('KNOWS'),
      out('KNOWS'),
      out('KNOWS'),
      count(),
    ),
  ],
  // ⚠️ TWO HOPS WITH A ROW-RETURNING TAIL, which NO row above reached (item 1614) — and the omission
  // was load-bearing rather than cosmetic. Every multi-hop row in this suite ends in `count()`,
  // which `hopChainCount` answers from degrees without walking at all (item 590), so the two-hop
  // WALK was only ever benched in the arm where it does not run. `V().out().values(age)` above rode
  // a fused walk; adding one `out` dropped the whole query onto the traverser pipeline at **254.6
  // ns a row against the one-hop walk's 25.9**, which `hop-chain-values.ts` now closes at 5.26x.
  //
  // BOTH TAILS, because the one-hop pair above (`values(age)` against `id()`) exists to separate the
  // property read from the walk, and a gap present in both arms is the walk. Here both were on the
  // pipeline and both are now fused.
  [
    'V().out().out().values(age)',
    traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), values('age')),
  ],
  ['V().out().out().id()', traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), id())],
  // ⚠️ THE FILTERED two-hop walk (item 1615), with the two rows above as its control. This shape
  // cost 4.7x its own UNFILTERED neighbour for a fraction of the rows, because it walked every
  // traverser down the pipeline and filtered at the end. Isolated A/B: 79.18 -> 20.27 ms, 3.91x on
  // the trailing position and 2.68x on the middle one.
  [
    'V().out().out().has().values(age)',
    traversal(
      V(),
      hasLabel('Person'),
      out('KNOWS'),
      out('KNOWS'),
      has('age', gt(44)),
      values('age'),
    ),
  ],
  // ⚠️ THREE hops YIELDING (item 1617): the generic stacked walk, where the two-hop rows above take
  // the literal nesting. 394.89 -> 103.79 ms isolated, 3.80x. The `count()` twin above is answered
  // from degrees without walking, so it says nothing about this row.
  [
    'V().out()x3.values(age)',
    traversal(V(), hasLabel('Person'), out('KNOWS'), out('KNOWS'), out('KNOWS'), values('age')),
  ],
  [
    'V().out().has().out().values(age)',
    traversal(
      V(),
      hasLabel('Person'),
      out('KNOWS'),
      has('age', gt(44)),
      out('KNOWS'),
      values('age'),
    ),
  ],
];

/**
 * A Map must be converted before comparing: the TS engine returns one for the
 * grouping steps, and `JSON.stringify(new Map([[3, 2]]))` is `{}` — which reads as
 * "the TS engine produced an empty map" and is purely this harness's fault. It
 * cost a round of chasing a non-bug; the fuzzer uses the conformance suite's
 * `canonJson` for the same reason.
 */
const plain = (x: unknown): unknown => (x instanceof Map ? Object.fromEntries(x) : x);

const timed = (f: () => void): number => {
  let best = Infinity;

  for (let i = 0; i < REPS; i++) {
    const t = performance.now();

    f();
    best = Math.min(best, performance.now() - t);
  }

  return best;
};

console.log(
  `${N} vertices / ${N * 5} edges, min of ${REPS}\n` +
    `${'traversal'.padEnd(28)}${'ts'.padStart(10)}${'native'.padStart(10)}${'ts/nat'.padStart(10)}  answers`,
);

for (const [name, plan] of SHAPES) {
  const text = planToGremlin(plan);
  let ts = Number.NaN;
  let nat = Number.NaN;
  let agree = '';

  try {
    ts = timed(() => void toArray(plan, tsG));
    nat = timed(() => void natG.gremlin(text));

    const a = JSON.stringify(toArray(plan, tsG).map(plain)).slice(0, 48);
    const b = JSON.stringify(natG.gremlin(text)).slice(0, 48);

    agree = a === b ? 'same' : `DIFFER ts=${a} nat=${b}`;
  } catch (e) {
    agree = `ERR ${(e as Error).message.slice(0, 60)}`;
  }

  console.log(
    `${name.padEnd(28)}${ts.toFixed(1).padStart(10)}${nat.toFixed(2).padStart(10)}` +
      `${(ts / Math.max(nat, 0.01)).toFixed(1).padStart(10)}  ${agree}`,
  );
}

natG.free();
