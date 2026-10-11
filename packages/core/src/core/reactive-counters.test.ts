// `version` and `epoch(token)` are the graph's public reactive surface — what `@lenke/react`'s
// hooks poll to decide whether a component has to re-render. Before audit item 313 neither had a
// single direct test: the React tests cover them transitively through `useLiveQuery`, which is
// enough to notice that reactivity is broken but not enough to pin down WHAT the counters promise.
//
// Item 313 batched their deferred update — one microtask per burst of writes rather than one per
// write — so the promise now has to be written down, because "it still re-renders" is true of a
// counter that lands on the wrong number.
//
// Both counters advance on a MICROTASK, deliberately (a burst coalesces into one React notify), so
// every assertion here is after an `await`. A test that reads them synchronously reads zero and
// passes for the wrong reason.
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

const tick = (): Promise<void> => Promise.resolve();

describe('reactive counters', () => {
  test('version counts every write, not every burst', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    g.addVertex({ id: 'c', labels: ['N'], properties: {} });

    await tick();

    // Three writes in one tick share one deferred drain; the count is still three. A drain that
    // advanced the version once per BURST would read 1 here, and every React consumer that
    // compares versions to detect "did anything change" would still work — which is exactly why
    // this needs an exact number and not a `toBeGreaterThan`.
    expect(g.version).toBe(3);
  });

  test('version keeps counting across bursts', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['N'], properties: {} });

    await tick();

    expect(g.version).toBe(1);

    g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    g.addVertex({ id: 'c', labels: ['N'], properties: {} });

    await tick();

    // 1 + 2: a second burst adds to the first rather than restarting it, and the pending counter
    // it accumulates into is reset by the drain (if it were not, this would read 1 + 3).
    expect(g.version).toBe(3);
  });

  test('epoch counts a token once per write that touches it', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'x' } });
    g.addVertex({ id: 'b', labels: ['Person'], properties: { name: 'y' } });

    await tick();

    // Both writes touch the label `Person` and the key `name`, so each token is bumped twice —
    // duplicates within a burst are kept, not deduplicated. A drain that put the burst's tokens
    // through a Set first would read 1 for each of these.
    expect(g.epoch('Person')).toBe(2);
    expect(g.epoch('name')).toBe(2);
    // A token no write mentioned stays at zero, which is what lets a selector keyed on one label
    // skip a re-render when an unrelated label is written.
    expect(g.epoch('Company')).toBe(0);
  });

  test('a write to one label does not bump another label', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['Person'], properties: {} });

    await tick();

    const before = g.epoch('Company');

    g.addVertex({ id: 'b', labels: ['Company'], properties: {} });

    await tick();

    expect(g.epoch('Company')).toBe(before + 1);
    // Still 1 from its own write: a drain that applied the whole pending burst to every token
    // seen so far — rather than to the tokens actually pushed — would bump this too.
    expect(g.epoch('Person')).toBe(1);
  });

  test('an edge write bumps the edge label and its property keys', async () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    await tick();

    g.addEdge({ id: 'e', from: a, to: b, labels: ['KNOWS'], properties: { since: 2020 } });

    await tick();

    expect(g.epoch('KNOWS')).toBe(1);
    expect(g.epoch('since')).toBe(1);
  });

  test('a committed transaction counts each write inside it', async () => {
    const g = new Graph();

    g.transaction(() => {
      g.addVertex({ id: 'a', labels: ['N'], properties: {} });
      g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    });

    await tick();

    // The events buffer until commit and then dispatch as a batch, so all of this arrives in one
    // burst — and the count is still per write.
    expect(g.version).toBe(2);
    expect(g.epoch('N')).toBe(2);
  });

  test('a rolled-back transaction advances nothing', async () => {
    const g = new Graph();

    expect(() => {
      g.transaction(() => {
        g.addVertex({ id: 'a', labels: ['N'], properties: {} });

        throw new Error('nope');
      });
    }).toThrow('nope');

    await tick();

    // Buffered events are discarded on rollback, so there is nothing to count. A React consumer
    // that re-rendered here would re-read an unchanged graph.
    expect(g.version).toBe(0);
    expect(g.epoch('N')).toBe(0);
  });

  test('a removal INSIDE a transaction bumps the tokens of the element it removed', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'x' } });

    await tick();

    g.transaction(() => {
      g.removeVertex('a');
    });

    await tick();

    // The hard case for a deferred counter: the event is buffered, and by the time it dispatches
    // at commit the element has been evicted and its `labels` getter would throw. So the tokens
    // have to be read at BUFFER time, while it is still live, and carried to the drain. If they
    // were read late this would be 1 (or an exception); if they were dropped, also 1.
    expect(g.epoch('Person')).toBe(2);
    expect(g.epoch('name')).toBe(2);
    expect(g.version).toBe(2);
  });

  test('an inner frame rollback drops its tokens and keeps the outer frame tokens', async () => {
    const g = new Graph();

    g.beginTransaction();
    g.addVertex({ id: 'keep', labels: ['Kept'], properties: {} });

    g.beginTransaction();
    g.addVertex({ id: 'drop', labels: ['Dropped'], properties: {} });
    g.rollbackTransaction(); // inner frame only — the outer transaction is still open

    g.addVertex({ id: 'keep2', labels: ['Kept'], properties: {} });
    g.commitTransaction();

    await tick();

    // The inner frame's buffered event is discarded to its savepoint mark, and the tokens it
    // contributed have to be discarded with it — they are accumulated FLAT for the whole
    // transaction, so a truncation that forgets them would leave `Dropped` bumped by a write that
    // never happened.
    expect(g.epoch('Dropped')).toBe(0);
    expect(g.epoch('Kept')).toBe(2);
    expect(g.version).toBe(2);
  });

  // `@graph/mutate` is a re-emission of each of the sixteen mutation events, so a caller can
  // subscribe once instead of sixteen times. Item 313 skips BUILDING it when nobody is subscribed,
  // which is unobservable by construction — except inside a transaction, where the event would be
  // buffered rather than dispatched and the subscriber list at buffer time is not the one that
  // will receive it. That is the whole reason the skip is conditioned on `txDepth === 0`, so it
  // gets the test.
  test('a @graph/mutate listener attached mid-transaction still sees the earlier writes', () => {
    const g = new Graph();
    let mutations = 0;

    g.transaction(() => {
      g.addVertex({ id: 'a', labels: ['N'], properties: {} });
      g.on('@graph/mutate', () => {
        mutations += 1;
      });
      g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    });

    // Two, not one: the first write's event was buffered before the listener existed, and a
    // buffered event is dispatched to whoever is subscribed AT COMMIT.
    expect(mutations).toBe(2);
  });

  test('a rolled-back transaction leaves nothing behind for the next one', async () => {
    const g = new Graph();

    expect(() => {
      g.transaction(() => {
        g.addVertex({ id: 'gone', labels: ['Discarded'], properties: { ghost: 1 } });

        throw new Error('nope');
      });
    }).toThrow('nope');

    await tick();

    g.transaction(() => {
      g.addVertex({ id: 'real', labels: ['Kept'], properties: {} });
    });

    await tick();

    // The transaction's token buffer is accumulated FLAT and handed over at commit, so a rollback
    // that tore down the transaction without clearing it would hand the DISCARDED write's tokens
    // to the next commit. Checking the counters straight after the rollback does not see that —
    // nothing is handed over on a rollback at all — so it takes a second, committing transaction
    // to make the leak observable.
    expect(g.epoch('Discarded')).toBe(0);
    expect(g.epoch('ghost')).toBe(0);
    expect(g.epoch('Kept')).toBe(1);
    expect(g.version).toBe(1);
  });

  test('a removal bumps the tokens of the element it removed', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'x' } });

    await tick();

    g.removeVertex('a');

    await tick();

    // Read off the element while it is still live — `Graph.emit` captures the tokens at emit
    // time for exactly this reason, since the element's graph ref is nulled before the deferred
    // drain runs. A drain that read them late would throw or see nothing.
    expect(g.epoch('Person')).toBe(2);
    expect(g.version).toBe(2);
  });
});
