import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Clause } from './ast.js';
import { dropUnreadEdgeVar } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * Item 1568: an unread EDGE variable on a QUANTIFIED segment is the same defect as item 1567's path
 * variable, and the same size — **71.9x**, 819.6 ms to 11.4, converging with the spelling that never
 * bound `r`.
 *
 * ⚠️ `dropUnreadGroupBinds` already drops an unread `rel.variable`, but only on a FUSED HOP: it
 * requires `hopFrom !== undefined` and refuses on `nested`/`unitRest`/`innerQ`. A plain quantified
 * hop has `rel.quantifier` and no `hopFrom`, so it falls through. This covers that gap only.
 *
 * ⚠️ The rewrite is answer-equivalent, so the suite cannot see a mutant in it — the transformation
 * is tested directly, plus answers for each refusal.
 */
const clausesOf = (q: string): readonly Clause[] => {
  const stmt = parse(q);
  const [part] = (stmt as unknown as { parts: { clauses?: readonly Clause[] }[] }).parts;
  const clauses = part?.clauses;

  if (clauses === undefined) {
    throw new Error(`no clause list parsed from: ${q}`);
  }

  return clauses;
};

/** The edge variable left on the first segment of the (single) pattern, if any. */
const edgeVarOf = (q: string): string | undefined => {
  const [m] = dropUnreadEdgeVar(clausesOf(q));
  const { patterns } = m as unknown as {
    patterns?: { segments?: { rel?: { variable?: string } }[] }[];
  };

  return patterns?.[0]?.segments?.[0]?.rel?.variable;
};

const g = (): Graph => {
  const graph = new Graph();
  const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 0 } });
  const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });
  const c = graph.addVertex({ id: 'c', labels: ['P'], properties: { n: 2 } });

  graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { w: 1 } });
  graph.addEdge({ id: 'e2', from: b, to: c, labels: ['E'], properties: { w: 2 } });

  return graph;
};

describe('an unread edge variable on a quantified segment is dropped', () => {
  test('it is dropped', () => {
    expect(edgeVarOf('MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN count(*) AS c')).toBeUndefined();
  });

  test('the answer is unchanged', () => {
    expect(query(g(), 'MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
    expect(query(g(), 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });
});

describe('⚠️ the refusals, each of which a mutant removes', () => {
  test('the projection READS it', () => {
    expect(edgeVarOf('MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN count(r) AS c')).toBe('r');
  });

  test('the clause WHERE reads it', () => {
    expect(edgeVarOf('MATCH (a:P)-[r:E]->{1,2}(b:P) WHERE size(r) > 1 RETURN count(*) AS c')).toBe(
      'r',
    );
  });

  test('⚠️ a SINGLE HOP is left alone — no quantifier, and it costs nothing there', () => {
    // Measured 0.2 ms either way, so there is nothing to win and the guard keeps the pass narrow.
    expect(edgeVarOf('MATCH (a:P)-[r:E]->(b:P) RETURN count(*) AS c')).toBe('r');
  });

  test('a rel carrying an inline WHERE is left alone', () => {
    // The predicate is evaluated against the bound edge, so the binding is load-bearing even
    // though no later clause names it.
    expect(edgeVarOf('MATCH (a:P)-[r:E WHERE r.w > 0]->{1,2}(b:P) RETURN count(*) AS c')).toBe('r');
  });

  test('a rel carrying inline PROPERTIES is left alone', () => {
    expect(edgeVarOf('MATCH (a:P)-[r:E {w: 1}]->{1,2}(b:P) RETURN count(*) AS c')).toBe('r');
  });

  test('RETURN * binds it', () => {
    expect(edgeVarOf('MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN *')).toBe('r');
  });

  test('a QUANTIFIED SUBPATH is left alone — it carries `hopFrom`', () => {
    // `MATCH (x:P)((a)-[r:E]->(b)){1,2}(y:P)` sets `hopFrom` on the segment, which is
    // `dropUnreadGroupBinds`' territory rather than this pass's. Inspecting the parsed AST is how
    // I learned the two shapes differ: a PLAIN quantified hop has `rel.quantifier` and no
    // `hopFrom`, a quantified SUBPATH has both.
    expect(edgeVarOf('MATCH (x:P)((a)-[r:E]->(b)){1,2}(y:P) RETURN count(*) AS c')).toBe('r');
  });

  test('⚠️ a NESTED subpath cannot reach this pass at all, and that is why a mutant survives', () => {
    // Removing the `nested !== undefined` guard SURVIVES the suite, and checking why is the point:
    // on a nested segment the OUTER `rel` carries no `variable` — `r` lives on `nested.rel` —
    // so `rel.variable === undefined` already refuses. The guard is belt-and-braces, kept for
    // consistency with `dropUnreadGroupBinds`' identical list, and it is NOT a coverage gap.
    //
    // This pins the shape the reasoning rests on, so a parser change that started putting a
    // variable on the outer rel would fail here rather than silently making the guard load-bearing.
    const [m] = dropUnreadEdgeVar(
      clausesOf('MATCH (x:P)(((a)-[r:E]->(b)){1,2}){1,3}(y:P) RETURN count(*) AS c'),
    );
    const { patterns } = m as unknown as {
      patterns?: { segments?: { rel?: { variable?: string }; nested?: unknown }[] }[];
    };
    const [seg] = patterns?.[0]?.segments ?? [];

    expect(seg?.nested).toBeDefined();
    expect(seg?.rel?.variable).toBeUndefined();
  });

  test('a subquery downstream refuses', () => {
    expect(
      edgeVarOf(
        'MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN count(*) AS c, COUNT { MATCH (a)-[:E]->(z) } AS q',
      ),
    ).toBe('r');
  });
});

describe('answers for the shapes that keep the edge variable', () => {
  test('reading the edge list still works', () => {
    const rows = query(g(), 'MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN size(r) AS len ORDER BY len');

    // Two 1-hop paths (1 edge) and one 2-hop path (2 edges).
    expect(rows.map((row) => row.len)).toEqual([1, 1, 2]);
  });

  test('an inline rel WHERE still filters', () => {
    expect(query(g(), 'MATCH (a:P)-[r:E WHERE r.w > 1]->{1,2}(b:P) RETURN count(*) AS c')).toEqual([
      { c: 1 },
    ]);
  });
});
