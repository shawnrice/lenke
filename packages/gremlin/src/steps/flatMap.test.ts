import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, flatMap, hasLabel, out, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('flatMap tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc-style: g.V(1).flatMap(out()).values('name')
  // marko's neighbors: lop, vadas, josh.
  test('flatMap expands each traverser via the sub-plan', () => {
    const r = arr(run(traversal(V('1'), flatMap(out()), values('name')), tinkerGraph));
    expect(r.sort()).toEqual(['josh', 'lop', 'vadas']);
  });

  // flatMap drops traversers whose sub-plan is empty.
  test('flatMap drops traversers when sub-plan yields nothing', () => {
    // Software vertices have no out().
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), flatMap(out())), tinkerGraph));
    expect(r).toEqual([]);
  });

  // flatMap with values('name') over persons mirrors values directly.
  test('flatMap(values) is equivalent to values for single-value props', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), flatMap(values('name'))), tinkerGraph));
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  // flatMap can yield multiple outputs per input traverser.
  test('flatMap can yield many per input', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), flatMap(out('CREATED')), values('name')), tinkerGraph),
    );
    // marko -> lop; josh -> ripple, lop; peter -> lop.
    expect(r.sort()).toEqual(['lop', 'lop', 'lop', 'ripple']);
  });
});
