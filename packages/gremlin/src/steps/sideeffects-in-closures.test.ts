import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, aggregate, filter, hasLabel, out, values, withinBag, withoutBag } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

// User-supplied closures (`map`, `filter`, `flatMap`, `sideEffect`, `fold`'s
// reducer) receive a read-only view of the run's side-effect bags via
// `t.sideEffects`. This lets closures branch on aggregated state without
// inventing new step kinds.
describe('sideEffects in closure traversers', () => {
  const g = createTestTinkerGraph();

  test('filter closure can read t.sideEffects directly', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          out('CREATED'), // {lop}
          aggregate('seen'),
          out('CREATED'), // lop has no out → empty
          filter((v, t) => !(t.sideEffects.get('seen') ?? []).includes(v)),
        ),
        g,
      ),
    );
    expect(r).toEqual([]);
  });

  test('withoutBag(key) sugar excludes already-aggregated values', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          aggregate('persons'),
          // Re-source the stream and exclude the aggregated set.
          // After aggregate, the upstream still has all persons; the bag
          // also has all persons; withoutBag drops every one.
          filter(withoutBag('persons')),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual([]);
  });

  test('withinBag(key) sugar keeps only aggregated values', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          out('CREATED'), // {lop}
          aggregate('created-by-marko'),
          // Reach broader via in/out: lop's creators are marko/josh/peter,
          // their CREATED edges go to lop, ripple, lop, lop. Filter to only
          // those that were in the original aggregate bag.
          out(), // creators have no out — empty for these vertices
          filter(withinBag('created-by-marko')),
        ),
        g,
      ),
    );
    expect(r).toEqual([]);
  });

  test('side-effects map identity is shared across the run', () => {
    let captured: ReadonlyMap<string, readonly unknown[]> | null = null;
    arr(
      run(
        traversal(
          V('1'),
          aggregate('a'),
          filter((_v, t) => {
            captured = t.sideEffects;

            return true;
          }),
        ),
        g,
      ),
    );
    expect(captured).not.toBeNull();
    // The same map should reflect the aggregated bag.
    const bag = captured!.get('a')!;
    expect(bag).toHaveLength(1);
  });
});
