import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import type { RelPattern } from './ast.js';
import { compileRel } from './executor.js';
import { expandFilteredArr, relHasInlinePred } from './executor/matching.js';
import { query } from './index.js';
import { parse } from './parser.js';

// Audit item 245. `expandFilteredArr`'s "does this hop have a predicate" check read `props` and
// `where`, while `satisfies` checks `props`, `eqProps` AND `where`. A hop whose only predicate
// had been lifted into `eqProps` would therefore have been expanded UNFILTERED — a superset,
// which no correctness test on a fixture lacking that spelling can see.
//
// It is unreachable through the parser today: `compileRel` calls `compilePredicate` with no
// `ownVar`, so `directEqProps` never lifts anything out of an edge's `WHERE`. That is exactly
// why it needs a test that does NOT go through the parser — the guard is defensive against
// `compileRel` gaining an `ownVar`, which item 230 left open for `compileNode`.
const build = (): Graph => {
  const g = new Graph();
  const v: Record<string, Vertex> = {};

  for (const id of ['a', 'b', 'c']) {
    v[id] = g.addVertex({ id, labels: ['P'], properties: { name: id } });
  }

  g.addEdge({ id: 'e1', from: v.a, to: v.b, labels: ['R'], properties: { w: 1 } });
  g.addEdge({ id: 'e2', from: v.a, to: v.c, labels: ['R'], properties: { w: 9 } });

  return g;
};

const relOf = (hop: string): ReturnType<typeof compileRel> => {
  const stmt = parse(`MATCH (a:P)${hop}(b) RETURN count(*) AS c`) as unknown as {
    parts: { clauses: { patterns: { segments: { rel: RelPattern }[] }[] }[] }[];
  };

  return compileRel(stmt.parts[0].clauses[0].patterns[0].segments[0].rel);
};

describe('a hop with an eqProps-only predicate is still filtered', () => {
  test('relHasInlinePred reports all three predicate fields', () => {
    const bare = relOf('-[:R]->');
    const withWhere = relOf('-[e:R WHERE e.w = 9]->');
    const withProps = relOf('-[:R {w: 9}]->');

    expect(relHasInlinePred(bare)).toBe(false);
    expect(relHasInlinePred(withWhere)).toBe(true);
    expect(relHasInlinePred(withProps)).toBe(true);

    // The field the old check omitted. Built by hand because the parser cannot currently
    // produce it — `compileRel` passes no `ownVar`, so this is the shape that would arrive the
    // day it does.
    const lifted = {
      ...bare,
      variable: 'e',
      pred: { props: [], eqProps: [{ key: 'w', value: () => 9 }] },
    } as typeof bare;

    expect(relHasInlinePred(lifted)).toBe(true);
  });

  test('expandFilteredArr applies an eqProps-only predicate', () => {
    const g = build();
    const a = g.verticesById.get('a')!;
    const bare = relOf('-[:R]->');

    // Unfiltered: both out-edges.
    expect(expandFilteredArr(g, a, bare, new Map(), {}).length).toBe(2);

    const lifted = {
      ...bare,
      variable: 'e',
      pred: { props: [], eqProps: [{ key: 'w', value: () => 9 }] },
    } as typeof bare;

    // Only `e2` has `w = 9`. Against the old check this returned both, because `hasPred` was
    // false and `satisfies` was never consulted.
    const got = expandFilteredArr(g, a, lifted, new Map(), {});

    expect(got.length).toBe(1);
    expect(got[0].edge.id).toBe('e2');
  });

  // The parser-level spelling must keep working, whichever field it lands in — this is the
  // regression guard for the change, since `relHasInlinePred` is now on the hot path of every
  // expansion.
  test('the parsed spellings still filter', () => {
    const g = build();

    expect(query(g, "MATCH (a:P {name: 'a'})-[e:R WHERE e.w = 9]->(b) RETURN b.name AS n")).toEqual(
      [{ n: 'c' }],
    );
    expect(query(g, "MATCH (a:P {name: 'a'})-[:R {w: 1}]->(b) RETURN b.name AS n")).toEqual([
      { n: 'b' },
    ]);
    expect(query(g, "MATCH (a:P {name: 'a'})-[:R]->(b) RETURN count(*) AS c")).toEqual([{ c: 2 }]);
  });
});
