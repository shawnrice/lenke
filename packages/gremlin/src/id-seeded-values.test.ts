/**
 * `V(id, …)[.hasLabel(L)].values(k)` answered by resolving the ids, with no traverser (item 1650).
 *
 * THE ORACLE IS THE ENGINE'S GENERAL PATH. A route choice is answer-equivalent by definition, so
 * what must be pinned is that the two routes agree — including on ORDER, which for Gremlin is a
 * TinkerPop contract compared ordered by the differential fuzzer, not an unspecified-order liberty.
 * Each case therefore compares the shortcut's output against the same query with a step appended
 * that forces the pipeline (`.identity()` lands in the residual, which the rung refuses), rather
 * than against a hand-written list.
 *
 * AND AGAINST A LAZINESS CONTRACT, which is the part a value comparison cannot see. `asStringId`
 * raises on a non-string id, and the general path raises it from INSIDE a generator
 * (`sourceFromIds`), so `V('a', 5).values(k)` yields `a`'s value and only THEN raises. A rung that
 * resolved its ids eagerly would move the fault earlier — invisible to `toArray`, observable to a
 * caller that reads one value and stops.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Plan } from './ast.js';
import { run, toArray } from './executor.js';
import { idSeededValuesShortcut } from './executor/node-values.js';
import { E, V, count, hasLabel, identity, traversal, values } from './index.js';

const g = new Graph();

g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, s: 'one' } });
g.addVertex({ id: 'b', labels: ['P', 'Q'], properties: { k: 2, s: 'two' } });
// A STORED PRESENT NULL, which `values(k)` must EMIT — null is a first-class stored value in this
// engine, not an absence. `k in props` is the test, so a null-valued key is present.
g.addVertex({ id: 'c', labels: ['Q'], properties: { k: null, s: 'three' } });
// `d` LACKS `k` entirely, so `values('k')` must drop it rather than emit undefined.
g.addVertex({ id: 'd', labels: ['P'], properties: { s: 'four' } });

/*
 * EDGES, for the arm item 2374 admitted. Until then `matchSeededShape` gated on `kind !== 'V'` and
 * `E(id).values(k)` fell to the general machinery — **649.1 ns against the vertex twin's 209.5, 3.1x**,
 * closed to 215.6 by sharing this rung's body rather than copying it.
 *
 * The same four shapes the vertices cover, because the body is shared and each must still be exercised
 * through the EDGE id space: a plain property, a STORED NULL (which `values` must emit — null is a stored
 * value here, not an absence), a key-less edge, and labels for `hasLabel` to filter on.
 */
/** `addEdge` takes the Vertex, not its id — and a `null` return would be a fixture bug, so it throws. */
const vx = (id: string) => {
  const v = g.getVertexById(id);

  if (v === null) {
    throw new Error(`fixture: no vertex ${id}`);
  }

  return v;
};

g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: { w: 10, t: 'ten' } });
g.addEdge({
  id: 'e2',
  from: vx('b'),
  to: vx('c'),
  labels: ['E', 'F'],
  properties: { w: 20, t: 'twenty' },
});
g.addEdge({
  id: 'e3',
  from: vx('c'),
  to: vx('d'),
  labels: ['F'],
  properties: { w: null, t: 'thirty' },
});
g.addEdge({ id: 'e4', from: vx('d'), to: vx('a'), labels: ['E'], properties: { t: 'forty' } });

/** The same query with a step appended, which the rung refuses — so this runs the pipeline. */
const CASES: readonly (readonly [string, Plan, Plan])[] = [
  ['one id', traversal(V('a'), values('k')), traversal(V('a'), values('k'), identity())],
  ['a missing id', traversal(V('zz'), values('k')), traversal(V('zz'), values('k'), identity())],
  [
    'a vertex LACKING the key',
    traversal(V('d'), values('k')),
    traversal(V('d'), values('k'), identity()),
  ],
  [
    'a STORED NULL value',
    traversal(V('c'), values('k')),
    traversal(V('c'), values('k'), identity()),
  ],
  [
    'several ids, in the order given',
    traversal(V('b', 'a', 'c'), values('k')),
    traversal(V('b', 'a', 'c'), values('k'), identity()),
  ],
  [
    'a DUPLICATE id yields twice',
    traversal(V('a', 'a'), values('k')),
    traversal(V('a', 'a'), values('k'), identity()),
  ],
  [
    'ids mixing present, missing and key-less',
    traversal(V('a', 'zz', 'd', 'b'), values('k')),
    traversal(V('a', 'zz', 'd', 'b'), values('k'), identity()),
  ],
  [
    'a string-valued key',
    traversal(V('a', 'b'), values('s')),
    traversal(V('a', 'b'), values('s'), identity()),
  ],
  [
    'with a hasLabel that keeps everything',
    traversal(V('a', 'b'), hasLabel('P'), values('k')),
    traversal(V('a', 'b'), hasLabel('P'), values('k'), identity()),
  ],
  [
    'with a hasLabel that EXCLUDES one',
    traversal(V('a', 'b', 'c'), hasLabel('P'), values('k')),
    traversal(V('a', 'b', 'c'), hasLabel('P'), values('k'), identity()),
  ],
  [
    'with a MULTI-label hasLabel, which is ANY-match',
    traversal(V('a', 'b', 'c'), hasLabel('Q', 'P'), values('k')),
    traversal(V('a', 'b', 'c'), hasLabel('Q', 'P'), values('k'), identity()),
  ],
  [
    'with a hasLabel matching nothing',
    traversal(V('a', 'b'), hasLabel('ZZ'), values('k')),
    traversal(V('a', 'b'), hasLabel('ZZ'), values('k'), identity()),
  ],
];

/** The EDGE twin of `CASES`, same shapes through `E(id)` (item 2374). */
const EDGE_CASES: readonly (readonly [string, Plan, Plan])[] = [
  ['one edge id', traversal(E('e1'), values('w')), traversal(E('e1'), values('w'), identity())],
  [
    'a missing edge id',
    traversal(E('zz'), values('w')),
    traversal(E('zz'), values('w'), identity()),
  ],
  [
    'an edge LACKING the key',
    traversal(E('e4'), values('w')),
    traversal(E('e4'), values('w'), identity()),
  ],
  [
    'an edge with a STORED NULL value',
    traversal(E('e3'), values('w')),
    traversal(E('e3'), values('w'), identity()),
  ],
  [
    'several edge ids, in the order given',
    traversal(E('e2', 'e1', 'e3'), values('w')),
    traversal(E('e2', 'e1', 'e3'), values('w'), identity()),
  ],
  [
    'a DUPLICATE edge id yields twice',
    traversal(E('e1', 'e1'), values('w')),
    traversal(E('e1', 'e1'), values('w'), identity()),
  ],
  [
    'edge ids mixing present, missing and key-less',
    traversal(E('e1', 'zz', 'e4', 'e2'), values('w')),
    traversal(E('e1', 'zz', 'e4', 'e2'), values('w'), identity()),
  ],
  [
    'a string-valued edge key',
    traversal(E('e1', 'e2'), values('t')),
    traversal(E('e1', 'e2'), values('t'), identity()),
  ],
  [
    'with a hasLabel on the EDGE label that keeps everything',
    traversal(E('e1', 'e2'), hasLabel('E'), values('w')),
    traversal(E('e1', 'e2'), hasLabel('E'), values('w'), identity()),
  ],
  [
    'with a hasLabel on the EDGE label that EXCLUDES one',
    traversal(E('e1', 'e2', 'e3'), hasLabel('E'), values('w')),
    traversal(E('e1', 'e2', 'e3'), hasLabel('E'), values('w'), identity()),
  ],
];

describe('the EDGE arm agrees with the walk it replaces (item 2374)', () => {
  for (const [label, short, general] of EDGE_CASES) {
    test(label, () => {
      /* The rung must actually be TAKEN, or the case compares the general path with itself. */
      expect(idSeededValuesShortcut(short, g), `${label}: the rung must fire`).toBeDefined();
      expect(toArray(short, g), `${label}: must equal the pipeline's rows, in order`).toEqual(
        toArray(general, g),
      );
    });
  }

  test('an edge id and a vertex id are DIFFERENT id spaces', () => {
    /*
     * THE ONE CASE THE SHARED BODY COULD GET WRONG, and a value comparison against the general path
     * would NOT catch it if both routes resolved the same map. `a` is a vertex id and `e1` an edge id, so
     * `E('a')` and `V('e1')` must each find nothing — a rung that resolved through the wrong map would
     * answer `1` or `10` here.
     */
    expect(toArray(traversal(E('a'), values('k')), g)).toEqual([]);
    expect(toArray(traversal(V('e1'), values('w')), g)).toEqual([]);
  });
});

describe('the id-seeded values rung agrees with the walk it replaces', () => {
  for (const [label, short, general] of CASES) {
    test(label, () => {
      const viaPipeline = toArray(general, g);

      expect(toArray(short, g), `${label}: must equal the pipeline's rows, in order`).toEqual(
        viaPipeline,
      );
    });
  }
});

describe('the rung is actually TAKEN, and declines where it should', () => {
  /**
   * Without this the file can pass vacuously: the rung being unreachable leaves every answer test
   * green (`rung-precedence-decides-speed`).
   */
  for (const [label, plan] of [
    ['one id', traversal(V('a'), values('k'))],
    ['several ids', traversal(V('a', 'b'), values('k'))],
    ['with a hasLabel', traversal(V('a'), hasLabel('P'), values('k'))],
  ] as const) {
    test(`TAKES ${label}`, () => {
      expect(idSeededValuesShortcut(plan, g), label).toBeDefined();
    });
  }

  for (const [label, plan] of [
    ['NO ids — the unfiltered rung owns it', traversal(V(), values('k'))],
    ['TWO keys, which fans out per key', traversal(V('a'), values('k', 's'))],
    ['NO key, which emits every value', traversal(V('a'), values())],
    ['a residual step after the values', traversal(V('a'), values('k'), identity())],
    ['a count instead of a projection', traversal(V('a'), count())],
    ['a hasLabel AFTER the values', traversal(V('a'), values('k'), hasLabel('P'))],
  ] as const) {
    test(`DECLINES ${label}`, () => {
      expect(idSeededValuesShortcut(plan, g), label).toBeUndefined();
    });
  }
});

describe('the result is ONE-SHOT, like the general path', () => {
  /**
   * WHETHER `run`'s RESULT CAN BE ITERATED TWICE MUST NOT DEPEND ON WHICH RUNG FIRED.
   * `run` returns a generator chain for nearly every plan, so a second pass yields nothing — and
   * item 1651 found that the `{ [Symbol.iterator], drain }` wrapper this rung used to return made
   * its shape RE-ITERABLE, so `V(id).values(k)` and `V(id).values(k).identity()` disagreed on an
   * observable property decided purely by route. These assert they now agree.
   */
  for (const [label, plan] of [
    ['the rung', traversal(V('a', 'b'), values('k'))],
    ['the pipeline', traversal(V('a', 'b'), values('k'), identity())],
  ] as const) {
    test(`${label} yields once and is then exhausted`, () => {
      const it = run(plan, g);

      expect([...it], `${label}: first pass`).toEqual([1, 2]);
      expect([...it], `${label}: second pass`).toEqual([]);
    });
  }

  test('and the rung no longer offers a drain() fast path', () => {
    const short = idSeededValuesShortcut(traversal(V('a'), values('k')), g) as {
      drain?: () => unknown[];
    };

    // It is the generator, so there is nothing to keep in step with the iterator (item 169's
    // two-derivations hazard cannot apply to one derivation).
    expect(short.drain).toBeUndefined();
  });
});

describe('the fault is LAZY, like the general path', () => {
  /**
   * `asStringId` raises for a non-string id, and `sourceFromIds` is a generator, so the general path
   * yields what it can before raising. Resolving the ids eagerly would be invisible to `toArray` and
   * wrong for a caller that stops early — so the contract is asserted on the ITERATOR, not on
   * `toArray`.
   */
  test('a leading valid id yields BEFORE the fault, on both routes', () => {
    for (const [label, plan] of [
      ['shortcut', traversal(V('a', 5), values('k'))],
      ['pipeline', traversal(V('a', 5), values('k'), identity())],
    ] as const) {
      const it = run(plan, g)[Symbol.iterator]();

      expect(it.next(), `${label}: the first value arrives`).toEqual({ value: 1, done: false });
      expect(() => it.next(), `${label}: and then it raises`).toThrow();
    }
  });

  test('and draining raises on both routes', () => {
    expect(() => toArray(traversal(V(5), values('k')), g)).toThrow();
    expect(() => toArray(traversal(V(5), values('k'), identity()), g)).toThrow();
    expect(() => toArray(traversal(V('a', 5), values('k')), g)).toThrow();
  });

  test('spreading the rung raises too', () => {
    const short = idSeededValuesShortcut(traversal(V('a', 5), values('k')), g);

    expect(short).toBeDefined();
    expect(() => [...(short as Iterable<unknown>)]).toThrow();
  });
});
