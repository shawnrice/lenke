import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gt, gte } from '../predicates.js';
import {
  V,
  count,
  dedupe,
  has,
  hasLabel,
  in_,
  inE,
  inV,
  out,
  outE,
  outV,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Software creators', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().has('name','marko').out('created').values('name') — lop
  test('what marko created', () => {
    const r = arr(run(traversal(V(), has('name', eq('marko')), out('CREATED'), values('name')), g));
    expect(r).toEqual(['lop']);
  });

  // doc: g.V().out('created').dedup() — lop, ripple
  test('all created software, deduped', () => {
    const r = arr(run(traversal(V(), out('CREATED'), dedupe(), values('name')), g));
    expect((r as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  // doc: g.V().hasLabel("software").inE("created").count() — 4
  test('total CREATED edges (in)', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), inE('CREATED'), count()), g));
    expect(r).toEqual([4]);
  });

  // doc: g.V().hasLabel("software").inE("created").outV().count() — 4
  test('total creators (with multiplicity) of software', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), inE('CREATED'), outV(), count()), g));
    expect(r).toEqual([4]);
  });

  // doc: g.V().has("software","name","ripple").inE("created").has("weight", gte(0.5)).outV()
  test('creators of ripple with high weight', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('SOFTWARE'),
          has('name', eq('ripple')),
          inE('CREATED'),
          has('weight', gte(0.5)),
          outV(),
          values('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual(['josh']);
  });

  // doc: g.V(1).outE("created") — marko's CREATED edges
  test("marko's outgoing CREATED edges have weight 0.4", () => {
    const r = arr(run(traversal(V('1'), outE('CREATED'), values('weight')), g));
    expect(r).toEqual([0.4]);
  });

  // doc: g.E().hasLabel('knows').has('weight', gt(0.75)) — e[8]
  test('strong KNOWS edges (weight > 0.75)', () => {
    const r = arr(
      run(traversal(V(), outE('KNOWS'), has('weight', gt(0.75)), inV(), values('name')), g),
    );
    expect(r).toEqual(['josh']);
  });

  // Software with multiple creators (lop has 3).
  test('software with multiple creators', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('SOFTWARE'),
          where((p) => count()(in_('CREATED')(p))),
          values('name'),
        ),
        g,
      ),
    );
    // lop has 3 creators; ripple has 1.
    expect((r as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  // Persons who created at least one piece of software.
  test('persons who created at least one software', () => {
    const r = arr(
      run(traversal(V(), hasLabel('PERSON'), where(out('CREATED')), values('name')), g),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter']);
  });

  // doc: g.V().has("software","name","ripple").inE().has("weight", gte(0.5)).outV().properties()
  test('properties of strong creators of ripple', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('SOFTWARE'),
          has('name', eq('ripple')),
          inE('CREATED'),
          has('weight', gte(0.5)),
          outV(),
          values('age'),
        ),
        g,
      ),
    );
    expect(r).toEqual([32]);
  });
});
