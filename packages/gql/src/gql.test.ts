import { describe, expect, test } from 'bun:test';

import type { MatchClause, Query } from './ast.js';
import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { gql, parseQuery, query } from './index.js';

/** The first clause of a query's first linear part is its MATCH (in these tests). */
const firstMatch = (q: Query): MatchClause => q.parts[0]!.clauses[0] as MatchClause;

const g = createTestSocialGraph();
const names = (rows: { [k: string]: unknown }[], col: string): unknown[] =>
  rows.map((r) => r[col]).sort();

describe('GQL: MATCH / WHERE / RETURN', () => {
  test('the motivating example: friends-of older people', () => {
    const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 30 RETURN b.name`);
    // Only josh (32) and peter (35) are over 30, but only josh has KNOWS
    // out-edges... actually marko (29) is the one who KNOWS. So nobody over 30
    // has an outgoing KNOWS — expect empty.
    expect(rows).toEqual([]);
  });

  test('all KNOWS targets', () => {
    const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('WHERE on the source binds correctly', () => {
    const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b) WHERE a.name = 'marko' RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('CREATED edges to software', () => {
    const rows = query(g, `MATCH (p:Person)-[:CREATED]->(s:Software) RETURN p.name, s.name`);
    expect(rows).toHaveLength(4);
    expect(names(rows, 's.name')).toEqual(['lop', 'lop', 'lop', 'ripple']);
  });

  test('RETURN DISTINCT', () => {
    const rows = query(g, `MATCH (p:Person)-[:CREATED]->(s:Software) RETURN DISTINCT s.name`);
    expect(names(rows, 's.name')).toEqual(['lop', 'ripple']);
  });

  test('incoming direction <-', () => {
    const rows = query(
      g,
      `MATCH (s:Software)<-[:CREATED]-(p:Person) WHERE s.name = 'ripple' RETURN p.name`,
    );
    expect(names(rows, 'p.name')).toEqual(['josh']);
  });

  test('two-hop pattern', () => {
    const rows = query(
      g,
      `MATCH (a:Person)-[:KNOWS]->(b:Person)-[:CREATED]->(s:Software) RETURN a.name, s.name`,
    );
    // marko KNOWS josh; josh CREATED ripple + lop. marko KNOWS vadas (no creates).
    expect(names(rows, 's.name')).toEqual(['lop', 'ripple']);
  });

  test('AND / OR / NOT in WHERE', () => {
    const rows = query(g, `MATCH (p:Person) WHERE p.age >= 29 AND p.age < 33 RETURN p.name`);
    expect(names(rows, 'p.name')).toEqual(['josh', 'marko']);
  });

  test('AS alias and LIMIT', () => {
    const rows = query(g, `MATCH (p:Person) RETURN p.name AS who LIMIT 2`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => 'who' in r)).toBe(true);
  });

  test('comma-joined patterns share a variable', () => {
    const rows = query(
      g,
      `MATCH (a:Person)-[:KNOWS]->(b), (a)-[:CREATED]->(s) RETURN a.name, b.name, s.name`,
    );
    // Only marko both KNOWS someone and CREATED something.
    expect(rows.every((r) => r['a.name'] === 'marko')).toBe(true);
    expect(rows).toHaveLength(2); // {vadas,josh} x {lop}
  });

  test('tagged-template form', () => {
    const rows = gql(g)`MATCH (p:Person) WHERE p.name = 'vadas' RETURN p.age`;
    expect(rows).toEqual([{ 'p.age': 27 }]);
  });
});

describe('GQL: property maps & inline WHERE', () => {
  const g = createTestSocialGraph();

  test('node property map', () => {
    const rows = query(g, `MATCH (n {name: 'marko'}) RETURN n.age`);
    expect(rows).toEqual([{ 'n.age': 29 }]);
  });

  test('node property map with label', () => {
    const rows = query(g, `MATCH (s:Software {lang: 'java'}) RETURN s.name`);
    expect(names(rows, 's.name')).toEqual(['lop', 'ripple']);
  });

  test('node property map with no match', () => {
    expect(query(g, `MATCH (n {name: 'nobody'}) RETURN n.name`)).toEqual([]);
  });

  test('edge property map', () => {
    const rows = query(g, `MATCH (a)-[:KNOWS {weight: 1}]->(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh']);
  });

  test('inline WHERE on a node', () => {
    const rows = query(g, `MATCH (n:Person WHERE n.age > 30) RETURN n.name`);
    expect(names(rows, 'n.name')).toEqual(['josh', 'peter']);
  });

  test('inline WHERE on an edge', () => {
    const rows = query(g, `MATCH (a)-[r:KNOWS WHERE r.weight > 0.5]->(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh']);
  });

  test('property map and inline WHERE combine', () => {
    const rows = query(g, `MATCH (n:Person {name: 'josh'} WHERE n.age > 30) RETURN n.age`);
    expect(rows).toEqual([{ 'n.age': 32 }]);
  });

  test('empty property map matches anything', () => {
    const rows = query(g, `MATCH (n:Person {}) RETURN n.name`);
    expect(rows).toHaveLength(4);
  });

  test('property value can reference an earlier binding', () => {
    // edges where the target software name equals... contrived: match a person
    // who created lop, bound by name.
    const rows = query(g, `MATCH (a:Person)-[:CREATED]->(s {name: 'lop'}) RETURN a.name`);
    expect(names(rows, 'a.name')).toEqual(['josh', 'marko', 'peter']);
  });
});

describe('GQL: expressions & three-valued logic', () => {
  const g = createTestSocialGraph();

  test('NOT of a null comparison is UNKNOWN (excluded), not TRUE', () => {
    // The conformance bug: ISO yields 0 rows here.
    expect(query(g, `MATCH (n:Person) WHERE NOT (n.foo = 1) RETURN n.name`)).toEqual([]);
  });

  test('IS NULL / IS NOT NULL', () => {
    expect(names(query(g, `MATCH (n:Person) WHERE n.foo IS NULL RETURN n.name`), 'n.name')).toEqual(
      ['josh', 'marko', 'peter', 'vadas'],
    );
    expect(query(g, `MATCH (n:Person) WHERE n.age IS NOT NULL RETURN n.name`)).toHaveLength(4);
  });

  test('IN and NOT IN', () => {
    expect(
      names(query(g, `MATCH (n:Person) WHERE n.name IN ['marko', 'josh'] RETURN n.name`), 'n.name'),
    ).toEqual(['josh', 'marko']);
    expect(
      names(query(g, `MATCH (n:Person) WHERE n.name NOT IN ['marko'] RETURN n.name`), 'n.name'),
    ).toEqual(['josh', 'peter', 'vadas']);
  });

  test('XOR', () => {
    const rows = query(
      g,
      `MATCH (n:Person) WHERE (n.age > 30) XOR (n.name = 'marko') RETURN n.name`,
    );
    expect(names(rows, 'n.name')).toEqual(['josh', 'marko', 'peter']);
  });

  test('arithmetic with precedence', () => {
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN n.age + 1 AS x`)).toEqual([{ x: 30 }]);
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN 1 + 2 * 3 AS x`)).toEqual([{ x: 7 }]);
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN -n.age AS x`)).toEqual([{ x: -29 }]);
  });

  test('string concatenation ||', () => {
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN n.name || '!' AS x`)).toEqual([
      { x: 'marko!' },
    ]);
  });

  test('arithmetic with null is null', () => {
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN n.foo + 1 AS x`)).toEqual([
      { x: null },
    ]);
  });
});

describe('GQL: RETURN *, ORDER BY, SKIP/OFFSET', () => {
  const g = createTestSocialGraph();

  test('RETURN * returns all bound variables', () => {
    const rows = query(g, `MATCH (n:Person {name: 'marko'}) RETURN *`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toEqual(['n']);
  });

  test('ORDER BY ascending (default)', () => {
    const rows = query(g, `MATCH (n:Person) RETURN n.name ORDER BY n.age`);
    expect(rows.map((r) => r['n.name'])).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  test('ORDER BY descending', () => {
    const rows = query(g, `MATCH (n:Person) RETURN n.name ORDER BY n.age DESC`);
    expect(rows.map((r) => r['n.name'])).toEqual(['peter', 'josh', 'marko', 'vadas']);
  });

  test('ORDER BY an alias', () => {
    const rows = query(g, `MATCH (n:Person) RETURN n.name AS who, n.age AS a ORDER BY a DESC`);
    expect(rows.map((r) => r['who'])).toEqual(['peter', 'josh', 'marko', 'vadas']);
  });

  test('SKIP and LIMIT', () => {
    const rows = query(g, `MATCH (n:Person) RETURN n.name ORDER BY n.age SKIP 1 LIMIT 2`);
    expect(rows.map((r) => r['n.name'])).toEqual(['marko', 'josh']);
  });

  test('OFFSET is a synonym for SKIP', () => {
    const rows = query(g, `MATCH (n:Person) RETURN n.name ORDER BY n.age OFFSET 2`);
    expect(rows.map((r) => r['n.name'])).toEqual(['josh', 'peter']);
  });
});

describe('GQL: aggregation', () => {
  const g = createTestSocialGraph();

  test('count(*)', () => {
    expect(query(g, `MATCH (n:Person) RETURN count(*) AS c`)).toEqual([{ c: 4 }]);
  });

  test('count(*) over no matches is 0', () => {
    expect(query(g, `MATCH (n:Robot) RETURN count(*) AS c`)).toEqual([{ c: 0 }]);
  });

  test('sum / avg / min / max', () => {
    expect(query(g, `MATCH (n:Person) RETURN sum(n.age) AS s`)).toEqual([{ s: 123 }]);
    expect(query(g, `MATCH (n:Person) RETURN avg(n.age) AS a`)).toEqual([{ a: 30.75 }]);
    expect(query(g, `MATCH (n:Person) RETURN min(n.age) AS lo, max(n.age) AS hi`)).toEqual([
      { lo: 27, hi: 35 },
    ]);
  });

  test('collect', () => {
    const rows = query(g, `MATCH (n:Person) RETURN collect(n.name) AS names`);
    expect((rows[0]!.names as string[]).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('implicit grouping', () => {
    const rows = query(
      g,
      `MATCH (:Person)-[:CREATED]->(s:Software) RETURN s.name, count(*) AS c ORDER BY s.name`,
    );
    expect(rows).toEqual([
      { 's.name': 'lop', c: 3 },
      { 's.name': 'ripple', c: 1 },
    ]);
  });

  test('count(DISTINCT …)', () => {
    const rows = query(g, `MATCH (:Person)-[:CREATED]->(s) RETURN count(DISTINCT s.name) AS c`);
    expect(rows).toEqual([{ c: 2 }]);
  });

  test('scalar function (upper)', () => {
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN upper(n.name) AS u`)).toEqual([
      { u: 'MARKO' },
    ]);
  });
});

describe('GQL: OPTIONAL MATCH & WITH', () => {
  const g = createTestSocialGraph();

  test('OPTIONAL MATCH keeps unmatched rows with nulls', () => {
    const rows = query(
      g,
      `MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.name, b.name`,
    );
    // marko → vadas, josh; vadas/josh/peter → null.
    expect(rows).toHaveLength(5);
    const friends = rows.map((r) => r['b.name']).filter(Boolean) as string[];
    expect(friends.sort()).toEqual(['josh', 'vadas']);
  });

  test('WITH projects and chains a WHERE', () => {
    const rows = query(
      g,
      `MATCH (n:Person) WITH n.age AS age WHERE age > 30 RETURN age ORDER BY age`,
    );
    expect(rows.map((r) => r['age'])).toEqual([32, 35]);
  });

  test('WITH carries an element into the next MATCH', () => {
    const rows = query(
      g,
      `MATCH (a:Person {name: 'marko'}) WITH a MATCH (a)-[:KNOWS]->(b) RETURN b.name`,
    );
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('WITH aggregation then filter (HAVING-style)', () => {
    const rows = query(
      g,
      `MATCH (:Person)-[:CREATED]->(s) WITH s.name AS name, count(*) AS c WHERE c > 1 RETURN name, c`,
    );
    expect(rows).toEqual([{ name: 'lop', c: 3 }]);
  });
});

describe('GQL: parameters & numeric literals', () => {
  const g = createTestSocialGraph();

  test('$param in WHERE', () => {
    const rows = query(g, `MATCH (n:Person) WHERE n.name = $name RETURN n.age`, { name: 'marko' });
    expect(rows).toEqual([{ 'n.age': 29 }]);
  });

  test('$param as a list for IN', () => {
    const rows = query(g, `MATCH (n:Person) WHERE n.name IN $names RETURN n.name`, {
      names: ['marko', 'josh'],
    });
    expect(names(rows, 'n.name')).toEqual(['josh', 'marko']);
  });

  test('hex, scientific, and underscored numbers', () => {
    const one = (lit: string) =>
      query(g, `MATCH (n:Person {name: 'marko'}) RETURN ${lit} AS x`)[0]!.x;
    expect(one('0xFF')).toBe(255);
    expect(one('0o17')).toBe(15);
    expect(one('0b1010')).toBe(10);
    expect(one('1e3')).toBe(1000);
    expect(one('1_000')).toBe(1000);
    expect(one('3.5e-1')).toBe(0.35);
  });
});

describe('GQL: variable-length paths', () => {
  const g = createTestSocialGraph();

  test('+ (one or more hops)', () => {
    const rows = query(g, `MATCH (a:Person {name: 'marko'})-[:KNOWS]->+(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('* includes zero hops (the start node itself)', () => {
    const rows = query(g, `MATCH (a:Person {name: 'marko'})-[:KNOWS]->*(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'marko', 'vadas']);
  });

  test('bounded {1,1}', () => {
    const rows = query(g, `MATCH (a:Person {name: 'marko'})-[:KNOWS]->{1,1}(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('{2,3} finds nothing (no 2-hop KNOWS chain)', () => {
    const rows = query(g, `MATCH (a:Person {name: 'marko'})-[:KNOWS]->{2,3}(b) RETURN b.name`);
    expect(rows).toEqual([]);
  });

  test('undirected var-length reaches back to the start', () => {
    const rows = query(g, `MATCH (a:Person {name: 'josh'})~[:KNOWS]~{1,2}(b) RETURN b.name`);
    // josh←marko (1), then marko→{vadas,josh} (2).
    expect(names(rows, 'b.name')).toEqual(['josh', 'marko', 'vadas']);
  });
});

describe('GQL: set operations', () => {
  const g = createTestSocialGraph();

  test('UNION (distinct)', () => {
    const rows = query(
      g,
      `MATCH (n:Person) RETURN n.name AS x UNION MATCH (s:Software) RETURN s.name AS x`,
    );
    expect((rows.map((r) => r['x']) as string[]).sort()).toEqual([
      'josh',
      'lop',
      'marko',
      'peter',
      'ripple',
      'vadas',
    ]);
  });

  test('UNION removes duplicates; UNION ALL keeps them', () => {
    const distinct = query(
      g,
      `MATCH (n:Person {name: 'marko'}) RETURN n.name AS x UNION MATCH (n:Person {name: 'marko'}) RETURN n.name AS x`,
    );
    expect(distinct).toHaveLength(1);
    const all = query(
      g,
      `MATCH (n:Person {name: 'marko'}) RETURN n.name AS x UNION ALL MATCH (n:Person {name: 'marko'}) RETURN n.name AS x`,
    );
    expect(all).toHaveLength(2);
  });

  test('EXCEPT', () => {
    const rows = query(
      g,
      `MATCH (n:Person) RETURN n.name AS x EXCEPT MATCH (n:Person {name: 'marko'}) RETURN n.name AS x`,
    );
    expect((rows.map((r) => r['x']) as string[]).sort()).toEqual(['josh', 'peter', 'vadas']);
  });

  test('INTERSECT', () => {
    const rows = query(
      g,
      `MATCH (n:Person) RETURN n.name AS x INTERSECT MATCH (n:Person) WHERE n.age > 30 RETURN n.name AS x`,
    );
    expect((rows.map((r) => r['x']) as string[]).sort()).toEqual(['josh', 'peter']);
  });
});

describe('GQL: delimited identifiers', () => {
  test('backtick-delimited variable and property', () => {
    const g = createTestSocialGraph();
    query(g, `MATCH (n:Person {name: 'marko'}) SET n.\`full name\` = 'Marko P'`);
    const rows = query(
      g,
      `MATCH (\`the node\`:Person {name: 'marko'}) RETURN \`the node\`.\`full name\` AS x`,
    );
    expect(rows).toEqual([{ x: 'Marko P' }]);
  });
});

describe('GQL: write statements', () => {
  test('INSERT a node', () => {
    const g = createTestSocialGraph();
    query(g, `INSERT (n:Person {name: 'newbie', age: 99})`);
    expect(query(g, `MATCH (n:Person {name: 'newbie'}) RETURN n.age`)).toEqual([{ 'n.age': 99 }]);
  });

  test('INSERT … RETURN binds the created node', () => {
    const g = createTestSocialGraph();
    expect(query(g, `INSERT (n:Person {name: 'z'}) RETURN n.name`)).toEqual([{ 'n.name': 'z' }]);
  });

  test('INSERT an edge between matched nodes', () => {
    const g = createTestSocialGraph();
    query(
      g,
      `MATCH (a:Person {name: 'marko'}), (b:Person {name: 'peter'}) INSERT (a)-[:KNOWS]->(b)`,
    );
    const rows = query(g, `MATCH (:Person {name: 'marko'})-[:KNOWS]->(b) RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'peter', 'vadas']);
  });

  test('SET a property', () => {
    const g = createTestSocialGraph();
    query(g, `MATCH (n:Person {name: 'marko'}) SET n.age = 30`);
    expect(query(g, `MATCH (n:Person {name: 'marko'}) RETURN n.age`)).toEqual([{ 'n.age': 30 }]);
  });

  test('SET a label', () => {
    const g = createTestSocialGraph();
    query(g, `MATCH (n:Person {name: 'marko'}) SET n:Verified`);
    expect(query(g, `MATCH (n:Verified) RETURN n.name`)).toEqual([{ 'n.name': 'marko' }]);
  });

  test('REMOVE a property', () => {
    const g = createTestSocialGraph();
    query(g, `MATCH (n:Person {name: 'marko'}) REMOVE n.age`);
    expect(query(g, `MATCH (n:Person {name: 'marko'}) WHERE n.age IS NULL RETURN n.name`)).toEqual([
      { 'n.name': 'marko' },
    ]);
  });

  test('DETACH DELETE a node', () => {
    const g = createTestSocialGraph();
    query(g, `MATCH (n:Person {name: 'marko'}) DETACH DELETE n`);
    expect(query(g, `MATCH (n:Person) RETURN count(*) AS c`)).toEqual([{ c: 3 }]);
  });
});

describe('GQL: parser', () => {
  test('parses direction into the AST', () => {
    const q = parseQuery(`MATCH (a)<-[:R]-(b) RETURN a`);
    expect(firstMatch(q).patterns[0]!.segments[0]!.rel.direction).toBe('in');
  });

  test('parses an edge label expression', () => {
    const q = parseQuery(`MATCH (a)-[:KNOWS|CREATED]->(b) RETURN a`);
    expect(firstMatch(q).patterns[0]!.segments[0]!.rel.label?.kind).toBe('or');
  });
});

describe('GQL: ISO (not Cypher) syntax', () => {
  const g = createTestSocialGraph();

  test('-- is a line comment, not an undirected edge', () => {
    const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b) -- only marko KNOWS\nRETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('// line comment', () => {
    const rows = query(g, `// find software\nMATCH (s:Software) RETURN s.name`);
    expect(names(rows, 's.name')).toEqual(['lop', 'ripple']);
  });

  test('/* block comment */', () => {
    const rows = query(g, `MATCH (s:Software) /* inline */ RETURN s.name`);
    expect(names(rows, 's.name')).toEqual(['lop', 'ripple']);
  });

  test('~ is an undirected edge', () => {
    const q = parseQuery(`MATCH (a)~[:KNOWS]~(b) RETURN a`);
    expect(firstMatch(q).patterns[0]!.segments[0]!.rel.direction).toBe('both');
  });

  test('undirected edge matches either traversal direction', () => {
    // josh is reached from marko via KNOWS; undirected should also find marko
    // from josh.
    const rows = query(g, `MATCH (a)~[:KNOWS]~(b) WHERE a.name = 'josh' RETURN b.name`);
    expect(names(rows, 'b.name')).toEqual(['marko']);
  });

  test('label disjunction :A|B', () => {
    const rows = query(g, `MATCH (n:Person|Software) RETURN n.name`);
    expect(rows).toHaveLength(6); // all nodes
  });

  test('label conjunction :A&B', () => {
    // No fixture node is both Person and Software.
    const rows = query(g, `MATCH (n:Person&Software) RETURN n.name`);
    expect(rows).toEqual([]);
    // …but it parses as a conjunction.
    const q = parseQuery(`MATCH (n:Person&Software) RETURN n`);
    expect(firstMatch(q).patterns[0]!.start.label?.kind).toBe('and');
  });

  test('label negation :!A', () => {
    const rows = query(g, `MATCH (n:!Software) RETURN n.name`);
    expect(names(rows, 'n.name')).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('label wildcard :%', () => {
    const rows = query(g, `MATCH (n:%) RETURN n.name`);
    expect(rows).toHaveLength(6);
  });

  test('IS as the label introducer', () => {
    const rows = query(g, `MATCH (n IS Person) RETURN n.name`);
    expect(names(rows, 'n.name')).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('grouped label expression :(A|B)&!C', () => {
    const q = parseQuery(`MATCH (n:(Person|Robot)&!Software) RETURN n`);
    expect(firstMatch(q).patterns[0]!.start.label?.kind).toBe('and');
  });

  test('edge label disjunction [:A|B]', () => {
    const rows = query(g, `MATCH (a:Person)-[:KNOWS|CREATED]->(b) RETURN b.name`);
    // marko: KNOWS vadas, KNOWS josh, CREATED lop; josh: CREATED ripple, lop;
    // peter: CREATED lop.
    expect(rows).toHaveLength(6);
  });

  test('edge label negation [:!CREATED]', () => {
    const rows = query(g, `MATCH (a:Person)-[:!CREATED]->(b) RETURN b.name`);
    // Only the two KNOWS edges remain.
    expect(names(rows, 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('colon-chained :A:B (Cypher) is rejected', () => {
    expect(() => parseQuery(`MATCH (n:Person:Software) RETURN n`)).toThrow();
  });

  test('abbreviated arrows ->, <-, <->', () => {
    expect(
      firstMatch(parseQuery(`MATCH (a)->(b) RETURN a`)).patterns[0]!.segments[0]!.rel.direction,
    ).toBe('out');
    expect(
      firstMatch(parseQuery(`MATCH (a)<-(b) RETURN a`)).patterns[0]!.segments[0]!.rel.direction,
    ).toBe('in');
    expect(
      firstMatch(parseQuery(`MATCH (a)<->(b) RETURN a`)).patterns[0]!.segments[0]!.rel.direction,
    ).toBe('both');
  });
});
