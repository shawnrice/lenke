import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  both,
  count,
  in_,
  inV,
  limit,
  out,
  outE,
  path,
  run,
  toArray,
  traversal,
  values,
} from '../index.js';
import { pathHopValues } from './path-hop-values.js';

/**
 * `V().out(T).path()` with the path built directly instead of accumulated (item 1920).
 *
 * The workload screen's TOP row, at 200,000 vertices / 800,000 edges:
 *
 *     path: hop path   124.55 -> 8.40 ms for 600,000 rows   <- 14.8x
 *     hop1: values      45.75     for the same 600,000      the same walk, no path
 *
 * `path()` MAKES `planReadsPath` TRUE, and every fused walk in this package is gated on
 * `!tracksPath`, so this shape reached no rung at all. The warrant for riding past that guard is
 * items 1912/1914's: the rung claims the WHOLE plan — three steps, `rest` always `[]` — so there is
 * no downstream step left that could ask for a path. A fourth step declines, which is also what
 * makes `limit(BIG)` a usable oracle below.
 *
 * THE LAYOUT WAS READ OFF THE ENGINE (`pathshape-probe-1920.mjs`) RATHER THAN ASSUMED, because a
 * fusion built on a guessed path layout is a wrong answer no aggregate would show: `[near, far]` per
 * edge, `[d, d]` for a self-loop, and `near` is the SCAN vertex for `in` as well as `out`.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd', 'z']) {
    g.addVertex({ id, labels: ['P'], properties: { k: id } });
  }

  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: vx('a'), to: vx('c'), labels: ['E'], properties: {} });
  // A SELF-LOOP, which is the only shape where the path's two elements are the same object.
  g.addEdge({ id: 'e3', from: vx('b'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e4', from: vx('c'), to: vx('d'), labels: ['E'], properties: {} });
  // A SECOND TYPE, so a typed hop is not vacuous.
  g.addEdge({ id: 'e5', from: vx('d'), to: vx('a'), labels: ['F'], properties: {} });
  // `z` is ISOLATED — a zero-degree vertex the walk must skip rather than emit.

  return g;
};

/** Each path rendered as the ids it holds, so a wrong END is visible rather than a wrong count. */
/** Projected rows rendered the same way, so a wrong END is visible rather than a wrong count. */
const paths2 = (rows: readonly unknown[]): string[] =>
  rows.map((p) => (Array.isArray(p) ? p.map((e) => String(e)).join('>') : `?${String(p)}`));

const paths = (rows: readonly unknown[]): string[] =>
  rows.map((p) =>
    Array.isArray(p) ? p.map((e) => String((e as Vertex).id)).join('>') : `?${String(p)}`,
  );

/**
 * TWICE, BECAUSE THE RUNG RIDES ITEM 1889'S SECOND-ASK POLICY and declines its own first call: a
 * single `toArray` measures the bucket walk and a repeat measures the CSR. Both must answer the
 * same — five mutants survived a single-`toArray` suite at item 1889 for exactly this reason.
 */
const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown[] => {
  const first = toArray(make(), g);
  const second = toArray(make(), g);

  expect(second).toStrictEqual(first);

  return second;
};

describe('the bare-path gate', () => {
  it('admits a directed single-type hop and nothing else', () => {
    const g = fixture();

    expect(pathHopValues(traversal(V(), out('E'), path()), g)).not.toBeUndefined();
    expect(pathHopValues(traversal(V(), in_('E'), path()), g)).not.toBeUndefined();

    // `both` walks two buckets and drops a self-loop's duplicate; a multi-type hop needs the
    // cross-bucket dedupe. `soleTypeBucket` refuses both and this follows it.
    expect(pathHopValues(traversal(V(), both('E'), path()), g)).toBeUndefined();
    expect(pathHopValues(traversal(V(), out('E', 'F'), path()), g)).toBeUndefined();
    expect(pathHopValues(traversal(V(), out(), path()), g)).toBeUndefined();

    // An EDGE step puts the edge in the path, and `values` puts a SCALAR there — other layouts.
    expect(pathHopValues(traversal(V(), outE('E'), path()), g)).toBeUndefined();
    expect(pathHopValues(traversal(V(), out('E'), values('k'), path()), g)).toBeUndefined();

    // A fourth step breaks the whole-plan warrant, which is what makes `limit` a safe oracle.
    expect(pathHopValues(traversal(V(), out('E'), path(), limit(99)), g)).toBeUndefined();
    expect(pathHopValues(traversal(V(), out('E'), path(), count()), g)).toBeUndefined();
    expect(pathHopValues(traversal(V(), out('E'), out('E'), path()), g)).toBeUndefined();

    // Two steps is the bare scan, not this shape.
    expect(pathHopValues(traversal(V(), path()), g)).toBeUndefined();

    // `V(id, …)` enumerates a given set rather than the whole graph.
    expect(pathHopValues(traversal(V('a'), out('E'), path()), g)).toBeUndefined();
  });
});

describe('pathHopValues — the answer, on both walks', () => {
  it('is [near, far] per edge, with the SELF-LOOP included', () => {
    const g = fixture();

    // a->b, a->c, b->b (the self-loop), c->d. `z` is isolated and contributes nothing.
    expect(paths(twice(() => traversal(V(), out('E'), path()), g))).toStrictEqual([
      'a>b',
      'a>c',
      'b>b',
      'c>d',
    ]);
  });

  it('for `in`, NEAR is still the scan vertex', () => {
    const g = fixture();

    // Reading the same four E edges backwards: b<-a, b<-b, c<-a, d<-c.
    expect(paths(twice(() => traversal(V(), in_('E'), path()), g))).toStrictEqual([
      'b>a',
      'b>b',
      'c>a',
      'd>c',
    ]);
  });

  it('and a different edge type selects different edges', () => {
    const g = fixture();

    expect(paths(twice(() => traversal(V(), out('F'), path()), g))).toStrictEqual(['d>a']);
    expect(paths(twice(() => traversal(V(), out('NOPE'), path()), g))).toStrictEqual([]);
  });

  /**
   * THE LAZY ITERATOR IS A SECOND COPY OF THE LOOP, and only spreading `run` reaches it — item
   * 1913's duplication hazard. Item 1914 then found that a `toArray` BEFORE the spread warms the
   * CSR, so the iterator's BUCKET arm was reached by nothing; both orders are driven here.
   */
  it('the LAZY iterator agrees with the eager drain — CSR arm', () => {
    const g = fixture();
    const make = (): ReturnType<typeof traversal> => traversal(V(), out('E'), path());

    toArray(make(), g); // warms the CSR

    expect(paths([...run(make(), g)])).toStrictEqual(['a>b', 'a>c', 'b>b', 'c>d']);
  });

  it('the LAZY iterator on a COLD graph — the BUCKET arm', () => {
    // A FRESH graph, because `seenBefore` records per (graph, topology, shape): without this the
    // iterator's bucket arm is unreachable.
    const g = fixture();

    expect(paths([...run(traversal(V(), out('E'), path()), g)])).toStrictEqual([
      'a>b',
      'a>c',
      'b>b',
      'c>d',
    ]);
  });

  /**
   * AND THE COLD ITERATOR MUST BE DRIVEN WITH `in` TOO — a MUTANT IS WHY. The bucket arm reads
   * `direct.forward ? e.to : e.from`, and for `out` that is just `e.to`, so a mutant replacing the
   * whole expression with `e.to` SURVIVED the first battery: every cold-iterator test used `out`.
   * This is the fourth path (iterator x bucket x the direction that discriminates), which is item
   * 1914's finding — a walk written twice over two arms is four paths and the obvious tests reach
   * two.
   */
  it('the LAZY iterator on a COLD graph, INCOMING — the arm that reads the other end', () => {
    const g = fixture();

    expect(paths([...run(traversal(V(), in_('E'), path()), g)])).toStrictEqual([
      'b>a',
      'b>b',
      'c>a',
      'd>c',
    ]);
  });

  /**
   * THE `by` MODE NEEDS THE ITERATOR ARMS TOO — all four paths, which is item 1920's own finding
   * in this very module: a walk written twice (lazy, eager) over two arms (CSR, bucket) is FOUR
   * paths, and that item's battery found three of them untested. Adding a MODE multiplies them
   * again, so each is driven here rather than assumed to follow from the drain.
   */
  it('the by mode on the LAZY iterator — CSR arm', () => {
    const g = fixture();
    const make = (): ReturnType<typeof traversal> => traversal(V(), out('E'), path().by('k'));

    toArray(make(), g); // warms the CSR

    expect([...run(make(), g)]).toStrictEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'b'],
      ['c', 'd'],
    ]);
  });

  it('the by mode on the LAZY iterator — COLD, the BUCKET arm', () => {
    // A FRESH graph, because `seenBefore` records per (graph, topology, shape).
    const g = fixture();

    expect([...run(traversal(V(), out('E'), path().by('k')), g)]).toStrictEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'b'],
      ['c', 'd'],
    ]);
  });

  it('the by mode reads the other end for `in`', () => {
    const g = fixture();

    expect(paths2(twice(() => traversal(V(), in_('E'), path().by('k')), g))).toStrictEqual([
      'b>a',
      'b>b',
      'c>a',
      'd>c',
    ]);
  });

  /** The path elements are the GRAPH'S OWN vertices, not copies — identity is the contract. */
  it('holds the real vertices, which downstream steps compare by identity', () => {
    const g = fixture();
    const first = twice(() => traversal(V(), out('E'), path()), g)[0] as Vertex[];

    // `getVertexById` is `Vertex | null`, so the cast is what makes `toBe` an identity check on a
    // Vertex rather than on a nullable — the point of the test is the OBJECT, not the id.
    expect(first[0]).toBe(g.getVertexById('a') as Vertex);
    expect(first[1]).toBe(g.getVertexById('b') as Vertex);

    // And a self-loop's two slots are the SAME object, not two equal ones.
    const loop = (twice(() => traversal(V(), out('E'), path()), g)[2] as Vertex[]) ?? [];

    expect(loop[0]).toBe(loop[1]);
  });
});

/**
 * Every answer above is also checked against the generic path, so a route that stopped being taken
 * would still have to be correct — and a route that is taken and wrong fails here.
 */
describe('the fused path agrees with the generic path', () => {
  const agree = (steps: readonly unknown[]): void => {
    const g = fixture();
    const fused = toArray(traversal(V(), ...(steps as never[])), g);
    // `limit` above the row count makes the plan four steps, so the gate refuses and the generic
    // pipeline answers the identical question.
    const generic = toArray(traversal(V(), ...(steps as never[]), limit(9999)), g);

    expect(paths(fused)).toStrictEqual(paths(generic));
  };

  it('for out, in and a second type', () => {
    agree([out('E'), path()]);
    agree([in_('E'), path()]);
    agree([out('F'), path()]);
    agree([out('NOPE'), path()]);
  });

  /**
   * `path().by(k)` IS NOW SERVED (item 1924) where item 1920 refused it — **304.87 -> 80.55 ms,
   * 3.78x**, which lands at its floor: `values(k)` is 44.99 for ONE property read per row and this
   * does two.
   */
  it('path().by(k) projects each element through the modulator', () => {
    const g = fixture();

    expect(pathHopValues(traversal(V(), out('E'), path().by('k')), g)).not.toBeUndefined();
    expect(toArray(traversal(V(), out('E'), path().by('k')), g)).toStrictEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'b'],
      ['c', 'd'],
    ]);
  });

  /**
   * AN ABSENT KEY AND A STORED NULL ARE DIFFERENT VALUES — `undefined` and `null` — and this is
   * the assertion a JSON comparison cannot make. `pathby-shape-1924.mjs`'s FIRST version used
   * `JSON.stringify`, which renders `undefined` inside an array AS `null`, and so showed the two as
   * identical. A fusion building `null` for an absent key would have passed it.
   */
  it('an absent key is undefined and a stored null is null', () => {
    const g = new Graph();
    const mk = (id: string, props: Record<string, unknown>): Vertex =>
      g.addVertex({ id, labels: ['P'], properties: props });
    const a = mk('a', { opt: 1 });

    mk('b', {}); // no `opt` at all
    mk('c', { opt: null }); // a STORED null

    g.addEdge({
      id: 'x1',
      from: a,
      to: g.getVertexById('b') as Vertex,
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'x2',
      from: a,
      to: g.getVertexById('c') as Vertex,
      labels: ['E'],
      properties: {},
    });

    const rows = toArray(traversal(V(), out('E'), path().by('opt')), g) as unknown[][];

    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBeUndefined();
    expect(rows[1][1]).toBeNull();
    // And the distinction survives a round trip the naive comparison would lose.
    expect(rows[0][1] === null).toBe(false);
  });

  /**
   * `Object.hasOwn`, NOT `in`: `evalBy`'s own note says an inherited name must never leak a
   * prototype function. With `in` the row would hold `function toString()`.
   */
  it('an inherited name does not leak a prototype function', () => {
    const g = fixture();
    const rows = toArray(traversal(V(), out('E'), path().by('toString')), g) as unknown[][];

    for (const row of rows) {
      expect(row[0]).toBeUndefined();
      expect(row[1]).toBeUndefined();
    }
  });

  /**
   * TWO `by`s CYCLE ROUND-ROBIN across path positions, so they are a DIFFERENT answer and must be
   * refused: `path().by(n).by(opt)` projects position 0 through `n` and position 1 through `opt`.
   */
  it('two bys are refused, and still cycle', () => {
    const g = fixture();

    expect(pathHopValues(traversal(V(), out('E'), path().by('k').by('n')), g)).toBeUndefined();
    /*
     * AND A NON-`key` BY IS REFUSED TOO — a mutant is why. Dropping the `by.kind === 'key'` test
     * survived, because every `by` in these tests is a key. Item 1899 shipped the mirror of this
     * bug (a gate testing `typeof by === 'string'` when the AST holds `{kind: 'key', key}`) and
     * only measuring BOTH spellings caught it.
     */
    expect(
      pathHopValues(traversal(V(), out('E'), path().by(traversal(values('k')))), g),
    ).toBeUndefined();
    // And the traversal-by still answers, through the generic path.
    expect(toArray(traversal(V(), out('E'), path().by(traversal(values('k')))), g)).toStrictEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'b'],
      ['c', 'd'],
    ]);
    // Both keys hold the same values in this fixture, so the assertion is on the REFUSAL plus the
    // answer still being produced by the generic path.
    expect(toArray(traversal(V(), out('E'), path().by('k').by('n')), g)).toHaveLength(4);
  });

  it('and the DECLINED shapes are untouched', () => {
    const g = fixture();

    // Each of these keeps the generic path; the assertion is that it still answers, with the
    // layout the probe recorded.
    expect(paths(toArray(traversal(V(), both('E'), path()), g)).length).toBe(8);
    expect(paths(toArray(traversal(V(), out('E'), out('E'), path()), g))).toStrictEqual([
      'a>b>b',
      'a>c>d',
      'b>b>b',
    ]);
    expect(
      toArray(traversal(V(), outE('E'), inV(), path()), g).map((p) => (p as unknown[]).length),
    ).toStrictEqual([3, 3, 3, 3]);
  });
});
