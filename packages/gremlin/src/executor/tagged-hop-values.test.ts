import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  as_,
  both,
  eq,
  gt,
  in_,
  limit,
  neq,
  out,
  path,
  run,
  select,
  toArray,
  traversal,
  values,
  where,
} from '../index.js';
import { taggedHopValues } from './tagged-hop-values.js';

/**
 * The two TAGGED hop shapes that are tag-free computations (item 1912).
 *
 * ⚠️⚠️ **THIS RUNG RIDES PAST THE `tracksPath` GUARD, which no other fusion here does**, so the
 * declines matter as much as the answers. Its warrant is that it claims the WHOLE plan — exactly
 * four steps — so no downstream step is left to ask for a path. Every test below that adds a fifth
 * step is checking that warrant, not padding.
 *
 * ⚠️ THE ORACLE IS `limit(huge)`, which needs no kill switch: a fifth step takes the plan to five
 * steps, so the rung declines and the GENERIC path answers — while a limit above the row count
 * changes nothing. Each answer is therefore checked against the same query on the old route.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', k: 1 },
    { id: 'b', k: 2 },
    { id: 'c', k: 3 },
    { id: 'd', k: 4 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { k: spec.k } });
  }

  // `z` has no edges at all.
  g.addVertex({ id: 'z', labels: ['T'], properties: { k: 9 } });

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b', labels: ['E'] },
    { id: 'e2', from: 'a', to: 'c', labels: ['E'] },
    // ⚠️ A SELF-LOOP — the ONLY thing the two shapes differ on, so a fixture without one cannot
    // tell `select` (which emits it) from `where(neq)` (which drops it).
    { id: 'e3', from: 'b', to: 'b', labels: ['E'] },
    { id: 'e4', from: 'c', to: 'd', labels: ['E'] },
    // An `F`-only edge, and one carrying BOTH types.
    { id: 'e5', from: 'd', to: 'a', labels: ['F'] },
    { id: 'e6', from: 'd', to: 'b', labels: ['E', 'F'] },
  ]) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: spec.labels,
    });
  }

  return g;
};

const ids = (rows: unknown[]): unknown[] => rows.map((v) => (v as { id: string }).id);

/**
 * ⚠️ TWICE, BECAUSE THE RUNG RIDES ITEM 1889'S SECOND-ASK POLICY and declines its own first call:
 * a single `toArray` measures the bucket walk and a repeat measures the CSR. Both must answer the
 * same — five mutants survived a single-`toArray` suite at item 1889 for exactly this reason.
 */
const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown[] => {
  const first = toArray(make(), g);
  const second = toArray(make(), g);

  expect(second).toStrictEqual(first);

  return second;
};

describe('taggedHopValues — the answer, on both walks', () => {
  it('select(tag) is the NEAR vertex, once per edge, self-loop INCLUDED', () => {
    const g = fixture();
    const got = ids(twice(() => traversal(V(), as_('x'), out('E'), select('x')), g));

    // a has 2 E-edges, b has 1 (its self-loop), c has 1, d has 1 (the two-type edge), z none.
    expect(got).toStrictEqual(['a', 'a', 'b', 'c', 'd']);
    // ⚠️ AGAINST THE GENERIC PATH: a fifth step declines the rung, and a limit above the row count
    // changes nothing.
    expect(got).toStrictEqual(
      ids(toArray(traversal(V(), as_('x'), out('E'), select('x'), limit(1000)), g)),
    );
  });

  it('where(neq(tag)) is the FAR vertex, self-loop DROPPED', () => {
    const g = fixture();
    const got = ids(twice(() => traversal(V(), as_('x'), out('E'), where(neq('x'))), g));

    expect(got).toStrictEqual(['b', 'c', 'd', 'b']);
    expect(got).toStrictEqual(
      ids(toArray(traversal(V(), as_('x'), out('E'), where(neq('x')), limit(1000)), g)),
    );
  });

  it('serves `in`, both shapes, against the generic path', () => {
    const g = fixture();

    // ⚠️ Each pair is written out rather than derived from `.steps`: `traversal()` takes step
    // BUILDERS, not step objects, so a plan cannot be rebuilt from a compiled one.
    expect(ids(twice(() => traversal(V(), as_('x'), in_('E'), select('x')), g))).toStrictEqual(
      ids(toArray(traversal(V(), as_('x'), in_('E'), select('x'), limit(1000)), g)),
    );
    expect(ids(twice(() => traversal(V(), as_('x'), in_('E'), where(neq('x'))), g))).toStrictEqual(
      ids(toArray(traversal(V(), as_('x'), in_('E'), where(neq('x')), limit(1000)), g)),
    );
    // And spelled out: `E` IN-edges are b<-a, c<-a, b<-b, d<-c, b<-d in vertex order.
    expect(ids(twice(() => traversal(V(), as_('x'), in_('E'), select('x')), g))).toStrictEqual([
      'b',
      'b',
      'b',
      'c',
      'd',
    ]);
  });

  it('keeps the edge TYPE — an F-only edge is not followed, a two-type edge once', () => {
    const g = fixture();

    expect(ids(twice(() => traversal(V(), as_('x'), out('F'), select('x')), g))).toStrictEqual([
      'd',
      'd',
    ]);
  });

  /** ⚠️ The lazy iterator is a second copy of the loop; only spreading `run` reaches it. */
  it('the LAZY iterator agrees with the eager drain', () => {
    const g = fixture();
    const make = () => traversal(V(), as_('x'), out('E'), select('x'));

    toArray(make(), g);

    expect(ids([...run(make(), g)])).toStrictEqual(['a', 'a', 'b', 'c', 'd']);
    expect(ids([...run(traversal(V(), as_('x'), out('E'), where(neq('x'))), g)])).toStrictEqual([
      'b',
      'c',
      'd',
      'b',
    ]);
  });
});

/**
 * The FIVE-step spellings, with a trailing `values(k)` (item 1912).
 *
 * ⚠️⚠️ THESE ARE THE SHAPES THE WORKLOAD SCREEN MEASURES, and the four-step rung alone left them
 * untouched at 406 and 196 ms — a win that had not reached the shape anyone flagged. The screen's
 * own definitions are what showed it, which is why its spellings are mirrored here exactly.
 */
describe('taggedHopValues — a trailing values(k)', () => {
  it('select(tag).values(k) is the NEAR vertex\u2019s property, once per edge', () => {
    const g = fixture();
    const got = twice(() => traversal(V(), as_('x'), out('E'), select('x'), values('k')), g);

    // The near vertex per E-edge is a,a,b,c,d, whose `k` is 1,1,2,3,4.
    expect(got).toStrictEqual([1, 1, 2, 3, 4]);
    expect(got).toStrictEqual(
      toArray(traversal(V(), as_('x'), out('E'), select('x'), values('k'), limit(1000)), g),
    );
  });

  it('where(neq(tag)).values(k) is the FAR property, self-loop dropped', () => {
    const g = fixture();
    const got = twice(() => traversal(V(), as_('x'), out('E'), where(neq('x')), values('k')), g);

    // Far vertices b,c,d,b → 2,3,4,2.
    expect(got).toStrictEqual([2, 3, 4, 2]);
    expect(got).toStrictEqual(
      toArray(traversal(V(), as_('x'), out('E'), where(neq('x')), values('k'), limit(1000)), g),
    );
  });

  /**
   * ⚠️ A MISSING KEY IS DROPPED, NOT EMITTED AS NULL — `projectValues`' rule (`k in props`), and a
   * STORED null is a present value that IS emitted. Both arms of that distinction are here.
   */
  it('drops an element lacking the key, and keeps a stored null', () => {
    const g = fixture();

    g.addVertex({ id: 'nokey', labels: ['T'], properties: {} });
    g.addVertex({ id: 'nullk', labels: ['T'], properties: { k: null } });
    g.addEdge({
      id: 'e7',
      from: g.getVertexById('nokey') as never,
      to: g.getVertexById('a') as never,
      labels: ['E'],
    });
    g.addEdge({
      id: 'e8',
      from: g.getVertexById('nullk') as never,
      to: g.getVertexById('a') as never,
      labels: ['E'],
    });

    const got = twice(() => traversal(V(), as_('x'), out('E'), select('x'), values('k')), g);

    // `nokey` contributes nothing; `nullk` contributes its stored null.
    expect(got).toStrictEqual([1, 1, 2, 3, 4, null]);
    expect(got).toStrictEqual(
      toArray(traversal(V(), as_('x'), out('E'), select('x'), values('k'), limit(1000)), g),
    );
  });

  /**
   * ⚠️⚠️ A SIXTH STEP MUST DECLINE, AND A MUTANT IS WHY THIS TEST EXISTS. Loosening the gate to
   * `steps.length < 4` left every other assertion green: a five-step plan ending in `limit` still
   * declined (the fifth step is not a `values`), so nothing reached the case where the fifth step IS
   * a `values` and a SIXTH is dropped. `rest` is always `[]`, so an admitted residual is not run —
   * 800,000 rows where the query asked for two.
   */
  it('declines a SIXTH step, so no residual is silently dropped', () => {
    const g = fixture();
    const six = traversal(V(), as_('x'), out('E'), select('x'), values('k'), limit(2));

    expect(taggedHopValues(six, g)).toBeUndefined();
    expect(toArray(six, g)).toHaveLength(2);

    const sixNeq = traversal(V(), as_('x'), out('E'), where(neq('x')), values('k'), limit(2));

    expect(taggedHopValues(sixNeq, g)).toBeUndefined();
    expect(toArray(sixNeq, g)).toHaveLength(2);
  });

  it('declines a multi-key or keyless values, and any other fifth step', () => {
    const g = fixture();

    expect(
      taggedHopValues(traversal(V(), as_('x'), out('E'), select('x'), values('k', 'other')), g),
    ).toBeUndefined();
    expect(
      taggedHopValues(traversal(V(), as_('x'), out('E'), select('x'), values()), g),
    ).toBeUndefined();
    expect(
      taggedHopValues(traversal(V(), as_('x'), out('E'), select('x'), limit(2)), g),
    ).toBeUndefined();
  });
});

describe('taggedHopValues — what it declines', () => {
  const g = fixture();

  /** Each decline: the gate returns `undefined`, AND the plan still answers correctly. */
  const declines = (plan: ReturnType<typeof traversal>): unknown[] => {
    expect(taggedHopValues(plan, g)).toBeUndefined();

    return toArray(plan, g);
  };

  /**
   * ⚠️⚠️ THE WARRANT. A FIFTH STEP MUST DECLINE, because this rung rides past the `tracksPath`
   * guard only by claiming the whole plan — a residual would be handed bare values whose traversers
   * never existed, and a path-reading step would have nothing to read.
   */
  it('declines a fifth step, even a trivial one', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), select('x'), limit(2))).length).toBe(2);
    expect(declines(traversal(V(), as_('x'), out('E'), where(neq('x')), limit(2))).length).toBe(2);
  });

  /** ⚠️ AND A PATH-READING TAIL, which is the shape the guard exists for. */
  it('declines a `path` tail', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), path())).length).toBe(5);
  });

  it('declines select of a DIFFERENT label', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), select('y'))).length).toBe(0);
  });

  it('declines a multi-label select, which projects a MAP', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), select('x', 'x'))).length).toBe(5);
  });

  it('declines a select with a `by`, which modulates the projection', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), select('x').by('k')))).toStrictEqual([
      1, 1, 2, 3, 4,
    ]);
  });

  it('declines an `eq` or ordering predicate — a different question', () => {
    expect(ids(declines(traversal(V(), as_('x'), out('E'), where(eq('x')))))).toStrictEqual(['b']);
    expect(declines(traversal(V(), as_('x'), out('E'), where(gt('x')))).length).toBe(0);
  });

  it('declines the two-tag where form, which reads a tag this shape never binds', () => {
    expect(declines(traversal(V(), as_('x'), out('E'), where('x', neq('x')))).length).toBe(0);
  });

  it('declines a `values` tail — that is the other rungs’ shape', () => {
    // The far `k` per E-edge in walk order: b(2) c(3) b(2) d(4) b(2).
    expect(declines(traversal(V(), as_('x'), out('E'), values('k')))).toStrictEqual([
      2, 3, 2, 4, 2,
    ]);
  });

  it('declines `V(ids)`, a two-label hop and `both`', () => {
    expect(declines(traversal(V('a'), as_('x'), out('E'), select('x'))).length).toBe(2);
    // `[:E|F]` per-vertex union, deduped: a->b,c | b->b | c->d | d->a,b = 6.
    expect(declines(traversal(V(), as_('x'), out('E', 'F'), select('x'))).length).toBe(6);
    expect(declines(traversal(V(), as_('x'), both('E'), select('x'))).length).toBe(10);
  });

  it('declines a plan with no tag at all', () => {
    expect(taggedHopValues(traversal(V(), out('E'), select('x'), limit(1)), g)).toBeUndefined();
  });
});
