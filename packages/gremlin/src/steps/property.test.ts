import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Cardinality, V, hasLabel, property, valueMap, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('property() mutation', () => {
  // doc: g.V(1).property('city','santa fe').property('state','new mexico').valueMap()
  test('writes a single property and chains', () => {
    const g = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V('1'),
          property('city', 'santa fe'),
          property('state', 'new mexico'),
          valueMap('city', 'state'),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ city: 'santa fe', state: 'new mexico' }]);
    // mutation persisted on the graph
    expect(g.getVertexById('1')!.properties.city).toBe('santa fe');
  });

  test('property() with explicit Cardinality.single overwrites', () => {
    const g = createTestTinkerGraph();
    arr(run(traversal(V('1'), property(Cardinality.single, 'name', 'MARKO!')), g));
    expect(g.getVertexById('1')!.properties.name).toBe('MARKO!');
  });

  test('property() on a non-element value silently drops the traverser', () => {
    const g = createTestTinkerGraph();
    const r = arr(run(traversal(V(), values('age'), property('foo', 'bar')), g));
    expect(r).toEqual([]);
  });

  test('property() works on edges', () => {
    const g = createTestTinkerGraph();
    const [edge] = [...g.edges];
    const r = arr(run(traversal(V(), hasLabel('PERSON'), property('seen', true)), g));
    expect(r.length).toBeGreaterThan(0);
    // The edge wasn't visited so unchanged.
    expect(edge.properties.seen).toBeUndefined();

    // But every PERSON vertex got the new property.
    for (const v of g.vertices) {
      if (v.labels.has('PERSON')) {
        expect(v.properties.seen).toBe(true);
      }
    }
  });
});
