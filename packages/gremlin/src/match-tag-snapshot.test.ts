import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  as_,
  barrier,
  count,
  match,
  out,
  pipe,
  select,
  tagsObservedFrom,
  toArray,
  traversal,
  union,
  values,
} from './index.js';

/**
 * Item 1560: `match()`'s solver carries ONE mutable tag map down its depth-first search and snapshots
 * it per solution, because `extend` propagates `tags` by reference. `tagsObservedFrom` lets it SKIP
 * that snapshot when nothing downstream can read tags.
 *
 * ⚠️ THE SKIP IS A SILENT-WRONG-ANSWER RISK, which is why this file pins two different things. If
 * the analysis wrongly says "nobody reads tags", the emitted traverser shares the live map and a
 * later `select` reads whatever state the search had reached — the right row COUNT with the wrong
 * contents, which no count-based test can see. So:
 *
 *   - the ANSWER tests below read the bindings back out, with several distinct values, so a stale
 *     or shared map shows up as wrong CONTENTS rather than a wrong total (the lesson from the
 *     correlated-push tests: project, do not count);
 *   - the VERDICT tests pin `tagsObservedFrom` itself, including the allowlist's safe direction.
 */
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

  // a -> b -> c, plus a -> c, so `a` has two distinct out-neighbours and the solver branches.
  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });
  g.addEdge({ id: 'e3', from: a, to: c, labels: ['E'] });

  return g;
};

describe('the skip does not change answers', () => {
  test('match(...).count() — the shape the skip fires on', () => {
    const g = build();
    const plan = traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), count());

    // Three edges, each a distinct (a, b) assignment.
    expect(toArray(plan, g)).toEqual([3]);
  });

  test('match(...).select() reads the bindings back, and they are the RIGHT ones', () => {
    const g = build();
    // `select('b')` observes tags, so the snapshot MUST still be taken. Reading `k` off the
    // selected vertex distinguishes a correct binding from a stale one — three different values.
    const plan = traversal(
      V(),
      match(pipe(as_('a'), out('E'), as_('b'))),
      select('b'),
      values('k'),
    );

    expect([...(toArray(plan, g) as number[])].sort((x, y) => x - y)).toEqual([2, 3, 3]);
  });

  test('the two spellings agree on the SAME assignments', () => {
    const g = build();
    const selected = toArray(
      traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), select('a'), values('k')),
      g,
    ) as number[];

    // `a` is the start of each of the three edges: a, b, a.
    expect([...selected].sort((x, y) => x - y)).toEqual([1, 1, 2]);
  });

  test('a match nested in a sub-plan, with an OUTER select, still answers correctly', () => {
    const g = build();
    // ⚠️ THE CASE THE `tailObserved` DEFAULT EXISTS FOR. The inner plan's suffix is empty, so a
    // suffix-only analysis would skip the snapshot — and the outer `select('b')` would then read a
    // map the solver had kept rewriting. Steps reached through a sub-plan keep `matchStep`'s
    // default of "observed", so this stays correct.
    const plan = traversal(
      V(),
      union(match(pipe(as_('a'), out('E'), as_('b')))),
      select('b'),
      values('k'),
    );

    expect([...(toArray(plan, g) as number[])].sort((x, y) => x - y)).toEqual([2, 3, 3]);
  });
});

describe('⚠️ the snapshot is only load-bearing when a step BUFFERS traversers', () => {
  // THIS IS WHY THE FIRST VERSION OF THIS FILE HAD NO TEETH, found by mutation (item 1560). Three
  // mutants that skip the snapshot when it IS needed — flipping the `tagsObserved` default, inverting
  // the condition, and hard-coding the call site to `false` — all SURVIVED the whole 1500-test suite
  // plus the answer tests above.
  //
  // The reason is laziness. The pipeline is pull-based, so a consumer reads a traverser's tags
  // BEFORE the solver advances to the next candidate and rewrites the shared map. Sharing is then
  // accidentally safe, and no straight-line pipeline can tell the two apart.
  //
  // It stops being safe the moment a step BUFFERS traversers: every buffered traverser then holds
  // the same map, and a later read returns the LAST solution's binding for all of them. `barrier()`
  // is the smallest such step.
  test('barrier() then select() — every buffered traverser keeps its OWN binding', () => {
    const g = build();
    const plan = traversal(
      V(),
      match(pipe(as_('a'), out('E'), as_('b'))),
      barrier(),
      select('b'),
      values('k'),
    );

    // Without the snapshot all three rows collapse onto whichever `b` the solver finished on.
    expect([...(toArray(plan, g) as number[])].sort((x, y) => x - y)).toEqual([2, 3, 3]);
  });

  test('the suffix containing a reader after a barrier is reported as OBSERVED', () => {
    const plan = traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), barrier(), select('b'));
    const i = plan.steps.findIndex((s) => s.kind === 'match');

    // `barrier` is itself tag-blind and allowlisted; the `select` after it is what forces the
    // snapshot. A suffix of buffering steps ALONE needs no snapshot, because nothing reads.
    expect(tagsObservedFrom(plan.steps, i + 1)).toBe(true);
  });
});

describe('tagsObservedFrom: the allowlist, and its safe direction', () => {
  const kindsOf = (...steps: Parameters<typeof traversal>): readonly string[] =>
    traversal(...steps).steps.map((s) => s.kind);

  test('a tag-blind suffix answers false', () => {
    const plan = traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), count());
    const i = plan.steps.findIndex((s) => s.kind === 'match');

    expect(kindsOf(V(), match(pipe(as_('a'), out('E'), as_('b'))), count())).toEqual([
      'V',
      'match',
      'count',
    ]);
    expect(tagsObservedFrom(plan.steps, i + 1)).toBe(false);
  });

  test('a select in the suffix answers true', () => {
    const plan = traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), select('b'), count());
    const i = plan.steps.findIndex((s) => s.kind === 'match');

    expect(tagsObservedFrom(plan.steps, i + 1)).toBe(true);
  });

  test('an UNLISTED kind answers true — the allowlist defaults to observed', () => {
    // `order` is deliberately absent from TAG_BLIND_KINDS because it can carry a `by` traversal,
    // and `by` is not a SUBPLAN_FIELD, so the nested-plan check would not catch it. This pins the
    // direction: unlisted means observed, never the reverse.
    const plan = traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), count());

    expect(tagsObservedFrom([...plan.steps, { kind: 'order' } as never], 2)).toBe(true);
  });

  test('an empty suffix answers false', () => {
    expect(tagsObservedFrom([], 0)).toBe(false);
  });

  test('a tag-blind kind CARRYING a nested plan answers true', () => {
    // The second guard: a listed kind is still "observed" if it holds a sub-plan, because the
    // sub-plan can contain a reader.
    const inner = traversal(V(), select('b'));

    expect(tagsObservedFrom([{ kind: 'count', plan: inner } as never], 0)).toBe(true);
  });
});
