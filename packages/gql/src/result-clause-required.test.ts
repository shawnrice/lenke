import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode } from '@lenke/errors';

import { createValidator, query } from './index.js';

// A query must END in a result statement. ISO:
//
//   <ambient linear query statement> ::=
//       [ <simple linear query statement> ] <primitive result statement>
//   <ambient linear data-modifying statement body> ::=
//       <simple linear data-accessing statement> [ <primitive result statement> ]
//   <primitive result statement> ::= <return statement> [ … ] | FINISH
//
// So RETURN/FINISH is mandatory for a read and optional for a write. This went unenforced until
// audit item 165: `MATCH (x)` returned `[]` — a read with nothing to return read as an EMPTY
// ANSWER rather than a bad query — where native raised `E_SYNTAX`. Ten shapes did it.
//
// How it was found is worth recording: item 164 wrote `MATCH (a)-->(x)` in a test and got `[]`,
// and concluded TS was accepting a Cypherism. It was not. `--` is the ISO SIMPLE COMMENT
// INTRODUCER, so that query lexed as `MATCH (a)` plus a comment — and the real defect was that
// `MATCH (a)` parsed at all.

const fixture = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['L'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['L'], properties: { n: 2 } });
  g.addEdge({
    id: 'e',
    from: g.getVertexById('a')!,
    to: g.getVertexById('b')!,
    labels: ['E'],
    properties: {},
  });

  return g;
};

const codeOf = (q: string): unknown => {
  try {
    query(fixture(), q);
  } catch (e) {
    return (e as { code?: unknown }).code;
  }

  return 'NO THROW';
};

describe('a read-only query without RETURN or FINISH is a syntax error', () => {
  // Every one of these returned `[]` before item 165, and native raised on all ten.
  test.each([
    ['a bare MATCH', 'MATCH (x)'],
    ['a trailing WHERE', 'MATCH (x) WHERE x.n = 1'],
    ['a hop', 'MATCH (x)-[:E]->(y)'],
    ['a lone LET', 'LET k = 1'],
    ['a trailing LET', 'MATCH (x) LET k = x.n'],
    ['a trailing ORDER BY', 'MATCH (x) ORDER BY x.n'],
    ['a trailing LIMIT', 'MATCH (x) LIMIT 1'],
    ['a trailing FILTER', 'MATCH (x) FILTER x.n = 1'],
    ['a lone FOR', 'FOR i IN [1, 2]'],
    ['a trailing WITH', 'MATCH (x) WITH x'],
  ])('%s raises E_SYNTAX', (_name, q) => {
    expect(codeOf(q)).toBe(ErrorCode.Syntax);
  });

  test('the comment form that started this also raises', () => {
    // `MATCH (a)-->(x) RETURN count(*) AS c` is `MATCH (a)` followed by a `--` comment, so it
    // is a result-clause-less query and now refuses loudly instead of answering `[]`.
    expect(codeOf('MATCH (a)-->(x) RETURN count(*) AS c')).toBe(ErrorCode.Syntax);
    expect(codeOf('MATCH (a)--(x) RETURN count(*) AS c')).toBe(ErrorCode.Syntax);
  });

  test('a comment after a COMPLETE query is still fine', () => {
    // The pair that proves the rule did not break comments: same `--`, but the query is whole
    // before it starts.
    expect(query(fixture(), 'MATCH (x) RETURN count(*) AS c -- a trailing comment')).toEqual([
      { c: 2 },
    ]);
    expect(query(fixture(), 'MATCH (x) -- comment\nRETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });
});

describe('a writing statement may omit the result clause', () => {
  test('INSERT alone is accepted', () => {
    const g = fixture();

    expect(query(g, 'INSERT (:L {n: 9})')).toEqual([]);
    expect(query(g, 'MATCH (x:L) WHERE x.n = 9 RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('SET alone is accepted and applies', () => {
    const g = fixture();

    expect(query(g, 'MATCH (x:L) WHERE x.n = 1 SET x.n = 5')).toEqual([]);
    expect(query(g, 'MATCH (x:L) WHERE x.n = 5 RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });

  test('REMOVE alone is accepted', () => {
    const g = fixture();

    expect(query(g, 'MATCH (x:L) REMOVE x.n')).toEqual([]);
  });

  test('DETACH DELETE alone is accepted', () => {
    const g = fixture();

    expect(query(g, 'MATCH (x:L) DETACH DELETE x')).toEqual([]);
    expect(query(g, 'MATCH (x) RETURN count(*) AS c')).toEqual([{ c: 0 }]);
  });

  test('_MERGE alone is accepted', () => {
    // `_MERGE` needs a unique constraint to define its key — a semantic requirement unrelated to
    // this rule, and the reason this test first failed with E_CONSTRAINT rather than passing.
    // What matters here is that it PARSES without a result clause.
    const g = fixture();

    g.createUniqueConstraint('L', 'n');

    expect(query(g, '_MERGE (:L {n: 1})')).toEqual([]);
  });

  test('a write WITH a result clause still works', () => {
    const g = fixture();

    expect(query(g, 'INSERT (:L {n: 9}) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });
});

describe('the result clauses themselves', () => {
  test('RETURN satisfies the rule', () => {
    expect(query(fixture(), 'MATCH (x) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });

  test('FINISH satisfies the rule', () => {
    // FINISH is the other arm of `<primitive result statement>` — a query that returns no rows
    // on purpose. It must NOT be swept up by a check that only looks for RETURN.
    //
    // Native does not implement FINISH at all (`MATCH (x) FINISH` and a bare `FINISH` both
    // raise E_SYNTAX there) — recorded in item 165 as a native conformance gap, NOT matched
    // here, because TS is the engine that is right.
    expect(query(fixture(), 'MATCH (x) FINISH')).toEqual([]);
  });
});

describe('set-operator branches each need their own result clause', () => {
  test('both branches returning is fine', () => {
    const rows = query(
      fixture(),
      'MATCH (x:L) RETURN count(*) AS c UNION ALL MATCH (y:L) RETURN count(*) AS c',
    );

    expect(rows).toEqual([{ c: 2 }, { c: 2 }]);
  });

  test('a branch missing its RETURN raises', () => {
    expect(codeOf('MATCH (x:L) RETURN count(*) AS c UNION ALL MATCH (y:L)')).toBe(ErrorCode.Syntax);
  });
});

describe('the predicate wrapper still parses', () => {
  test('a validator predicate is unaffected', () => {
    // `parsePredicate` wrapped its input as `MATCH (_v) WHERE <src>` — a result-clause-less
    // query, so this rule broke it, and nine validator tests said so immediately. The wrapper
    // now carries a `RETURN`. This pins that, since the wrapper is internal and otherwise only
    // covered indirectly.
    const g = new Graph();

    createValidator(g, 'User', 'u', 'u.age >= 0 AND u.age < 150');

    expect(g.validators().length).toBe(1);
  });

  test('a predicate smuggling its own RETURN is still rejected', () => {
    // The wrapper's clause-count guard has to keep working: the predicate cannot carry extra
    // clauses just because the wrapper now ends in one.
    const g = new Graph();
    let threw = false;

    try {
      createValidator(g, 'User', 'u', 'u.age >= 0 RETURN 1 AS x');
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(g.validators()).toEqual([]);
  });
});
