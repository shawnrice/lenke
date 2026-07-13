// Scenario 3 — reconnect / resume correctness.
//
// Part 1: clean reconnect — A drops, B writes while A is down, A re-dials and
//         catches up EXACTLY once (no drop, no double).
// Part 2 (crown-jewel hunt): A's OWN write commits server-side but its ack +
//         cursor-tick are lost (socket cut mid-response). A reconnects to a
//         FRESH host (new origin id). Does origin-skip still hold across the
//         reconnect, or does A re-ingest its own write (double-apply)?
import { newServer, connect, cardCount, cards, settle } from './lib.ts';

const log = (...a: unknown[]) => console.log(...a);

// ---------------------------------------------------------------- Part 1
{
  log('=== Part 1: clean reconnect catch-up ===');
  const server = newServer();
  const A = connect(server, 'A');
  const B = connect(server, 'B');

  A.engine.mutate('INSERT (:Card {id: $id})', { id: 'c1' });
  await settle();
  log(
    'before cut: A',
    cardCount(A.local),
    'B',
    cardCount(B.local),
    'server',
    cardCount(server.store),
  );

  // A's socket drops (both directions).
  A.toHost.cut();
  A.fromHost.cut();

  // B writes twice while A is offline.
  B.engine.mutate('INSERT (:Card {id: $id})', { id: 'c2' });
  B.engine.mutate('INSERT (:Card {id: $id})', { id: 'c3' });
  await settle();
  log('while A offline: server', cardCount(server.store), 'A(stale)', cardCount(A.local));

  // A re-dials.
  A.reconnect();
  await settle();
  log('after A reconnect: A', cardCount(A.local), '(expect 3)');
  log(
    '  A cards:',
    cards(A.local).map((c) => c.id),
  );
  const p1 = cardCount(A.local) === 3;
  log('  Part 1:', p1 ? 'PASS' : 'FAIL — dropped or double-applied a write');
}

// ---------------------------------------------------------------- Part 2
{
  log('\n=== Part 2: own-write lost-ack reconnect (origin-skip across reconnect) ===');
  const server = newServer();
  const A = connect(server, 'A');
  const B = connect(server, 'B');
  void B;

  log('before: A', cardCount(A.local), 'server', cardCount(server.store));

  // Cut ONLY host->client so A's write reaches+commits on the server, but A
  // never receives the ack nor the CDC cursor-tick for its own write. A's write
  // cursor stays behind; the write stays "pending/unacked" on A.
  A.fromHost.cut();

  A.engine.mutate('INSERT (:Card {id: $id})', { id: 'x1' }); // applied optimistically on A.local
  await settle();
  log('after A writes x1 with fromHost cut:');
  log('  A.local cards :', cardCount(A.local), '(optimistic = 1)');
  log('  server cards  :', cardCount(server.store), '(committed = 1)');

  // Now A reconnects to a FRESH host (new origin id) and replays.
  A.toHost.cut();
  A.reconnect();
  await settle();

  log('after A reconnect + replay:');
  log('  server cards :', cardCount(server.store), '(expect 1 — dedup blocks re-apply)');
  log('  A.local cards:', cardCount(A.local), '(expect 1 — must NOT re-ingest own write)');
  log(
    '  A.local ids  :',
    cards(A.local).map((c) => c.id),
  );

  const p2server = cardCount(server.store) === 1;
  const p2client = cardCount(A.local) === 1;
  log('  server exactly-once:', p2server ? 'PASS' : 'FAIL');
  log('  client no-double   :', p2client ? 'PASS' : 'FAIL — A re-ingested its OWN write via CDC');
}
