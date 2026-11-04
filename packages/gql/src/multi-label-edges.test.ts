import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * An edge carries a SET of types and the label indexes bucket it under every
 * one, so anything that sums or concatenates buckets sees a two-type edge once
 * per bucket. Native walks one adjacency list and asks "does this edge carry
 * any of these types", so a duplicate here is a cross-engine divergence — the
 * same shape as the `[:R|S]` double-count already fixed on the native side.
 *
 * Every edge below is BOTH `R` and `S`, which makes the reference trivial: every
 * spelling that selects an edge at all must select exactly the same edges.
 */
const twoLabelChain = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['V'], properties: {} });
  }

  for (const [id, from, to] of [
    ['e0', 'a', 'b'],
    ['e1', 'b', 'c'],
  ] as const) {
    g.addEdge({ id, from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels: ['R', 'S'] });
  }

  return g;
};

const rows = (src: string): unknown[] => query(twoLabelChain(), src);

describe('a multi-type edge is matched once per pattern', () => {
  test('a type disjunction counts each edge once', () => {
    const one = rows('MATCH (a)-[:R]->(b) RETURN count(*) AS n');

    expect(one).toEqual([{ n: 2 }]);
    expect(rows('MATCH (a)-[:S]->(b) RETURN count(*) AS n')).toEqual(one);
    expect(rows('MATCH (a)-[]->(b) RETURN count(*) AS n')).toEqual(one);
    expect(rows('MATCH (a)-[:R|S]->(b) RETURN count(*) AS n')).toEqual(one);
  });

  test('the labelled-endpoint count shortcut agrees', () => {
    const one = rows('MATCH (a:V)-[:R]->(b:V) RETURN count(*) AS n');

    expect(one).toEqual([{ n: 2 }]);
    expect(rows('MATCH (a:V)-[:R|S]->(b:V) RETURN count(*) AS n')).toEqual(one);
  });

  test('the two-hop degree product agrees', () => {
    const one = rows('MATCH (a)-[:R]->(b)-[:R]->(c) RETURN count(*) AS n');

    expect(one).toEqual([{ n: 1 }]);
    expect(rows('MATCH (a)-[:R|S]->(b)-[:R|S]->(c) RETURN count(*) AS n')).toEqual(one);
  });

  test('enumeration agrees with the counts', () => {
    const one = rows('MATCH (a)-[:R]->(b) RETURN a.nm AS x ORDER BY x');

    expect(rows('MATCH (a)-[:R|S]->(b) RETURN a.nm AS x ORDER BY x')).toEqual(one);
  });

  test('a reachability walk visits each edge once', () => {
    const one = rows('MATCH (a)-[:R]->{1,2}(b) RETURN count(*) AS n');

    expect(rows('MATCH (a)-[:R|S]->{1,2}(b) RETURN count(*) AS n')).toEqual(one);
  });
});

/**
 * The O(1) `count(*)` shortcut sums per-type bucket sizes, which is only sound
 * while no edge sits in two buckets — `graph.multiTypeEdgeCount === 0` arms it.
 * A counter that drifts silently returns a wrong number with no error, so these
 * drive an edge across the 1↔2 type boundary in every way the API allows and
 * check the answer after each step.
 */
describe('the count shortcut tracks edges crossing the one-type boundary', () => {
  const chain = (): Graph => {
    const g = new Graph();

    for (const id of ['a', 'b']) {
      g.addVertex({ id, labels: ['V'], properties: {} });
    }

    g.addEdge({ id: 'e0', from: g.getVertexById('a')!, to: g.getVertexById('b')!, labels: ['R'] });

    return g;
  };

  const n = (g: Graph, q: string): number => (query(g, q)[0] as { n: number } | undefined)?.n ?? 0;
  const both = (g: Graph): number => n(g, 'MATCH ()-[:R|S]->() RETURN count(*) AS n');

  test('single → multi → single', () => {
    const g = chain();
    const e = g.getEdgeById('e0')!;

    expect(both(g)).toBe(1);
    expect(g.multiTypeEdgeCount).toBe(0);

    g.addLabelToEdge('S', e);
    expect(g.multiTypeEdgeCount).toBe(1);
    expect(both(g)).toBe(1); // one edge, now in both buckets

    g.removeLabelFromEdge('S', e);
    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(1);
  });

  test('re-adding a type it already has changes nothing', () => {
    const g = chain();
    const e = g.getEdgeById('e0')!;

    g.addLabelToEdge('S', e);
    g.addLabelToEdge('S', e);

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(both(g)).toBe(1);
  });

  test('removing a type it does not have changes nothing', () => {
    const g = chain();

    g.removeLabelFromEdge('S', g.getEdgeById('e0')!);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(1);
  });

  test('a third type and back', () => {
    const g = chain();
    const e = g.getEdgeById('e0')!;

    g.addLabelToEdge('S', e);
    g.addLabelToEdge('T', e);
    expect(g.multiTypeEdgeCount).toBe(1); // still ONE multi-type edge, not two
    expect(both(g)).toBe(1);

    g.removeLabelFromEdge('T', e);
    expect(g.multiTypeEdgeCount).toBe(1);
    g.removeLabelFromEdge('S', e);
    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(1);
  });

  test('removing a multi-type edge re-arms the shortcut', () => {
    const g = chain();
    const e = g.getEdgeById('e0')!;

    g.addLabelToEdge('S', e);
    g.removeEdge(e);

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(0);
  });

  test('inserting a multi-type edge disarms it', () => {
    const g = chain();

    g.addEdge({
      id: 'e1',
      from: g.getVertexById('b')!,
      to: g.getVertexById('a')!,
      labels: ['R', 'S'],
    });

    expect(g.multiTypeEdgeCount).toBe(1);
    expect(both(g)).toBe(2);
  });

  test('a rolled-back type change leaves the counter where it started', () => {
    const g = chain();

    expect(() =>
      g.transaction(() => {
        g.addLabelToEdge('S', g.getEdgeById('e0')!);
        expect(g.multiTypeEdgeCount).toBe(1);

        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(1);
  });

  test('truncate resets the counter', () => {
    const g = chain();

    g.addLabelToEdge('S', g.getEdgeById('e0')!);
    g.truncate();

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(both(g)).toBe(0);
  });
});

/**
 * `labels()` takes an ELEMENT — a node or an edge — and returns its label set.
 *
 * ISO GQL does not define `labels()` at all: the standard interrogates labels
 * with the `IS LABELED` predicate, and its only element function is
 * `element_id`. `labels` is a Cypher inheritance vendors added, and the two that
 * ship it define it over an element rather than just a node — Spanner's
 * `LABELS(GRAPH_ELEMENT) -> ARRAY<STRING>` and Fabric's `labels(node_or_edge)`
 * "the labels of a node or edge as a list of strings". Both return a length-1
 * list for an edge because neither has multi-label edges; this engine does, so
 * it returns the whole set.
 */
describe('labels() of an edge is its type set', () => {
  const mixed = (): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['W', 'V'], properties: {} });
    g.addVertex({ id: 'b', labels: ['V'], properties: {} });
    g.addEdge({
      id: 'e0',
      from: g.getVertexById('a')!,
      to: g.getVertexById('b')!,
      labels: ['S', 'R'],
    });
    g.addEdge({ id: 'e1', from: g.getVertexById('b')!, to: g.getVertexById('a')!, labels: ['T'] });

    return g;
  };
  const ask = (src: string): unknown[] => query(mixed(), src);

  test('an edge reports every type, sorted', () => {
    expect(ask('MATCH ()-[e]->() RETURN labels(e) AS x ORDER BY x')).toEqual([
      { x: ['R', 'S'] },
      { x: ['T'] },
    ]);
  });

  test('a single-type edge still gets a one-element list', () => {
    expect(ask('MATCH ()-[e:T]->() RETURN labels(e) AS x')).toEqual([{ x: ['T'] }]);
  });

  test('the node arm is unchanged', () => {
    expect(ask('MATCH (n) RETURN labels(n) AS x ORDER BY x')).toEqual([
      { x: ['V'] },
      { x: ['V', 'W'] },
    ]);
  });

  test('type() stays singular', () => {
    // openCypher's `type(relationship) -> String` cannot express a set, so it
    // reports the first type. `labels(e)` is the accessor for all of them.
    expect(ask('MATCH ()-[e:R]->() RETURN type(e) AS x')).toEqual([{ x: 'S' }]);
  });

  test('neither function accepts a non-element', () => {
    expect(ask('MATCH (n) RETURN labels(n.missing) AS x LIMIT 1')).toEqual([{ x: null }]);
    expect(ask('MATCH (n) RETURN type(n) AS x LIMIT 1')).toEqual([{ x: null }]);
  });

  test('labels() agrees with the pattern matcher', () => {
    for (const t of ['R', 'S']) {
      expect(ask(`MATCH ()-[e:${t}]->() RETURN labels(e) AS x`)).toEqual([{ x: ['R', 'S'] }]);
    }

    expect(ask('MATCH ()-[e:S]->() RETURN size(labels(e)) AS x')).toEqual([{ x: 2 }]);
  });
});

/**
 * A MIXED fixture, which `twoLabelChain` above cannot provide: it makes every edge both `R` and
 * `S`, so a bucket walk that deduped nothing and one that deduped everything would agree on it.
 * Here `e1` carries both types while `e2` and `e3` carry one each, so the three buckets OVERLAP
 * PARTIALLY and the dedupe has to be exactly right rather than merely present.
 *
 * Item 1377 rewrote that dedupe — `edgesOfManyTypes` no longer builds a `seen` Set and instead asks
 * the EARLIER buckets directly, which was 62.5% on a 200,000-edge multi-type hop. The three cases
 * below are the ones that rewrite changes the MECHANISM for and which nothing in this package
 * covered: a DUPLICATE type (the same bucket appears twice in the walk), an ABSENT type (no bucket
 * at all), and the untyped walk over several buckets. `[:X|X]` appeared in zero gql tests.
 */
const mixedLabels = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: {} });
  }

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T', 'U'] });
  g.addEdge({ id: 'e2', from: v('a'), to: v('c'), labels: ['T'] });
  g.addEdge({ id: 'e3', from: v('b'), to: v('c'), labels: ['U'] });

  return g;
};

const mixed = (src: string): unknown[] => query(mixedLabels(), src);

describe('partially overlapping type buckets dedupe exactly (item 1377)', () => {
  test('a disjunction counts the union, not the sum of buckets', () => {
    // |T| = 2, |U| = 2, and e1 is in both, so the SUM is 4 and the UNION is 3.
    expect(mixed('MATCH (x:P)-[:T]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 2 }]);
    expect(mixed('MATCH (x:P)-[:U]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 2 }]);
    expect(mixed('MATCH (x:P)-[:T|U]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 3 }]);
  });

  test('bucket ORDER does not change the union', () => {
    expect(mixed('MATCH (x:P)-[:U|T]->(y:P) RETURN count(*) AS n')).toEqual(
      mixed('MATCH (x:P)-[:T|U]->(y:P) RETURN count(*) AS n'),
    );
  });

  test('an untyped walk over SEVERAL buckets counts each edge once', () => {
    // `types === undefined` with more than one bucket is the branch item 1377 restructured most,
    // and it is the one a single-type fixture can never reach.
    expect(mixed('MATCH (x:P)-[]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 3 }]);
  });

  test('a DUPLICATE type names the same bucket twice and still counts it once', () => {
    // The walk now holds the same `Set` at two positions, so position 1 must recognise position 0.
    expect(mixed('MATCH (x:P)-[:T|T]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 2 }]);
    expect(mixed('MATCH (x:P)-[:T|U|T]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 3 }]);
  });

  test('an ABSENT type contributes no bucket and changes nothing', () => {
    expect(mixed('MATCH (x:P)-[:T|Z]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 2 }]);
    expect(mixed('MATCH (x:P)-[:Z|W]->(y:P) RETURN count(*) AS n')).toEqual([{ n: 0 }]);
  });
});

/**
 * THE GLOBAL-BUCKET UNION (item 1386). `MATCH ()-[:E]->()` answers from a global bucket SIZE in
 * 0.003 ms; `-[:E|F]->` cost **6.44 ms** because `bucketSumsAreSound` correctly refuses to sum
 * overlapping buckets and the query fell through to the deduping walk. Counting the UNION instead is
 * 87% (7.7x) and order-symmetric.
 *
 * THE FIXTURE MAKES A SUM WRONG: `|E|` = 4 and `|F|` = 3, so the sum is 7 where the union is 5.
 * `e4` is a self-loop carrying both labels and `e5` ends at a `Q`, which is what lets the two
 * ADMISSION cases below bite — the union route is only valid when BOTH endpoints are vacuous, and a
 * real label on either end must send the query somewhere else entirely.
 */
const unionEdges = (): Graph => {
  const g = new Graph();

  // `nm`/`tg` carry the element's own id as a PROPERTY, because a projection has to read one and
  // `b.id` is not an accessor for the element id (it read as `null`, which made four of item 1388's
  // assertions pass against the wrong thing until the untyped case failed loudly).
  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: { nm: id } });
  }

  g.addVertex({ id: 'q', labels: ['Q'], properties: { nm: 'q' } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E', 'F'], properties: { tg: 'e1' } });
  g.addEdge({ id: 'e2', from: v('a'), to: v('c'), labels: ['E'], properties: { tg: 'e2' } });
  g.addEdge({ id: 'e3', from: v('b'), to: v('c'), labels: ['F'], properties: { tg: 'e3' } });
  g.addEdge({ id: 'e4', from: v('a'), to: v('a'), labels: ['E', 'F'], properties: { tg: 'e4' } });
  g.addEdge({ id: 'e5', from: v('a'), to: v('q'), labels: ['E'], properties: { tg: 'e5' } });

  return g;
};

const u = (src: string): unknown => query<{ c: number }>(unionEdges(), src)[0]?.c;

describe('a multi-type edge count is the UNION of global buckets (item 1386)', () => {
  test('the single-type buckets are 4 and 3, so a SUM would answer 7', () => {
    expect(u('MATCH ()-[:E]->() RETURN count(*) AS c')).toBe(4);
    expect(u('MATCH ()-[:F]->() RETURN count(*) AS c')).toBe(3);
  });

  test('the disjunction counts the union, not the sum', () => {
    expect(u('MATCH ()-[:E|F]->() RETURN count(*) AS c')).toBe(5);
  });

  test('type ORDER does not change it', () => {
    expect(u('MATCH ()-[:F|E]->() RETURN count(*) AS c')).toBe(5);
  });

  test('a DUPLICATE type names one bucket twice and counts it once', () => {
    expect(u('MATCH ()-[:E|E]->() RETURN count(*) AS c')).toBe(4);
  });

  test('an ABSENT type contributes nothing', () => {
    expect(u('MATCH ()-[:E|Z]->() RETURN count(*) AS c')).toBe(4);
    expect(u('MATCH ()-[:Z|W]->() RETURN count(*) AS c')).toBe(0);
  });

  test('an UNTYPED rel is every edge once, whatever labels it carries', () => {
    expect(u('MATCH ()-[]->() RETURN count(*) AS c')).toBe(5);
  });

  // THE ADMISSION CASES. The union is over the WHOLE graph, so it is only the answer when neither
  // endpoint is really labelled — otherwise the question is a degree sum over that endpoint's
  // bucket. Only `e5` reaches a `Q`, and nothing leaves one.
  test('a REAL label on an endpoint declines the whole-graph route', () => {
    expect(u('MATCH ()-[:E|F]->(x:Q) RETURN count(*) AS c')).toBe(1);
    expect(u('MATCH (x:Q)-[:E|F]->() RETURN count(*) AS c')).toBe(0);
  });

  test('past the type CAP it declines and the answer is unchanged', () => {
    expect(u('MATCH ()-[:E|F|Z1|Z2|Z3|Z4|Z5|Z6|Z7]->() RETURN count(*) AS c')).toBe(5);
  });
});

/**
 * The YIELD side of the same disjunction (item 1388).
 *
 * Item 1387 measured `-[:E|F]->(b) RETURN b.n` at 379.6 ms against `-[:E]->`'s 38.9 over the
 * identical 200,000 edges - 9.8x, same 20,000 rows - because `hopEnds` declined any disjunction and
 * the query fell onto the general matcher. Admitting it means the plain hop walks now union a
 * vertex's buckets themselves, so the thing to pin is that a two-type edge produces ONE row and that
 * every route the guard still declines keeps answering.
 *
 * The fixture's shape is what makes these cheap to read: `e1` and `e4` carry BOTH types, so a
 * concatenating walk would emit 7 rows where 5 are right - the same arithmetic the count tests above
 * use, now observed per row rather than in a total.
 */
const uRows = (src: string): unknown[] => query(unionEdges(), src).map((r) => r['x']);

/** Row ORDER is unspecified, so every assertion here is on the multiset. */
const uSorted = (src: string): unknown[] => uRows(src).slice().sort();

describe('a multi-type hop PROJECTION yields each edge once (item 1388)', () => {
  test('the single-type projections are 4 and 3 rows, so a concatenation would be 7', () => {
    expect(uRows('MATCH ()-[:E]->(b) RETURN b.nm AS x')).toHaveLength(4);
    expect(uRows('MATCH ()-[:F]->(b) RETURN b.nm AS x')).toHaveLength(3);
  });

  test('the disjunction yields the union, not the concatenation', () => {
    expect(uSorted('MATCH ()-[:E|F]->(b) RETURN b.nm AS x')).toEqual(['a', 'b', 'c', 'c', 'q']);
  });

  test('type ORDER does not change the multiset', () => {
    expect(uSorted('MATCH ()-[:F|E]->(b) RETURN b.nm AS x')).toEqual(
      uSorted('MATCH ()-[:E|F]->(b) RETURN b.nm AS x'),
    );
  });

  test('a DUPLICATE type names one bucket twice and yields it once', () => {
    expect(uSorted('MATCH ()-[:E|E]->(b) RETURN b.nm AS x')).toEqual(['a', 'b', 'c', 'q']);
  });

  test('an ABSENT type contributes no rows', () => {
    expect(uSorted('MATCH ()-[:E|Z]->(b) RETURN b.nm AS x')).toEqual(['a', 'b', 'c', 'q']);
    expect(uRows('MATCH ()-[:Z|W]->(b) RETURN b.nm AS x')).toHaveLength(0);
  });

  test('a FAR LABEL still filters, and only e5 reaches a Q', () => {
    expect(uSorted('MATCH ()-[:E|F]->(b:Q) RETURN b.nm AS x')).toEqual(['q']);
    expect(uSorted('MATCH ()-[:E|F]->(b:P) RETURN b.nm AS x')).toEqual(['a', 'b', 'c', 'c']);
  });

  test('the START end can be projected, which routes elsewhere and must still dedupe', () => {
    expect(uSorted('MATCH (a)-[:E|F]->() RETURN a.nm AS x')).toEqual(['a', 'a', 'a', 'a', 'b']);
  });

  // THE DECLINED ROUTES. `MULTI_TYPE_PLAIN_ONLY` sends each of these to the general matcher, which
  // is the code that answered them before item 1388 - so these pin that the guard's complement is
  // the right one. A route that slipped past it would answer for `types[0]` alone: a WRONG answer.
  test('a FAR PREDICATE declines the plain walk and still answers', () => {
    expect(uSorted(`MATCH ()-[:E|F]->(b) WHERE b.nm <> 'c' RETURN b.nm AS x`)).toEqual([
      'a',
      'b',
      'q',
    ]);
  });

  test('a BOUND REL declines the plain walk and still answers', () => {
    expect(uSorted('MATCH ()-[r:E|F]->() RETURN r.tg AS x')).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
    ]);
  });

  // NINE, not ten: four two-way edges give 8 and the `a`->`a` SELF-LOOP is traversed once. That is
  // the pre-existing answer by construction - `hopEnds` declined every disjunction before item 1388
  // and `MULTI_TYPE_PLAIN_ONLY` declines the undirected one after, so this query takes the identical
  // path either side of the change. I guessed 10 and the test said 9; the number is the engine's.
  test('an UNDIRECTED hop declines the plain walk and still answers', () => {
    expect(uRows('MATCH ()-[:E|F]-(b) RETURN b.nm AS x')).toHaveLength(9);
  });

  test('past the type CAP it declines and the rows are unchanged', () => {
    expect(uSorted('MATCH ()-[:E|F|Z1|Z2|Z3|Z4|Z5|Z6|Z7]->(b) RETURN b.nm AS x')).toEqual([
      'a',
      'b',
      'c',
      'c',
      'q',
    ]);
  });

  test('an UNTYPED hop is every edge once, which this route never had to change', () => {
    expect(uSorted('MATCH ()-[]->(b) RETURN b.nm AS x')).toEqual(['a', 'b', 'c', 'c', 'q']);
  });
});
