import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

// Audit item 244. A SIMPLE path may close on its own start, and the matcher decided whether a
// hop was that close by inspecting the RAW cursor position: `after.length === 1 && at its
// unit's end`. That is true only for a SINGLE-LEVEL unit. One nesting level down the raw
// position sits at the INNERMOST unit's end with the outer cursor still open, so a nested
// sub-group closed on nothing — and `((x)-[:R]->(y)){1,2}` and `(((x)-[:R]->(y)){1,2}){1,1}`,
// which are the same question, answered 11 and 6.
//
// The question is settled by that equivalence, not by comparing against the Rust engine: one
// outer repetition of an inner 1..2-hop group IS a flat 1..2-hop group, so an engine that
// answers them differently is wrong about one of them whatever any other engine says.
//
// The fix asks `resolve` instead: `completedOuter` is the post-epsilon-closure answer to "did
// an outer repetition just finish", and the closure is exactly what pops the finished inner
// reps up to the outer end.
const closable = (): Graph => {
  const g = new Graph();
  const v: Record<string, Vertex> = {};

  for (const id of ['0', '1', '2']) {
    v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
  }

  // 0 -> 1, 1 -> 0 (a 2-cycle), 2 -> 2 (a self-loop: a close in ONE hop), 2 -> 0, 0 -> 2.
  const e = (id: string, from: string, to: string): void => {
    g.addEdge({ id, from: v[from], to: v[to], labels: ['R'], properties: {} });
  };

  e('e0', '0', '1');
  e('e1', '1', '0');
  e('e2', '2', '2');
  e('e3', '2', '0');
  e('e4', '0', '2');

  return g;
};

const count = (g: Graph, q: string): number => {
  const rows = query(g, q) as Array<Record<string, unknown>>;

  return rows[0].c as number;
};

describe('a SIMPLE close in a nested group', () => {
  test('the three spellings of one group agree, under every mode', () => {
    const g = closable();

    for (const mode of ['SIMPLE', 'ACYCLIC', 'TRAIL', 'WALK']) {
      const flat = count(g, `MATCH ${mode} (a:N)((x)-[:R]->(y)){1,2} RETURN count(*) AS c`);
      const innerQ = count(
        g,
        `MATCH ${mode} (a:N)(((x)-[:R]->(y)){1,2}){1,1} RETURN count(*) AS c`,
      );
      const outerQ = count(
        g,
        `MATCH ${mode} (a:N)(((x)-[:R]->(y)){1,1}){1,2} RETURN count(*) AS c`,
      );

      expect({ mode, innerQ, outerQ }).toEqual({ mode, innerQ: flat, outerQ: flat });
    }
  });

  // The hand-derived numbers, so three spellings cannot satisfy the test above by all being
  // wrong together. SIMPLE admits 1-2 hop paths with distinct interior nodes, a hop back onto
  // the source allowed as the final one:
  //   from 0: 0->1, 0->2, 0->1->0 (close), 0->2->0 (close)        = 4
  //   from 1: 1->0, 1->0->1 (close), 1->0->2                      = 3
  //   from 2: 2->2 (close in one hop), 2->0, 2->0->1, 2->0->2 (close) = 4
  // ACYCLIC forbids all five closes, leaving 6. That second number is what gives the first
  // its meaning: both modes mark vertices, and the close is their ONLY difference.
  test('SIMPLE admits the five closes where ACYCLIC forbids them', () => {
    const g = closable();

    expect(count(g, 'MATCH SIMPLE (a:N)((x)-[:R]->(y)){1,2} RETURN count(*) AS c')).toBe(11);
    expect(count(g, 'MATCH ACYCLIC (a:N)((x)-[:R]->(y)){1,2} RETURN count(*) AS c')).toBe(6);
    expect(count(g, 'MATCH SIMPLE (a:N)(((x)-[:R]->(y)){1,2}){1,1} RETURN count(*) AS c')).toBe(11);
    expect(count(g, 'MATCH ACYCLIC (a:N)(((x)-[:R]->(y)){1,2}){1,1} RETURN count(*) AS c')).toBe(6);
  });

  // A close MID-unit must match NOTHING, not terminate early: a path may not stop part-way
  // through a repetition, and an interior repeat of a node is forbidden outright. Without
  // this, admitting any close and simply stopping there would pass both tests above.
  test('a close part-way through a unit matches nothing', () => {
    const g = new Graph();
    const v: Record<string, Vertex> = {};

    for (const id of ['0', '1', '2']) {
      v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
    }

    g.addEdge({ id: 'e0', from: v['2'], to: v['2'], labels: ['R'], properties: {} });
    g.addEdge({ id: 'e1', from: v['2'], to: v['1'], labels: ['R'], properties: {} });
    g.addEdge({ id: 'e2', from: v['1'], to: v['0'], labels: ['R'], properties: {} });

    // One repetition of a TWO-hop unit from `2`: taking the self-loop first lands back on the
    // start with an element still to go, so `2 -> 2 -> 1` would repeat the start as an
    // interior node. The only completing repetition is `2 -> 1 -> 0`.
    expect(
      count(g, 'MATCH SIMPLE (a:N {n: 2})((x)-[:R]->(m)-[:R]->(y)){1,1} RETURN count(*) AS c'),
    ).toBe(1);
  });

  // The close must still be at a repetition BOUNDARY, which a lower bound above 1 makes
  // observable: with `{2,2}` a one-rep close is not a valid answer, so the close that `{1,2}`
  // admits must disappear rather than emit early.
  test('a close is only admitted at a repetition boundary', () => {
    const g = closable();
    const twoReps = count(g, 'MATCH SIMPLE (a:N)((x)-[:R]->(y)){2,2} RETURN count(*) AS c');
    const nested = count(g, 'MATCH SIMPLE (a:N)(((x)-[:R]->(y)){2,2}){1,1} RETURN count(*) AS c');

    expect(nested).toBe(twoReps);
    // The three two-hop closes (0->1->0, 1->0->1, 2->0->2) plus 1->0->2 and 0->2->... : the
    // number itself is pinned by the flat spelling, which predates this fix and was correct.
    expect(twoReps).toBeGreaterThan(0);
  });

  // A close must NOT MARK its target, and the consequence is not obvious. The close bypasses
  // `hopCollides`, emits, and then deletes its mark — so if it were allowed to mark, the
  // `marks.add(start)` would be a no-op on an already-marked start and the matching
  // `marks.delete(start)` would UNMARK IT. A later hop onto the start that is not a boundary
  // (mid-unit, where `hopCollides` is consulted) would then be wrongly admitted and the path
  // would repeat the start as an interior node.
  //
  // The fixture is built for exactly that order, with 0's out-edges in this sequence:
  //   0->1, then 1->0 closes rep 1 at the unit end, then 1->2 completes rep 1 at 2,
  //   then 2->0 is MID-unit of rep 2 and must be refused, which would otherwise let 0->3
  //   complete rep 2 at 3.
  // `3` has no out-edge and nothing else reaches it, so an end of 3 means and only means that
  // the walk passed through 0 twice. Found by mutation: `hopMark(mode, false, …)` survived
  // every other test here and returns `{n: 3}` under this one.
  test('a close does not unmark the start for its siblings', () => {
    const g = new Graph();
    const v: Record<string, Vertex> = {};

    for (const id of ['0', '1', '2', '3']) {
      v[id] = g.addVertex({ id, labels: ['N'], properties: { n: Number(id) } });
    }

    (
      [
        ['e0', '0', '1'],
        ['e1', '1', '0'],
        ['e2', '1', '2'],
        ['e3', '2', '0'],
        ['e4', '0', '3'],
      ] as Array<[string, string, string]>
    ).forEach(([id, from, to]) => {
      g.addEdge({ id, from: v[from], to: v[to], labels: ['R'], properties: {} });
    });

    for (const q of [
      'MATCH SIMPLE (a:N {n: 0})((x)-[:R]->(m)-[:R]->(y)){1,2} (z) RETURN z.n AS n ORDER BY n',
      'MATCH SIMPLE (a:N {n: 0})(((x)-[:R]->(m)-[:R]->(y)){1,1}){1,2} (z) RETURN z.n AS n ORDER BY n',
    ]) {
      expect(query(g, q)).toEqual([{ n: 0 }, { n: 2 }]);
    }
  });

  // A nested unit whose inner bound cannot be met by one hop must not close either: the close
  // test has to be the OUTER completion, and an inner `{2,2}` means one hop leaves the outer
  // repetition unfinished.
  test('a nested unit whose inner rep is unfinished does not close', () => {
    const g = closable();
    // Inner {2,2} x outer {1,1} is a flat {2,2}: 1 outer rep of 2 hops.
    expect(count(g, 'MATCH SIMPLE (a:N)(((x)-[:R]->(y)){2,2}){1,1} RETURN count(*) AS c')).toBe(
      count(g, 'MATCH SIMPLE (a:N)((x)-[:R]->(y)){2,2} RETURN count(*) AS c'),
    );
  });
});
