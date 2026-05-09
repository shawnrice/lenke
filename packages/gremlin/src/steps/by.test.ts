import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import {
  Order,
  V,
  count,
  dedupe,
  group,
  groupCount,
  hasLabel,
  inE,
  label,
  order,
  outE,
  path,
  project,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

// `by()` is the most-overloaded modulator in TinkerPop. These tests cover the
// three forms we model: identity, key, and sub-traversal. Comparator/token
// forms are deferred (see ast.ts).
describe('by() modulator', () => {
  const g = createTestTinkerGraph();

  // doc-style: order by a property name via the modulator.
  test('order().by(key) sorts by property', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), order().by('age'), values('name')), g),
    );
    expect(r).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  // doc: g.V().dedup().by(label) — one vertex per label.
  test('dedupe().by(label()) keeps one per label', () => {
    const r = arr(run(traversal(V(), dedupe().by(label())), g)) as Array<{ id: string }>;
    expect(r).toHaveLength(2);
  });

  // doc: g.V().group().by(label).by('name')
  test('group().by(label()).by("name") groups names by label', () => {
    const r = arr(run(traversal(V(), group().by(label()).by('name')), g));
    const map = r[0] as Map<unknown, unknown[]>;
    expect(map).toBeInstanceOf(Map);
    expect((map.get('PERSON') as string[]).slice().sort()).toEqual([
      'josh',
      'marko',
      'peter',
      'vadas',
    ]);
    expect((map.get('SOFTWARE') as string[]).slice().sort()).toEqual(['lop', 'ripple']);
  });

  // doc: g.V().groupCount().by(label) — [software:2,person:4]
  test('groupCount().by(label()) counts by label', () => {
    const r = arr(run(traversal(V(), groupCount().by(label())), g));
    const map = r[0] as Map<unknown, number>;
    expect(map.get('PERSON')).toBe(4);
    expect(map.get('SOFTWARE')).toBe(2);
  });

  // doc: g.V().has('name','marko').project('id','name','out','in')
  //         .by(id()).by('name').by(outE().count()).by(inE().count())
  test('project().by() with sub-traversals', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          project(['name', 'outDeg', 'inDeg'])
            .by('name')
            .by(traversal(outE(), count()))
            .by(traversal(inE(), count())),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ name: 'marko', outDeg: 3, inDeg: 0 }]);
  });

  // doc: g.V().out().out().path().by('name') — project each path element by name.
  test('path().by("name") projects each path element', () => {
    const r = arr(
      run(traversal(V('1'), outE('KNOWS'), path().by('name')), g),
    );
    // Two outgoing 'knows' edges from marko (id=1).
    expect(r).toHaveLength(2);
    // Each path: [marko-vertex projected by name, edge projected by name].
    // marko vertex has 'name'; edges don't, so they pass through unchanged.
    const names = (r as Array<unknown[]>).map((p) => p[0]);
    expect(names).toEqual(['marko', 'marko']);
  });

  // doc: g.V().values('name').order().by(desc) — comparator-only form.
  test('order().by(Order.desc) sorts values descending', () => {
    const r = arr(
      run(traversal(V(), values('name'), order().by(Order.desc)), g),
    );
    expect(r).toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
  });

  // Per-by direction: primary key asc, but tie-broken on a desc secondary.
  test('order().by(key, Order.asc).by(key2, Order.desc) — per-by direction', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          order().by(traversal(outE('CREATED'), count()), Order.desc).by('age', Order.asc),
          values('name'),
        ),
        g,
      ),
    );
    // outDeg: marko=1, vadas=0, josh=2, peter=1.
    // Desc primary: josh(2) first, then marko/peter tied at 1, then vadas(0).
    // Tie-break asc on age: marko(29) before peter(35).
    expect(r).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  // doc: g.V().hasLabel('person').order().by(outE('created').count(), asc).by('age', asc)
  // We exercise the sub-traversal form for sort key (no comparator).
  test('order().by(sub-traversal) sorts by count', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          order().by(traversal(outE('CREATED'), count())),
          values('name'),
        ),
        g,
      ),
    );
    // Counts: marko=1, vadas=0, josh=2, peter=1. asc: vadas(0), then marko/peter(1) tied, then josh(2).
    expect(r[0]).toBe('vadas');
    expect(r[r.length - 1]).toBe('josh');
  });

  // doc: g.V().groupCount().by('name') — count by name (each name unique => 1 each)
  test('groupCount().by("name") counts by property name', () => {
    const r = arr(run(traversal(V(), groupCount().by('name')), g));
    const map = r[0] as Map<unknown, number>;
    expect(map.get('marko')).toBe(1);
    expect(map.get('lop')).toBe(1);
    expect(map.size).toBe(6);
  });
});
