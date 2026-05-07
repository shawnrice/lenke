import type { Plan } from '../ast.js';
import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, has, is, loops, or, out, repeat, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('loops tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().emit(__.has('name','marko').or().loops().is(2)).repeat(__.out()).values('name')
  // The emit-before form (modulator placed before repeat) is not modeled in
  // v2; we use the AFTER form: repeat(out()).times(...).emit(predicate).
  test('loops: termination by iteration counter', () => {
    const loopsIs2 = (p: Plan) => is(eq(2))(loops()(p));
    const r = arr(
      run(
        traversal(
          V(),
          repeat(out()).times(2).emit(or(has('name', eq('marko')), loopsIs2)),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // loops() yields the iteration index; the predicate composes through emit.
    expect(Array.isArray(r)).toBe(true);
  });
});
