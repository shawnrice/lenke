import { ErrorCode, LenkeError } from '@lenke/errors';

/**
 * Server-side dedupe for **exactly-once** write application. Delivery is
 * at-least-once: a write can land on the server, have its ack lost, and be
 * re-sent when the client reconnects and replays its unacked writes (against a
 * *new* host). Without dedupe that re-applies — double-incrementing counters,
 * duplicating non-idempotent INSERTs. A `DedupRegistry` remembers applied writes
 * and lets the host re-ack a duplicate WITHOUT re-applying.
 *
 * All hosts on one server share ONE registry (as they share one `Store` and
 * `WriteLog`), so it survives the reconnect that swaps the connection.
 *
 * This is the one CDC path that fails **closed**: everywhere else a mistake shows
 * up as a loud error, but a dedupe that forgets re-applies a write, and a dedupe
 * that over-remembers drops one — both silently, both as wrong data. The shape
 * below follows from that.
 *
 * ## Windows are per session, and drain on ack
 *
 * Retained ids are grouped by SESSION (see {@link DedupTicket}) and each write
 * carries a per-session sequence number. A client piggybacks `ackedThrough`: the
 * highest sequence it has contiguously resolved — acked or rejected, either way
 * never to be re-sent. The host {@link DedupRegistry.drain}s everything at or
 * below that, which is what frees space.
 *
 * The earlier design retained a single global FIFO of ids and evicted the oldest
 * past a capacity. That is unsafe at any size: a client that goes quiet holding
 * unacked writes keeps its replay window open indefinitely, while other clients
 * flood past the capacity and evict its ids — and its eventual replay then
 * double-applies. Eviction by count cannot distinguish "old" from "no longer
 * needed"; only the client's own ack can.
 *
 * ## Full means STOP, not forget
 *
 * When a session's window fills — the client is genuinely not keeping up, not
 * acking — {@link DedupRegistry.admit} throws `E_RESOURCE_EXHAUSTED` and the host
 * NACKs the write. The client surfaces that as a rejected `mutate()`: loud
 * backpressure the caller can retry, rather than a silent eviction that turns
 * into a double-apply later. Refusing new work while the queue is full is the
 * only answer that keeps the invariant.
 *
 * ## The key must not be forgeable
 *
 * The server cannot derive the key itself: it has to be stable across a reconnect
 * onto a *different* host, so it can only come from what the client carries. That
 * makes it forgeable — a client that guesses another's session and sequence gets
 * a genuine write re-acked WITHOUT it being applied, i.e. silent loss. The fix is
 * namespacing: the host prefixes every session with an authenticated `principal`
 * it gets from its transport (a session token, mTLS identity, signed cookie).
 * lenke's host is transport-agnostic and cannot authenticate on its own, so this
 * is the embedder's to supply — see `principal` on `SyncHostOptions`. Without it
 * the namespace is empty and ids are only as trustworthy as the clients.
 */
export type DedupTicket = {
  /**
   * The write's session: principal, client id, and the client's per-session
   * epoch, already joined by the host. Two sessions never share a window.
   *
   * The epoch matters on its own: a client that persists its `clientId` (which it
   * should, for CDC origin-skip) but resets its in-memory counter on restart
   * would otherwise re-issue sequence 1, 2, 3 … and have its NEW writes silently
   * deduped away as duplicates of the old ones. A fresh epoch per client instance
   * keeps replay-within-a-session working while making a restart unmistakable.
   */
  session: string;
  /**
   * Per-session write sequence, contiguous from 1. Omitted by a legacy client
   * that sends only an opaque `req`; see {@link DedupRegistry.admit} for what
   * that costs.
   */
  seq?: number;
  /** The wire `req`. The dedupe identity for a legacy ticket with no `seq`. */
  id: string;
};

export type DedupRegistry = {
  /** Already applied — a re-send after a lost ack, to be re-acked not re-run. */
  seen(ticket: DedupTicket): boolean;
  /**
   * Claim window space for a write about to be applied. Throws a coded
   * `E_RESOURCE_EXHAUSTED` when this session's window is full, so the host NACKs
   * rather than evicting something it may still need.
   *
   * A LEGACY ticket (no `seq`) cannot drain, because nothing tells the host which
   * of its ids the client is done with; those windows fall back to FIFO eviction
   * and are therefore best-effort, exactly as the whole registry used to be. They
   * never throw — an old client has no way to understand backpressure.
   */
  admit(ticket: DedupTicket): void;
  /** Record a write as applied. Call only AFTER it actually applied. */
  mark(ticket: DedupTicket): void;
  /**
   * Drop everything this session has resolved up to and including
   * `ackedThrough`, freeing window space. Ignores a value that would move the
   * mark backwards.
   */
  drain(session: string, ackedThrough: number): void;
  /** Retained-id count for a session — for tests and diagnostics. */
  size(session: string): number;
};

export type DedupOptions = {
  /**
   * Max retained ids per SESSION before a write is refused with
   * `E_RESOURCE_EXHAUSTED`. This bounds one client's unacked window, so it wants
   * to sit above the client's own `maxPendingWrites` (default 1000) with room for
   * a reconnect replay. Default 4096.
   */
  capacity?: number;
  /**
   * Max sessions tracked at once. Past this the least-recently-used session's
   * whole window is dropped — the one remaining place an id can be forgotten
   * while it might still matter, so it is set high enough that reaching it means
   * something else is wrong (a client cycling epochs, a leak). Default 1024.
   */
  maxSessions?: number;
};

type Window = {
  /** Applied sequences still retained (all > `lowWater`). */
  seqs: Set<number>;
  /** Everything at or below this has been acked by the client and dropped. */
  lowWater: number;
  /** Legacy opaque ids, FIFO-evicted (no `seq` to drain by). */
  legacy: Set<string>;
  legacyOrder: string[];
};

const retained = (w: Window): number => w.seqs.size + w.legacy.size;

const newWindow = (): Window => ({
  seqs: new Set(),
  lowWater: 0,
  legacy: new Set(),
  legacyOrder: [],
});

export const createDedupRegistry = (options: DedupOptions = {}): DedupRegistry => {
  const capacity = Math.max(1, options.capacity ?? 4096);
  const maxSessions = Math.max(1, options.maxSessions ?? 1024);
  // Insertion order is LRU order: a touched session is re-inserted at the end.
  const windows = new Map<string, Window>();

  const touch = (session: string): Window => {
    const found = windows.get(session);

    if (found) {
      windows.delete(session);
      windows.set(session, found);

      return found;
    }

    const fresh = newWindow();
    windows.set(session, fresh);

    while (windows.size > maxSessions) {
      const oldest = windows.keys().next();

      if (oldest.done) {
        break;
      }

      windows.delete(oldest.value);
    }

    return fresh;
  };

  return {
    seen: (ticket) => {
      const w = windows.get(ticket.session);

      if (!w) {
        return false;
      }

      if (ticket.seq === undefined) {
        return w.legacy.has(ticket.id);
      }

      // At or below the low-water mark means the client told us it had resolved
      // this write, so re-acking without re-applying is the safe answer whether
      // it originally applied or was rejected — either way it must not run twice.
      return ticket.seq <= w.lowWater || w.seqs.has(ticket.seq);
    },

    admit: (ticket) => {
      const w = touch(ticket.session);

      if (ticket.seq === undefined || retained(w) < capacity) {
        return;
      }

      throw new LenkeError(
        `lenke: write window full for this session (${capacity} unacked writes retained for exactly-once dedupe) — ` +
          `acknowledge outstanding writes before sending more`,
        { code: ErrorCode.ResourceExhausted, details: { session: ticket.session, capacity } },
      );
    },

    mark: (ticket) => {
      const w = touch(ticket.session);

      if (ticket.seq === undefined) {
        if (w.legacy.has(ticket.id)) {
          return;
        }

        w.legacy.add(ticket.id);
        w.legacyOrder.push(ticket.id);

        if (w.legacyOrder.length > capacity) {
          const evicted = w.legacyOrder.shift();

          if (evicted !== undefined) {
            w.legacy.delete(evicted);
          }
        }

        return;
      }

      if (ticket.seq > w.lowWater) {
        w.seqs.add(ticket.seq);
      }
    },

    drain: (session, ackedThrough) => {
      const w = windows.get(session);

      if (!w || !Number.isFinite(ackedThrough) || ackedThrough <= w.lowWater) {
        return;
      }

      // Walk only the newly-acked span: every sequence is visited at most once
      // over a session's life, so this is amortized O(1) per write rather than a
      // scan of the whole window on each ack.
      for (let n = w.lowWater + 1; n <= ackedThrough; n++) {
        w.seqs.delete(n);
      }

      w.lowWater = ackedThrough;
    },

    size: (session) => {
      const w = windows.get(session);

      return w ? retained(w) : 0;
    },
  };
};
