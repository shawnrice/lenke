import { describe, expect, test } from 'bun:test';

import { createSyncClient } from './client.js';
import type { ClientMessage } from './protocol.js';

/*
 * Item 2521: the pre-first-push `rows` array must keep ONE identity, and nothing tested that.
 *
 * `ClientSnapshot.rows`'s own comment calls it "a stable `[]` before the first push". That stability
 * is load-bearing, not cosmetic: `@lenke/react`'s hooks feed these snapshots to
 * `useSyncExternalStore`, which compares the value it gets by reference. A `getSnapshot` that
 * returned a FRESH `[]` each call would make React believe the store changed on every render —
 * the classic "getSnapshot should be cached" infinite loop.
 *
 * The existing suite pins stability BETWEEN PUSHES (`rows).toBe(rowsRef)`, `toBe(warm)`), but not the
 * EMPTY case, which is the one `EMPTY_ROWS` exists for. Measured: replacing every `EMPTY_ROWS` use
 * with a fresh `[]` left **sync 176/176 and react 26/26 green** — the mutant survived both suites,
 * including a rebuild so react saw it. These rows close that.
 *
 * They use a BARE client with a dummy port rather than the `connect()` host loop the neighbouring
 * file uses, because every assertion here is about the state BEFORE any host traffic — so no engine
 * library is needed and the rows can never be anything but the sentinel.
 */
/*
 * `send` is a no-op, so NO host ever answers and no push can arrive. That is what makes these rows
 * necessarily the sentinel rather than coincidentally empty.
 */
const nullPort = (): { send: (m: ClientMessage) => void } => ({ send: () => {} });

describe('the empty rows array keeps one identity (item 2521)', () => {
  test('repeated getSnapshot before any push returns the SAME rows reference', () => {
    const client = createSyncClient(nullPort());
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person', 'name'] });
    const stop = live.subscribe(() => {});

    const first = live.getSnapshot();
    const second = live.getSnapshot();

    // The SNAPSHOT may be cached wholesale; the rows array must be identical either way, because
    // that is what useSyncExternalStore compares.
    expect(second.rows).toBe(first.rows);
    expect(first.rows).toHaveLength(0);
    expect(first.complete).toBe(false);

    stop();
  });

  /*
   * THE CROSS-SUBSCRIPTION HALF. Two unrelated queries share the one module-level sentinel. This is
   * the deliberate counterpart to item 2520's GraphContext finding: sharing an EMPTY IMMUTABLE array
   * is safe and desirable, where sharing a MUTABLE Graph was not — and the `readonly Row[]` type
   * added in this item is what keeps the distinction true.
   */
  test('two different queries share the same empty rows reference', () => {
    const client = createSyncClient(nullPort());
    const a = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });
    const b = client.liveQuery('MATCH (d:Dog) RETURN d.name', { deps: null });
    const stopA = a.subscribe(() => {});
    const stopB = b.subscribe(() => {});

    expect(b.getSnapshot().rows).toBe(a.getSnapshot().rows);

    stopA();
    stopB();
  });

  test('a snapshot taken before subscribing has the same empty rows too', () => {
    const client = createSyncClient(nullPort());
    const live = client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: null });

    const bare = live.getSnapshot();
    const stop = live.subscribe(() => {});

    expect(live.getSnapshot().rows).toBe(bare.rows);
    stop();
  });
});
