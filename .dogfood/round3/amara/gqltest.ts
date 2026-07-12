import { createEmptyGraph, createStore } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';
const backend = createFfiBackend(
  '/home/shawn/projects/pl-graph/crates/lenke-core/target/release/liblenke_core.so',
);
const store = createStore(createEmptyGraph(backend));
store.mutate((g) =>
  g.query('INSERT (:Card {id: $id, title: $t, col: $c})', { id: 'a', t: 'Design API', c: 'todo' }),
);
store.mutate((g) =>
  g.query('INSERT (:Card {id: $id, title: $t, col: $c})', { id: 'b', t: 'Write tests', c: 'todo' }),
);
// move a -> doing
store.mutate((g) =>
  g.query('MATCH (c:Card {id: $id}) SET c.col = $col', { id: 'a', col: 'doing' }),
);
console.log(
  store.graph.query(
    'MATCH (c:Card) RETURN c.id AS id, c.title AS title, c.col AS col ORDER BY c.id',
  ),
);
// ndjson roundtrip
const nd = store.graph.toNdjson();
console.log('ndjson bytes', nd.length);
