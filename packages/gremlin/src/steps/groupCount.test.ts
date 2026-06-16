import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, groupCount, hasLabel, label, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('STEP, groupCount', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().hasLabel('person').values('age').groupCount() — [32:1,35:1,27:1,29:1]
  test('counts occurrences of each value', () => {
    const result = arr(run(traversal(V(), hasLabel('PERSON'), values('age'), groupCount()), g));
    const map = result[0] as Map<unknown, number>;
    expect(map).toBeInstanceOf(Map);
    expect(map.get(29)).toBe(1);
    expect(map.get(27)).toBe(1);
    expect(map.get(32)).toBe(1);
    expect(map.get(35)).toBe(1);
  });

  // doc-ish: groupCount over a 'lang' property — only software vertices have it.
  test('groupCount by property name', () => {
    const result = arr(run(traversal(V(), hasLabel('SOFTWARE'), groupCount({ by: 'lang' })), g));
    const map = result[0] as Map<unknown, number>;
    expect(map.get('java')).toBe(2);
  });

  // doc: g.V().groupCount().by(label) — [software:2,person:4]
  test('groupCount by(label())', () => {
    const result = arr(run(traversal(V(), groupCount().by(label())), g));
    const map = result[0] as Map<unknown, number>;
    expect(map.get('PERSON')).toBe(4);
    expect(map.get('SOFTWARE')).toBe(2);
  });

  // doc: g.V().hasLabel('person').groupCount().by('age') — [32:1,35:1,27:1,29:1]
  test('groupCount by("age") on persons', () => {
    const result = arr(run(traversal(V(), hasLabel('PERSON'), groupCount({ by: 'age' })), g));
    const map = result[0] as Map<unknown, number>;
    expect(map.get(29)).toBe(1);
    expect(map.get(27)).toBe(1);
    expect(map.get(32)).toBe(1);
    expect(map.get(35)).toBe(1);
  });

  // doc: g.V().groupCount().by('age') — counts only over vertices with `age`.
  // Software vertices have no age; they bucket under `undefined` in our impl.
  test('groupCount by("age") across all vertices', () => {
    const result = arr(run(traversal(V(), groupCount({ by: 'age' })), g));
    const map = result[0] as Map<unknown, number>;
    expect(map.get(29)).toBe(1);
    expect(map.get(27)).toBe(1);
    expect(map.get(32)).toBe(1);
    expect(map.get(35)).toBe(1);
  });
});
