// Doc-accuracy probes: copy-paste guide examples verbatim + inspect errors.
import { Graph } from '@lenke/node';
import { createNodeBackend } from '@lenke/node/backend';
import { graphFromNdjson, createStore } from '@lenke/native';
import { buildNdjson } from './seed.mjs';

const ndjson = buildNdjson({ users: 20, seed: 1 });

// --- A) @lenke/node README "raw Graph class" example, verbatim shape ---
console.log('--- A) raw Graph class (README lines 13-19) ---');
const g = Graph.fromNdjson(Buffer.from(ndjson));
const doc = JSON.parse(new TextDecoder().decode(g.query('MATCH (p:Person) RETURN p.name')));
console.log('query() ->', JSON.stringify(doc).slice(0, 80), '...');
const arrow = g.queryArrow('MATCH (p:Person) RETURN p.accountAgeDays');
console.log('queryArrow() -> Buffer', arrow.length, 'bytes, first4=', new TextDecoder().decode(arrow.subarray(0, 4)));
// README: mergeNdjson returns a Buffer of JSON you JSON.parse yourself
const mr = JSON.parse(new TextDecoder().decode(g.mergeNdjson(Buffer.from(ndjson))));
console.log('raw mergeNdjson JSON ->', JSON.stringify(mr).slice(0, 80));

// --- B) backend-embedded README "Lifecycle" snippet, verbatim ---
console.log('\n--- B) backend-embedded lifecycle (guide lines 11-28) ---');
const backend = createNodeBackend();
const store = createStore(graphFromNdjson(backend, ndjson));
const r = store.graph.query`MATCH (p:Person) WHERE p.uid = ${'u1'} RETURN p.name`;
console.log('store.graph.query ->', JSON.stringify(r));
// guide: store.mutate((g) => g.query`INSERT ...`)
store.mutate((gg) => gg.query`INSERT (:Person {uid: ${'zzz'}, name: ${'new'}})`);
console.log('after mutate vertexCount =', store.graph.vertexCount);
store[Symbol.dispose]?.();

// --- C) error object shape (structured fields?) ---
console.log('\n--- C) error shapes ---');
const g2 = graphFromNdjson(backend, ndjson);
for (const [label, q, params] of [
  ['syntax', 'MATCH (p:Person RETURN p.name', undefined],
  ['unknown-fn', 'MATCH (p:Person) RETURN nope(p.name)', undefined],
  ['missing-param', 'MATCH (p:Person {uid: $x}) RETURN p.name', undefined],
]) {
  try {
    g2.query(q, params);
  } catch (e) {
    console.log(`${label}: name=${e.constructor.name} code=${JSON.stringify(e.code)} pos=${JSON.stringify(e.pos)}`);
    console.log(`  ownKeys=${JSON.stringify(Object.getOwnPropertyNames(e).filter((k) => k !== 'stack'))}`);
  }
}
g2.free();
console.log('\nprobe done');
