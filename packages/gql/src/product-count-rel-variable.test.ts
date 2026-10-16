import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 487: a rel VARIABLE nothing reads, in the two- and three-hop degree PRODUCTS. They bind
// no edge and run only for a shape with no `WHERE` and no start constraint, so a name nobody
// can read changes nothing — and refusing it cost 29x on the two-hop (2165 ms against 75) and
// 44x on the three-hop.
//
// The oracle is the same query with the names removed, plus `WHERE true`, which routes to the
// FILTERED builder (still refusing rel variables) and so answers through a different path.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string) => g.addVertex({ id, labels: ['P'], properties: { id } });
  const a = v('a');
  const b = v('b');
  const c = v('c');
  const d = v('d');

  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: { w: 1 } });
  g.addEdge({ id: 'bc', from: b, to: c, labels: ['T'], properties: { w: 2 } });
  g.addEdge({ id: 'cd', from: c, to: d, labels: ['T'], properties: { w: 3 } });
  g.addEdge({ id: 'ac', from: a, to: c, labels: ['S'], properties: { w: 4 } });

  return g;
};

const count = (g: Graph, q: string): number => query<{ c: number }>(g, q)[0].c;

describe('an unread rel variable in a count product (item 487)', () => {
  test('the two-hop product answers as it does without the names', () => {
    const g = build();

    expect(count(g, 'MATCH (:P)-[r:T]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[:T]->(x)-[:T]->(y) RETURN count(*) AS c'),
    );
    expect(count(g, 'MATCH (:P)-[r:T]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(2);
  });

  test('the three-hop product answers as it does without the names', () => {
    const g = build();

    expect(count(g, 'MATCH (:P)-[r:T]->(w)-[s:T]->(x)-[t:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[:T]->(w)-[:T]->(x)-[:T]->(y) RETURN count(*) AS c'),
    );
    expect(count(g, 'MATCH (:P)-[r:T]->(w)-[s:T]->(x)-[t:T]->(y) RETURN count(*) AS c')).toBe(1);
  });

  test('a REPEATED rel variable is a self-join and must decline', () => {
    const g = build();

    // `-[r:T]->(x)-[r:T]->(y)` means the SAME edge at both positions, which no product can
    // express — admitting it answered 1 where the general path answers 0. This case was written
    // because the hazard was suspected; no existing test covered it, and the widening shipped
    // the wrong answer for as long as it took to probe.
    expect(count(g, 'MATCH (:P)-[r:T]->(x)-[r:T]->(y) RETURN count(*) AS c')).toBe(0);
    expect(count(g, 'MATCH (:P)-[r:T]->(x)-[r:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[r:T]->(x)-[r:T]->(y) WHERE true RETURN count(*) AS c'),
    );
    // Three hops, with the repetition in the outer positions.
    expect(count(g, 'MATCH (:P)-[r:T]->(w)-[s:T]->(x)-[r:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[r:T]->(w)-[s:T]->(x)-[r:T]->(y) WHERE true RETURN count(*) AS c'),
    );
  });

  test('a rel variable shared with a NODE name also declines', () => {
    const g = build();

    expect(count(g, 'MATCH (:P)-[x:T]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[x:T]->(x)-[s:T]->(y) WHERE true RETURN count(*) AS c'),
    );
  });

  test('a WHERE or an inline constraint still declines the product', () => {
    const g = build();

    // The filtered builder refuses a rel variable, so these take the general path — and must be
    // right either way.
    expect(
      count(g, "MATCH (a:P)-[r:T]->(x)-[s:T]->(y) WHERE a.id = 'a' RETURN count(*) AS c"),
    ).toBe(1);
    expect(count(g, "MATCH (a:P {id: 'a'})-[r:T]->(x)-[s:T]->(y) RETURN count(*) AS c")).toBe(1);
  });

  test('an inline REL constraint declines — `plainRel` is still enforced', () => {
    const g = build();

    expect(count(g, 'MATCH (:P)-[r:T {w: 1}]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(1);
    expect(count(g, 'MATCH (:P)-[r:T {w: 99}]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(0);
    // The THREE-hop twin, which has its own `plainRel` check — and whose mutant survived until
    // this line, because the case above only exercises the two-hop builder.
    expect(
      count(g, 'MATCH (:P)-[r:T {w: 1}]->(w2)-[s:T]->(x)-[t:T]->(y) RETURN count(*) AS c'),
    ).toBe(1);
    expect(
      count(g, 'MATCH (:P)-[r:T {w: 99}]->(w2)-[s:T]->(x)-[t:T]->(y) RETURN count(*) AS c'),
    ).toBe(0);
  });

  test('the edge TYPE still selects with names present', () => {
    const g = build();

    expect(count(g, 'MATCH (:P)-[r:S]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(
      count(g, 'MATCH (:P)-[:S]->(x)-[:T]->(y) RETURN count(*) AS c'),
    );
    expect(count(g, 'MATCH (:P)-[r:S]->(x)-[s:T]->(y) RETURN count(*) AS c')).toBe(1);
  });
});
