import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

// The version/epoch bump is deferred to a microtask (so a burst of mutations
// coalesces into one notify), so tests flush first.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

// Subscriber `notify()` is debounced behind a timer (scheduled from inside the
// deferred bump), so it lands a tick after the version/epoch flush — settle a
// little longer before asserting on subscriber calls.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('Graph reactive change tracking', () => {
  test('mutations bump the global version; reads do not', async () => {
    const graph = new Graph();
    expect(graph.version).toBe(0);

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann', age: 30 } });
    await flush();
    const afterAdd = graph.version;
    expect(afterAdd).toBeGreaterThan(0);

    // a read is not a mutation
    void [...graph.vertices];
    await flush();
    expect(graph.version).toBe(afterAdd);
  });

  test('adding an element bumps its label and property-key epochs', async () => {
    const graph = new Graph();
    graph.addVertex({ labels: ['Person'], properties: { name: 'ann', age: 30 } });
    await flush();
    expect(graph.epoch('Person')).toBeGreaterThan(0);
    expect(graph.epoch('name')).toBeGreaterThan(0);
    expect(graph.epoch('age')).toBeGreaterThan(0);
    expect(graph.epoch('Never')).toBe(0); // untouched token
  });

  test('a property write bumps only that key (finer than the global version)', async () => {
    const graph = new Graph();
    const v = graph.addVertex({ labels: ['Person'], properties: { name: 'ann', age: 30 } });
    await flush();

    const { version } = graph;
    const person = graph.epoch('Person');
    const age = graph.epoch('age');
    const name = graph.epoch('name');

    v.setProperty('age', 31);
    await flush();

    expect(graph.version).toBeGreaterThan(version); // global always moves
    expect(graph.epoch('age')).toBeGreaterThan(age); // the written key moves
    expect(graph.epoch('Person')).toBe(person); // label NOT moved by a value write
    expect(graph.epoch('name')).toBe(name); // unrelated key NOT moved
  });

  test('removing an element bumps the removed element’s tokens (no throw)', async () => {
    const graph = new Graph();
    const v = graph.addVertex({ labels: ['Doomed'], properties: { tag: 'x' } });
    await flush();
    const doomed = graph.epoch('Doomed');
    const tag = graph.epoch('tag');

    graph.removeVertex(v);
    await flush();

    expect(graph.epoch('Doomed')).toBeGreaterThan(doomed);
    expect(graph.epoch('tag')).toBeGreaterThan(tag);
  });
});

describe('Graph subscriber notification', () => {
  test('subscribers are notified after a mutation', async () => {
    const graph = new Graph();
    let fired = 0;
    graph.subscribe(() => {
      fired += 1;
    });

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });
    await settle();

    expect(fired).toBe(1);
  });

  test('many mutations in a tick coalesce into a single notification', async () => {
    const graph = new Graph();
    let fired = 0;
    graph.subscribe(() => {
      fired += 1;
    });

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });
    graph.addVertex({ labels: ['Person'], properties: { name: 'bob' } });
    graph.addVertex({ labels: ['Person'], properties: { name: 'cat' } });
    await settle();

    expect(fired).toBe(1); // debounced
  });

  test('unsubscribe stops further notifications', async () => {
    const graph = new Graph();
    let fired = 0;
    const unsubscribe = graph.subscribe(() => {
      fired += 1;
    });

    unsubscribe();
    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });
    await settle();

    expect(fired).toBe(0);
  });

  test('a throwing subscriber is isolated: the others still run', async () => {
    const errors: unknown[] = [];
    const graph = new Graph({ onError: (e) => errors.push(e) });

    const calls: string[] = [];
    const boom = new Error('boom');
    graph.subscribe(() => calls.push('a'));
    graph.subscribe(() => {
      throw boom;
    });
    graph.subscribe(() => calls.push('c'));

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });
    await settle();

    expect(calls).toEqual(['a', 'c']); // the thrower did not stop the others
    expect(errors).toEqual([boom]); // surfaced via onError, not swallowed
  });

  test('a subscriber that unsubscribes mid-notification does not corrupt the pass', async () => {
    const graph = new Graph();
    const calls: string[] = [];
    // `a` removes `b` while the snapshot is being walked; `b` must still be
    // safe to skip and `c` must still run.
    let unsubscribeB = (): void => {};
    graph.subscribe(() => {
      calls.push('a');
      unsubscribeB();
    });
    unsubscribeB = graph.subscribe(() => calls.push('b'));
    graph.subscribe(() => calls.push('c'));

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });
    await settle();

    expect(calls).toEqual(['a', 'b', 'c']); // snapshot taken before the pass
  });
});

// Since audit item 171 a write with NOBODY subscribed does not schedule a notification — there
// is nothing to notify, and the `clearTimeout`/`setTimeout` pair per write was pure cost. A small
// write went 461ns to 262ns (92.2ms to 52.3ms over 200,000 writes), with the SUBSCRIBED case flat
// at 453 against 456ns as the control.
//
// What must not change: the reactive counters, which are public (`version`, `epoch`) and pollable
// without ever subscribing; and a real subscriber's notification.
describe('a write with no subscriber still tracks, and still notifies once one exists', () => {
  test('version and epochs advance with NOBODY subscribed', () => {
    // The guard skips only the notify SCHEDULING. If it skipped the bookkeeping, a caller
    // polling `version` would never see a change — and nothing would fail except their code.
    const graph = new Graph();

    expect(graph.version).toBe(0);
    graph.addVertex({ labels: ['Person'], properties: { name: 'ann' } });

    return flush().then(() => {
      expect(graph.version).toBeGreaterThan(0);
      expect(graph.epoch('Person')).toBeGreaterThan(0);
      expect(graph.epoch('name')).toBeGreaterThan(0);
    });
  });

  test('a subscriber added AFTER a write is notified by the NEXT write', async () => {
    // This is the behaviour the guard changes, pinned deliberately: the earlier write scheduled
    // nothing, so the late subscriber is not told about it. That is owed to nobody — `subscribe`
    // does not notify on subscribe, so a subscriber reads its first snapshot on subscribing and
    // already sees that write. The next write must still reach it.
    const graph = new Graph();

    graph.addVertex({ id: 'early', labels: ['Person'], properties: {} });
    await settle();

    let calls = 0;

    graph.subscribe(() => {
      calls += 1;
    });

    // Nothing was pending for the write that happened before subscribing.
    await settle();
    expect(calls).toBe(0);

    graph.addVertex({ id: 'later', labels: ['Person'], properties: {} });
    await settle();
    expect(calls).toBeGreaterThan(0);
  });

  test('a subscriber present BEFORE the write is notified, as always', async () => {
    const graph = new Graph();
    let calls = 0;

    graph.subscribe(() => {
      calls += 1;
    });

    graph.addVertex({ labels: ['Person'], properties: {} });
    await settle();

    expect(calls).toBeGreaterThan(0);
  });

  test('unsubscribing mid-stream stops the scheduling without losing the counters', async () => {
    const graph = new Graph();
    let calls = 0;
    const off = graph.subscribe(() => {
      calls += 1;
    });

    graph.addVertex({ id: 'a', labels: ['Person'], properties: {} });
    await settle();

    const seen = calls;

    expect(seen).toBeGreaterThan(0);
    off();

    graph.addVertex({ id: 'b', labels: ['Person'], properties: {} });
    await settle();

    // No further notification, but the version kept moving.
    expect(calls).toBe(seen);
    expect(graph.version).toBeGreaterThan(0);
    expect(graph.vertexCount).toBe(2);
  });

  test('a burst still coalesces into one notification', async () => {
    // The debounce is the reason the scheduling exists at all; the guard must not have turned it
    // into a notify-per-write for the subscribed case.
    const graph = new Graph();
    let calls = 0;

    graph.subscribe(() => {
      calls += 1;
    });

    for (let i = 0; i < 50; i++) {
      graph.addVertex({ id: `b${i}`, labels: ['Person'], properties: {} });
    }

    await settle();

    expect(calls).toBe(1);
  });

  test('two subscribers are both notified', async () => {
    const graph = new Graph();
    let a = 0;
    let b = 0;

    graph.subscribe(() => {
      a += 1;
    });
    graph.subscribe(() => {
      b += 1;
    });

    graph.addVertex({ labels: ['Person'], properties: {} });
    await settle();

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});
