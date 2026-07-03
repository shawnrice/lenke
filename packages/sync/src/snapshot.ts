/**
 * Snapshot persistence — the warm-boot layer under the sync loop.
 *
 * The load-bearing rule: the local snapshot is **warmth, never truth**. Losing
 * it (eviction, corruption, tampering, a version bump, a different user) must
 * degrade to a cold boot, never to data loss or a lie — so `readSnapshot`
 * answers `null` for *every* failure mode and the caller cold-syncs. The one
 * exception is the **pending-write queue** (truth-on-client until acked),
 * which rides inside the snapshot so unsynced changes survive a reload.
 *
 * ## Format (`LNKS1`)
 *
 * ```
 * [magic "LNKS" | version u8] [u32 headerLen LE] [header JSON] [payload]
 * payload = gzip( [u32 ndjsonLen LE] [graph NDJSON] [pending-writes JSON] )
 *         …optionally wrapped as [12-byte IV][AES-GCM ciphertext]
 * ```
 *
 * The **header is plaintext by design** — it is the invalidation tier, checked
 * before any decryption: `{ formatVersion, schemaVersion, userId,
 * serverCursor, collections }`. A mismatch on any expectation → dump and
 * cold-sync (this is also the different-user-same-machine check, which the
 * per-user key already fails cryptographically). `collections` names the
 * scopes the snapshot covers — feed it to the engine's `initiallyComplete`.
 * `serverCursor` is the opaque resume point for the app's sync stream; a
 * cursor-too-old answer from the server means: delete the snapshot, cold boot.
 *
 * ## Encryption
 *
 * Compress-then-encrypt with AES-GCM (authenticated: any tamper fails the
 * decrypt and reads as absent). The key is delivered at authentication and
 * lives in worker memory only — never persisted; revocation = drop the key
 * and the ciphertext is garbage (crypto-shredding). A fresh random 96-bit IV
 * per save.
 *
 * ## Storage
 *
 * {@link SnapshotStorage} is the seam: {@link opfsStorage} for the browser
 * (origin-private file system — the owning worker is the only thing that can
 * touch it), {@link memorySnapshotStorage} for tests/servers. Design for
 * eviction as a normal event; `navigator.storage.persist()` is an upgrade,
 * not a guarantee.
 */

import type { QueryParams, Store } from '@lenke/native';

import type { GqlWrite } from './engine.js';

const MAGIC = [0x4c, 0x4e, 0x4b, 0x53] as const; // "LNKS"
const FORMAT_VERSION = 1;
const IV_BYTES = 12;

/** The plaintext invalidation header, written ahead of the payload. */
export type SnapshotHeader = {
  formatVersion: number;
  /** App schema version — bump it to invalidate every existing snapshot. */
  schemaVersion: string;
  /** Whose data this is; a different login must never warm-boot from it. */
  userId: string;
  /** Opaque resume point for the app's sync stream ('' = none). */
  serverCursor: string;
  /** Collections this snapshot covers → the engine's `initiallyComplete`. */
  collections: readonly string[];
};

/** What the app asserts about a snapshot before trusting it. */
export type SnapshotExpectation = {
  schemaVersion: string;
  userId: string;
};

export type Snapshot = {
  header: SnapshotHeader;
  /** Graph NDJSON — feed to `graphFromNdjson`. */
  ndjson: Uint8Array;
  /** The persisted pending-write queue → the engine's `initialWrites`. */
  pendingWrites: GqlWrite[];
};

/** Where snapshot bytes live. All-or-nothing semantics per call. */
export type SnapshotStorage = {
  read: () => Promise<Uint8Array | null>;
  write: (bytes: Uint8Array) => Promise<void>;
  delete: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// storage adapters
// ---------------------------------------------------------------------------

/**
 * OPFS-backed storage (browser / worker). Uses the async `createWritable`
 * path, which works in windows and workers alike; sync access handles are a
 * dedicated-worker-only optimization for later.
 */
const dir = (): Promise<FileSystemDirectoryHandle> => navigator.storage.getDirectory();

export const opfsStorage = (filename: string): SnapshotStorage => {
  return {
    read: async () => {
      try {
        const handle = await (await dir()).getFileHandle(filename);
        const file = await handle.getFile();

        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null; // absent or unreadable — both mean "cold boot"
      }
    },
    write: async (bytes) => {
      const handle = await (await dir()).getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      // Snapshot bytes are always heap-backed; the assertion narrows the
      // ArrayBufferLike view type to what the DOM sink accepts.
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    },
    delete: async () => {
      try {
        await (await dir()).removeEntry(filename);
      } catch {
        // already gone — deleting is idempotent
      }
    },
  };
};

/** In-memory storage — tests, SSR, and anywhere OPFS doesn't exist. */
export const memorySnapshotStorage = (): SnapshotStorage => {
  let bytes: Uint8Array | null = null;

  return {
    read: () => Promise.resolve(bytes),
    write: (b) => {
      bytes = b.slice();

      return Promise.resolve();
    },
    delete: () => {
      bytes = null;

      return Promise.resolve();
    },
  };
};

// ---------------------------------------------------------------------------
// key handling
// ---------------------------------------------------------------------------

/**
 * Import raw AES-256 key bytes (delivered at authentication) as a WebCrypto
 * key for this module. Keep the result in worker memory only — a
 * non-extractable CryptoKey parked in IndexedDB weakens the story to
 * casual-inspection-only.
 */
export const importSnapshotKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

const pipeThrough = async (
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);

  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);

  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;

  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }

  return out;
};

/**
 * Serialize a store (graph + pending writes) into snapshot bytes. Pass the
 * `key` to encrypt at rest (compress-then-encrypt); omit it for plaintext.
 */
export const encodeSnapshot = async (
  store: Store,
  meta: {
    schemaVersion: string;
    userId: string;
    serverCursor?: string;
    collections?: readonly string[];
    pendingWrites?: readonly GqlWrite[];
  },
  opts: { key?: CryptoKey } = {},
): Promise<Uint8Array> => {
  const header: SnapshotHeader = {
    formatVersion: FORMAT_VERSION,
    schemaVersion: meta.schemaVersion,
    userId: meta.userId,
    serverCursor: meta.serverCursor ?? '',
    collections: meta.collections ?? [],
  };
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(JSON.stringify(header));

  const ndjson = store.graph.toNdjson();
  const writesBytes = encoder.encode(JSON.stringify(meta.pendingWrites ?? []));
  let payload = await pipeThrough(
    concat(u32le(ndjson.byteLength), ndjson, writesBytes),
    new CompressionStream('gzip'),
  );

  if (opts.key) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      opts.key,
      payload as BufferSource,
    );
    payload = concat(iv, new Uint8Array(ciphertext));
  }

  return concat(
    new Uint8Array([...MAGIC, FORMAT_VERSION]),
    u32le(headerBytes.byteLength),
    headerBytes,
    payload,
  );
};

/**
 * Read the plaintext header without touching the payload (no key needed).
 * `null` for anything that isn't a well-formed snapshot.
 */
export const peekHeader = (bytes: Uint8Array): SnapshotHeader | null => {
  try {
    if (bytes.byteLength < 9 || MAGIC.some((b, i) => bytes[i] !== b)) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(5, true);
    const headerBytes = bytes.subarray(9, 9 + headerLen);

    if (headerBytes.byteLength !== headerLen) {
      return null;
    }

    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as SnapshotHeader;

    return typeof header.formatVersion === 'number' &&
      typeof header.schemaVersion === 'string' &&
      typeof header.userId === 'string'
      ? header
      : null;
  } catch {
    return null;
  }
};

/**
 * Decode snapshot bytes into a warm-boot bundle. **Every** failure mode —
 * malformed bytes, a format/schema/user mismatch, a missing or wrong key, a
 * tampered or truncated payload — answers `null`: dump it and cold-boot.
 */
export const decodeSnapshot = async (
  bytes: Uint8Array,
  expect: SnapshotExpectation,
  opts: { key?: CryptoKey } = {},
): Promise<Snapshot | null> => {
  const header = peekHeader(bytes);

  if (
    header === null ||
    header.formatVersion !== FORMAT_VERSION ||
    header.schemaVersion !== expect.schemaVersion ||
    header.userId !== expect.userId
  ) {
    return null;
  }

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(5, true);
    let payload = bytes.subarray(9 + headerLen);

    if (opts.key) {
      const iv = payload.subarray(0, IV_BYTES);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        opts.key,
        payload.subarray(IV_BYTES) as BufferSource,
      );
      payload = new Uint8Array(plaintext);
    }

    const inner = await pipeThrough(payload, new DecompressionStream('gzip'));
    const ndjsonLen = new DataView(inner.buffer, inner.byteOffset).getUint32(0, true);
    const ndjson = inner.subarray(4, 4 + ndjsonLen);
    const writesJson = new TextDecoder().decode(inner.subarray(4 + ndjsonLen));
    const pendingWrites = JSON.parse(writesJson) as {
      gql: string;
      params?: QueryParams;
    }[];

    if (!Array.isArray(pendingWrites)) {
      return null;
    }

    return { header, ndjson: ndjson.slice(), pendingWrites };
  } catch {
    // Wrong key, tamper, truncation, gzip corruption: all read as absent.
    return null;
  }
};

/**
 * Convenience: read + validate a snapshot from storage. A `null` means cold
 * boot; a bad-but-present snapshot is deleted on the way out (it will never
 * become valid again).
 */
export const readSnapshot = async (
  storage: SnapshotStorage,
  expect: SnapshotExpectation,
  opts: { key?: CryptoKey } = {},
): Promise<Snapshot | null> => {
  const bytes = await storage.read();

  if (bytes === null) {
    return null;
  }

  const snapshot = await decodeSnapshot(bytes, expect, opts);

  if (snapshot === null) {
    await storage.delete(); // invalid forever — reclaim the space now
  }

  return snapshot;
};
