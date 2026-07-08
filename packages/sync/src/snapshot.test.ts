// Proves the warm-boot layer honors its load-bearing rule — the snapshot is
// warmth, never truth: every failure mode (tamper, truncation, wrong key,
// version/user mismatch, garbage bytes) reads as ABSENT and the caller cold
// boots. Plus the one exception: the pending-write queue rides the snapshot
// and resumes replication on boot. Run: bun test packages/sync/src/snapshot.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { createStore, graphFromNdjson, type Store } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

import { createSyncEngine, type SyncWrite } from './engine.js';
import {
  decodeSnapshot,
  encodeSnapshot,
  importSnapshotKey,
  memorySnapshotStorage,
  peekHeader,
  readSnapshot,
} from './snapshot.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[snapshot.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"a","labels":["Person"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["Person"],"properties":{"name":"vadas","age":27}}',
].join('\n');

const newStore = (seed: string = NDJSON): Store =>
  createStore(graphFromNdjson(createFfiBackend(LIB), new TextEncoder().encode(seed)));

const EXPECT = { schemaVersion: 'v1', userId: 'shawn' };
const KEY_BYTES = new Uint8Array(32).map((_, i) => i * 7 + 1);
// Persisting plaintext is an explicit, greppable choice (secure-by-default).
const PLAIN = { unencrypted: true } as const;

suite('@lenke/sync snapshot · codec', () => {
  test('plaintext round-trip: graph, header, and queue survive', async () => {
    const store = newStore();
    const writes: SyncWrite[] = [{ text: 'INSERT (:Person {name: $n})', params: { n: 'queued' } }];
    const bytes = await encodeSnapshot(
      store,
      {
        ...EXPECT,
        serverCursor: 'cursor-42',
        collections: ['people'],
        pendingWrites: writes,
      },
      PLAIN,
    );

    const snap = await decodeSnapshot(bytes, EXPECT, PLAIN);
    expect(snap).not.toBeNull();
    expect(snap!.header).toMatchObject({
      formatVersion: 1,
      schemaVersion: 'v1',
      userId: 'shawn',
      serverCursor: 'cursor-42',
      collections: ['people'],
    });
    expect(snap!.pendingWrites).toEqual(writes);

    // The NDJSON payload actually reconstructs the graph.
    const restored = newStore(new TextDecoder().decode(snap!.ndjson));
    expect(restored.graph.vertexCount).toBe(2);
  });

  test('crypto choice is required — no silent keyless plaintext', async () => {
    const store = newStore();
    // @ts-expect-error the union forbids omitting the crypto choice…
    expect(encodeSnapshot(store, EXPECT)).rejects.toThrow(/refusing to silently write/);
    // …and passing an empty object (the old accidental default) is refused too.
    expect(encodeSnapshot(store, EXPECT, {} as { unencrypted: true })).rejects.toThrow(
      /refusing to silently write/,
    );

    const bytes = await encodeSnapshot(store, EXPECT, PLAIN);
    // A misused crypto arg on decode throws loudly (programmer error), rather
    // than being swallowed as a corrupt-snapshot cold boot.
    expect(decodeSnapshot(bytes, EXPECT, {} as { unencrypted: true })).rejects.toThrow(
      /refusing to silently write/,
    );
  });

  test('legacy and malformed persisted writes normalize safely', async () => {
    const store = newStore();
    // Simulate a pre-`lang` snapshot ({gql}) and a corrupted write (neither
    // key) riding in the persisted queue — the cast models old/damaged bytes.
    const persisted = [
      { gql: 'INSERT (:Person {name: $n})', params: { n: 'legacy' } },
      { params: { n: 'garbage' } }, // no text, no gql → must be dropped
      { text: "g.addV('Person')", lang: 'gremlin' },
    ] as unknown as SyncWrite[];
    const bytes = await encodeSnapshot(store, { ...EXPECT, pendingWrites: persisted }, PLAIN);

    const snap = await decodeSnapshot(bytes, EXPECT, PLAIN);
    expect(snap!.pendingWrites).toEqual([
      { text: 'INSERT (:Person {name: $n})', params: { n: 'legacy' } }, // gql → text
      { text: "g.addV('Person')", lang: 'gremlin' }, // lang survives
    ]); // the text-less write is gone, not { text: undefined } poisoning the queue
  });

  test('encrypted round-trip; wrong key and missing key read as absent', async () => {
    const store = newStore();
    const key = await importSnapshotKey(KEY_BYTES);
    const bytes = await encodeSnapshot(store, EXPECT, { key });

    const good = await decodeSnapshot(bytes, EXPECT, { key });
    expect(good).not.toBeNull();
    expect(newStore(new TextDecoder().decode(good!.ndjson)).graph.vertexCount).toBe(2);

    const wrongKey = await importSnapshotKey(new Uint8Array(32).map((_, i) => i + 99));
    expect(await decodeSnapshot(bytes, EXPECT, { key: wrongKey })).toBeNull();
    // Decoding a sealed snapshot as plaintext (no key) gzip-fails → absent.
    expect(await decodeSnapshot(bytes, EXPECT, PLAIN)).toBeNull();
  });

  test('the header stays readable without the key (the invalidation tier)', async () => {
    const key = await importSnapshotKey(KEY_BYTES);
    const bytes = await encodeSnapshot(newStore(), { ...EXPECT, serverCursor: 'c9' }, { key });

    expect(peekHeader(bytes)).toMatchObject({ userId: 'shawn', serverCursor: 'c9' });
  });

  test('any expectation mismatch reads as absent (dump → cold boot)', async () => {
    const bytes = await encodeSnapshot(newStore(), EXPECT, PLAIN);

    expect(await decodeSnapshot(bytes, { schemaVersion: 'v2', userId: 'shawn' }, PLAIN)).toBeNull();
    expect(
      await decodeSnapshot(bytes, { schemaVersion: 'v1', userId: 'intruder' }, PLAIN),
    ).toBeNull();
  });

  test('tamper, truncation, and garbage all read as absent', async () => {
    const key = await importSnapshotKey(KEY_BYTES);
    const plain = await encodeSnapshot(newStore(), EXPECT, PLAIN);
    const sealed = await encodeSnapshot(newStore(), EXPECT, { key });

    const flipped = sealed.slice();
    flipped[flipped.byteLength - 1] ^= 0xff; // tamper with AES-GCM ciphertext
    expect(await decodeSnapshot(flipped, EXPECT, { key })).toBeNull();

    const corrupt = plain.slice();
    corrupt[corrupt.byteLength - 5] ^= 0xff; // corrupt the gzip payload
    expect(await decodeSnapshot(corrupt, EXPECT, PLAIN)).toBeNull();

    expect(await decodeSnapshot(plain.subarray(0, 40), EXPECT, PLAIN)).toBeNull(); // truncated
    expect(
      await decodeSnapshot(new TextEncoder().encode('not a snapshot'), EXPECT, PLAIN),
    ).toBeNull();
    expect(peekHeader(new Uint8Array(0))).toBeNull();
  });

  test('an edited (but still valid) header on an encrypted snapshot reads as absent', async () => {
    const key = await importSnapshotKey(KEY_BYTES);
    // A distinctive cursor we can swap for an equal-length one — same headerLen,
    // same JSON structure, so peekHeader still parses and expectations pass.
    const bytes = await encodeSnapshot(
      newStore(),
      { ...EXPECT, serverCursor: 'AAAAAAAA' },
      { key },
    );
    expect(await decodeSnapshot(bytes, EXPECT, { key })).not.toBeNull(); // untouched: fine

    const tampered = bytes.slice();
    const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);
    const headerLen = view.getUint32(5, true);
    const headerText = new TextDecoder().decode(tampered.subarray(9, 9 + headerLen));
    const at = headerText.indexOf('AAAAAAAA');
    new TextEncoder().encodeInto('BBBBBBBB', tampered.subarray(9 + at)); // edit in place

    // The header edit took (it's plaintext) — but it's bound to the ciphertext
    // as AEAD additionalData, so the decrypt fails the tag and we cold-boot,
    // instead of trusting a forged `collections`/`serverCursor`.
    expect(peekHeader(tampered)).toMatchObject({ serverCursor: 'BBBBBBBB' });
    expect(await decodeSnapshot(tampered, EXPECT, { key })).toBeNull();
  });

  test('readSnapshot deletes an invalid-forever snapshot on the way out', async () => {
    const storage = memorySnapshotStorage();
    await storage.write(await encodeSnapshot(newStore(), EXPECT, PLAIN));

    // Schema bumped: the stored snapshot can never become valid again.
    const miss = await readSnapshot(storage, { schemaVersion: 'v2', userId: 'shawn' }, PLAIN);
    expect(miss).toBeNull();
    expect(await storage.read()).toBeNull(); // reclaimed

    // Absent storage is a quiet cold boot.
    expect(await readSnapshot(storage, EXPECT, PLAIN)).toBeNull();
  });
});

suite('@lenke/sync snapshot · warm boot', () => {
  test('save → boot: graph, completeness, cursor, and queue all resume', async () => {
    // Session 1: a loaded engine with one write stuck in the queue.
    const held: SyncWrite[] = [];
    const session1 = createSyncEngine({
      store: newStore(),
      collections: { people: { labels: ['Person'], load: () => Promise.resolve([]) } },
      initiallyComplete: ['people'],
      upstream: { push: () => new Promise(() => {}) }, // upstream never answers
    });
    session1.mutate('INSERT (:Person {name: $n})', { n: 'offline-edit' });
    expect(session1.pendingWrites()).toBe(1);

    const storage = memorySnapshotStorage();
    await storage.write(
      await encodeSnapshot(
        session1.store,
        {
          ...EXPECT,
          serverCursor: 'resume-here',
          collections: ['people'],
          pendingWrites: session1.queuedWrites(),
        },
        PLAIN,
      ),
    );

    // Session 2 (the "reload"): boot from the snapshot.
    const snap = await readSnapshot(storage, EXPECT, PLAIN);
    expect(snap).not.toBeNull();
    expect(snap!.header.serverCursor).toBe('resume-here'); // the app resumes its stream here

    const store2 = newStore(new TextDecoder().decode(snap!.ndjson));
    const session2 = createSyncEngine({
      store: store2,
      collections: { people: { labels: ['Person'], load: () => Promise.resolve([]) } },
      initiallyComplete: snap!.header.collections,
      initialWrites: snap!.pendingWrites,
      upstream: {
        push: (w) => {
          held.push(w);

          return Promise.resolve();
        },
      },
    });

    // The optimistic edit is IN the graph (not replayed, not lost)…
    expect(store2.graph.vertexCount).toBe(3);
    // …the collection is warm (no demand-fill)…
    expect(session2.isComplete(['Person'])).toBe(true);
    // …and the stranded write resumes replication immediately.
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(held).toEqual([{ text: 'INSERT (:Person {name: $n})', params: { n: 'offline-edit' } }]);
    expect(session2.pendingWrites()).toBe(0);
  });
});
