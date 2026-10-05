import { describe, expect, test } from 'bun:test';

import { Edge } from './Edge.js';
import { Graph } from './Graph.js';
import { Vertex } from './Vertex.js';

// An element's label set now lives in a BOX that the element caches, so `v.labels` is a field
// load instead of a string-keyed `Map.get` into a map with one entry per element (audit item
// 162). Measured 18.84ms -> 4.10ms over 200,000 vertices testing one label each.
//
// This is the `prop-box.test.ts` suite's twin, and it carries everything that one does plus two
// asymmetries the label path has and the property path does not:
//
//   - a DETACHED `Vertex` throws on `.labels` while a detached `Edge` reads empty. The two have
//     never agreed, and a cached box could silently turn the throw into a successful read.
//   - the returned `Set` is the graph's LIVE, UNFROZEN object (properties are frozen), and the
//     write paths REPLACE it rather than mutate it — so a reference held across a write goes
//     stale. That is the behaviour replacing the map entry used to give, and it is preserved by
//     replacing `box.set` rather than mutating the set in place.
describe('a label write is visible through every instance of the element', () => {
  test('two Vertex instances for one id share the write', () => {
    // `new Vertex({ ..., graph })` outside `addVertex` is a real construction path — `Graph`'s
    // own test suite uses it — so two ATTACHED instances can hold the same id. Caching the SET
    // rather than a box would let the first go stale here, silently.
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    // Read through `first` BEFORE the second instance exists, so its cache is populated and a
    // stale read is possible.
    expect([...first.labels]).toEqual(['P']);

    const second = new Vertex({ id: 'v', labels: ['Q'], graph: g, properties: {} });

    expect([...second.labels]).toEqual(['Q']);
    expect([...first.labels]).toEqual(['Q']);
  });

  test('addLabelToVertex through the second instance reaches the first', () => {
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect([...first.labels]).toEqual(['P']);

    const second = new Vertex({ id: 'v', labels: ['P'], graph: g, properties: {} });

    g.addLabelToVertex('R', second);

    expect([...first.labels]).toEqual(['P', 'R']);
    expect([...second.labels]).toEqual(['P', 'R']);
  });

  test('removeLabelFromVertex through the second instance reaches the first', () => {
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P', 'R'], properties: {} });

    expect([...first.labels]).toEqual(['P', 'R']);

    const second = new Vertex({ id: 'v', labels: ['P', 'R'], graph: g, properties: {} });

    g.removeLabelFromVertex('P', second);

    expect([...first.labels]).toEqual(['R']);
    expect([...second.labels]).toEqual(['R']);
  });

  test('the labels SETTER through one instance reaches the other', () => {
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: {} });
    const second = new Vertex({ id: 'v', labels: ['P'], graph: g, properties: {} });

    expect([...second.labels]).toEqual(['P']);
    first.labels = ['Z'];

    expect([...second.labels]).toEqual(['Z']);
    expect([...first.labels]).toEqual(['Z']);
  });

  test('the SETTER reaches the other instance when the writer has already cached its box', () => {
    // The setter skips the map when it is already holding the box. That shortcut is only sound
    // because the box is SHARED, so mutating it through the writer's own reference is the same
    // write — assigning a fresh box there instead would strand the other instance.
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: {} });
    const second = new Vertex({ id: 'v', labels: ['P'], graph: g, properties: {} });

    // Both read, so both hold the box and the writer takes the shortcut.
    expect([...first.labels]).toEqual(['P']);
    expect([...second.labels]).toEqual(['P']);

    first.labels = ['Z'];

    expect([...second.labels]).toEqual(['Z']);

    // My expectation here was WRONG and the test said so: I assumed the write would drop `v`
    // from the `P` bucket. The raw `labels` SETTER has never maintained `verticesByLabel` —
    // only `addLabelToVertex`/`removeLabelFromVertex` index — so the stale bucket entry is
    // pre-existing behaviour, unchanged by the box. Pinned as-is rather than quietly fixed:
    // that is a separate question from this item.
    expect([...g.getVerticesByLabel('P')].map((x) => x.id)).toEqual(['v']);
  });

  test('the setter shortcut still writes through to the graph map', () => {
    // A write that never reached `elementLabels` would be invisible to anything reading the
    // graph rather than the element — the box must be the SAME object the map holds.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect([...v.labels]).toEqual(['P']);
    v.labels = ['Q'];

    expect([...(g.elementLabels.get('v')?.set ?? [])]).toEqual(['Q']);
  });

  test('two Edge instances for one id share the write', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const first = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect([...first.labels]).toEqual(['E']);

    const second = new Edge({ id: 'e', from: a, to: b, labels: ['F'], graph: g, properties: {} });

    expect([...second.labels]).toEqual(['F']);
    expect([...first.labels]).toEqual(['F']);
  });

  test('addLabelToEdge through the second instance reaches the first', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const first = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect([...first.labels]).toEqual(['E']);

    const second = new Edge({ id: 'e', from: a, to: b, labels: ['E'], graph: g, properties: {} });

    g.addLabelToEdge('F', second);

    expect([...first.labels]).toEqual(['E', 'F']);
  });
});

describe('moving an element to another graph drops the cached label box', () => {
  test('a Vertex reassigned to a new graph does not read the old labels', () => {
    // The box belongs to the FIRST graph's map. Without clearing the cache on reassignment the
    // element would keep reading the old graph's label set.
    const g1 = new Graph();
    const v = g1.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect([...v.labels]).toEqual(['P']);

    const g2 = new Graph();

    v.graph = g2;

    // g2 knows nothing about this id, so there is no set to read.
    expect([...v.labels]).toEqual([]);

    // And the ORIGINAL graph still holds its own value, untouched.
    expect([...(g1.elementLabels.get('v')?.set ?? [])]).toEqual(['P']);
  });

  test('an Edge reassigned to a new graph does not read the old labels', () => {
    const g1 = new Graph();
    const a = g1.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g1.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const e = g1.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect([...e.labels]).toEqual(['E']);

    e.graph = new Graph();

    expect([...e.labels]).toEqual([]);
  });
});

describe('a detached element: the Vertex throws and the Edge reads empty', () => {
  test('an evicted Vertex still THROWS on .labels', () => {
    // `Vertex.labels` dereferences `this.#graph!` where `Edge.labels` uses `?.`, so an evicted
    // vertex has always thrown a raw TypeError here. The cached box must not turn that into a
    // successful read — which is why `evict` clears it.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    // Populate the cache first: that is the only way the box could resurrect the labels.
    expect([...v.labels]).toEqual(['P']);
    g.removeVertex(v);

    expect(() => v.labels).toThrow(TypeError);
  });

  test('an evicted Vertex that was NEVER read also throws', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    g.removeVertex(v);

    expect(() => v.labels).toThrow(TypeError);
  });

  test('an evicted Edge reads as an empty set', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect([...e.labels]).toEqual(['E']);
    g.removeEdge(e);

    expect([...e.labels]).toEqual([]);
  });
});

describe('the returned set is live, and a held reference goes stale as it always did', () => {
  test('a reference held across addLabel does NOT see the new label', () => {
    // The write paths build a fresh `Set` and REPLACE `box.set`, exactly as they replaced the
    // map entry before. A box that mutated its set in place would make this reference update —
    // a behaviour change, not an optimization.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });
    const held = v.labels;

    g.addLabelToVertex('R', v);

    expect([...held]).toEqual(['P']);
    expect([...v.labels]).toEqual(['P', 'R']);
  });

  test('a reference held across the SETTER does not see the new labels either', () => {
    // The `addLabel` case above went through the graph's funnel; this one goes through the
    // setter's own shortcut, which is a separate piece of code and was NOT covered — a mutant
    // that made the shortcut mutate the set in place survived the whole 201-test suite until
    // this test existed. Before the box the setter did `elementLabels.set(id, new Set(...))`,
    // so a held reference went stale; it still must.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });
    const held = v.labels;

    v.labels = ['Q'];

    expect([...held]).toEqual(['P']);
    expect([...v.labels]).toEqual(['Q']);
  });

  test('a reference held across an Edge setter write does not see the new labels', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    const held = e.labels;

    e.labels = ['F'];

    expect([...held]).toEqual(['E']);
    expect([...e.labels]).toEqual(['F']);
  });

  test('the getter hands back the graph live object, and a write through it is visible', () => {
    // Labels are NOT frozen the way properties are, so this is reachable today. Pinned because
    // it is the one place the box's identity is observable from outside.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect(v.labels).toBe(v.labels);
    v.labels.add('X');

    expect([...v.labels]).toEqual(['P', 'X']);
  });
});

describe('the label index and the multi-type edge count still track the box', () => {
  test('verticesByLabel agrees with a read through a second instance', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });
    const alias = new Vertex({ id: 'v', labels: ['P'], graph: g, properties: {} });

    g.addLabelToVertex('R', alias);

    expect([...v.labels]).toEqual(['P', 'R']);
    expect([...g.getVerticesByLabel('R')].map((x) => x.id)).toEqual(['v']);
  });

  test('multiTypeEdgeCount still sees the 1 -> 2 -> 1 transitions', () => {
    // `addLabelToEdge` decides this from `next.size`, which is computed from a read of the box.
    // A box bug that lost a label would silently re-arm an O(1) count shortcut that is not safe.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(g.multiTypeEdgeCount).toBe(0);

    g.addLabelToEdge('F', e);
    expect(g.multiTypeEdgeCount).toBe(1);
    expect([...e.labels]).toEqual(['E', 'F']);

    g.removeLabelFromEdge('F', e);
    expect(g.multiTypeEdgeCount).toBe(0);
    expect([...e.labels]).toEqual(['E']);
  });

  test('a rolled-back label add leaves the box as it was', () => {
    // The undo path replays through `removeLabelFromVertex`, which reads and writes the box.
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect(() => {
      g.transaction(() => {
        g.addLabelToVertex('R', v);
        expect([...v.labels]).toEqual(['P', 'R']);

        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect([...v.labels]).toEqual(['P']);
  });
});
