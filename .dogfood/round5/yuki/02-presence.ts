// Scenario 2 — presence via _MERGE upsert + ephemeral teardown on disconnect.
import { newServer, connect, presenceCount, presences, settle } from './lib.ts';

const log = (...a: unknown[]) => console.log(...a);
const server = newServer();
const A = connect(server, 'A');
const B = connect(server, 'B');

// Presence teardown registered up front (runs on host.close, broadcast via CDC).
A.client.onDisconnect([
  { text: 'MATCH (p:Presence {sid: $s}) DETACH DELETE p', params: { s: 'A' } },
]);
B.client.onDisconnect([
  { text: 'MATCH (p:Presence {sid: $s}) DETACH DELETE p', params: { s: 'B' } },
]);

// A and B announce presence with _MERGE (keyed upsert on Presence.sid).
A.engine.mutate('_MERGE (p:Presence {sid: $s, card: $card})', { s: 'A', card: 'c1' });
B.engine.mutate('_MERGE (p:Presence {sid: $s, card: $card})', { s: 'B', card: 'c2' });
await settle();

log('after both announce presence:');
log('  server:', presences(server.store));
log('  A     :', presences(A.local));
log('  B     :', presences(B.local));

// A moves its cursor to a new card — a re-_MERGE should UPDATE, not duplicate.
A.engine.mutate('_MERGE (p:Presence {sid: $s, card: $card})', { s: 'A', card: 'c9' });
await settle();

log('after A moves cursor c1 -> c9:');
log('  server presence count:', presenceCount(server.store), '(expect 2, no dup)');
log('  B sees A on card     :', presences(B.local).find((p) => p.sid === 'A')?.card);

// A disconnects: host.close runs the ephemeral teardown + broadcasts the DELETE.
log('\n-- A disconnects --');
A.host().close();
await settle();

log('after A disconnect:');
log('  server:', presences(server.store));
log('  B     :', presences(B.local));

const ok =
  presenceCount(server.store) === 1 &&
  presenceCount(B.local) === 1 &&
  presences(B.local)[0]?.sid === 'B';
log('\nRESULT:', ok ? "PASS — A's presence vanished for everyone" : 'FAIL — presence leak');
