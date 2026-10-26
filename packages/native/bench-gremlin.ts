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
  gt,
  has,
  hasLabel,
  out,
  order,
  planToGremlin,
  repeat,
  toArray,
  traversal,
  values,
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
  // THE SAME TRAVERSAL WITH A TRAILING STEP (item 608). `hopValuesShortcut` matched a plan of
  // EXACTLY three steps, so this was four and dropped the whole query onto the traverser
  // pipeline. The row above is its reference and its control: a change letting a residual ride
  // the shortcut must move this row and leave that one alone.
  ['V().out().values(age).order()', traversal(V(), out('KNOWS'), values('age'), order())],
  ['V().out().has().count()', traversal(V(), out('KNOWS'), has('age', gt(44)), count())],
  ['V().groupCount(age)', traversal(V(), groupCount({ by: 'age' }))],
  ['V().out().dedupe().count()', traversal(V(), out('KNOWS'), dedupe(), count())],
  // A FILTER CHAIN, which no row here had — and its absence is why item 537's 4-6x was
  // invisible: `countShortcut` answered `V()` plus ONE step and a chain fell to the traverser
  // pipeline at ~40-50 ns a vertex PER STEP. Every vertex carries `Person`, so the label
  // excludes nothing and the pair is an EQUIVALENT-SPELLING guard as much as a perf row: these
  // two ask the same question and must stay close.
  ['V().hasLabel().has().count()', traversal(V(), hasLabel('Person'), has('age', gt(44)), count())],
  ['V().has().has().count()', traversal(V(), has('age', gt(44)), has('age', gt(-1)), count())],
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
