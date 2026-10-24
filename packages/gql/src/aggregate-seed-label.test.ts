import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// An ungrouped aggregate over a single-node scan folds the argument's VALUES during the walk
// instead of materializing a `Row` per vertex (item 651). That walk may be SEEDED from an index
// when the index is narrower than the label bucket — and a seeded set is a SUPERSET: an index
// hint is a NECESSARY condition, not a sufficient one, so it can hand back a vertex of the WRONG
// LABEL that happens to share the indexed value. The label is therefore rechecked per candidate,
// guarded on `seeded` so the bucket walk pays nothing for a test it satisfies by construction.
//
// ⚠️ THESE TESTS EXIST BECAUSE MUTATION FOUND THE GUARD UNTESTED. Dropping the recheck from both
// the fold path and the collecting path SURVIVED the whole 2554-test suite. The row-projecting
// path's own copy of this guard is covered — its comment records two tests catching the omission
// as a WRONG ANSWER, not a slow one — but every one of those projects rows, so none of them
// reaches an aggregate closure. The guard was correct and unverified, which is the state a
// passing suite cannot distinguish from correct and verified.
//
// The fixture is the whole point and is easy to get wrong in a way that proves nothing:
//
//   - the index must be NARROWER than the label bucket, or no seed fires and the bucket walk
//     satisfies the label by construction — the mutant then survives for a legitimate reason;
//   - the wrong-label vertex must share the INDEXED VALUE, since that is the only way a seek
//     returns it at all;
//   - its contribution must CHANGE THE ANSWER. A `Q` whose `w` sat inside `P`'s range would be
//     folded in and the assertion would still pass.
const seeded = (): Graph => {
  const g = new Graph();

  // Many `P` under other tags, so the `tag: 'x'` index entry is strictly smaller than the `P`
  // bucket and the seek is worth taking.
  for (let i = 0; i < 200; i++) {
    g.addVertex({ id: `p${i}`, labels: ['P'], properties: { tag: `t${i}`, w: 1 } });
  }

  for (let i = 0; i < 5; i++) {
    g.addVertex({ id: `x${i}`, labels: ['P'], properties: { tag: 'x', w: i + 1 } });
  }

  // THE TRAP: label `Q`, the same indexed `tag`, and a `w` far outside `P`'s range so folding it
  // in cannot be mistaken for the right answer.
  g.addVertex({ id: 'q0', labels: ['Q'], properties: { tag: 'x', w: 999 } });

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });

  return g;
};

describe('an ungrouped aggregate over a SEEDED scan rechecks the label', () => {
  const g = seeded();

  // The fold path (`max` has a streaming fold).
  test('max over a seeded scan excludes the wrong-label vertex', () => {
    expect(query(g, "MATCH (n:P {tag: 'x'}) RETURN max(n.w) AS m")).toEqual([{ m: 5 }]);
  });

  test('min over a seeded scan excludes the wrong-label vertex', () => {
    expect(query(g, "MATCH (n:P {tag: 'x'}) RETURN min(n.w) AS m")).toEqual([{ m: 1 }]);
  });

  // The COLLECTING path (`sum`/`avg` have no fold and stream values to `aggregateOverValues`).
  // A separate case because the two paths carry their own copy of the guard, and mutation showed
  // both were unverified — one test would have left the other's survivor in place.
  test('sum over a seeded scan excludes the wrong-label vertex', () => {
    expect(query(g, "MATCH (n:P {tag: 'x'}) RETURN sum(n.w) AS s")).toEqual([{ s: 15 }]);
  });

  test('avg over a seeded scan excludes the wrong-label vertex', () => {
    expect(query(g, "MATCH (n:P {tag: 'x'}) RETURN avg(n.w) AS a")).toEqual([{ a: 3 }]);
  });

  // The clause `WHERE` spelling of the same constraint. Equivalent spellings must cost the same
  // AND answer the same; this one also seeds, so it needs its own case rather than inheriting the
  // inline one's coverage.
  test('the clause WHERE spelling agrees with the inline one', () => {
    expect(query(g, "MATCH (n:P) WHERE n.tag = 'x' RETURN max(n.w) AS m")).toEqual([{ m: 5 }]);
  });

  // The CONTROL: the same question with the label that the trap vertex carries. If the recheck
  // were somehow filtering by something other than the queried label, this would break — so it
  // pins that the guard admits `Q` when `Q` is what was asked for.
  test('querying the OTHER label returns that vertex, not nothing', () => {
    expect(query(g, "MATCH (n:Q {tag: 'x'}) RETURN max(n.w) AS m")).toEqual([{ m: 999 }]);
  });

  // An UNSEEDED spelling of the aggregate, so the suite still covers the bucket walk where the
  // recheck is deliberately skipped. Without this, a mutant that made the recheck unconditional
  // would be invisible.
  test('an unseeded aggregate over the whole label still folds every vertex', () => {
    expect(query(g, 'MATCH (n:P) RETURN max(n.w) AS m')).toEqual([{ m: 5 }]);
    expect(query(g, 'MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 205 }]);
  });
});
