import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  dedupe,
  hasLabel,
  in_,
  limit,
  out,
  run,
  toArray,
  traversal,
  values,
} from '../index.js';
import { hopValuesDedupe } from './hop-values-dedupe.js';

/**
 * The DISTINCT far values of a hop, fused (item 1899), in both of its spellings.
 *
 * ⚠️ THE ORACLE IS HAND-COMPUTED and every sequence assertion is `toStrictEqual` (item 1884 lost a
 * mutant to `toEqual`, which ignores `undefined` entries). The fixture is built to discriminate:
 * duplicate far values so the dedupe has work to do, a far vertex MISSING the key, a far vertex
 * whose value is a stored `null` (which [[null-first-class-policy]] makes a PRESENT value and so a
 * distinct row), an `F`-only edge, an edge carrying BOTH types, a self-loop, and an isolated vertex.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    // `c` repeats `b`'s value — without a duplicate the dedupe is unobservable.
    { id: 'c', n: 2 },
    { id: 'd', n: 3 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  // `f` has NO `n`: it contributes no row, and must not occupy the dedupe set either.
  g.addVertex({ id: 'f', labels: ['T'], properties: { other: 9 } });
  // `z` has no edges at all.
  g.addVertex({ id: 'z', labels: ['T'], properties: { n: 9 } });
  // ⚠️ `k`'s `n` is a STORED null — a present value and therefore its own distinct row.
  g.addVertex({ id: 'k', labels: ['T'], properties: { n: null } });

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b', labels: ['E'] },
    { id: 'e2', from: 'a', to: 'c', labels: ['E'] },
    { id: 'e3', from: 'a', to: 'f', labels: ['E'] },
    { id: 'e4', from: 'b', to: 'd', labels: ['E'] },
    { id: 'e5', from: 'c', to: 'b', labels: ['E'] },
    { id: 'e6', from: 'd', to: 'd', labels: ['E'] },
    { id: 'e7', from: 'b', to: 'c', labels: ['F'] },
    // BOTH types on one edge — in the `E` bucket and the `F` bucket.
    { id: 'e8', from: 'd', to: 'a', labels: ['E', 'F'] },
    { id: 'e9', from: 'a', to: 'k', labels: ['E'] },
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

/**
 * A CHAIN whose every far value is distinct, which is the only fixture that can see a CSR run-bound
 * off-by-one.
 *
 * ⚠️⚠️ **THE DEDUPE MASKS AN OVER-READ ON ANY ORDINARY FIXTURE, and a mutant proved it.** Reading one
 * slot past a vertex's run yields the NEXT vertex's first target — on `fixture()` that is a value
 * the set already holds, so the answer is byte-identical and the off-by-one survives everything.
 * Here `p1->p2->p3->p4` with values 11/22/33/44 makes every over-read introduce a value out of turn:
 * correct is [22, 33, 44], and the off-by-one appends 11 (slot 0, from the zero-filled tail of the
 * over-allocated `memo.flat`). ⚠️ So a deduping rung needs a UNIQUE-VALUE fixture beside its
 * duplicate-bearing one; neither alone has teeth.
 */
const chain = (): Graph => {
  const g = new Graph();

  for (const [i, n] of [11, 22, 33, 44].entries()) {
    g.addVertex({ id: `p${String(i + 1)}`, labels: ['T'], properties: { n } });
  }

  for (let i = 1; i < 4; i += 1) {
    g.addEdge({
      id: `c${String(i)}`,
      from: g.getVertexById(`p${String(i)}`) as never,
      to: g.getVertexById(`p${String(i + 1)}`) as never,
      labels: ['E'],
    });
  }

  return g;
};

/**
 * ⚠️ TWICE, BECAUSE THE RUNG RIDES ITEM 1889'S SECOND-ASK POLICY and declines its own first call.
 * A single `toArray` therefore measures the bucket walk rather than the CSR one, so every answer
 * below is asserted on a REPEAT — and the two are asserted equal, which is the real claim: the
 * policy may change the route but never the answer. ⚠️ FIVE MUTANTS SURVIVED a single-`toArray`
 * suite at item 1889 for exactly this reason.
 */
const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown[] => {
  const first = toArray(make(), g);
  const second = toArray(make(), g);

  expect(second).toStrictEqual(first);

  return second;
};

/**
 * ⚠️ BOTH SPELLINGS ARE ONE QUESTION, so they are asserted against the SAME oracle in the same
 * test. `bun run spelling:gremlin` is the perf side of this claim; this is the answer side.
 */
const bothSpellings = (hop: 'out' | 'in', key: string, type: string, g: Graph): unknown[] => {
  const step = hop === 'out' ? out(type) : in_(type);
  const viaValues = twice(() => traversal(V(), step, values(key), dedupe()), g);
  const viaBy = twice(() => traversal(V(), step, dedupe().by(key), values(key)), g);

  expect(viaBy).toStrictEqual(viaValues);

  return viaValues;
};

describe('hopValuesDedupe — the answer, on the repeat call that takes it', () => {
  it('emits the distinct far values in first-seen order, both spellings', () => {
    // `E` out-edges in vertex order a, b, c, d, f, z, k:
    //   a->b(2) a->c(2) a->f(NO KEY) a->k(null) | b->d(3) | c->b(2) | d->d(3) d->a(1)
    // so the stream is 2, 2, null, 3, 2, 3, 1 and first-seen distinct is 2, null, 3, 1.
    expect(bothSpellings('out', 'n', 'E', fixture())).toStrictEqual([2, null, 3, 1]);
  });

  it('serves `in`, reading the other end', () => {
    // `E` in-edges per vertex: a <- d(3) | b <- a(1), c(2) | c <- a(1) | d <- b(2), d(3) |
    //   f <- a(1) | k <- a(1)  =>  3, 1, 2, 1, 2, 3, 1  =>  distinct 3, 1, 2.
    expect(bothSpellings('in', 'n', 'E', fixture())).toStrictEqual([3, 1, 2]);
  });

  it('keeps the edge TYPE — an `F`-only edge is not followed, a two-type edge once', () => {
    // `F` out-edges: b->c(2), d->a(1).
    expect(bothSpellings('out', 'n', 'F', fixture())).toStrictEqual([2, 1]);
  });

  it('a far vertex MISSING the key contributes nothing and occupies no slot in the set', () => {
    // Only `f` lacks `n`, and `other` is a key only `f` carries — so the whole `E` hop projects
    // exactly ONE row, which it could not do if an absent key were deduped as a value.
    expect(bothSpellings('out', 'other', 'E', fixture())).toStrictEqual([9]);
  });

  it('each over-read is visible on a fixture whose far values are all distinct', () => {
    expect(bothSpellings('out', 'n', 'E', chain())).toStrictEqual([22, 33, 44]);
  });

  /**
   * ⚠️ THE ROUTE IS ITS OWN ASSERTION, because taking it is ANSWER-EQUIVALENT — which is
   * [[perf-gate-needs-its-own-test]] exactly. Item 1899's own bug (a `By` is never the bare string
   * the caller writes, so `byKey` always declined) changed no answer at all: it cost 4x and the
   * whole suite passed. A mutant restoring it survived every test here until this one.
   */
  it('BOTH spellings actually reach the rung — the route, not the answer', () => {
    const g = fixture();

    expect(hopValuesDedupe(traversal(V(), out('E'), values('n'), dedupe()), g)).not.toBeUndefined();
    expect(
      hopValuesDedupe(traversal(V(), out('E'), dedupe().by('n'), values('n')), g),
    ).not.toBeUndefined();
    expect(hopValuesDedupe(traversal(V(), in_('E'), values('n'), dedupe()), g)).not.toBeUndefined();
  });

  /**
   * ⚠️ THIS TEST EXISTS BECAUSE THE WALK IS WRITTEN TWICE — a lazy `[Symbol.iterator]` and an eager
   * `drain` (item 1412: `toArray` prefers `drain`) — and item 1889 caught a run-bound off-by-one in
   * the DRAIN that survived in the ITERATOR, because every other test here goes through `toArray`.
   * Spreading `run` is the only thing that reaches the other copy.
   */
  /**
   * ⚠️⚠️ ON THE **CHAIN** FIXTURE, AND A MUTANT IS WHY (item 1913). The lazy-iterator test below
   * used `fixture()`, whose duplicate values ABSORB a CSR over-read — exactly the masking item 1899
   * built `chain()` to defeat, applied to the DRAIN path (which `toArray` takes) and never to the
   * iterator. So the iterator's own run-bound off-by-one survived a 21-test suite. The two paths are
   * the same loop written twice; a fixture that discriminates has to reach BOTH.
   */
  it('the LAZY iterator sees an over-read too, on the unique-value chain', () => {
    const g = chain();

    toArray(traversal(V(), out('E'), values('n'), dedupe()), g);

    expect([...run(traversal(V(), out('E'), values('n'), dedupe()), g)]).toStrictEqual([
      22, 33, 44,
    ]);
    expect([...run(traversal(V(), out('E'), dedupe().by('n'), values('n')), g)]).toStrictEqual([
      22, 33, 44,
    ]);
  });

  it('the LAZY iterator agrees with the eager drain', () => {
    const g = fixture();
    const make = () => traversal(V(), out('E'), values('n'), dedupe());

    toArray(make(), g);

    expect([...run(make(), g)]).toStrictEqual([2, null, 3, 1]);
    expect([...run(traversal(V(), out('E'), dedupe().by('n'), values('n')), g)]).toStrictEqual([
      2,
      null,
      3,
      1,
    ]);
  });
});

describe('hopValuesDedupe — the tail it hands back', () => {
  /**
   * ⚠️ A DROPPED `rest` IS ANSWER-VISIBLE ONLY WITH A STEP AFTER THE PROJECTION, and `limit` is the
   * cheapest one: `rest: []` would silently ignore it and emit all four values.
   */
  it('runs a step that follows the projection', () => {
    expect(
      twice(() => traversal(V(), out('E'), values('n'), dedupe(), limit(2)), fixture()),
    ).toStrictEqual([2, null]);
    expect(
      twice(() => traversal(V(), out('E'), dedupe().by('n'), values('n'), limit(2)), fixture()),
    ).toStrictEqual([2, null]);
  });
});

describe('hopValuesDedupe — what it declines', () => {
  const g = fixture();

  /**
   * ⚠️ EACH DECLINE IS ASSERTED TWICE: the gate returns `undefined`, AND the plan still answers
   * correctly through whatever route does take it. A gate that declined by crashing would pass the
   * first assertion alone.
   */
  const declines = (plan: ReturnType<typeof traversal>): unknown[] => {
    expect(hopValuesDedupe(plan, g)).toBeUndefined();

    return toArray(plan, g);
  };

  it('declines a `by` key that differs from the projected key — a different question', () => {
    // Keeps the FIRST element per `n` (b=2, k=null, d=3, a=1) and reads `other` off each: none of
    // those four carries `other`, so the answer is EMPTY — where the distinct `other` values are
    // [9], which is the row the fused walk returns for the matching-key spelling above. ⚠️ A `by`
    // whose key is absent also FILTERS the element (that is why `f` never reaches the projection),
    // so the two keys cannot be fused into one walk in either direction.
    expect(declines(traversal(V(), out('E'), dedupe().by('n'), values('other')))).toStrictEqual([]);
  });

  it('declines a label-scoped `dedupe(label)`, which dedupes a tagged tuple', () => {
    // No step is tagged `x`, so every traverser's tuple is the same empty one and the whole stream
    // collapses to its FIRST element (b, n=2) — emphatically not the distinct `n` values.
    expect(declines(traversal(V(), out('E'), dedupe('x'), values('n')))).toStrictEqual([2]);
  });

  it('declines a `by` carrying a traversal rather than a bare key', () => {
    expect(declines(traversal(V(), out('E'), dedupe().by(values('n')), values('n')))).toStrictEqual(
      [2, null, 3, 1],
    );
  });

  it('declines `V(ids)`, which enumerates a given set rather than the graph', () => {
    expect(declines(traversal(V('a'), out('E'), values('n'), dedupe()))).toStrictEqual([2, null]);
  });

  it('declines a two-label hop', () => {
    expect(declines(traversal(V(), out('E', 'F'), values('n'), dedupe()))).toStrictEqual([
      2,
      null,
      3,
      1,
    ]);
  });

  it('declines `both`, which is not a directed single hop', () => {
    const got = declines(traversal(V(), both('E'), values('n'), dedupe()));

    expect(got).toStrictEqual([2, null, 3, 1]);
  });

  it('declines a label-scoped dedupe in the `values` spelling too', () => {
    // An untagged label makes every tuple the same empty one, so the stream collapses to its
    // FIRST value rather than to its distinct ones.
    expect(declines(traversal(V(), out('E'), values('n'), dedupe('x')))).toStrictEqual([2]);
  });

  it('declines a labelled dedupe that ALSO carries a `by`', () => {
    // The LABEL wins over the `by`: one element survives, so one row does.
    expect(declines(traversal(V(), out('E'), dedupe('x').by('n'), values('n')))).toStrictEqual([2]);
  });

  it('declines a trailing `by` on the `values` spelling, which dedupes the VALUES by a key', () => {
    // ⚠️ THIS ONE IS ANSWER-EQUIVALENT — a `by` over a scalar stream lands on the scalar itself, so
    // it agrees with the fused walk. It is therefore caught ONLY by the gate assertion inside
    // `declines`, which is the whole reason that helper asserts the route as well as the rows.
    expect(declines(traversal(V(), out('E'), values('n'), dedupe().by('n')))).toStrictEqual([
      2,
      null,
      3,
      1,
    ]);
  });

  it('declines a multi-key projection in the `by` spelling too', () => {
    // The `by` key still equals the FIRST projected key, so only the arity check refuses this —
    // and a mutant that dropped it survived until this case existed. ⚠️ The answer differs from the
    // `values`-spelling twin below ([2, 9, …]): a `by` on an absent key FILTERS the element, so `f`
    // never reaches the projection and its `other` (9) never appears.
    expect(
      declines(traversal(V(), out('E'), dedupe().by('n'), values('n', 'other'))),
    ).toStrictEqual([2, null, 3, 1]);
  });

  it('declines a multi-key projection', () => {
    // Two keys per element, so `f`'s `other` (9) joins the stream — a strictly larger answer.
    expect(declines(traversal(V(), out('E'), values('n', 'other'), dedupe()))).toStrictEqual([
      2,
      9,
      null,
      3,
      1,
    ]);
  });

  it('declines a shape shorter than four steps', () => {
    // A bare element dedupe, which is a different question: six distinct far VERTICES (b, c, f, k,
    // d, a) against the four distinct far VALUES the fused walk returns.
    expect(declines(traversal(V(), out('E'), dedupe()))).toHaveLength(6);
  });

  it('declines a filter between the hop and the projection', () => {
    expect(declines(traversal(V(), out('E'), hasLabel('T'), values('n'), dedupe()))).toStrictEqual([
      2,
      null,
      3,
      1,
    ]);
  });
});
