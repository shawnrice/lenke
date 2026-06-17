import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gt, gte, lt, within } from '../predicates.js';
import {
  V,
  and,
  count,
  has,
  hasLabel,
  in_,
  is,
  not,
  or,
  out,
  outE,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Filter combinations', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().and(outE('knows'), values('age').is(lt(30))).values('name') — marko
  test('and: has KNOWS out edge AND age < 30', () => {
    const r = arr(
      run(
        traversal(
          V(),
          and(outE('KNOWS'), (p) => is(lt(30))(values('age')(p))),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // doc: g.V().or(__.outE('created'), __.inE('created').count().is(gt(1))).values('name')
  test('or: has CREATED-out OR has multiple CREATED-in', () => {
    const r = arr(
      run(
        traversal(
          V(),
          or(outE('CREATED'), (p) => is(gt(1))(count()(in_('CREATED')(p)))),
          values('name'),
        ),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'lop', 'marko', 'peter']);
  });

  // doc: g.V().hasLabel('person').not(out('created').count().is(gt(1))).values('name')
  test('not: persons who did NOT create more than 1 software', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          not((p) => is(gt(1))(count()(out('CREATED')(p)))),
          values('name'),
        ),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['marko', 'peter', 'vadas']);
  });

  // doc: g.V().where(__.not(out('created'))).where(__.in('knows')).values('name') — vadas
  test('chained where: no out CREATED AND has in KNOWS', () => {
    const r = arr(
      run(traversal(V(), where(not(out('CREATED'))), where(in_('KNOWS')), values('name')), g),
    );
    expect(r).toEqual(['vadas']);
  });

  // doc: g.V().hasLabel('person').out().has('name',within('vadas','josh'))
  test('within predicate after out()', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          out(),
          has('name', within('vadas', 'josh')),
          values('name'),
        ),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'vadas']);
  });

  // doc: g.V().where(__.in('created').count().is(gte(2))).values('name') — lop
  test('where with count.is(gte(2))', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => is(gte(2))(count()(in_('CREATED')(p)))),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['lop']);
  });

  // doc: g.V().where(out('knows').where(out('created'))).values('name') — marko
  test('nested where: knows someone who created something', () => {
    const r = arr(
      run(
        traversal(
          V(),
          where((p) => where(out('CREATED'))(out('KNOWS')(p))),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // doc: g.V().has('person','name','marko').out('knows').toList() — vadas, josh
  test('has with label+key+pred narrows to typed match', () => {
    const r = arr(
      run(
        traversal(V(), hasLabel('PERSON'), has('name', eq('marko')), out('KNOWS'), values('name')),
        g,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'vadas']);
  });

  // hasNot of a property: software vertices lack 'age'.
  test('software vertices lack the age property', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), values('age')), g));
    expect(r).toEqual([]);
  });

  // doc: g.V().has('name', within('josh','marko')).values('name')
  test('has within retrieves multiple matches', () => {
    const r = arr(run(traversal(V(), has('name', within('josh', 'marko')), values('name')), g));
    expect((r as string[]).sort()).toEqual(['josh', 'marko']);
  });
});
