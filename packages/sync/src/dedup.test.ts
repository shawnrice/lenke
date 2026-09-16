import { describe, expect, test } from 'bun:test';

import { hasErrorCode } from '@lenke/errors';

import { createDedupRegistry, type DedupTicket } from './dedup.js';

const w = (seq: number, session = 's1'): DedupTicket => ({ session, seq, id: `r${seq}` });

describe('DedupRegistry (exactly-once writes)', () => {
  test('a marked write is seen; an unmarked one is not', () => {
    const d = createDedupRegistry();
    expect(d.seen(w(1))).toBe(false);
    d.mark(w(1));
    expect(d.seen(w(1))).toBe(true);
    expect(d.seen(w(2))).toBe(false);
  });

  test('mark is idempotent', () => {
    const d = createDedupRegistry();
    d.mark(w(1));
    d.mark(w(1));
    expect(d.seen(w(1))).toBe(true);
    expect(d.size('s1')).toBe(1);
  });

  test('sessions are isolated — one client cannot answer for another', () => {
    const d = createDedupRegistry();
    d.mark(w(1, 'alice'));
    expect(d.seen(w(1, 'alice'))).toBe(true);
    // Same sequence number, different session: a distinct write, not a duplicate.
    expect(d.seen(w(1, 'bob'))).toBe(false);
  });

  test('drain releases acked ids, and a drained id still reads as seen', () => {
    const d = createDedupRegistry();
    d.mark(w(1));
    d.mark(w(2));
    d.mark(w(3));
    expect(d.size('s1')).toBe(3);

    d.drain('s1', 2);
    expect(d.size('s1')).toBe(1); // 1 and 2 released; 3 still retained

    // Released, but a replay of one must still not re-apply: the client said it
    // had resolved these, so the answer is "already handled", not "never seen".
    expect(d.seen(w(1))).toBe(true);
    expect(d.seen(w(2))).toBe(true);
    expect(d.seen(w(3))).toBe(true);
  });

  test('drain never moves the mark backwards', () => {
    const d = createDedupRegistry();
    d.mark(w(1));
    d.mark(w(2));
    d.drain('s1', 2);
    d.drain('s1', 1); // a stale ackedThrough riding a replayed write
    expect(d.seen(w(2))).toBe(true);
    expect(d.size('s1')).toBe(0);
  });

  test('a full window refuses new writes instead of forgetting old ones', () => {
    const d = createDedupRegistry({ capacity: 2 });
    d.admit(w(1));
    d.mark(w(1));
    d.admit(w(2));
    d.mark(w(2));

    // THE point of the redesign: at capacity the registry says stop, loudly.
    // Evicting here is what let a later replay of the evicted id double-apply.
    let thrown: unknown;

    try {
      d.admit(w(3));
    } catch (e) {
      thrown = e;
    }

    expect(hasErrorCode(thrown, 'E_RESOURCE_EXHAUSTED')).toBe(true);
    expect(d.seen(w(1))).toBe(true); // and nothing was forgotten
    expect(d.seen(w(2))).toBe(true);
  });

  test('acking reopens a full window', () => {
    const d = createDedupRegistry({ capacity: 2 });
    d.admit(w(1));
    d.mark(w(1));
    d.admit(w(2));
    d.mark(w(2));
    expect(() => d.admit(w(3))).toThrow();

    d.drain('s1', 2); // the client acked both
    expect(() => d.admit(w(3))).not.toThrow(); // space again
  });

  test("one client's flood cannot evict another's ids", () => {
    // The failure the old global FIFO had: a quiet client holding unacked writes
    // while a busy one pushes past capacity lost its ids, and its eventual replay
    // double-applied. Windows are per session, so the quiet client is untouched.
    const d = createDedupRegistry({ capacity: 4 });
    d.mark(w(1, 'quiet'));

    for (let n = 1; n <= 4; n++) {
      d.admit(w(n, 'busy'));
      d.mark(w(n, 'busy'));
    }

    expect(() => d.admit(w(5, 'busy'))).toThrow(); // busy hits its own limit
    expect(d.seen(w(1, 'quiet'))).toBe(true); // quiet keeps its window
  });

  test('a restarted client (fresh epoch) is not mistaken for the old session', () => {
    const d = createDedupRegistry();
    d.mark(w(1, 'alice::epoch-1'));
    // Same client id, new instance, counter back to 1 — these are NEW writes and
    // must not be deduped away as the previous session's.
    expect(d.seen(w(1, 'alice::epoch-2'))).toBe(false);
  });

  test('legacy ids (no seq) still dedupe, FIFO-bounded and never throwing', () => {
    const d = createDedupRegistry({ capacity: 2 });
    const legacy = (id: string): DedupTicket => ({ session: 'old', id });

    d.admit(legacy('a')); // an old client cannot understand backpressure
    d.mark(legacy('a'));
    d.mark(legacy('b'));
    expect(d.seen(legacy('a'))).toBe(true);

    d.mark(legacy('c')); // evicts 'a' — best-effort, as it always was
    expect(d.seen(legacy('a'))).toBe(false);
    expect(d.seen(legacy('c'))).toBe(true);
  });

  test('sessions are bounded: the least recently used window is dropped', () => {
    const d = createDedupRegistry({ maxSessions: 2 });
    d.mark(w(1, 'a'));
    d.mark(w(1, 'b'));
    d.mark(w(1, 'c')); // 'a' is the least recently touched

    expect(d.seen(w(1, 'a'))).toBe(false);
    expect(d.seen(w(1, 'b'))).toBe(true);
    expect(d.seen(w(1, 'c'))).toBe(true);
  });
});
