import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, fold, in_, out, unfold, union, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('union tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().union(fold(),fold()).unfold().values('name')
  // — marko;marko;vadas;vadas;lop;lop;josh;josh;ripple;ripple;peter;peter
  // (each vertex appears twice via two fold() branches).
  test('union runs each sub-plan and merges outputs', () => {
    const r = arr(
      run(traversal(V(), union(fold(), fold()), unfold(), values('name')), tinkerGraph),
    );
    // v2 order: marko, vadas, josh, peter, lop, ripple — each twice.
    // union concatenates: first all-folded run, then second.
    // v2 union is interleaved per-traverser: each input vertex emits both
    // sub-plan results back-to-back. So the sequence is
    // marko,marko,vadas,vadas,josh,josh,peter,peter,lop,lop,ripple,ripple.
    expect(r).toEqual([
      'marko',
      'marko',
      'vadas',
      'vadas',
      'josh',
      'josh',
      'peter',
      'peter',
      'lop',
      'lop',
      'ripple',
      'ripple',
    ]);
  });

  // legacy: g.V('4').union(in_(), out()).values('age', 'lang') — 29, java, java
  // josh's in: marko (age 29). josh's out: ripple, lop (lang java).
  test('union of in_() and out() emits both', () => {
    const r = arr(
      run(
        traversal(V('4'), union(in_(), out()), values('age', 'lang')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual([29, 'java', 'java']);
  });
});
