import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  values,
  repeat,
  loops,
  is,
  eq,
  gt,
  pipe,
  toArray,
} from '@lenke/gremlin';

// Byte-identity check: does the native (Rust) gremlin engine share the same
// until()/loops() divergence as the TS engine? If yes, it is a shared
// divergence FROM TinkerPop (not a TS-vs-native bug).
import { createFfiBackend } from '../../../packages/native/src/backend-ffi.js';
import { createTestTinkerGraph } from './util.ts';

const LIB = new URL('../../../crates/lenke-core/target/release/liblenke_core.so', import.meta.url)
  .pathname;
const backend = createFfiBackend(LIB);
const MODERN_NDJSON = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}',
].join('\n');

const dec = new TextDecoder();
function native(groovy: string): unknown[] {
  const h = backend.graphFromNdjson(new TextEncoder().encode(MODERN_NDJSON), false);
  try {
    return JSON.parse(dec.decode(backend.gremlinJson(h, groovy))) as unknown[];
  } finally {
    backend.graphFree(h);
  }
}

const g = createTestTinkerGraph();
function ts(plan: unknown): unknown[] {
  return (toArray as any)(plan, g);
}
const norm = (a: unknown[]) =>
  JSON.stringify([...a].map((x: any) => x?.properties?.name ?? x).sort());

const cases: { name: string; groovy: string; plan: unknown; tp: string }[] = [
  {
    name: 'repeat(out).until(loops.is(eq(2)))  [TP=2hop lop,ripple]',
    groovy: "g.V('1').repeat(out()).until(loops().is(eq(2))).values('name')",
    plan: traversal(V('1'), repeat(out()).until(pipe(loops(), is(eq(2)))), values('name')),
    tp: '["lop","ripple"]',
  },
  {
    name: 'repeat(out).until(loops.is(eq(1)))  [TP=1hop josh,lop,vadas]',
    groovy: "g.V('1').repeat(out()).until(loops().is(eq(1))).values('name')",
    plan: traversal(V('1'), repeat(out()).until(pipe(loops(), is(eq(1)))), values('name')),
    tp: '["josh","lop","vadas"]',
  },
  {
    name: 'repeat(outE?).until(hasLabel PERSON) start satisfies  [TP=josh,vadas]',
    groovy: "g.V('1').repeat(out('KNOWS')).until(hasLabel('PERSON')).values('name')",
    plan: traversal(V('1'), repeat(out('KNOWS')).until(hasLabel('PERSON')), values('name')),
    tp: '["josh","vadas"]',
  },
  {
    name: 'repeat(out).times(2)  [TP=2hop lop,ripple] (control)',
    groovy: "g.V('1').repeat(out()).times(2).values('name')",
    plan: traversal(V('1'), repeat(out()).times(2), values('name')),
    tp: '["lop","ripple"]',
  },
];

console.log('name | native | ts | TinkerPop-expected | native==ts | matches-TP');
for (const c of cases) {
  let nat: string, tsr: string;
  try {
    nat = norm(native(c.groovy));
  } catch (e: any) {
    nat = 'THROW:' + e.message;
  }
  try {
    tsr = norm(ts(c.plan));
  } catch (e: any) {
    tsr = 'THROW:' + e.message;
  }
  console.log(`\n${c.name}`);
  console.log(`  native:   ${nat}`);
  console.log(`  ts:       ${tsr}`);
  console.log(`  TinkerPop:${c.tp}`);
  console.log(`  native==ts: ${nat === tsr}   matches-TP: ${nat === c.tp}`);
}
