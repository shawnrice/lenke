import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { containing, endingWith, notContaining, regex, startsWith } from '../predicates.js';
import { V, has, hasLabel, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('TextP predicate tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().has('name', containing('o')) — marko, josh, lop  (vadas, ripple, peter excluded)
  test('containing("o") matches marko, josh, lop', () => {
    const r = arr(run(traversal(V(), has('name', containing('o')), values('name')), tinkerGraph));
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'marko']);
  });

  test('notContaining("o") matches vadas, ripple, peter', () => {
    const r = arr(
      run(traversal(V(), has('name', notContaining('o')), values('name')), tinkerGraph),
    );
    expect((r as string[]).sort()).toEqual(['peter', 'ripple', 'vadas']);
  });

  // doc: g.V().has('person','name', endingWith('o')) — marko
  test('endingWith("o") matches only marko', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('name', endingWith('o')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // doc: g.V().has('person','name', regex('r')).values('name') — marko; peter
  test('regex("r") matches marko and peter', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), has('name', regex('r')), values('name')), tinkerGraph),
    );
    expect((r as string[]).sort()).toEqual(['marko', 'peter']);
  });

  // doc: g.V().has('person', 'name', regex('peter')).values('name') — peter
  test('regex anchored-substring "peter" matches only peter', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('name', regex('peter')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['peter']);
  });

  // doc: g.V().has('person', 'name', regex('r$')).values('name') — peter
  test('regex with end anchor "r$" matches only peter', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('name', regex('r$')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['peter']);
  });

  // doc-style: g.V().has('person', 'name', startingWith('m'))
  test('startsWith("m") matches only marko', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('name', startsWith('m')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // regex with anchor for short single-letter names — ripple ends with 'e'
  test('regex("e$") matches names ending in e', () => {
    const r = arr(run(traversal(V(), has('name', regex('e$')), values('name')), tinkerGraph));
    expect((r as string[]).sort()).toEqual(['ripple']);
  });
});
