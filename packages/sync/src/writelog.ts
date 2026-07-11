import type { SyncWrite } from './protocol.js';

/**
 * The server-side op log behind the CDC write stream. All `SyncHost`s on one
 * server share a single `WriteLog` (the way they share one `Store`): a host
 * `append`s each committed write, and every host with a stream subscriber
 * `subscribe`s to fan the tail out to its client. Ordering + resumability come
 * from a monotonic `seq`; a bounded ring caps memory, so a client that has
 * fallen too far behind gets `null` from `since` and must cold-boot from a
 * snapshot. This is statement-based replication — the op *is* the `SyncWrite`
 * (write-language text + resolved params), replayed through `runWrite`, which is
 * deterministic because the two engines are byte-identical.
 */
export type WriteLogEntry = {
  /** Monotonic sequence number (1-based; `0` means "before the first op"). */
  seq: number;
  /** The participant (host/connection) that committed it — for origin-skip so a
   *  client never re-ingests the write it already applied optimistically. */
  origin: number;
  write: SyncWrite;
  /**
   * The label / edge-type / property-key tokens this write touches (as by
   * `inferDeps`), for interest routing — a host forwards the write only to
   * clients whose subscriptions depend on one of these tokens. `undefined` means
   * "affects everything / can't infer" (e.g. a Gremlin write) → forward to all.
   */
  tokens?: readonly string[];
};

export type WriteLogOptions = {
  /**
   * Max retained entries (ring buffer). Older entries drop; a `since` reaching
   * past them returns `null`, signalling the client to cold-boot from a
   * snapshot rather than apply a gapped stream. Default 1024.
   */
  capacity?: number;
};

export type WriteLog = {
  /** Register a participant; returns its stable origin id (for `append`). */
  register(): number;
  /** Append a committed write (with the tokens it touches, for interest routing);
   *  assigns + returns its `seq` and notifies subscribers. */
  append(origin: number, write: SyncWrite, tokens?: readonly string[]): number;
  /** Subscribe to the live tail. Returns an unsubscribe. */
  subscribe(cb: (entry: WriteLogEntry) => void): () => void;
  /**
   * Entries strictly after `seq`, ascending. `[]` if the caller is already
   * current; `null` if `seq` has fallen off the retained tail (there'd be a gap
   * → the caller must cold-boot). `since(0)` means "from the very start".
   */
  since(seq: number): WriteLogEntry[] | null;
  /** The latest assigned seq (`0` if none yet). */
  head(): number;
};

export const createWriteLog = (options: WriteLogOptions = {}): WriteLog => {
  const capacity = Math.max(1, options.capacity ?? 1024);
  const buffer: WriteLogEntry[] = []; // retained tail, ascending, contiguous seq
  const subscribers = new Set<(entry: WriteLogEntry) => void>();
  let seq = 0;
  let nextId = 0;

  return {
    register: () => nextId++,

    append: (origin, write, tokens) => {
      seq += 1;
      const entry: WriteLogEntry = { seq, origin, write, tokens };
      buffer.push(entry);

      if (buffer.length > capacity) {
        buffer.shift();
      }

      // Deliver to current subscribers. (Callbacks here are host forwards — they
      // don't (un)subscribe mid-fan-out, so iterating the set directly is safe.)
      for (const cb of subscribers) {
        cb(entry);
      }

      return seq;
    },

    subscribe: (cb) => {
      subscribers.add(cb);

      return () => {
        subscribers.delete(cb);
      };
    },

    since: (from) => {
      if (from >= seq) {
        return []; // caller is current (or ahead — treated as current)
      }

      // The buffer holds a contiguous run [oldest … seq]. The caller needs
      // (from … seq]; that's a gap unless `from + 1` is still retained.
      const oldest = buffer.length > 0 ? buffer[0].seq : seq + 1;

      if (from + 1 < oldest) {
        return null; // fell off the tail → cold boot
      }

      return buffer.filter((e) => e.seq > from);
    },

    head: () => seq,
  };
};
