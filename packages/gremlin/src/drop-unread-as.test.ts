import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  as_,
  count,
  dedupe,
  dropUnreadAs,
  effectivePlan,
  filter,
  gt,
  has,
  out,
  path,
  select,
  toArray,
  traversal,
  values,
  where,
} from './index.js';

/**
 * Item 1572: `as(l)` whose label nothing downstream can read is removed from the plan.
 *
 * ⚠️ THE BIG COST IS NOT THE TAG COPY. `as` copies the whole tag map per traverser, which is real —
 * but it is also one more step in front of the hop, and every count/values rung matches a plan
 * PREFIX from the source, so an unread `as` makes them all decline:
 *
 *     V().as(x).out(E).count()     24.1 ms -> 0.0    the shortcut answers it again
 *     V().as(x).out(E).values(k)   30.1    -> 8.1    3.7x — this one IS the tag copy
 *
 * ⚠️ The drop is answer-equivalent, so the suite cannot see a mutant in it
 * (`perf-gate-needs-its-own-test`). Hence ROUTE assertions on `effectivePlan` plus answers.
 */
const kindsOf = (plan: Parameters<typeof effectivePlan>[0], graph: Graph): string[] =>
  effectivePlan(plan, graph, false).steps.map((s) => s.kind);

const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

  graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  graph.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });

  return graph;
};

describe('an unread as() label is dropped', () => {
  test('a count suffix reads no tags', () => {
    expect(kindsOf(traversal(V(), as_('x'), out('E'), count()), g())).toEqual([
      'V',
      'out',
      'count',
    ]);
  });

  test('a values suffix reads no tags', () => {
    expect(kindsOf(traversal(V(), as_('x'), out('E'), values('k')), g())).toEqual([
      'V',
      'out',
      'values',
    ]);
  });

  test('⚠️ TWO unread labels both go — the pass walks BACKWARDS', () => {
    // `as` is not tag-blind (it reads `t.tags` to copy it), so testing each `as` against the
    // ORIGINAL suffix would let the second keep the first alive and drop only `y`. Testing against
    // the KEPT suffix drops both.
    expect(kindsOf(traversal(V(), as_('x'), out('E'), as_('y'), count()), g())).toEqual([
      'V',
      'out',
      'count',
    ]);
  });

  test('the answers are unchanged', () => {
    const graph = g();

    expect(toArray(traversal(V(), as_('x'), out('E'), count()), graph)).toEqual([2]);
    expect(toArray(traversal(V(), out('E'), count()), graph)).toEqual([2]);
    expect(
      [...(toArray(traversal(V(), as_('x'), out('E'), values('k')), graph) as number[])].sort(
        (p, q) => p - q,
      ),
    ).toEqual([2, 3]);
  });
});

describe('⚠️ the refusals, each of which a mutant removes', () => {
  test('a select READS the tag', () => {
    // ⚠️ THE TAIL IS DELIBERATELY NOT A BARE `count()`. It was, until item 1800 taught the chain to
    // drop a `select(tag)` whose only tail is `count()` — after which this plan legitimately
    // becomes `V().out('E').count()` and says nothing about THIS pass's refusal. The invariant
    // under test is "`dropUnreadAs` must not drop an `as` a later step reads", so the shape has to
    // be one item 1800 declines: a select whose value is observed.
    expect(kindsOf(traversal(V(), as_('x'), out('E'), select('x'), values('k')), g())).toEqual([
      'V',
      'as',
      'out',
      'select',
      'values',
    ]);
    // …and the counted form, which item 1800 rewrites, no longer carries either step.
    expect(kindsOf(traversal(V(), as_('x'), out('E'), select('x'), count()), g())).toEqual([
      'V',
      'out',
      'count',
    ]);
  });

  test('a where keeps it', () => {
    const kinds = kindsOf(traversal(V(), as_('x'), out('E'), where(select('x')), count()), g());

    expect(kinds).toContain('as');
  });

  test('a dedupe keeps it — `dedupe` can carry labels, so it is not tag-blind', () => {
    expect(kindsOf(traversal(V(), as_('x'), out('E'), dedupe(), count()), g())).toContain('as');
  });

  test('a USER CLOSURE keeps it — a closure receives the traverser and can read any tag', () => {
    expect(
      kindsOf(
        traversal(
          V(),
          as_('x'),
          out('E'),
          filter((v: unknown) => v !== null),
          count(),
        ),
        g(),
      ),
    ).toContain('as');
  });

  test('⚠️ a PATH-reading plan is left entirely alone', () => {
    // `effectivePlan` applies no rewrite at all when the run tracks paths, so the `as` survives
    // for a reason that has nothing to do with this pass. Pinned so the two cannot be confused.
    const plan = traversal(V(), as_('x'), out('E'), path());

    expect(effectivePlan(plan, g(), true).steps.map((s) => s.kind)).toEqual([
      'V',
      'as',
      'out',
      'path',
    ]);
  });

  test('a tag-blind suffix with a predicate filter still drops it', () => {
    // `has` takes a predicate over the VALUE, never the traverser, so it is tag-blind and the
    // drop still applies — the contrast with the closure case above.
    expect(kindsOf(traversal(V(), as_('x'), has('k', gt(0)), out('E'), count()), g())).toEqual([
      'V',
      'has',
      'out',
      'count',
    ]);
  });
});

describe('the pass is identity-preserving when it changes nothing', () => {
  // ⚠️ THESE DO NOT TEST THE KIND GATE, and I first wrote them claiming they did. Removing
  // `if ((plan.kinds & KIND_BITS.as) === 0) return plan` leaves the loop to run, find no `as`,
  // keep `changed` false and return `plan` — THE SAME OBJECT. So the gate has no observable
  // effect whatsoever and its mutant is unkillable by any behavioural test; it is a pure cost
  // guard, added because item 1506 measured such a pass at 10.7% of a 175 ns reused-plan call.
  //
  // What these DO pin is the identity contract callers rely on: a pass that changes nothing hands
  // back the original plan rather than an equal copy, which is what keeps the rewrite chain's
  // other identity checks meaningful.
  test('a plan with no `as` comes back by reference', () => {
    const plan = traversal(V(), out('E'), count());

    expect(dropUnreadAs(plan)).toBe(plan);
  });

  test('a plan WITH an unread `as` is rebuilt, so the gate is not simply always true', () => {
    const plan = traversal(V(), as_('x'), out('E'), count());

    expect(dropUnreadAs(plan)).not.toBe(plan);
    expect(dropUnreadAs(plan).steps.map((st) => st.kind)).toEqual(['V', 'out', 'count']);
  });

  test('a plan with a READ `as` is returned unchanged by reference too', () => {
    const plan = traversal(V(), as_('x'), out('E'), select('x'), count());

    expect(dropUnreadAs(plan)).toBe(plan);
  });
});

describe('answers for the shapes that keep the label', () => {
  test('select still resolves the tag', () => {
    const rows = toArray(traversal(V(), as_('x'), out('E'), select('x'), values('k')), g());

    expect([...(rows as number[])].sort((p, q) => p - q)).toEqual([1, 2]);
  });
});
