import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import {
  V,
  count,
  group,
  groupCount,
  has,
  hasLabel,
  id,
  inE,
  label,
  outE,
  project,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Aggregations', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().hasLabel('person').count() — 4
  test('count persons', () => {
    expect(arr(run(traversal(V(), hasLabel('PERSON'), count()), g))).toEqual([4]);
  });

  // doc: g.V().has('name','marko').out('knows').count() — 2
  test("marko's friend count", () => {
    expect(
      arr(
        run(
          traversal(V(), has('name', eq('marko')), (p) => ({
            ...p,
            steps: [...p.steps],
          })),
          g,
        ),
      ),
    ).toHaveLength(1);
  });

  // doc: g.V().groupCount().by(label) — {software:2, person:4}
  test('groupCount by label', () => {
    const r = arr(run(traversal(V(), groupCount().by(label())), g));
    const map = r[0] as Map<unknown, number>;
    expect(map.get('PERSON')).toBe(4);
    expect(map.get('SOFTWARE')).toBe(2);
  });

  // doc: g.V().group().by(label).by('name')
  test('group names by label', () => {
    const r = arr(run(traversal(V(), group().by(label()).by('name')), g));
    const map = r[0] as Map<unknown, string[]>;
    expect((map.get('PERSON') as string[]).slice().sort()).toEqual([
      'josh',
      'marko',
      'peter',
      'vadas',
    ]);
    expect((map.get('SOFTWARE') as string[]).slice().sort()).toEqual(['lop', 'ripple']);
  });

  // doc: g.V().hasLabel('person').values('age').groupCount() — {32:1, 35:1, 27:1, 29:1}
  test('groupCount by age value', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), values('age'), groupCount()), g));
    const map = r[0] as Map<unknown, number>;
    expect(map.get(29)).toBe(1);
    expect(map.get(27)).toBe(1);
    expect(map.get(32)).toBe(1);
    expect(map.get(35)).toBe(1);
  });

  // doc: g.V().has('name','marko').project('id','name','out','in').by(id).by('name').by(outE().count()).by(inE().count())
  test("project marko's id, name, out-degree, in-degree", () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          project(['id', 'name', 'out', 'in'])
            .by(id())
            .by('name')
            .by(traversal(outE(), count()))
            .by(traversal(inE(), count())),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ id: '1', name: 'marko', out: 3, in: 0 }]);
  });

  // Project name & created-count for each person.
  test('project per-person name and created-count', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          project(['name', 'created'])
            .by('name')
            .by(traversal(outE('CREATED'), count())),
        ),
        g,
      ),
    );
    expect(r).toEqual([
      { name: 'marko', created: 1 },
      { name: 'vadas', created: 0 },
      { name: 'josh', created: 2 },
      { name: 'peter', created: 1 },
    ]);
  });

  // groupCount of edge labels.
  test('groupCount of all edges by label', () => {
    const r = arr(run(traversal(V(), outE(), groupCount().by(label())), g));
    const map = r[0] as Map<unknown, number>;
    expect(map.get('CREATED')).toBe(4);
    expect(map.get('KNOWS')).toBe(2);
  });

  // group software vertices by lang
  test('group software names by language', () => {
    const r = arr(
      run(traversal(V(), hasLabel('SOFTWARE'), group({ keyBy: 'lang', valueBy: 'name' })), g),
    );
    const map = r[0] as Map<unknown, string[]>;
    expect((map.get('java') as string[]).slice().sort()).toEqual(['lop', 'ripple']);
  });
});
