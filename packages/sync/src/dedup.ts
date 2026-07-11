/**
 * Server-side request-id dedupe for **exactly-once** write application. Delivery
 * is at-least-once: a write can land on the server, have its ack lost, and be
 * re-sent when the client reconnects and replays its unacked writes (against a
 * *new* host). Without dedupe that re-applies — double-incrementing counters,
 * duplicating non-idempotent INSERTs (Kenji's "+2 over-count"). A `DedupRegistry`
 * remembers applied write ids and lets the host re-ack a duplicate WITHOUT
 * re-applying.
 *
 * All hosts on one server share ONE registry (as they share one `Store` and
 * `WriteLog`), so it survives the reconnect that swaps the connection. The key is
 * the write's `req`, which the client makes globally unique (a stable per-client
 * id prefix) and re-sends verbatim on replay, so the same logical write always
 * carries the same id.
 */
export type DedupRegistry = {
  /** True if this write id was already applied (a re-send after a lost ack). */
  seen(id: string): boolean;
  /** Record a write id as applied. Bounded — the oldest ids evict past capacity. */
  mark(id: string): void;
};

export type DedupOptions = {
  /**
   * Max retained applied-write ids (FIFO eviction). A duplicate older than this
   * could slip through and re-apply, so keep it well above the largest plausible
   * count of in-flight/unacked writes across a disconnect. Default 4096.
   */
  capacity?: number;
};

export const createDedupRegistry = (options: DedupOptions = {}): DedupRegistry => {
  const capacity = Math.max(1, options.capacity ?? 4096);
  const seen = new Set<string>();
  const order: string[] = []; // FIFO of ids, for bounded eviction

  return {
    seen: (id) => seen.has(id),

    mark: (id) => {
      if (seen.has(id)) {
        return;
      }

      seen.add(id);
      order.push(id);

      if (order.length > capacity) {
        const evicted = order.shift();

        if (evicted !== undefined) {
          seen.delete(evicted);
        }
      }
    },
  };
};
