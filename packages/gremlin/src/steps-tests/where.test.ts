import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gte } from '../predicates.js';
import { V, and, bothE, count, hasId, in_, is, not, or, otherV, out, outE, values, where } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('where tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().where(__.in('created').count().is(1)).values('name') — ripple
  test('where filters by sub-traversal scalar predicate (count is 1)', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => is(eq(1))(count()(in_('CREATED')(p)))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['ripple']);
  });

  // doc: g.V().where(__.in('created').count().is(gte(2))).values('name') — lop
  test('where filters by gte', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => is(gte(2))(count()(in_('CREATED')(p)))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['lop']);
  });

  // doc: g.V().where(out('created')).values('name') — marko; josh; peter
  test('where keeps traversers whose sub-plan emits anything', () => {
    const r = arr(run(traversal(V(), where(out('CREATED')), values('name')), tinkerGraph));
    expect(r).toEqual(['marko', 'josh', 'peter']);
  });

  // doc: g.V().out('knows').where(out('created')).values('name') — josh
  test('where after out preserves filtering on result', () => {
    const r = arr(
      run(
        traversal(V(), out('KNOWS'), where(out('CREATED')), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['josh']);
  });

  // doc: g.V().where(__.not(out('created'))).where(__.in('knows')).values('name') — vadas
  test('chained where with not + in', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where(not(out('CREATED'))),
          where(in_('KNOWS')),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['vadas']);
  });

  // doc: g.V(1).bothE().where(otherV().hasId(2)) — e[7][1-knows->2]
  test('where(otherV().hasId(2)) — bothE on v[1]', () => {
    const r = arr(
      run(
        traversal(V('1'), bothE(), where((p) => hasId('2')(otherV()(p)))),
        tinkerGraph,
      ),
    ) as Array<{ id: string }>;
    expect(r.map((e) => e.id)).toEqual(['7']);
  });

  // doc: g.V().where(out('created').count().is(gte(2))).values('name') — josh
  test('where with out().count().is(gte(2))', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => is(gte(2))(count()(out('CREATED')(p)))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['josh']);
  });

  // doc: g.V().where(outE('created').and().outE('knows')).values('name') — marko
  test('where with and(outE created, outE knows)', () => {
    const r = arr(
      run(
        traversal(V(), where(and(outE('CREATED'), outE('KNOWS'))), values('name')),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // doc: g.V().where(outE('created').or().outE('knows')).values('name') — marko; josh; peter
  test('where with or(outE created, outE knows)', () => {
    const r = arr(
      run(
        traversal(V(), where(or(outE('CREATED'), outE('KNOWS'))), values('name')),
        tinkerGraph,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter']);
  });

  // doc: g.V().where(out('knows').where(out('created'))).values('name') — marko
  test('nested where: who knows someone who created', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => where(out('CREATED'))(out('KNOWS')(p))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });
});
