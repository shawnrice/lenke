import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, count, fold, hasLabel, inV, local, out, outE, pipe, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('local tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().local(pipe(outE(), inV())).path() — paths kept per-traverser.
  // We assert the output set: every (vertex, out-neighbor) pair the doc query
  // implies, but flat instead of via path() (path() across a `local` boundary
  // is its own concern).
  test('local(pipe(outE(), inV())) yields out-neighbors per traverser', () => {
    const r = arr(run(traversal(V(), local(pipe(outE(), inV())), values('name')), tinkerGraph));
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'lop', 'lop', 'ripple', 'vadas']);
  });

  // local() with a barrier-style aggregate sub-plan: count per traverser.
  test('local(pipe(out(), count())) yields out-degree per starting vertex', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), local(pipe(out(), count()))), tinkerGraph),
    );
    // marko has 3 out, josh has 2, vadas/peter have 1/0+1. Order = vertex insertion: marko, vadas, josh, peter.
    expect(r).toEqual([3, 0, 2, 1]);
  });

  // `Scope.local` on limit/range/take IS supported in v2 — covered by the
  // limit(Scope.local) / range(Scope.local) tests in steps/limit.test.ts.

  // local(fold) bundles each per-traverser sub-plan output into its own list.
  test('local(out().fold()) yields a per-vertex list of out-neighbors', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), local(pipe(out(), fold()))), tinkerGraph),
    ) as Array<unknown[]>;
    // Sizes per person in insertion order: marko=3, vadas=0, josh=2, peter=1.
    expect(r.map((bag) => bag.length)).toEqual([3, 0, 2, 1]);
  });

  // Suppress unused-import lint
  void inV;
});
