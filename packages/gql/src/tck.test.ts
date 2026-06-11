import { describe, expect, test } from 'bun:test';

import { Graph } from '@pl-graph/core';

import { query } from './index.js';

/**
 * Conformance tests adapted from the openCypher Technology Compatibility Kit
 * (github.com/opencypher/openCypher, `tck/features`, Apache License 2.0, created
 * by the openCypher community). The TCK's `Given graph / When query / Then
 * result` scenarios are re-expressed here as bun tests.
 *
 * Adaptations to our ISO GQL dialect:
 *  - `CREATE` → `INSERT` (ISO's data-insertion keyword).
 *  - Explicit `AS` aliases added where the TCK relies on Cypher's
 *    expression-text column naming (we name complex expressions `expr`).
 *  - Scenarios depending on features outside this engine (UNWIND, list
 *    comprehensions, map literals, `toInteger`, list indexing, CASE) are
 *    omitted, not adapted.
 *
 * The truth tables below are the canonical three-valued (Kleene) logic results;
 * a failure here is a real conformance regression, not a fixture quirk.
 */

const empty = new Graph();

// Boolean1 — And logical operations, Scenario [1].
describe('TCK Boolean1: AND (three-valued)', () => {
  test('conjunction of two truth values', () => {
    const r = query(
      empty,
      `RETURN true AND true AS tt, true AND false AS tf, true AND null AS tn,
              false AND true AS ft, false AND false AS ff, false AND null AS fn,
              null AND true AS nt, null AND false AS nf, null AND null AS nn`,
    );
    expect(r).toEqual([
      {
        tt: true,
        tf: false,
        tn: null,
        ft: false,
        ff: false,
        fn: false,
        nt: null,
        nf: false,
        nn: null,
      },
    ]);
  });
});

// Boolean2 — OR logical operations, Scenario [1].
describe('TCK Boolean2: OR (three-valued)', () => {
  test('disjunction of two truth values', () => {
    const r = query(
      empty,
      `RETURN true OR true AS tt, true OR false AS tf, true OR null AS tn,
              false OR true AS ft, false OR false AS ff, false OR null AS fn,
              null OR true AS nt, null OR false AS nf, null OR null AS nn`,
    );
    expect(r).toEqual([
      { tt: true, tf: true, tn: true, ft: true, ff: false, fn: null, nt: true, nf: null, nn: null },
    ]);
  });
});

// Boolean3 — XOR logical operations, Scenario [1].
describe('TCK Boolean3: XOR (three-valued)', () => {
  test('exclusive disjunction of two truth values', () => {
    const r = query(
      empty,
      `RETURN true XOR true AS tt, true XOR false AS tf, true XOR null AS tn,
              false XOR true AS ft, false XOR false AS ff, false XOR null AS fn,
              null XOR true AS nt, null XOR false AS nf, null XOR null AS nn`,
    );
    expect(r).toEqual([
      {
        tt: false,
        tf: true,
        tn: null,
        ft: true,
        ff: false,
        fn: null,
        nt: null,
        nf: null,
        nn: null,
      },
    ]);
  });
});

// Boolean4 — NOT logical operations, Scenario [1].
describe('TCK Boolean4: NOT (three-valued)', () => {
  test('logical negation of truth values', () => {
    const r = query(empty, `RETURN NOT true AS nt, NOT false AS nf, NOT null AS nn`);
    expect(r).toEqual([{ nt: false, nf: true, nn: null }]);
  });
});

// Null3 — Null evaluation, Scenarios [1]–[3].
describe('TCK Null3: null evaluation', () => {
  test('the inverse of a null is a null', () => {
    expect(query(empty, `RETURN NOT null AS value`)).toEqual([{ value: null }]);
  });

  test('null = null is unknown (null)', () => {
    expect(query(empty, `RETURN null = null AS value`)).toEqual([{ value: null }]);
  });

  test('null <> null is unknown (null)', () => {
    expect(query(empty, `RETURN null <> null AS value`)).toEqual([{ value: null }]);
  });
});

// Null3 — Scenario [4], "Using null in IN" (the empty-list case is the one this
// engine previously got wrong: `null IN []` must be FALSE, not UNKNOWN).
describe('TCK Null3: IN with null', () => {
  test('membership three-valued logic', () => {
    const r = query(
      empty,
      `RETURN 1 IN [1, 2] AS present, 3 IN [1, 2] AS absent,
              1 IN [1, null] AS foundDespiteNull, 3 IN [1, null] AS unknownDueToNull,
              null IN [1, 2] AS nullElt, null IN [] AS nullInEmpty, 1 IN [] AS valInEmpty`,
    );
    expect(r).toEqual([
      {
        present: true,
        absent: false,
        foundDespiteNull: true,
        unknownDueToNull: null,
        nullElt: null,
        nullInEmpty: false,
        valInEmpty: false,
      },
    ]);
  });
});

// Null1 — IS NULL validation, Scenarios [1]–[4].
describe('TCK Null1: IS NULL validation', () => {
  test('property null check on a non-null node', () => {
    const g = new Graph();
    query(g, `INSERT ({exists: 42})`);
    const r = query(
      g,
      `MATCH (n) RETURN n.missing IS NULL AS missingNull, n.exists IS NULL AS existsNull`,
    );
    expect(r).toEqual([{ missingNull: true, existsNull: false }]);
  });

  test('property null check on a null node (unmatched OPTIONAL)', () => {
    const g = new Graph();
    const r = query(g, `OPTIONAL MATCH (n) RETURN n.missing IS NULL AS missingNull`);
    expect(r).toEqual([{ missingNull: true }]);
  });

  test('a literal null IS NULL', () => {
    expect(query(empty, `RETURN null IS NULL AS value`)).toEqual([{ value: true }]);
  });
});

// Aggregation1 — Count, Scenario [1]: count ignores nulls, with implicit grouping.
describe('TCK Aggregation1: count only non-null values', () => {
  test('count(n.num) skips the node missing num', () => {
    const g = new Graph();
    query(g, `INSERT ({name: 'a', num: 33}), ({name: 'a'}), ({name: 'b', num: 42})`);
    const r = query(g, `MATCH (n) RETURN n.name AS name, count(n.num) AS c ORDER BY name`);
    expect(r).toEqual([
      { name: 'a', c: 1 },
      { name: 'b', c: 1 },
    ]);
  });
});

// Precedence1 — On boolean values. NB: scenario [1] is where ISO GQL diverges
// from Cypher: the TCK (Cypher) gives XOR higher precedence than OR, but
// ISO/IEC 39075 puts OR and XOR at one left-associative level, so
// `true OR true XOR true` is `(true OR true) XOR true` = false, not true. We
// follow the ISO grammar; the remaining scenarios agree with the TCK.
describe('TCK Precedence1: boolean operator precedence', () => {
  const abc = (q: string) => query(empty, q)[0];

  test('[1] ISO: OR and XOR share one left-associative level', () => {
    expect(
      abc(
        `RETURN true OR true XOR true AS a, true OR (true XOR true) AS b, (true OR true) XOR true AS c`,
      ),
    ).toEqual({ a: false, b: true, c: false });
  });

  test('[2] AND takes precedence over XOR', () => {
    expect(
      abc(
        `RETURN true XOR false AND false AS a, true XOR (false AND false) AS b, (true XOR false) AND false AS c`,
      ),
    ).toEqual({ a: true, b: true, c: false });
  });

  test('[3] AND takes precedence over OR', () => {
    expect(
      abc(
        `RETURN true OR false AND false AS a, true OR (false AND false) AS b, (true OR false) AND false AS c`,
      ),
    ).toEqual({ a: true, b: true, c: false });
  });

  test('[4] NOT takes precedence over AND', () => {
    expect(
      abc(`RETURN NOT true AND false AS a, (NOT true) AND false AS b, NOT (true AND false) AS c`),
    ).toEqual({ a: false, b: false, c: true });
  });

  test('[5] NOT takes precedence over OR', () => {
    expect(
      abc(`RETURN NOT false OR true AS a, (NOT false) OR true AS b, NOT (false OR true) AS c`),
    ).toEqual({ a: true, b: true, c: false });
  });

  test('[6] comparison takes precedence over NOT', () => {
    expect(
      abc(`RETURN NOT false >= false AS a, NOT (false >= false) AS b, (NOT false) >= false AS c`),
    ).toEqual({ a: false, b: false, c: true });
  });
});

// Precedence2 — On numeric values (the `^`-free scenarios).
describe('TCK Precedence2: numeric operator precedence', () => {
  const abc = (q: string) => query(empty, q)[0];

  test('[1] multiplication takes precedence over addition', () => {
    expect(abc(`RETURN 4 * 2 + 3 * 2 AS a, 4 * 2 + (3 * 2) AS b, 4 * (2 + 3) * 2 AS c`)).toEqual({
      a: 14,
      b: 14,
      c: 40,
    });
  });

  test('[5] unary minus takes precedence over addition', () => {
    expect(abc(`RETURN -3 + 2 AS a, (-3) + 2 AS b, -(3 + 2) AS c`)).toEqual({
      a: -1,
      b: -1,
      c: -5,
    });
  });
});

// Mathematical6 — Modulo division.
describe('TCK Mathematical6: modulo', () => {
  test('modulo of positive integers', () => {
    expect(query(empty, `RETURN 7 % 3 AS a, 8 % 4 AS b, 5 % 3 AS c`)[0]).toEqual({
      a: 1,
      b: 0,
      c: 2,
    });
  });
});

// Aggregation2/3/5 — min/max/sum/collect all ignore nulls. (UNWIND sources are
// adapted to inserted nodes carrying the values as a property.)
describe('TCK Aggregation2/3/5: null handling in aggregates', () => {
  test('min/max over integers ignore null', () => {
    const g = new Graph();
    query(g, `INSERT ({num: 1}), ({num: 2}), ({num: 0}), ({other: 9}), ({num: -1})`);
    expect(query(g, `MATCH (n) RETURN max(n.num) AS mx, min(n.num) AS mn`)).toEqual([
      { mx: 2, mn: -1 },
    ]);
  });

  test('sum only non-null values', () => {
    const g = new Graph();
    query(g, `INSERT ({name: 'a', num: 33}), ({name: 'a'}), ({name: 'a', num: 42})`);
    expect(query(g, `MATCH (n) RETURN n.name AS name, sum(n.num) AS total`)).toEqual([
      { name: 'a', total: 75 },
    ]);
  });

  test('collect filters nulls', () => {
    const g = new Graph();
    query(g, `INSERT (:Lonely)`);
    const r = query(g, `MATCH (n) OPTIONAL MATCH (n)-[:NOT_EXIST]->(x) RETURN collect(x) AS xs`);
    expect(r).toEqual([{ xs: [] }]);
  });
});

// Comparison3 — chained/range comparisons (`1 < x < 3`). ISO/IEC 39075's
// `<comparison predicate>` is strictly binary (`<predicand> <comp op>
// <predicand>`), so — unlike Cypher — these are a syntax error in GQL. This
// guards that we reject them rather than silently mis-parse.
describe('TCK Comparison3: chained comparison rejected (ISO is binary-only)', () => {
  test('1 < 2 < 3 is a syntax error', () => {
    expect(() => query(empty, `RETURN 1 < 2 < 3 AS x`)).toThrow();
  });
});

// Comparison1 — Scenarios [4]/[5]: graph elements compare by identity.
describe('TCK Comparison1: element identity', () => {
  test('comparing nodes to nodes', () => {
    const g = new Graph();
    query(g, `INSERT (:N)`);
    const r = query(g, `MATCH (a) WITH a MATCH (b) WHERE a = b RETURN count(b) AS c`);
    expect(r).toEqual([{ c: 1 }]);
  });

  test('comparing relationships to relationships', () => {
    const g = new Graph();
    query(g, `INSERT (:A)-[:T]->(:B)`);
    const r = query(g, `MATCH ()-[a]->() WITH a MATCH ()-[b]->() WHERE a = b RETURN count(b) AS c`);
    expect(r).toEqual([{ c: 1 }]);
  });
});

// Union1 / Union2 — DISTINCT union dedups; UNION ALL keeps duplicates.
describe('TCK Union1/Union2: set operations', () => {
  test('[1] two unique elements, distinct', () => {
    expect(query(empty, `RETURN 1 AS x UNION RETURN 2 AS x`)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  test('[2] three elements, two unique, distinct', () => {
    expect(query(empty, `RETURN 2 AS x UNION RETURN 1 AS x UNION RETURN 2 AS x`)).toEqual([
      { x: 2 },
      { x: 1 },
    ]);
  });

  test('UNION ALL keeps duplicates', () => {
    expect(query(empty, `RETURN 1 AS x UNION ALL RETURN 1 AS x`)).toEqual([{ x: 1 }, { x: 1 }]);
  });
});

// Set1 — Setting properties. NB: sc2 uses `+` for string concatenation in
// Cypher; ISO GQL reserves `+` for numbers, so it is adapted to `||`.
describe('TCK Set1: set a property', () => {
  test('[1] set a property to a literal', () => {
    const g = new Graph();
    query(g, `INSERT (:A {name: 'Andres'})`);
    query(g, `MATCH (n:A) WHERE n.name = 'Andres' SET n.name = 'Michael'`);
    expect(query(g, `MATCH (n:A) RETURN n.name AS name`)).toEqual([{ name: 'Michael' }]);
  });

  test('[2] set a property to an expression (|| for concat in ISO)', () => {
    const g = new Graph();
    query(g, `INSERT (:A {name: 'Andres'})`);
    query(g, `MATCH (n:A) WHERE n.name = 'Andres' SET n.name = n.name || ' was here'`);
    expect(query(g, `MATCH (n:A) RETURN n.name AS name`)).toEqual([{ name: 'Andres was here' }]);
  });
});

// Remove1 — Removing a node property makes it null.
describe('TCK Remove1: remove a node property', () => {
  test('[1] removed property is no longer present', () => {
    const g = new Graph();
    query(g, `INSERT (:L {num: 42})`);
    const r = query(g, `MATCH (n) REMOVE n.num RETURN n.num IS NOT NULL AS stillThere`);
    expect(r).toEqual([{ stillThere: false }]);
  });
});

// Delete1 — Deleting nodes removes them from the graph.
describe('TCK Delete1: delete nodes', () => {
  test('[1] delete an isolated node', () => {
    const g = new Graph();
    query(g, `INSERT (:Doomed)`);
    query(g, `MATCH (n:Doomed) DELETE n`);
    expect(query(g, `MATCH (n) RETURN count(*) AS c`)).toEqual([{ c: 0 }]);
  });

  test('[2] DETACH DELETE removes a node and its relationships', () => {
    const g = new Graph();
    query(g, `INSERT (:A)-[:T]->(:B)`);
    query(g, `MATCH (a:A) DETACH DELETE a`);
    // The A node and the T edge are gone; only B remains, now isolated.
    expect(query(g, `MATCH (n) RETURN count(*) AS c`)).toEqual([{ c: 1 }]);
    expect(query(g, `MATCH ()-[r]->() RETURN count(*) AS c`)).toEqual([{ c: 0 }]);
  });
});

// Literals1–6 — Literal lexing/evaluation. (int64-overflow scenarios like
// 9223372036854775807 are omitted: this engine uses IEEE-754 doubles.)
describe('TCK Literals1/2/3/4/5/6: literals', () => {
  const lit = (src: string) => query(empty, `RETURN ${src} AS literal`)[0]!.literal;

  test('booleans and null, case-insensitive keywords', () => {
    expect(lit('true')).toBe(true);
    expect(lit('TRUE')).toBe(true);
    expect(lit('false')).toBe(false);
    expect(lit('FALSE')).toBe(false);
    expect(lit('null')).toBeNull();
  });

  test('decimal integers', () => {
    expect(lit('1')).toBe(1);
    expect(lit('0')).toBe(0);
    expect(lit('372036854')).toBe(372036854);
  });

  test('hexadecimal integers', () => {
    expect(lit('0x1')).toBe(1);
    expect(lit('0x162CD4F6')).toBe(372036854);
  });

  test('octal integers', () => {
    expect(lit('0o1')).toBe(1);
    expect(lit('0o2613152366')).toBe(372036854);
  });

  test('floats, including leading-dot and IEEE-754 rounding', () => {
    expect(lit('1.0')).toBe(1);
    expect(lit('.1')).toBe(0.1);
    expect(lit('.3405892687')).toBe(0.3405892687);
    // Same double rounding the TCK expects (…687 stores as …686).
    expect(lit('3985764.3405892687')).toBe(3985764.3405892686);
  });

  test('strings', () => {
    expect(lit(`''`)).toBe('');
    expect(lit(`'a'`)).toBe('a');
  });
});

// Literals6 — string escape sequences. ISO/IEC 39075 defines `\t \n \r \\ \' \"`
// and `\uXXXX` / `\UXXXXXX`; they must be *decoded*, not left as the literal
// escaped character. (String.raw keeps the backslash from JS so our lexer, not
// the test file, does the decoding.)
describe('TCK Literals6: string escape sequences (ISO)', () => {
  const lit = (raw: string) => query(empty, raw)[0]!.literal;

  test('control-character escapes decode', () => {
    expect(lit(String.raw`RETURN '\n' AS literal`)).toBe('\n');
    expect(lit(String.raw`RETURN '\t' AS literal`)).toBe('\t');
    expect(lit(String.raw`RETURN '\r' AS literal`)).toBe('\r');
  });

  test('escaped backslash and quotes decode', () => {
    expect(lit(String.raw`RETURN '\\' AS literal`)).toBe('\\');
    expect(lit(String.raw`RETURN '\'' AS literal`)).toBe("'");
    expect(lit(String.raw`RETURN "\"" AS literal`)).toBe('"');
  });

  test('unicode escapes \\uXXXX and \\UXXXXXX decode to code points', () => {
    const bs = String.fromCharCode(92); // a single backslash, kept out of the source
    expect(lit(`RETURN '${bs}u0041' AS literal`)).toBe('A');
    expect(lit(`RETURN '${bs}u01FF' AS literal`)).toBe('ǿ');
    expect(lit(String.raw`RETURN '\U01F600' AS literal`)).toBe('😀');
  });

  test('a malformed unicode escape is a syntax error', () => {
    expect(() => query(empty, String.raw`RETURN '\uH' AS x`)).toThrow();
  });
});

// ReturnSkipLimit2/3 — LIMIT and SKIP. (UNWIND sources adapted to inserts.)
describe('TCK ReturnSkipLimit: SKIP / LIMIT', () => {
  const seed = () => {
    const g = new Graph();
    query(g, `INSERT ({name:'A'}), ({name:'B'}), ({name:'C'}), ({name:'D'}), ({name:'E'})`);
    return g;
  };

  test('[2] ORDER BY then LIMIT 2 keeps the first two', () => {
    const r = query(seed(), `MATCH (n) RETURN n.name AS name ORDER BY n.name ASC LIMIT 2`);
    expect(r).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  test('[3] LIMIT 0 returns no rows', () => {
    expect(query(seed(), `MATCH (n) RETURN n.name AS name LIMIT 0`)).toEqual([]);
  });

  test('SKIP then LIMIT pages through the ordering', () => {
    const r = query(seed(), `MATCH (n) RETURN n.name AS name ORDER BY n.name ASC SKIP 2 LIMIT 2`);
    expect(r).toEqual([{ name: 'C' }, { name: 'D' }]);
  });

  test('SKIP past the end yields no rows', () => {
    expect(query(seed(), `MATCH (n) RETURN n.name AS name SKIP 99`)).toEqual([]);
  });
});

// ReturnOrderBy6 — aggregation expressions inside ORDER BY.
describe('TCK ReturnOrderBy6: aggregation inside ORDER BY', () => {
  test('[1] empty match: avg over no rows is null; ORDER BY an aggregate + param', () => {
    const g = new Graph();
    const r = query(
      g,
      `MATCH (person) RETURN avg(person.age) AS avgAge ORDER BY $age + avg(person.age) - 1000`,
      { age: 38 },
    );
    // The match is empty, but the aggregating projection still yields one row.
    expect(r).toEqual([{ avgAge: null }]);
  });

  test('ORDER BY an aggregate sorts the groups', () => {
    const g = new Graph();
    query(
      g,
      `INSERT ({city:'London'}), ({city:'London'}), ({city:'London'}),
              ({city:'Paris'}), ({city:'Berlin'}), ({city:'Berlin'})`,
    );
    const r = query(
      g,
      `MATCH (n) RETURN n.city AS city, count(*) AS cnt ORDER BY count(*) DESC, city`,
    );
    expect(r).toEqual([
      { city: 'London', cnt: 3 },
      { city: 'Berlin', cnt: 2 },
      { city: 'Paris', cnt: 1 },
    ]);
  });
});
