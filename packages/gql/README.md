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

## Supported query features

The engine implements the ISO GQL core, not Cypher. Notable differences: `--` is a line comment (not an undirected edge), undirected edges use `~`, and label expressions are the boolean-algebra form `A&B` / `A|B` / `!A` / `%` rather than colon-chained `:A:B`.

- **Patterns** — node patterns `(v:Label {prop: value} WHERE pred)`, relationship patterns with direction (`-[:KNOWS]->`, `<-[...]-`, `~[...]~`), and variable-length quantifiers (`*`, `+`, `{n}`, `{n,m}`).
- **Reading** — `MATCH` / `OPTIONAL MATCH`, `WHERE` with ISO three-valued (Kleene) logic, `WITH` for chaining projections, and `RETURN` with `DISTINCT`, `AS` aliases, `ORDER BY` (`ASC`/`DESC`, `NULLS FIRST`/`LAST`), `SKIP`/`OFFSET`, and `LIMIT`.
- **Expressions** — arithmetic, `||` (string **and** list concatenation), comparisons, `IN`, `IS [NOT] NULL`, the string-matching predicates `CONTAINS` / `STARTS WITH` / `ENDS WITH`, `CASE`, `CAST(value AS type)`, `EXISTS { … }` and `COUNT { … }` subqueries, ISO numeric/string/list scalar functions, and the aggregates `count`, `sum`, `avg`, `min`, `max`, `collect_list` (with implicit grouping).
- **Scalar functions** — numeric (`abs`, `ceil`/`ceiling`, `floor`, `round`, `sign`, `sqrt`, `power`, `mod`, `exp`, `ln`, `log`, `log10`, trig, `degrees`, `radians`, `pi()`, `e()`); string (`upper`, `lower`, `trim`/`btrim`/`ltrim`/`rtrim`, `left`, `right`, `substring`, `split`, `replace`, `reverse`, `char_length`, `byte_length`/`octet_length`, `contains`, `starts_with`, `ends_with`); conversion (`to_string`, `to_integer`, `to_float`, `to_boolean`, `to_list`); list (`size`/`length`, `head`, `last`, `tail`, `append`, `range`, `reverse`, `list_union`, `intersection`, `difference`, `list_contains`, `list_sort`); graph (`labels`, `type`, `keys`, `element_id`); and `coalesce` / `nullif`. An unknown function is a loud `ErrorCode.Unsupported` error, never a silent `null`. The set-style list functions (`list_union`/`intersection`/`difference`) dedup with first-occurrence order; `list_contains` returns the numeric `1`/`0` (per the ISO Return Type, not a boolean); `list_sort(list, [order], [nullOrder])` reuses the `ORDER BY` total order.
- **Set operators** — `UNION`, `EXCEPT`, `INTERSECT`, each with optional `ALL`.
- **Writing** — `INSERT`, `SET`, `REMOVE`, `[DETACH] DELETE`, and `FINISH`.

Both engines (this TS engine and the Rust core) produce **byte-identical** results for every one of the above; the parity is pinned by a table-driven differential test (`@lenke/native`'s `gql-functions-conformance.test.ts`).

### Documented divergences

- **`substring` is 1-based** (SQL / ISO GQL convention: `substring('crystal', 1, 3)` → `'cry'`), not the 0-based Cypher form.
- **String length and slicing count UTF-16 code units** (JS `.length` parity), not Unicode code points. `split('')` and `reverse` therefore operate on UTF-16 units; splitting or reversing _across_ an astral (surrogate-pair) character is inherently lossy and yields U+FFFD on both engines — a deliberate divergence from JS `String.split('')`, which preserves lone surrogate halves.
- **`null` is a first-class stored property value** (distinct from absent); remove a property with `REMOVE`, never `SET x.k = null`.
- **Ordering across unlike types.** ISO GQL doesn't define an order between different value types, so `ORDER BY` / `min` / `max` / `list_sort` impose a deterministic **total order across type groups** — `number < string < boolean < other` (graph elements/lists) — with **nulls last** by default (overridable with `NULLS FIRST`/`LAST`). The relational operators `< > <= >=` are unaffected: comparing unlike types there is still `UNKNOWN`, per ISO.

### Known gaps (future work)

The `^` power operator and `list[i]` element indexing are not yet parsed (both engines reject them identically). They await the exact spec precedence / indexing base rather than a guess.

Index-backed seeking is automatic: when a graph has property indexes (`graph.createVertexIndex(key)`), equality, range, and `IN` constraints in patterns or `WHERE` are planned as index seeks rather than full scans.

A syntactically invalid query throws `GqlSyntaxError` (exported), which carries the source offset (`error.pos`) and the stable `ErrorCode.Syntax` code.

## License

Apache-2.0
