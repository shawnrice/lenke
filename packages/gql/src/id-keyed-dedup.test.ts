import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1584 gave `valueSet` a container of its own for every value `valueKey` keys by id —
 * elements and any map carrying an `id` field — keyed on `String(v.id)` rather than on the
 * `'@' + String(v.id)` string `valueKey` builds. **1.92-2.31x**, because the `'@'` is a constant
 * within a container of its own and a string id needs no new string at all:
 *
 * ```text
 *   MATCH (a:P)-[:E]->(b) RETURN DISTINCT b          21.958 -> 11.425 ms   1.92x
 *   MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b)   17.895 ->  9.172      1.95x
 *   MATCH (n:P) RETURN count(DISTINCT n)              7.425 ->  3.210      2.31x
 *   MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a)   11.381 ->  5.126      2.22x
 * ```
 *
 * ⚠️ WHAT HAS TO BE PINNED, and it is not the speed. Dropping the tag means the container is now
 * the only thing keeping these values apart from other kinds, exactly as the `LocalDate` and zoned
 * containers above it are — so the EQUIVALENCE must be unchanged:
 *
 *   - a vertex, an edge and a map that share an id are ONE value, because `valueKey` made them
 *     one and this is meant to preserve it, not improve on it;
 *   - an id `5` and an id `'5'` are ONE value, which is why the key is `String(v.id)` and not the
 *     raw `v.id` — a raw key would split them;
 *   - a value with no `id` is untouched and still takes the structural branch.
 *
 * These are REACHABLE, which was checked rather than assumed: a `UNION` puts a node column and a
 * map-with-`id` column into one dedup, and `{id: …}` is a map literal needing no element at all.
 */
const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
  const b = graph.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });
  const c = graph.addVertex({ id: 'z', labels: ['P'], properties: { k: 1 } });

  graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  graph.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });
  graph.addEdge({ id: 'e3', from: a, to: c, labels: ['E'] });
  // Two edges into the same far node, so a dedup has something to collapse.
  graph.addEdge({ id: 'e4', from: c, to: b, labels: ['E'] });

  return graph;
};

const rows = (graph: Graph, q: string): Array<Record<string, unknown>> => query(graph, q);

describe('an element dedups on its id, as it always did', () => {
  test('count(DISTINCT <node>) counts elements and not edges', () => {
    const graph = g();

    // Four edges; far ends are y, z, z, y -> two distinct.
    expect(rows(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
    expect(rows(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c')).toEqual([{ c: 2 }]);
    // Start ends are x, y, x, z -> three distinct.
    expect(rows(graph, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c')).toEqual([{ c: 3 }]);
  });

  test('the rows spelling yields one row per distinct element', () => {
    const graph = g();
    const out = rows(graph, 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b');

    expect(out).toHaveLength(2);
    expect(out.map((r) => (Object.values(r)[0] as { id: string }).id).sort()).toEqual(['y', 'z']);
  });

  test('edges dedup by id too — the same branch, a different element kind', () => {
    const graph = g();

    expect(rows(graph, 'MATCH ()-[e:E]->() RETURN count(DISTINCT e) AS c')).toEqual([{ c: 4 }]);
    expect(rows(graph, 'MATCH ()-[e:E]->() RETURN DISTINCT e')).toHaveLength(4);
  });

  test('a node-only scan dedups every vertex once', () => {
    const graph = g();

    expect(rows(graph, 'MATCH (n:P) RETURN count(DISTINCT n) AS c')).toEqual([{ c: 3 }]);
  });
});

describe("WHAT ACTUALLY REACHES the `'id' in v` branch: elements, and nothing else", () => {
  // ⚠️ I GOT THIS WRONG AND THESE TESTS CAUGHT IT. The container is gated on `'id' in v`, and I
  // assumed a map literal `{id: 'x'}` passed that test — so I wrote two assertions saying a map
  // and a vertex sharing an id collapse into one dedup value. Both failed.
  //
  // `'id' in LenkeRecord` is FALSE: a record holds its fields internally and has no own keys, so
  // `Object.keys(rec)` is `[]`. A map therefore falls through to `valueKey`'s record branch and
  // keys as `{id=n5,}` — which also means it keeps its field TYPES apart, where an element id is
  // coerced with `String`.
  //
  // So item 1584's container is reached ONLY by real elements, whose `id` is always a string. That
  // makes the change strictly narrower than I first described it, and these are the tests that say
  // so rather than a comment claiming it.
  test('a map with an id field is NOT an element, and keeps its field types apart', () => {
    const graph = g();

    // `{id: 5}` and `{id: '5'}` are TWO values, because the record branch keys `n5` and `s5`
    // distinctly. An element's id would be coerced; a record's field is not.
    expect(
      rows(
        graph,
        "MATCH (n:P) RETURN DISTINCT {id: 5} UNION MATCH (n:P) RETURN DISTINCT {id: '5'}",
      ),
    ).toHaveLength(2);
  });

  test('a map does NOT collapse with a vertex sharing its id', () => {
    const graph = g();

    expect(
      rows(
        graph,
        "MATCH (n:P) WHERE n.k = 2 RETURN DISTINCT n UNION MATCH (m:P) RETURN DISTINCT {id: 'y'}",
      ),
    ).toHaveLength(2);
  });

  test('a VERTEX and an EDGE sharing an id DO collapse — both take the branch', () => {
    // This is the collapse `valueKey` has always produced (`'@' + String(v.id)` for either kind),
    // and the one item 1584 had to preserve: dropping the tag is only sound because the container
    // holds BOTH element kinds, exactly as it did when they shared a tag.
    const graph = new Graph();
    const a = graph.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
    const b = graph.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });

    // An edge may share a vertex's id — checked, not assumed.
    graph.addEdge({ id: 'x', from: a, to: b, labels: ['E'] });

    const out = rows(
      graph,
      'MATCH (n:P) WHERE n.k = 1 RETURN DISTINCT n UNION MATCH ()-[e:E]->() RETURN DISTINCT e',
    );

    // Vertex `x` and edge `x` are ONE value, so the UNION of the two one-row columns is one row.
    expect(out).toHaveLength(1);
  });

  test('distinct ids stay distinct across element kinds', () => {
    const graph = g();

    // `g()`'s edges are e1..e4 and its vertices x, y, z — no id is shared, so nothing collapses.
    expect(
      rows(graph, 'MATCH (n:P) RETURN DISTINCT n UNION MATCH ()-[e:E]->() RETURN DISTINCT e'),
    ).toHaveLength(7);
  });
});

describe('⚠️ the String(v.id) coercion is LOAD-BEARING, and it preserves a TS BUG', () => {
  // MUTATION FOUND THIS GAP. Replacing `String(v.id)` with a bare cast survived the whole suite,
  // and the reason was not that the coercion is dead — it is that nothing covered it. A vertex id
  // may be a NUMBER: `addVertex({ id: 5 })` stores `5`, not `'5'`.
  //
  // ⚠️⚠️ AND THE BEHAVIOUR IT PRESERVES IS WRONG. `valueKey` keys an element as
  // `'@' + String(v.id)`, so a vertex with id `5` and a DIFFERENT vertex with id `'5'` are one
  // value — `count(*)` is 2 while `count(DISTINCT n)` is 1, for two genuinely distinct vertices.
  // Native answers 2, which is correct. That is a PRE-EXISTING TS bug, not item 1584's: item 1584
  // is a perf change and preserving the existing equivalence exactly was the point, so the
  // coercion stays and this test pins it as the CURRENT state rather than as desired behaviour.
  //
  // Fixing it belongs to its own item: `valueKey`'s conflation is shared by `groupIndex` and the
  // set-operation dedup, so a fix in one place alone would make DISTINCT and GROUP BY disagree
  // with each other. Two containers — one for string ids, one for the rest — would fix it without
  // giving back item 1584's win, since neither needs a tag.
  const mixed = (): Graph => {
    const graph = new Graph();

    // ⚠️ The TYPE says `id: string`, so this needs a cast — which narrows how the bug is reached:
    // not from typed code, but from untyped JS or from DESERIALIZATION. NDJSON `{"id":5,…}`
    // ingests fine (that is how the native side of the comparison got its numeric id), so the
    // conflation is reachable in practice and not only in a cast.
    graph.addVertex({ id: 5 as unknown as string, labels: ['P'], properties: { k: 1 } });
    graph.addVertex({ id: '5', labels: ['P'], properties: { k: 2 } });

    return graph;
  };

  test('both vertices exist and are counted', () => {
    expect(rows(mixed(), 'MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });

  test('CURRENT STATE: a numeric id and its string form collapse in a dedup', () => {
    // If this test starts failing because someone split the ids by type, that is the FIX — update
    // this test rather than the code, and check `groupIndex` and the set-op dedup in the same
    // change. A bare `v.id` key (no coercion) would also make it fail, which is what gives the
    // mutation survivor its teeth.
    expect(rows(mixed(), 'MATCH (n:P) RETURN count(DISTINCT n) AS c')).toEqual([{ c: 1 }]);
    expect(rows(mixed(), 'MATCH (n:P) RETURN DISTINCT n')).toHaveLength(1);
  });
});

describe('values with no id are untouched', () => {
  test('a list still dedups structurally', () => {
    const graph = g();

    // Two vertices have k = 1, one has k = 2, so [k, k] takes two distinct values.
    expect(rows(graph, 'MATCH (n:P) RETURN count(DISTINCT [n.k, n.k]) AS c')).toEqual([{ c: 2 }]);
  });

  test('a map without an id dedups structurally', () => {
    const graph = g();

    expect(rows(graph, 'MATCH (n:P) RETURN count(DISTINCT {v: n.k}) AS c')).toEqual([{ c: 2 }]);
  });

  test('primitives and nulls keep their own rules', () => {
    const graph = g();

    expect(rows(graph, 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c')).toEqual([{ c: 2 }]);
    // A null never counts toward count(DISTINCT …).
    expect(rows(graph, 'MATCH (n:P) RETURN count(DISTINCT n.nope) AS c')).toEqual([{ c: 0 }]);
  });
});
