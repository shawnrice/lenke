# @lenke/gql

> An ISO-GQL (ISO/IEC 39075) query engine that parses and executes graph queries against a `@lenke/core` graph in TypeScript.

Write declarative graph queries — `MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name` — and run them against an in-memory labeled property graph. Reach for it when you want a query language over a `@lenke/core` `Graph` instead of writing imperative traversals by hand: pattern matching, `WHERE` filters, aggregation, `ORDER BY`/`SKIP`/`LIMIT`, set operators, and write clauses (`INSERT`/`SET`/`REMOVE`/`DELETE`).

## Install

```bash
bun add @lenke/gql
```

This package executes queries against a `@lenke/core` `Graph`, so install that too:

```bash
bun add @lenke/core
```

## Usage

```ts
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();

const marko = g.addVertex({ labels: ['Person'], properties: { name: 'marko', age: 29 } });
const josh = g.addVertex({ labels: ['Person'], properties: { name: 'josh', age: 32 } });
const lop = g.addVertex({ labels: ['Software'], properties: { name: 'lop', lang: 'java' } });

g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1.0 } });
g.addEdge({ from: josh, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });

// Parse + run a query string against the graph; returns an array of rows.
const rows = query(g, `MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN b.name AS friend`);
// => [{ friend: 'josh' }]

// Parameters are supplied as $name and passed in the third argument.
const olderThan = query(g, `MATCH (p:Person) WHERE p.age > $min RETURN p.name`, { min: 30 });
// => [{ 'p.name': 'josh' }]
```

A row is a `Record<string, unknown>` keyed by each `RETURN` item's alias (or a derived name like `b.name` when no `AS` is given).

## Entry points

The package exposes four ways to run a query, all importing from `@lenke/gql`:

```ts
import { query, gql, prepare, parseQuery } from '@lenke/gql';

// One-shot: parse + execute, with optional $params.
query(graph, 'MATCH (n:Person) RETURN n.name', params);

// Bind a graph, then run query strings against it (tagged-template or plain-string).
const run = gql(graph);
run`MATCH (n:Person) RETURN n.name`;
run('MATCH (n:Person) RETURN n.name');

// Parse + compile once into a reusable Plan; rerun with (graph, params) — no re-parse.
const plan = prepare('MATCH (n:Person) WHERE n.age > $min RETURN n.name');
const result = plan(graph, { min: 30 });

// Parse a query string to its AST without executing (tooling/tests).
const ast = parseQuery('MATCH (n) RETURN n');
```

For hot queries, `prepare` (or the lower-level `compile(parse(text))`) does parsing and analysis once and returns a reusable, reentrant `Plan = (graph, params?) => Row[]`.

`explain(query, graph?)` shows the plan. **Pass a graph** and each MATCH shows the _physical_ plan the executor will run against it — which end each pattern seeds from, the seed strategy (index seek / label scan / full scan) with a cardinality estimate, and the expansion. It's the real planner's decision, so it answers "did my index get used?":

```ts
import { explain } from '@lenke/gql';

const q = `MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 55 RETURN b.name LIMIT 5`;

console.log(explain(q, graph));
// Query — 1 part
//   MATCH
//     seed a → label scan :Person  (~100 vertices)
//       expand -[:KNOWS]-> (b)
//     filter: WHERE (residual)
//   RETURN — 1 item, limit 5

graph.createVertexIndex('age');
console.log(explain(q, graph));
//     seed a → index seek age (range)  (~8 vertices)   ← the index is now used
```

**Without a graph** it's the _logical_ view — the parsed clause structure — which is all that's knowable without index sizes:

```ts
console.log(explain(q));
// Query — 1 part
//   MATCH — 1 pattern(s), 3 elements, WHERE
//   RETURN — 1 item, limit 5
```

For programmatic use, `planMatch(graph, clause, params?)` returns the seed plan as structured `PatternPlan[]`.

## Supported query features

The engine implements the ISO GQL core, not Cypher. Notable differences: `--` is a line comment (not an undirected edge), undirected edges use `~`, and label expressions are the boolean-algebra form `A&B` / `A|B` / `!A` / `%` rather than colon-chained `:A:B`.

- **Patterns** — node patterns `(v:Label {prop: value} WHERE pred)`, relationship patterns with direction (`-[:KNOWS]->`, `<-[...]-`, `~[...]~`), and variable-length quantifiers (`*`, `+`, `{n}`, `{n,m}`).
- **Reading** — `MATCH` / `OPTIONAL MATCH`, `WHERE` with ISO three-valued (Kleene) logic, `WITH` for chaining projections, and `RETURN` with `DISTINCT`, `AS` aliases, `ORDER BY` (`ASC`/`DESC`, `NULLS FIRST`/`LAST`), `SKIP`/`OFFSET`, and `LIMIT`.
- **Expressions** — arithmetic, string concatenation (`||`), comparisons, `IN`, `IS [NOT] NULL`, `CASE`, `EXISTS { … }` and `COUNT { … }` subqueries, ISO numeric/string scalar functions, and the aggregates `count`, `sum`, `avg`, `min`, `max`, `collect_list` (with implicit grouping).
- **Set operators** — `UNION`, `EXCEPT`, `INTERSECT`, each with optional `ALL`.
- **Writing** — `INSERT`, `SET`, `REMOVE`, `[DETACH] DELETE`, and `FINISH`.

Index-backed seeking is automatic: when a graph has property indexes (`graph.createVertexIndex(key)`), equality, range, and `IN` constraints in patterns or `WHERE` are planned as index seeks rather than full scans.

A syntactically invalid query throws `GqlSyntaxError` (exported), which carries the source offset (`error.pos`) and the stable `ErrorCode.Syntax` code.

## License

Apache-2.0
