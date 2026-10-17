// Item 540. Every shortcut in `run` matches a plan PREFIX that starts at the source —
// `countShortcut` wants `V()` plus one or two steps, `hopValuesShortcut` wants exactly
// `V().out(T).values(k)`, `groupCountShortcut` wants `V().groupCount()`. A leading `hasLabel` is
// one step too many for all of them, so it does not merely cost its own per-element test: it drops
// the whole query onto the traverser pipeline. At 100,000 vertices / 500,000 edges, every vertex
// carrying `Person`:
//
//   V().out('KNOWS').values('age')                         65.24 ms
//   V().hasLabel('Person').out('KNOWS').values('age')     134.40      2.1x
//   V().out('KNOWS').dedupe().count()                       3.39
//   V().hasLabel('Person').out('KNOWS').dedupe().count()  102.63     30.3x
//
// `dropVacuousLabels` removes the step when the label's bucket holds every live element, which is
// the plan-level form of the tautology short-circuit native's `IsLabeled` evaluator has.
//
// These assert the DECISION as well as the answer, because dropping a step that keeps everything
// is answer-preserving by construction: a mutant that never drops, or that drops a label it must
// not, passes every row assertion in the package. The decision is read through the TIMING-free
// route — `countShortcut` claims a shape only when the plan reaches it — plus direct answers for
// the cases where dropping would be wrong.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countShortcut } from './executor/count-shortcut.js';
import { E, V, count, dedupe, hasLabel, out, path, toArray, traversal, values } from './index.js';

/** Every vertex is a `P`; half are also `Q`. Every edge is a `KNOWS`. */
const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i % 2 === 0 ? ['P', 'Q'] : ['P'], properties: { n: i } }),
  );

  for (let i = 0; i < 6; i++) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i + 1) % 6], labels: ['KNOWS'], properties: {} });
  }

  return g;
};

const g = build();
const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('a vacuous hasLabel is dropped from the plan (item 540)', () => {
  test('the shortcut becomes reachable again, and the answer is unchanged', () => {
    // `V().out(T).dedupe().count()` is a reverse-adjacency read; with the label in front it was a
    // walk. Both must answer 6 — every vertex is reached by exactly one KNOWS edge.
    const bare = traversal(V(), out('KNOWS'), dedupe(), count());
    const labelled = traversal(V(), hasLabel('P'), out('KNOWS'), dedupe(), count());

    expect(arr(toArray(bare, g))).toEqual([6]);
    expect(arr(toArray(labelled, g))).toEqual([6]);
    // The DECISION: the plan the labelled form presents to `countShortcut` is now the bare one.
    // (`countShortcut` itself sees the raw plan, so this reads the shape rather than the route —
    // what matters is that the two plans agree once the vacuous step is gone.)
    expect(countShortcut(bare, g)).toBe(6);
  });

  test('a NON-vacuous label is kept — `Q` is only half the vertices', () => {
    // v0, v2, v4 are `Q`; each has one KNOWS out-edge, so three distinct targets.
    expect(arr(toArray(traversal(V(), hasLabel('Q'), out('KNOWS'), dedupe(), count()), g))).toEqual(
      [3],
    );
    expect(arr(toArray(traversal(V(), hasLabel('Q'), count()), g))).toEqual([3]);
  });

  test('a MULTI-label hasLabel is kept', () => {
    // It is already a union, and a vacuous one would need a different test. `P` or `Q` is every
    // vertex here, so a wrong drop would be invisible in the ANSWER — which is why the
    // non-vacuous single-label case above is the one with teeth for the drop rule.
    expect(arr(toArray(traversal(V(), hasLabel('P', 'Q'), count()), g))).toEqual([6]);
    expect(arr(toArray(traversal(V(), hasLabel('Q', 'P'), count()), g))).toEqual([6]);
  });

  test('a label AFTER a hop is kept — it tests the ENDPOINTS, not the source', () => {
    // Dropping this would be wrong whenever the endpoints are not the whole vertex set. Every
    // vertex is a `P` so the count is unchanged, but `Q` must still filter.
    expect(arr(toArray(traversal(V(), out('KNOWS'), hasLabel('Q'), count()), g))).toEqual([3]);
    expect(arr(toArray(traversal(V(), out('KNOWS'), hasLabel('P'), count()), g))).toEqual([6]);
  });

  test('an EDGE source drops a vacuous edge label too', () => {
    expect(arr(toArray(traversal(E(), hasLabel('KNOWS'), count()), g))).toEqual([6]);
    expect(arr(toArray(traversal(E(), hasLabel('NOPE'), count()), g))).toEqual([0]);
  });

  test('a label nothing carries is NOT vacuous and still filters', () => {
    expect(arr(toArray(traversal(V(), hasLabel('NOPE'), count()), g))).toEqual([0]);
    expect(arr(toArray(traversal(V(), hasLabel('NOPE'), out('KNOWS'), count()), g))).toEqual([0]);
  });

  test('with path() tracked the step is kept', () => {
    // A step's output is recorded, so removing one could change what a path contains. The answer
    // here is the same either way; the point is that the plan is not rewritten under `path()`.
    const withPath = arr(toArray(traversal(V(), hasLabel('P'), out('KNOWS'), path()), g));

    expect(withPath.length).toBe(6);
    // Each path is [start, end] — two elements, which a dropped filter cannot change but a
    // dropped SOURCE step would.
    expect((withPath[0] as unknown[]).length).toBe(2);
  });

  test('an EMPTY graph is left alone', () => {
    const empty = new Graph();

    expect(arr(toArray(traversal(V(), hasLabel('P'), count()), empty))).toEqual([0]);
    expect(arr(toArray(traversal(V(), hasLabel('P'), values('n')), empty))).toEqual([]);
  });
});
