/* eslint-disable yoda */
import { describe, expect, mock, test } from 'bun:test';

import { ErrorCode, hasErrorCode } from '@pl-graph/errors';

import { createTestGraph, edgeId, vertexId } from '../fixtures/createTestGraph.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Vertex } from './Vertex.js';

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }

  return undefined;
};

describe('Graph Tests', () => {
  const graph = createTestGraph();

  test('it can get Gene Hackman by id', () => {
    expect(graph.getVertexById(vertexId('89'))!.properties.name).toBe('Gene Hackman');
  });

  test('it can get an edge by id', () => {
    const edge = graph.getEdgeById(edgeId('130'))!;
    expect(edge.from.properties.name).toBe('Gene Hackman');
    expect(edge.hasLabel('ACTED_IN')).toBeTruthy();
    expect((edge.getProperty('roles') as string[])[0]).toBe('Little Bill Daggett');
    expect(edge.to.properties.title).toBe('Unforgiven');
    expect(edge.to.properties.released).toBe(1992);
  });

  test('We can filter manually', () => {
    // Note, this is us using the indices manually, which isn't the best practice
    const moviesFromTheEarlyMidNineties = Array.from(graph.getVerticesByLabel('Movie'))
      .filter((x) => {
        const released = x.properties.released as number;

        if (!released) {
          return false;
        }

        return 1992 <= released && released < 1995;
      })
      .map((x) => x.properties.title);

    expect(moviesFromTheEarlyMidNineties).toEqual([
      'A Few Good Men',
      'Sleepless in Seattle',
      'Unforgiven',
      'Hoffa',
      'A League of Their Own',
    ]);
  });

  test('We can manually walk from a node', () => {
    const unforgiven = graph.getVertexById(vertexId('97'))!;
    const [{ from }] = unforgiven.edgesToByLabel('DIRECTED');
    expect(from.properties.name).toBe('Clint Eastwood');
  });

  test('we get an empty set for a non-existent label', () => {
    const unforgiven = graph.getVertexById(vertexId('97'))!;
    expect(Array.from(unforgiven.edgesToByLabel('This Label Does Not Exist'))).toEqual([]);
  });

  test('we can walk the other way', () => {
    const clientEastwood = graph.getVertexById(vertexId('99'))!;
    expect(clientEastwood.properties.name).toBe('Clint Eastwood');
    const movies = clientEastwood.edgesFromByLabel('DIRECTED');

    const [unforgiven] = Array.from(movies)
      .filter((x) => x.to.id === vertexId('97'))
      .map((x) => x.to);
    expect(unforgiven?.properties.title).toBe('Unforgiven');
  });

  test('we can add labels and then get them', () => {
    const apollo13 = graph.getVertexById(vertexId('142'))!;
    expect(apollo13.properties.title).toBe('Apollo 13');
    expect(apollo13.labels.size).toBe(1);
    expect(apollo13.labels.values().next().value).toBe('Movie');
    apollo13.addLabel('Space');
    expect(apollo13.labels.size).toBe(2);
    expect(graph.getVerticesByLabel('Space').values().next().value).toBe(apollo13);
    apollo13.removeLabel('Space');
    expect(apollo13.labels.size).toBe(1);
    expect(Array.from(graph.getVerticesByLabel('Space'))).toHaveLength(0);
  });

  test('the emitter works', () => {
    // Capture into an object: reads of `captured.type`/`.id` use the declared
    // property type, sidestepping the control-flow narrowing-to-`null` that a
    // `let` assigned only inside this listener closure would suffer.
    const captured: { type: string | null; id: string | null } = { type: null, id: null };
    const listener = mock((event) => {
      captured.type = event.type;
      captured.id = event.value.id;
    });
    graph.emitter.once('@graph/VertexAdded', listener);

    graph.enableEvents();

    graph.addVertex({
      id: '99999',
      labels: ['Movie'],
      properties: { a: 1 },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(captured.type).toBe('@graph/VertexAdded');
    expect(captured.id).toBe('99999');
  });

  test('we can double-up on the once emitters', () => {
    // vi.useFakeTimers();
    const tinkerGraph = createTestTinkerGraph();
    // vi.runOnlyPendingTimers();

    const vertexAdded = mock(() => {});
    const vertexAddedOnce = mock(() => {});
    const vertexAddedOnce2 = mock(() => {});
    const vertexRemoved = mock(() => {});
    const edgeAdded = mock(() => {});
    const edgeRemoved = mock(() => {});

    tinkerGraph.emitter.on('@graph/VertexAdded', vertexAdded);

    tinkerGraph.emitter.once('@graph/VertexAdded', vertexAddedOnce);
    tinkerGraph.emitter.once('@graph/VertexAdded', vertexAddedOnce2);
    tinkerGraph.emitter.once('@graph/VertexRemoved', vertexRemoved);
    tinkerGraph.emitter.on('@graph/EdgeAdded', edgeAdded);
    tinkerGraph.emitter.on('@graph/EdgeRemoved', edgeRemoved);

    const v = tinkerGraph.addVertex({
      id: '99999',
      labels: ['Movie'],
      properties: { a: 1 },
    });

    const v2 = tinkerGraph.addVertex({
      id: '999999',
      labels: ['Movie'],
      properties: { a: 1 },
    });

    tinkerGraph.addEdge({ from: v, to: v2, labels: ['Not Real'], properties: {} });
    tinkerGraph.removeVertex(v);
    tinkerGraph.removeVertex(v2);

    expect(vertexAdded).toHaveBeenCalledTimes(2);
    expect(vertexAddedOnce).toHaveBeenCalledTimes(1);
    expect(vertexAddedOnce2).toHaveBeenCalledTimes(1);
    expect(vertexRemoved).toHaveBeenCalledTimes(1);
    expect(edgeAdded).toHaveBeenCalledTimes(1);
    expect(edgeRemoved).toHaveBeenCalledTimes(1);
  });

  test('addEdge rejects a label-less edge (removal-cascade invariant)', () => {
    const g = createTestTinkerGraph();
    const a = g.getVertexById('1')!;
    const b = g.getVertexById('2')!;

    // A label-less edge would never land in a label bucket, so removeVertex
    // could not cascade it — reject it up front with a coded error.
    const err = thrownBy(() => g.addEdge({ from: a, to: b, labels: [], properties: {} }));
    expect(hasErrorCode(err, ErrorCode.InvalidGraphOp)).toBe(true);
  });

  test('addEdge throws on a missing endpoint and leaves no orphaned state', () => {
    const g = createTestTinkerGraph();
    const a = g.getVertexById('1')!;
    const stranger = new Vertex({ id: 'not-in-graph', labels: ['X'], properties: {}, graph: g });

    const edgesBefore = g.edgeCount;
    const propBagsBefore = g.elementProperties.size;

    const err = thrownBy(() =>
      g.addEdge({ from: a, to: stranger, labels: ['KNOWS'], properties: { w: 1 } }),
    );
    expect(hasErrorCode(err, ErrorCode.MissingVertex)).toBe(true);

    // Validation happens before construction, so the rejected edge wrote no
    // labels/properties into the graph's element maps.
    expect(g.edgeCount).toBe(edgesBefore);
    expect(g.elementProperties.size).toBe(propBagsBefore);
  });

  describe('clone is a fully independent deep copy', () => {
    test('mutating a clone does not corrupt the source (and vice versa)', () => {
      const g = createTestTinkerGraph();
      const clone = g.clone();

      clone.getVertexById('1')!.setProperty('name', 'CHANGED');
      expect(g.getVertexById('1')!.properties.name).toBe('marko'); // source untouched

      g.getVertexById('2')!.setProperty('name', 'ALSO-CHANGED');
      expect(clone.getVertexById('2')!.properties.name).toBe('vadas'); // clone untouched
    });

    test('clone holds distinct element instances with equal content', () => {
      const g = createTestTinkerGraph();
      const clone = g.clone();

      expect(clone.getVertexById('1')).not.toBe(g.getVertexById('1')); // not aliased
      expect(clone.vertexCount).toBe(g.vertexCount);
      expect(clone.edgeCount).toBe(g.edgeCount);
      expect(clone.getVertexById('1')!.properties).toEqual(g.getVertexById('1')!.properties);

      // Removing from the clone leaves the source intact.
      clone.removeVertex('1');
      expect(clone.getVertexById('1')).toBeNull();
      expect(g.getVertexById('1')).not.toBeNull();
    });
  });

  describe('the property bag is frozen against external mutation', () => {
    test('a stray top-level write throws instead of silently corrupting', () => {
      const g = createTestTinkerGraph();
      const v = g.getVertexById('1')!;

      // Strict mode (ES module): assigning to a frozen object throws.
      expect(() => {
        (v.properties as { name: string }).name = 'CHANGED';
      }).toThrow();

      // The legitimate path still works and keeps the index/value consistent.
      v.setProperty('name', 'CHANGED');
      expect(v.properties.name).toBe('CHANGED');
    });
  });
});
