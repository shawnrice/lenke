// Item 637. An inline rel's PROPERTIES now reach the one-hop tally through `satisfies`
// (`inRel`), closing an 8.76x against the clause spelling. Item 633 had left them out because
// its route — folding the predicate into the single `HopPred` — would have had to synthesize a
// `compare`, and `{w: v}` is IS-NULL semantics rather than `=`.
//
// So the tests that matter most here are the ones where a WRONG ANSWER would be SILENT:
//
//   - `{w: null}` must still match a stored null AND an absent key. That is the exact
//     divergence 633 refused to risk, and it is the first thing a synthesized `=` would break.
//   - a rel carrying properties with NO endpoint constraint must not fall through to the O(1)
//     bucket-size path, which would count EVERY edge.
//   - a shape the tally cannot answer (a quantifier) must DECLINE, not silently ignore the
//     constraint.
//
// Every expected count below is small enough to verify by hand against the fixture.
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

let g: Graph;

const count = (q: string, params: Record<string, unknown> = {}): number => {
  const rows = [...(query(g, q, params) as Iterable<{ c: number }>)];

  return rows[0]?.c ?? 0;
};

beforeAll(() => {
  g = new Graph();

  // Four vertices, `k` = the index.
  const v = Array.from({ length: 4 }, (_, i) =>
    g.addVertex({ id: `a${i}`, labels: ['P'], properties: { k: i } }),
  );

  // e0 a0->a1 w=1 | e1 a1->a2 w=2 | e2 a2->a3 w=2
  // e3 a3->a0 w=null (STORED null) | e4 a0->a2 (the key is ABSENT)
  g.addEdge({ id: 'e0', from: v[0], to: v[1], labels: ['E'], properties: { w: 1 } });
  g.addEdge({ id: 'e1', from: v[1], to: v[2], labels: ['E'], properties: { w: 2 } });
  g.addEdge({ id: 'e2', from: v[2], to: v[3], labels: ['E'], properties: { w: 2 } });
  g.addEdge({ id: 'e3', from: v[3], to: v[0], labels: ['E'], properties: { w: null } });
  g.addEdge({ id: 'e4', from: v[0], to: v[2], labels: ['E'], properties: {} });
});

describe('an inline rel predicate costs the same as its clause twin', () => {
  test('the two spellings of an equality agree', () => {
    expect(count('MATCH (a:P)-[r:E {w: 2}]->(b) RETURN count(*) AS c')).toBe(2);
    expect(count('MATCH (a:P)-[r:E]->(b) WHERE r.w = 2 RETURN count(*) AS c')).toBe(2);
  });

  test('a $param value reaches the tally, which is the shape 633 could not synthesize', () => {
    expect(count('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c', { w: 2 })).toBe(2);
  });

  test('the inline WHERE spelling still agrees (item 633 carried it another way)', () => {
    expect(count('MATCH (a:P)-[r:E WHERE r.w = 2]->(b) RETURN count(*) AS c')).toBe(2);
  });
});

describe('IS-NULL semantics survive the new route', () => {
  // THE test. `{w: null}` matches the STORED null (e3) and the ABSENT key (e4); `r.w = null`
  // matches neither. A synthesized `compare` would collapse the first into the second.
  test('inline {w: null} matches a stored null AND an absent key', () => {
    expect(count('MATCH (a:P)-[r:E {w: null}]->(b) RETURN count(*) AS c')).toBe(2);
  });

  test('a clause r.w = null matches nothing, and that is NOT the same question', () => {
    expect(count('MATCH (a:P)-[r:E]->(b) WHERE r.w = null RETURN count(*) AS c')).toBe(0);
  });

  test('a $param carrying null takes the IS-NULL branch too', () => {
    expect(count('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c', { w: null })).toBe(2);
  });
});

describe('the shapes that must DECLINE rather than ignore the constraint', () => {
  // The bucket-size path answers an unconstrained hop in O(1). A rel carrying properties and
  // NOTHING else must not reach it — that would count all five edges.
  test('properties with no endpoint constraint do not fall through to the bucket count', () => {
    expect(count('MATCH (a)-[r:E {w: 2}]->(b) RETURN count(*) AS c')).toBe(2);
  });

  test('a QUANTIFIED rel is a walk, not a single-edge tally', () => {
    // Length 1: e1, e2. Length 2: e1 then e2 (a1->a2->a3). Three paths.
    expect(count('MATCH (a:P)-[r:E {w: 2}]->{1,2}(b) RETURN count(*) AS c')).toBe(3);
  });

  test('an UNDIRECTED hop meets each edge from both ends', () => {
    expect(count('MATCH (a:P)-[r:E {w: 2}]-(b) RETURN count(*) AS c')).toBe(4);
  });

  test('a CORRELATED inline value is not a per-edge gate', () => {
    // Only a2 (k=2) has an outgoing edge whose `w` equals its own `k`: e2.
    expect(count('MATCH (a:P)-[r:E {w: a.k}]->(b) RETURN count(*) AS c')).toBe(1);
  });
});

describe('the rel constraint composes with the ones already there', () => {
  // The degree-summing walks cannot apply a per-edge rel filter, so they must refuse it
  // rather than sum bucket sizes and overcount.
  test('a START constraint beside the rel properties', () => {
    // a0's out-edges are e0 (w=1) and e4 (no w). Only e0 matches.
    expect(count('MATCH (a:P {k: 0})-[r:E {w: 1}]->(b) RETURN count(*) AS c')).toBe(1);
  });

  test('a FAR constraint beside the rel properties', () => {
    // Edges into a2: e1 (w=2) and e4 (no w). Only e1 matches.
    expect(count('MATCH (a:P)-[r:E {w: 2}]->(b:P {k: 2}) RETURN count(*) AS c')).toBe(1);
  });

  test('a clause WHERE reading the rel, beside inline properties on it', () => {
    // Both must be applied. `{w: 2}` keeps e1 and e2; `a.k = 1` keeps only e1.
    expect(count('MATCH (a:P)-[r:E {w: 2}]->(b) WHERE a.k = 1 RETURN count(*) AS c')).toBe(1);
  });

  test('a clause WHERE and inline properties BOTH on the rel', () => {
    // `{w: 2}` keeps e1 and e2; `r.w >= 2` keeps both; the conjunction is still 2. If one
    // were dropped the count would be 5 (every edge) or 2 either way — so the discriminating
    // case is the next one.
    expect(count('MATCH (a:P)-[r:E {w: 2}]->(b) WHERE r.w >= 2 RETURN count(*) AS c')).toBe(2);
  });

  test('a clause WHERE that DISAGREES with the inline properties keeps neither alone', () => {
    // `{w: 2}` keeps e1, e2; `r.w = 1` keeps e0. The conjunction is EMPTY. A tally that
    // dropped either predicate would answer 1 or 2 instead of 0.
    expect(count('MATCH (a:P)-[r:E {w: 2}]->(b) WHERE r.w = 1 RETURN count(*) AS c')).toBe(0);
  });
});
