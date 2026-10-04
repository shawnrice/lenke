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
  planToGremlin,
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
  ['V().out().count()', traversal(V(), out('KNOWS'), count())],
  ['V().out().values(age)', traversal(V(), out('KNOWS'), values('age'))],
  ['V().out().has().count()', traversal(V(), out('KNOWS'), has('age', gt(44)), count())],
  ['V().groupCount(age)', traversal(V(), groupCount({ by: 'age' }))],
  ['V().out().dedupe().count()', traversal(V(), out('KNOWS'), dedupe(), count())],
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
