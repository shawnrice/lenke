import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

// The version/epoch bump is deferred to the same microtask as snapshot
// staleness (so it sees the final `defaultPrevented`), so tests flush first.
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
