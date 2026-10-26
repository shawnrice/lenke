import { describe, expect, it } from 'bun:test';

/**
 * `orderStep` must be LAZY: constructing it does no work, and the work happens on first pull.
 *
 * These arrived with item 892, which tried replacing the generator with a lazy `Iterable` handing
 * back an array iterator and was REFUTED on measurement (1.01x; see CLOSED.md). The tests outlived
 * the change because the contract they pin is not about the implementation — a generator and a
 * lazy wrapper are both lazy, and only an EAGER rewrite (`return sortByBys(...)`, the simplest
 * thing to reach for) breaks it.
 *
 * Why it matters: an eager step would run the sort and raise the element fault at `applyStep` time
 * rather than on the first pull. This engine has a recorded lazy-vs-eager deviation on
 * `limit(0)`-shaped plans, so that is a real behaviour change and not an implementation detail.
 *
 * No ordering assertion can see any of this, because the ORDER is identical either way: these
 * distinguish "constructed" from "iterated". Verified by mutation — the eager rewrite fails two of
 * them while leaving all 826 other gremlin tests green.
 */
import { Graph } from '@lenke/core';

import { orderStep } from './executor/aggregation.ts';
import type { Traverser } from './executor/runtime.ts';

const g = new Graph();
const v = g.addVertex({ id: 'v1', labels: ['P'], properties: { age: 1 } });

const t = (value: unknown): Traverser<unknown> => ({ value }) as Traverser<unknown>;

// `orderStep` takes the executor's own RunContext; nothing here needs its contents, and an empty
// object is what the identity `by` path touches.
const ctx = {} as never;
const IDENTITY = [{ kind: 'identity' }] as never;

describe('orderStep laziness', () => {
  it('does NOT consume the stream until iterated', () => {
    let pulled = 0;

    const stream: Iterable<Traverser<unknown>> = {
      *[Symbol.iterator]() {
        for (const n of [3, 1, 2]) {
          pulled += 1;

          yield t(n);
        }
      },
    };

    const out = orderStep(stream, IDENTITY, false, g, ctx);

    // Constructed but not iterated: an eager implementation would already have drained this.
    expect(pulled).toBe(0);

    const values = [...out].map((x) => x.value);

    expect(pulled).toBe(3);
    expect(values).toEqual([1, 2, 3]);
  });

  it('does NOT raise the element fault until iterated', () => {
    // A graph element has no natural order, so iterating must throw. CONSTRUCTING must not.
    const stream = [t(v), t(1)];

    let out: Iterable<Traverser<unknown>> | undefined;

    expect(() => {
      out = orderStep(stream, IDENTITY, false, g, ctx);
    }).not.toThrow();

    expect(() => [...(out as Iterable<Traverser<unknown>>)]).toThrow(
      /no natural order|not supported/,
    );
  });
});
