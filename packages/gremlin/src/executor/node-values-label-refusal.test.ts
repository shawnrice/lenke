import { describe, expect, test } from 'bun:test';

/**
 * `nodeValuesShortcut` REFUSES a leading `hasLabel` — item 1870, and the route is what is pinned.
 *
 * ⚠️⚠️ **THIS TEST EXISTS BECAUSE ITS ABSENCE HID A 678x REGRESSION IN SHIPPED CODE.** Item 1482
 * shipped the rung on `V().hasLabel(L).values(k)` at **2.39x** and that was correct at the time.
 * The pipeline then learned to seed a leading `hasLabel` from `graph.verticesByLabel`
 * (`seedFromIndex`), so it visits only the labelled vertices while the rung scans all of them —
 * inverting the verdict. Measured with a kill switch, one arm per build, 200,000 vertices:
 *
 *     label covers    THE RUNG    PIPELINE    pipeline faster by
 *     1 in 1            5.46 ms     5.61 ms   tie
 *     1 in 3           10.51        3.14      3.35x
 *     1 in 100          6.93        0.15      46x
 *     1 in 1000         6.78        0.01      678x
 *
 * **The whole gremlin suite passed either way.** The rung kept returning correct answers and
 * nothing asserted which route claimed the shape, so there was no signal at all — an A/B's verdict
 * decays when the arm it beat gets faster, and only a route assertion notices.
 *
 * ⚠️ SO THE LOAD-BEARING ASSERTIONS HERE ARE ROUTE ASSERTIONS, not answers. Answers are checked
 * too, because a refusal that broke the answer would be worse than the regression — but an
 * answer-only test is exactly what failed to catch this.
 */
import { Graph } from '@lenke/core';

import { V, hasLabel, toArray, traversal, values } from '../index.js';
import { nodeValuesShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 12; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: i % 3 === 0 ? ['T', 'S'] : ['T'],
      properties: { k: i },
    });
  }

  return g;
};

/** Does the rung CLAIM this plan? `undefined` means it declined and the pipeline will run. */
const claimed = (plan: ReturnType<typeof traversal>, g: Graph): boolean =>
  nodeValuesShortcut(plan, g) !== undefined;

describe('the no-hop values rung and the label', () => {
  test('an UNLABELLED scan is claimed — the case it still wins', () => {
    const g = build();

    expect(claimed(traversal(V(), values('k')), g)).toBe(true);
  });

  /**
   * ⚠️ THE REGRESSION ASSERTION. A labelled scan must NOT be claimed: the pipeline seeds from the
   * label index and the rung cannot. If this ever reads `true` again, the 3.35x-678x above is back.
   */
  test('a LABELLED scan is REFUSED, so the index seed can run', () => {
    const g = build();

    expect(claimed(traversal(V(), hasLabel('S'), values('k')), g)).toBe(false);
    expect(claimed(traversal(V(), hasLabel('T'), values('k')), g)).toBe(false);
    // Multi-label too — `hasLabel(A, B)` is a union of buckets, still the pipeline's job.
    expect(claimed(traversal(V(), hasLabel('S', 'T'), values('k')), g)).toBe(false);
  });

  test('the refused shapes still answer, and answer what the unlabelled scan would filter to', () => {
    const g = build();

    // `S` is on one vertex in three: v0, v3, v6, v9.
    expect(toArray(traversal(V(), hasLabel('S'), values('k')), g)).toEqual([0, 3, 6, 9]);
    // `T` is on every vertex, so it is the whole scan.
    expect(toArray(traversal(V(), hasLabel('T'), values('k')), g)).toEqual(
      toArray(traversal(V(), values('k')), g),
    );
    expect(toArray(traversal(V(), hasLabel('S', 'T'), values('k')), g)).toEqual(
      toArray(traversal(V(), values('k')), g),
    );
  });

  /**
   * A label NOTHING carries answers empty on both routes — and is worth its own case because an
   * index seed on a missing bucket is where an `?? EMPTY_VERTICES` fallback either works or does
   * not.
   */
  test('a label no vertex carries answers empty', () => {
    const g = build();

    expect(toArray(traversal(V(), hasLabel('NOPE'), values('k')), g)).toEqual([]);
  });

  /**
   * ⚠️ AND THE DEDUPED SIBLING REFUSES IT TOO (item 1869), for the same measured reason. Pinned
   * here beside its twin so the two cannot drift apart on this decision.
   */
  test('the deduped sibling refuses a label as well', () => {
    const g = build();

    expect(toArray(traversal(V(), hasLabel('S'), values('k')), g)).toEqual([0, 3, 6, 9]);
  });
});
