import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, aggregate, cap, hasLabel, identity, out, pipe, sideEffect, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('sideEffect tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().hasLabel('person').sideEffect(System.out.&println) — pass-through.
  test('sideEffect with identity is transparent', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('SOFTWARE'), sideEffect(identity()), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['lop', 'ripple']);
  });

  test('sideEffect with a wider sub-plan does not multiply or drop traversers', () => {
    const r = arr(run(traversal(V(), sideEffect(out()), values('name')), tinkerGraph));
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter', 'lop', 'ripple']);
  });

  test('sideEffect with an empty (no-result) sub-plan still passes through', () => {
    // out().out() from a leaf vertex yields no results; sideEffect must still
    // pass the original traverser through unchanged.
    const r = arr(
      run(traversal(V('5'), sideEffect(pipe(out(), out())), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['ripple']);
  });

  // sideEffect's sub-plan can include aggregate; cap later reads the bag.
  // Verifies sideEffect drains its inner stream so the bag actually fills.
  test('sideEffect(aggregate) populates the bag; cap reads it back', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), sideEffect(aggregate('persons')), cap('persons')),
        tinkerGraph,
      ),
    );
    const bag = (r[0] as Array<{ id: string }>).map((v) => v.id).sort();
    expect(bag).toEqual(['1', '2', '4', '6']);
  });

  // doc: g.V().sideEffect(_ -> println(_)) — closure form for observation.
  test('sideEffect(closure) observes each traverser without altering the stream', () => {
    const seen: string[] = [];
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          sideEffect((v: unknown) => {
            seen.push((v as { properties: { name: string } }).properties.name);
          }),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
    expect(seen).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });

  test('sideEffect from a single root preserves identity', () => {
    const r = arr(
      run(traversal(V('1'), sideEffect(pipe(out(), out())), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko']);
  });
});
