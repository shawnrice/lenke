// Scenario 1 — basic 2-client kanban propagation via CDC.
// A adds a card → B sees it in its OWN optimistic store via the write stream.
import { newServer, connect, cardCount, cards, settle } from './lib.ts';

const log = (...a: unknown[]) => console.log(...a);

const server = newServer();
const A = connect(server, 'A');
const B = connect(server, 'B');

log('initial: server', cardCount(server.store), 'A', cardCount(A.local), 'B', cardCount(B.local));

// A creates a card.
A.engine.mutate('INSERT (:Card {id: $id, title: $t, column: $c})', {
  id: 'c1',
  t: 'Write findings',
  c: 'todo',
});
await settle();

log('after A insert c1:');
log('  server cards:', cards(server.store));
log('  A cards     :', cards(A.local));
log('  B cards     :', cards(B.local));

// B creates a card.
B.engine.mutate('INSERT (:Card {id: $id, title: $t, column: $c})', {
  id: 'c2',
  t: 'Fix bug',
  c: 'doing',
});
await settle();

log('after B insert c2:');
log('  server:', cardCount(server.store), 'A:', cardCount(A.local), 'B:', cardCount(B.local));

// Move a card: A moves c2 (created by B) to done.
A.engine.mutate('MATCH (c:Card {id: $id}) SET c.column = $col', { id: 'c2', col: 'done' });
await settle();

const colOf = (s: import('@lenke/native').Store, id: string) =>
  (
    s.mutate((g) => g.query('MATCH (c:Card {id:$id}) RETURN c.column AS col', { id })) as {
      col: unknown;
    }[]
  )[0]?.col;

log('after A moves c2 -> done:');
log('  server c2.column:', colOf(server.store, 'c2'));
log('  A c2.column     :', colOf(A.local, 'c2'));
log('  B c2.column     :', colOf(B.local, 'c2'));

const ok =
  cardCount(server.store) === 2 &&
  cardCount(A.local) === 2 &&
  cardCount(B.local) === 2 &&
  colOf(B.local, 'c2') === 'done';
log('\nRESULT:', ok ? 'PASS — all three stores converged' : 'FAIL — divergence');
