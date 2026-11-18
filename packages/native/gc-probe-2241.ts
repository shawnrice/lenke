/** Reduces item 2241's `values().groupCount()` cross-engine divergence to six vertices and three teams. */
import { Graph as TsGraph } from '@lenke/core';
import { V, groupCount, hasLabel, planToGremlin, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';

const N = 6;
const doc = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 3}}}`,
).join('\n');

const LIB = new URL('../../crates/lenke-engine/target/release/liblenke_engine.so', import.meta.url)
  .pathname;
const backend = createFfiEngineBackend(LIB);
const g = tsDeserialize(doc, 'ndjson', new TsGraph());
const h = backend.graphFromNdjson(new TextEncoder().encode(doc));

for (const [name, plan] of [
  ['values groupCount', traversal(V(), hasLabel('User'), values('team'), groupCount())],
  ['groupCount (no values)', traversal(V(), hasLabel('User'), groupCount())],
  ['values only', traversal(V(), hasLabel('User'), values('team'))],
] as const) {
  const text = planToGremlin(plan);

  console.log(`  --- ${name} ---`);
  console.log(`      rendered: ${text}`);
  const tsRows = toArray(plan, g);
  const shown = tsRows.map((r) =>
    r instanceof Map
      ? `Map(${r.size}){${[...r].map(([k, v]) => `${String(k)}=>${String(v)}`).join(',')}}`
      : JSON.stringify(r),
  );

  console.log(`      ts  : ${shown.join(' ')}   (ctor: ${tsRows[0]?.constructor?.name ?? 'n/a'})`);
  console.log(`      ffi : ${new TextDecoder().decode(backend.gremlinJson(h, text))}`);
}

backend.graphFree(h);
