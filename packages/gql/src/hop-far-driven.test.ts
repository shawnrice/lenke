import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode } from '@lenke/errors';
import type { LenkeError } from '@lenke/errors';

import { query } from './index.js';

// When the START end is unconstrained, the fused hop projection drives the FAR side instead:
// iterate far endpoints in creation order and emit one row per incident edge (audit item 167).
// Measured 266ns/row -> 116ns/row over 1,000,000 edges, because the far vertex's property is
// read once per VERTEX rather than once per edge, and sequentially rather than at random.
//
// What has to hold, and what each test is for:
//
//   - the row MULTISET and COUNT are unchanged (order is unspecified and does change);
//   - COLUMN order is unchanged, because that IS observable bytes;
//   - a far vertex with several in-edges yields one row per edge, all equal;
//   - a start LABEL that some vertex fails must still route to the start-driven walk, since the
//     far-driven one cannot apply it;
//   - the direction's index must be the mirror one, or an `in` hop reads the wrong side.

/**
 * `h` is a hub with THREE in-edges and `t` has one; `iso` has none. Degrees are deliberately
 * uneven — a 1:1 fixture cannot tell "one row per edge" from "one row per far vertex", which is
 * the entire difference this walk introduces.
 */
const hub = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 's1', labels: ['S'], properties: { k: 's1' } });
  g.addVertex({ id: 's2', labels: ['S'], properties: { k: 's2' } });
  g.addVertex({ id: 's3', labels: ['S'], properties: { k: 's3' } });
  g.addVertex({ id: 'h', labels: ['D'], properties: { k: 'h', n: 1 } });
  g.addVertex({ id: 't', labels: ['D'], properties: { k: 't', n: 2 } });
  g.addVertex({ id: 'iso', labels: ['D'], properties: { k: 'iso', n: 3 } });

  const v = (id: string) => g.getVertexById(id)!;

  g.addEdge({ id: 'e1', from: v('s1'), to: v('h'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('s2'), to: v('h'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: v('s3'), to: v('h'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e4', from: v('s1'), to: v('t'), labels: ['E'], properties: {} });

  return g;
};

const multiset = (rows: readonly unknown[]): string[] => rows.map((r) => JSON.stringify(r)).sort();

describe('the far-driven hop projection yields one row per edge', () => {
  test('a hub with three in-edges yields three identical rows', () => {
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.k AS k');

    expect(rows.length).toBe(4);
    expect(multiset(rows)).toEqual(multiset([{ k: 'h' }, { k: 'h' }, { k: 'h' }, { k: 't' }]));
  });

  test('the isolated far vertex contributes nothing', () => {
    // `iso` is a `D` with no in-edges. The far-driven walk looks it up in the edge index and
    // finds no bucket; a walk that emitted a row per far VERTEX would add a fifth row.
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.k AS k');

    expect(rows.some((r) => r.k === 'iso')).toBe(false);
  });

  test('each row is a DISTINCT object, not one shared reference', () => {
    // The cell values are computed once per far vertex, so the tempting implementation pushes
    // one object N times. A caller mutating a row would then alter its siblings.
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.k AS k') as Record<string, unknown>[];
    const hubRows = rows.filter((r) => r.k === 'h');

    expect(hubRows.length).toBe(3);
    expect(hubRows[0]).not.toBe(hubRows[1]);

    hubRows[0].k = 'mutated';

    expect(hubRows[1].k).toBe('h');
    expect(hubRows[2].k).toBe('h');
  });

  test('COLUMN order follows the projection, not the alphabet', () => {
    // Row order is unspecified; column order is bytes. The walk rebuilds each row from the keys
    // of its template, so the projection's order has to survive.
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.n AS zz, x.k AS aa');

    expect(Object.keys(rows[0])).toEqual(['zz', 'aa']);
  });

  test('a multi-column projection agrees cell for cell', () => {
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.k AS k, x.n AS n');

    expect(multiset(rows)).toEqual(
      multiset([
        { k: 'h', n: 1 },
        { k: 'h', n: 1 },
        { k: 'h', n: 1 },
        { k: 't', n: 2 },
      ]),
    );
  });

  test('an expression over the far end is evaluated per far vertex and still correct', () => {
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.n + 10 AS v');

    expect(multiset(rows)).toEqual(multiset([{ v: 11 }, { v: 11 }, { v: 11 }, { v: 12 }]));
  });

  test('an ABSENT property projects null, once per edge', () => {
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D) RETURN x.nope AS v');

    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.v === null)).toBe(true);
  });
});

describe('the far-driven walk only runs where the start is unconstrained', () => {
  test('a START label some vertex fails still gives the right rows', () => {
    // `S` is not carried by every vertex, so it cannot be ignored — the far-driven walk has no
    // way to apply it, and this must route to the start-driven walk instead. If it did not, the
    // `D`-to-`D` edge below would wrongly appear.
    const g = hub();
    const v = (id: string) => g.getVertexById(id)!;

    g.addEdge({ id: 'e9', from: v('t'), to: v('h'), labels: ['E'], properties: {} });

    const all = query(g, 'MATCH (a)-[:E]->(x:D) RETURN x.k AS k');
    const fromS = query(g, 'MATCH (a:S)-[:E]->(x:D) RETURN x.k AS k');

    expect(all.length).toBe(5);
    expect(fromS.length).toBe(4);
    expect(multiset(fromS)).toEqual(multiset([{ k: 'h' }, { k: 'h' }, { k: 'h' }, { k: 't' }]));
  });

  test('a VACUOUS start label is ignored and the rows are unchanged', () => {
    // Every vertex here carries `A`, so the label excludes nothing and the far-driven walk is
    // free to take it. The rows must be identical to the unlabelled spelling — the
    // equivalent-spellings rule.
    const g = new Graph();
    const v1 = g.addVertex({ id: 'p', labels: ['A'], properties: { k: 'p' } });
    const v2 = g.addVertex({ id: 'q', labels: ['A'], properties: { k: 'q' } });

    g.addEdge({ id: 'x1', from: v1, to: v2, labels: ['E'], properties: {} });
    g.addEdge({ id: 'x2', from: v2, to: v1, labels: ['E'], properties: {} });

    const labelled = query(g, 'MATCH (a:A)-[:E]->(x) RETURN x.k AS k');
    const bare = query(g, 'MATCH (a)-[:E]->(x) RETURN x.k AS k');

    expect(multiset(labelled)).toEqual(multiset(bare));
    expect(multiset(bare)).toEqual(multiset([{ k: 'q' }, { k: 'p' }]));
  });

  test('the INCOMING direction reads the mirror index', () => {
    // For an `in` hop the far end is the edge's SOURCE, so the far-driven walk must key the
    // other index. Getting this backwards yields the start vertices' properties instead.
    const rows = query(hub(), 'MATCH (x:D)<-[:E]-(a) RETURN a.k AS k');

    expect(multiset(rows)).toEqual(multiset([{ k: 's1' }, { k: 's2' }, { k: 's3' }, { k: 's1' }]));
  });

  test('a self-loop is counted once, not twice', () => {
    // A self-loop sits in BOTH adjacency indexes. The walk reads only one of them, so it must
    // still produce exactly one row — as the start-driven walk does.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['D'], properties: { k: 'a' } });

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });

    expect(query(g, 'MATCH (p)-[:E]->(x:D) RETURN x.k AS k')).toEqual([{ k: 'a' }]);
  });

  test('a far LABEL still filters', () => {
    // The far label is applied per far vertex now rather than per edge — cheaper, and it must
    // still exclude.
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:S) RETURN x.k AS k');

    expect(rows).toEqual([]);
  });

  test('a CONJUNCTION far label excludes a vertex the seed bucket includes', () => {
    // A mutant that deleted `matchesLabel` from this walk SURVIVED the whole suite, because
    // `candidateVertexSource` already narrows to the SEED label's bucket — so the filter only
    // earns its place where the label expression is NARROWER than its seed. `:D&Tag` seeds on
    // `D`, whose bucket holds `t` (untagged, and with an in-edge). Same fixture blindness as
    // items 156 and 166.
    const g = hub();

    g.addLabelToVertex('Tag', g.getVertexById('h')!);

    const rows = query(g, 'MATCH (a)-[:E]->(x:D&Tag) RETURN x.k AS k');

    expect(multiset(rows)).toEqual(multiset([{ k: 'h' }, { k: 'h' }, { k: 'h' }]));
  });

  test('a DISJUNCTION far label, which the seed cannot narrow at all', () => {
    // The other arm: an `or` yields no seed label, so the walk scans every vertex and
    // `matchesLabel` is the only thing keeping the `S` vertices out of the far position.
    const rows = query(hub(), 'MATCH (a)-[:E]->(x:D|S) RETURN x.k AS k');

    expect(multiset(rows)).toEqual(multiset([{ k: 'h' }, { k: 'h' }, { k: 'h' }, { k: 't' }]));
  });
});

describe('faults keep the general path semantics', () => {
  test('a projection that faults on a reached far vertex still raises', () => {
    // The expression is now evaluated once per far vertex instead of once per edge. The set of
    // vertices evaluated is unchanged — a far vertex in the index has at least one edge — so a
    // fault must still surface.
    const g = hub();
    let code: string | undefined;

    try {
      query(g, 'MATCH (a)-[:E]->(x:D) RETURN 1 / (x.n - 1) AS v');
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidValue);
  });

  test('a fault on an UNREACHED far vertex does not raise', () => {
    // `iso` would divide by zero, and has no in-edges — neither walk ever evaluates it.
    const g = hub();
    const rows = query(g, 'MATCH (a)-[:E]->(x:D) RETURN 1 / (x.n - 3) AS v');

    expect(rows.length).toBe(4);
  });
});
