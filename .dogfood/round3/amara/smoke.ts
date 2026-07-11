import { createFfiBackend } from '@lenke/native/ffi';
import { createEmptyGraph, createStore } from '@lenke/native';
import { createSyncHost, createSyncClient } from '@lenke/sync';

const LIB = '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so';
const backend = createFfiBackend(LIB);
const g = createEmptyGraph(backend);
const store = createStore(g);
store.mutate((gr) => gr.query("INSERT (:Card {id: '1', title: 'hello', col: 'todo'})"));
console.log('vertexCount', store.graph.vertexCount);
const rows = store.graph.query("MATCH (c:Card) RETURN c.title AS title");
console.log('rows', rows);
console.log('OK bun version', Bun.version);
