// Scenario 5 — robustness of the ingest path + interest routing.
//  (a) interest routing narrows: a :Card-only watcher does not receive :Note CDC.
//  (b) a single poison write in a CDC batch throws OUT of client.receive() — with
//      no per-write isolation, and (no transactions) leaves a partial apply.
//  (c) schema-not-replicated: a client whose local store lacks a constraint that
//      the server has crashes when it ingests a write that's valid on the server.
import { createStore, createEmptyGraph, type Store } from '@lenke/native';
import { createSyncClient, createSyncEngine, createWriteLog } from '@lenke/sync';

import { newServer, connect, settle, backend } from './lib.ts';

const log = (...a: unknown[]) => console.log(...a);
const items = (s: Store, label: string) =>
  s.mutate((g) => g.query<{ c: number }>(`MATCH (n:${label}) RETURN count(*) AS c`)[0].c);

// ---------------------------------------------------------------- (a)
{
  log('=== (a) interest routing narrows by live-query deps ===');
  const server = newServer();
  const A = connect(server, 'A');
  const B = connect(server, 'B');
  const bGotCard: string[] = [];
  // Re-point B's CDC handler so we can observe what actually arrives.
  // (connect() already wired ingest; issue a live query so B's host has deps.)
  B.client.liveQuery('MATCH (c:Card) RETURN c.id', { deps: ['Card'] }).subscribe(() => {});
  await settle();

  // A writes a Note (a label B does not watch) and a Card (a label B watches).
  A.engine.mutate('INSERT (:Note {id: $id})', { id: 'n1' });
  A.engine.mutate('INSERT (:Card {id: $id})', { id: 'k1' });
  await settle();
  void bGotCard;
  log('  B.local Cards:', items(B.local, 'Card'), '(expect 1 — Card is of interest)');
  log('  B.local Notes:', items(B.local, 'Note'), '(expect 0 — Note filtered by interest routing)');
  const ok = items(B.local, 'Card') === 1 && items(B.local, 'Note') === 0;
  log('  ', ok ? 'PASS — routing filtered the Note write' : 'FAIL');
}

// ---------------------------------------------------------------- (b)
{
  log('\n=== (b) a poison write in a CDC batch throws out of receive() ===');
  const local = createStore(createEmptyGraph(backend));
  const engine = createSyncEngine({ store: local });
  const client = createSyncClient({ send: () => {} });
  client.subscribeWrites((writes) => engine.ingest(writes));

  let threw: string | null = null;
  try {
    client.receive({
      type: 'writes',
      cursor: 1,
      writes: [{ text: 'INSERT (:Item {id: 1})' }, { text: 'THIS IS NOT GQL' }],
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  log('  receive() threw:', threw ?? '(no)');
  log(
    '  local Items after poison batch:',
    items(local, 'Item'),
    '(0 = atomic rollback, 1 = partial apply)',
  );
  log(
    '  ',
    threw
      ? 'FINDING — one bad replicated write escapes receive(); no per-write isolation'
      : 'handled internally',
  );
}

// ---------------------------------------------------------------- (c)
{
  log('\n=== (c) schema not replicated: constraint mismatch crashes ingest ===');
  // Server + a well-formed client both have the Card constraint (from newServer/connect).
  const server = newServer();
  const good = connect(server, 'good');

  // A malformed client: local store WITHOUT the Card unique constraint.
  const localGraph = createEmptyGraph(backend); // NO installSchema
  const local = createStore(localGraph);
  const engine = createSyncEngine({ store: local });
  const wl = createWriteLog();
  void wl;
  const client = createSyncClient({ send: (m) => badHost.receive(m) });
  const badHost = server.host((m) => client.receive(m));
  let ingestThrew: string | null = null;
  client.subscribeWrites((writes) => {
    try {
      engine.ingest(writes);
    } catch (e) {
      ingestThrew = (e as Error).message;
      throw e;
    }
  });
  await settle();

  // The good client _MERGEs presence (valid: server has the constraint).
  good.engine.mutate('_MERGE (p:Presence {sid: $s})', { s: 'good' });
  // And inserts two Cards with the same id via two writes — fine on the constrained
  // server/good-client, but on the bad client (no constraint) it just... both apply.
  good.engine.mutate('INSERT (:Card {id: $id})', { id: 'dup' });
  await settle();

  log('  bad-client ingest threw:', ingestThrew ?? '(no)');
  log('  bad-client Presence:', items(local, 'Presence'), '  Card:', items(local, 'Card'));
  log('  FINDING — schema (constraints/indexes) is NOT part of CDC; each store must');
  log('           mirror it out-of-band or replicated writes behave differently / crash.');
}
