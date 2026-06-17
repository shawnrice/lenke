import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import {
  V,
  addV,
  choose,
  count,
  filter,
  hasLabel,
  is,
  label,
  map,
  pipe,
  property,
  repeat,
  union,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

// In TinkerPop, anywhere a sub-traversal is expected, both anonymous (`__`)
// and rooted (`g`) traversals are accepted. Mirror that here: every sub-plan
// combinator takes either a `Plan` (from `traversal(...)`) or a branded
// `StepFn` (from `pipe(...)` or any single-step constructor).
describe('sub-plan combinators accept both Plan and StepFn', () => {
  const g = createTestTinkerGraph();

  test('filter: traversal() and pipe() are interchangeable', () => {
    const a = arr(run(traversal(V(), filter(traversal(label(), is(eq('PERSON'))))), g)) as Array<{
      id: string;
    }>;
    const b = arr(run(traversal(V(), filter(pipe(label(), is(eq('PERSON'))))), g)) as Array<{
      id: string;
    }>;
    expect(a.map((v) => v.id).sort()).toEqual(b.map((v) => v.id).sort());
    expect(a).toHaveLength(4);
  });

  test('where: traversal() form works (was StepFn-only)', () => {
    const r = arr(
      run(traversal(V(), where(traversal(label(), is(eq('PERSON')))), values('name')), g),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('union: traversal() variants merge correctly', () => {
    const r = arr(
      run(traversal(V('1'), union(traversal(values('name')), traversal(values('age')))), g),
    );
    expect(r.sort()).toEqual([29, 'marko']);
  });

  test('choose: traversal() in test/then/else slots', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          choose(
            traversal(values('age'), is(eq(29))),
            traversal(values('name')),
            traversal(values('age')),
          ),
        ),
        g,
      ),
    );
    // marko (29): then-branch yields 'marko'. Others: else-branch yields ages.
    expect(r.sort()).toEqual([27, 32, 35, 'marko']);
  });

  test('repeat: traversal() body works (the original footgun)', () => {
    const before = g.vertexCount;
    arr(run(traversal(V('1'), repeat(traversal(addV('REP'), property('via', 'rep'))).times(2)), g));
    expect(g.vertexCount).toBe(before + 2);
  });

  test('map: traversal() works without forcing a pipe wrapper', () => {
    const localG = createTestTinkerGraph();
    const before = localG.vertexCount;
    arr(
      run(
        traversal(V(), hasLabel('PERSON'), map(traversal(addV('SHADOW'), property('via', 'map')))),
        localG,
      ),
    );
    expect(localG.vertexCount).toBe(before + 4);
  });

  test('repeat.until/.emit: traversal() forms also accepted', () => {
    const localG = createTestTinkerGraph();
    const r = arr(
      run(
        traversal(
          V('1'),
          repeat(traversal(/* identity body */))
            .until(traversal(count(), is(eq(0))))
            .times(0),
        ),
        localG,
      ),
    );
    // smoke test: doesn't throw
    expect(Array.isArray(r)).toBe(true);
  });
});
