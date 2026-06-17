import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, filter, is, label, out, pipe, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('filter tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().filter(label().is('person')) — v[1]; v[2]; v[4]; v[6]
  test('filter keeps traversers whose sub-traversal yields a value', () => {
    const r = arr(
      run(traversal(V(), filter(pipe(label(), is(eq('PERSON')))), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });

  // doc-style: g.V().filter(out('CREATED')).values('name') — marko; josh; peter
  // (filter keeps traversers whose sub-plan emits at least one result)
  test('filter with sub-plan keeps vertices that have an outgoing CREATED edge', () => {
    const r = arr(run(traversal(V(), filter(out('CREATED')), values('name')), tinkerGraph));
    expect(r).toEqual(['marko', 'josh', 'peter']);
  });

  // doc-style: g.V().filter{it.get().value('name').length()<5} — names < 5 chars
  // Closure form: keep vertices whose name has fewer than 5 characters.
  test('filter with closure (name length < 5)', () => {
    const r = arr(
      run(
        traversal(
          V(),
          filter(
            (v: unknown) => (v as { properties: { name: string } }).properties.name.length < 5,
          ),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // marko=5, vadas=5, josh=4, peter=5, lop=3, ripple=6 → keep josh, lop.
    expect((r as string[]).sort()).toEqual(['josh', 'lop']);
  });
});
