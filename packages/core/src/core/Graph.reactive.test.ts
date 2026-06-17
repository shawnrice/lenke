import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

// The version/epoch bump is deferred to the same microtask as snapshot
// staleness (so it sees the final `defaultPrevented`), so tests flush first.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('Graph reactive change tracking', () => {
  test('mutations bump the global version; reads do not', async () => {
    const graph = new Graph();
    expect(graph.version).toBe(0);

    graph.addVertex({ labels: ['Person'], properties: { name: 'ann', age: 30 } });
    await flush();
    const afterAdd = graph.version;
    expect(afterAdd).toBeGreaterThan(0);

    // a read is not a mutation
    [...graph.vertices];
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
