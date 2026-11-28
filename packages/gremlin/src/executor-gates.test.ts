import { describe, expect, it } from 'bun:test';

import { type Plan, type Step, emptyPlan } from './ast.ts';
import { hasRevisit } from './executor/filters.ts';
import { type Hop, csrEligible } from './executor/hop-arm.ts';
import { tailIsOrderFree, tailIsOrderFreeFrom } from './executor/index-seed.ts';
import { hasAny, isEmptyPlan, isSliceable } from './executor/runtime.ts';

/**
 * Item 2462: six executor gates from item 2460's coverage map, none of them named in any test.
 *
 * A route choice is ANSWER-EQUIVALENT, so neither direction of a gate mutation is visible to the
 * differential, fuzz or conformance suites: narrowing sends a servable shape to the general path
 * (same rows, slower) and widening admits a shape the fast arm may answer wrongly. That is
 * `perf-gate-needs-its-own-test`.
 *
 * `csrEligible` is the clearest case — it is used in BOTH polarities at its call sites
 * (`csrEligible(hop) && seenBefore(…)` in `coalesce-hop-values.ts`, and `!csrEligible(thenHop)` in
 * `choose-hop-values.ts`), so a flip changes two behaviours in opposite directions at once and
 * neither shows up as a wrong row.
 *
 * Each assertion pins the VALUE at a boundary rather than that the gate "answered"
 * (`gate-returning-a-value`).
 */

const hop = (kind: 'out' | 'in' | 'both', labels: string[]): Hop => ({ kind, labels });
const step = (kind: string): Step => ({ kind }) as Step;
// `Plan` carries `readsPath`/`kinds`/`mayFault` and two symbol keys by construction (item 1504),
// so build from the exported empty one rather than casting a bare object through `unknown`.
const plan = (steps: Step[]): Plan => ({ ...emptyPlan, steps });

describe('csrEligible', () => {
  it('admits exactly one label on a directed hop — the whole domain, enumerated', () => {
    const kinds = ['out', 'in', 'both'] as const;
    const got: string[] = [];

    for (const kind of kinds) {
      for (const n of [0, 1, 2, 3]) {
        const labels = Array.from({ length: n }, (_v, i) => `L${i}`);

        got.push(`${kind}/${n}=${csrEligible(hop(kind, labels))}`);
      }
    }

    expect(got).toStrictEqual([
      'out/0=false',
      'out/1=true',
      'out/2=false',
      'out/3=false',
      'in/0=false',
      'in/1=true',
      'in/2=false',
      'in/3=false',
      'both/0=false',
      'both/1=false',
      'both/2=false',
      'both/3=false',
    ]);
  });

  it('refuses BOTH even with a single label', () => {
    // `both` would need two adjacency partitions, so one label is not enough to make it eligible.
    expect(csrEligible(hop('both', ['L0']))).toBe(false);
  });
});

describe('tailIsOrderFreeFrom', () => {
  it('requires the tail to END in count — that is what makes order unobservable', () => {
    expect(tailIsOrderFreeFrom([step('out'), step('count')], 0)).toBe(true);
    expect(tailIsOrderFreeFrom([step('count'), step('out')], 0)).toBe(false);
    expect(tailIsOrderFreeFrom([step('out')], 0)).toBe(false);
  });

  it('is false for an EMPTY tail, which returns the elements themselves', () => {
    expect(tailIsOrderFreeFrom([], 0)).toBe(false);
  });

  it('accepts a bare count', () => {
    // from = 0, last is count, and the interior loop spans nothing.
    expect(tailIsOrderFreeFrom([step('count')], 0)).toBe(true);
  });

  it('admits only out / in / both / dedupe between `from` and the count', () => {
    for (const kind of ['out', 'in', 'both', 'dedupe']) {
      expect(tailIsOrderFreeFrom([step(kind), step('count')], 0)).toBe(true);
    }

    for (const kind of ['order', 'values', 'limit', 'tail', 'where', 'path']) {
      expect(tailIsOrderFreeFrom([step(kind), step('count')], 0)).toBe(false);
    }
  });

  it('checks only from `from` ONWARD, leaving earlier steps deliberately unexamined', () => {
    // This is why it takes an index instead of a slice: `seedRest` asks once per leading filter of
    // every traversal, so slicing would allocate on a path every query takes. The consequence is
    // that an order-SENSITIVE step before `from` does not disqualify the tail.
    const steps = [step('order'), step('out'), step('count')];

    expect(tailIsOrderFreeFrom(steps, 1)).toBe(true);
    expect(tailIsOrderFreeFrom(steps, 0)).toBe(false);
  });

  it('is false when `from` is at or past the end', () => {
    const steps = [step('out'), step('count')];

    expect(tailIsOrderFreeFrom(steps, 2)).toBe(false);
    expect(tailIsOrderFreeFrom(steps, 7)).toBe(false);
  });

  it('tailIsOrderFree is the whole-array form', () => {
    expect(tailIsOrderFree([step('out'), step('count')])).toBe(true);
    expect(tailIsOrderFree([step('order'), step('count')])).toBe(false);
    expect(tailIsOrderFree([])).toBe(false);
  });
});

describe('hasRevisit', () => {
  it('is false for an empty path and for distinct elements', () => {
    expect(hasRevisit([])).toBe(false);
    expect(hasRevisit([1, 2, 3])).toBe(false);
  });

  it('is true for a repeat, adjacent or not', () => {
    expect(hasRevisit([1, 1])).toBe(true);
    expect(hasRevisit([1, 2, 3, 1])).toBe(true);
  });

  it('compares by IDENTITY, so equal-looking distinct objects are not a revisit', () => {
    const a = { id: 1 };
    const b = { id: 1 };

    expect(hasRevisit([a, b])).toBe(false);
    expect(hasRevisit([a, b, a])).toBe(true);
  });

  it('uses Set semantics: NaN revisits itself and 0 / -0 are the same element', () => {
    // Worth pinning because it differs from `===`: NaN !== NaN, yet a Set treats them as one.
    expect(hasRevisit([Number.NaN, Number.NaN])).toBe(true);
    expect(hasRevisit([0, -0])).toBe(true);
  });
});

describe('hasAny', () => {
  it('reports whether a stream yields anything', () => {
    expect(hasAny([])).toBe(false);
    expect(hasAny([1])).toBe(true);
    expect(hasAny(new Set())).toBe(false);
  });

  it('pulls at most ONE element — it must not drain the stream', () => {
    let pulled = 0;
    const counted = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 100; i += 1) {
          pulled += 1;

          yield i;
        }
      },
    };

    expect(hasAny(counted)).toBe(true);
    expect(pulled).toBe(1);
  });

  it('is true for a stream whose only element is falsy', () => {
    // The question is presence, not truthiness.
    expect(hasAny([undefined])).toBe(true);
    expect(hasAny([0])).toBe(true);
  });
});

describe('isSliceable', () => {
  it('refuses null, undefined and — deliberately — strings', () => {
    // A string IS iterable, so this is an explicit carve-out rather than a consequence.
    expect(isSliceable(null)).toBe(false);
    expect(isSliceable(undefined)).toBe(false);
    expect(isSliceable('abc')).toBe(false);
    expect(isSliceable('')).toBe(false);
  });

  it('accepts arrays, sets, maps and generators', () => {
    expect(isSliceable([])).toBe(true);
    expect(isSliceable(new Set([1]))).toBe(true);
    expect(isSliceable(new Map())).toBe(true);
    expect(
      isSliceable(
        (function* gen() {
          yield 1;
        })(),
      ),
    ).toBe(true);
  });

  it('refuses non-iterables', () => {
    expect(isSliceable(7)).toBe(false);
    expect(isSliceable(true)).toBe(false);
    expect(isSliceable({ length: 3 })).toBe(false);
  });
});

describe('isEmptyPlan', () => {
  it('is true only for a plan with no steps', () => {
    expect(isEmptyPlan(plan([]))).toBe(true);
    expect(isEmptyPlan(plan([step('out')]))).toBe(false);
  });
});
