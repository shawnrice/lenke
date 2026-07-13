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

- **Patterns** — node patterns `(v:Label {prop: value} WHERE pred)`, relationship patterns with direction (`-[:KNOWS]->`, `<-[...]-`, `~[...]~`), and variable-length quantifiers (`*`, `+`, `{n}`, `{n,m}`). The quantifier is written **after the relationship, immediately before the target node**: `(a)-[:KNOWS]->*(b)`, `(a)-[:KNOWS]->{1,2}(b)`, `(a)~[:KNOWS]~{1,2}(b)`. Bounds are hop counts; `*` is `{0,}` (includes the zero-hop start) and `+` is `{1,}`. (A quantifier binds the single preceding relationship — quantified _paths_ over a parenthesized multi-hop sub-pattern are not yet supported.)
- **Reading** — `MATCH` / `OPTIONAL MATCH`, `WHERE` with ISO three-valued (Kleene) logic, `WITH` for chaining projections, `FOR` list-unwind (see below), and `RETURN` with `DISTINCT`, `AS` aliases, `ORDER BY` (`ASC`/`DESC`, `NULLS FIRST`/`LAST`), `SKIP`/`OFFSET`, and `LIMIT`.
- **`FOR` (list unwind)** — `FOR x IN <list> [WITH ORDINALITY n]` expands a list into one row per element (the ISO/IEC 39075 statement that does what Cypher spells `UNWIND` — so it is written bare, no sigil). It multiplies the current row table: `MATCH (p:Person {name: 'marko'}) FOR t IN ['x', 'y'] RETURN p.name, t` yields a row per `t`. `WITH ORDINALITY n` binds a 1-based counter, `WITH OFFSET n` a 0-based one. A list unwinds its elements; **`null` yields zero rows**; any other scalar unwinds as a one-element list. The list may reference any prior binding (`FOR x IN [p.name, p.age]`). Combined with `OPTIONAL MATCH` this gives a **batch check** — one row per requested key, present or absent: `FOR id IN $ids OPTIONAL MATCH (u:User {id: $me})-[:CAN_ACCESS]->(r:Resource {id: id}) RETURN id, r IS NOT NULL AS allowed`.
- **Expressions** — arithmetic, `||` (string **and** list concatenation), comparisons, `IN`, `IS [NOT] NULL`, the string-matching predicates `CONTAINS` / `STARTS WITH` / `ENDS WITH`, `CASE`, `CAST(value AS type)`, `EXISTS { … }` and `COUNT { … }` subqueries, ISO numeric/string/list scalar functions, and the aggregates `count`, `sum`, `avg`, `min`, `max`, `collect_list` (with implicit grouping).
- **Scalar functions** — numeric (`abs`, `ceil`/`ceiling`, `floor`, `round`, `sign`, `sqrt`, `power`, `mod`, `exp`, `ln`, `log`, `log10`, trig, `degrees`, `radians`, `pi()`, `e()`); string (`upper`, `lower`, `trim`/`btrim`/`ltrim`/`rtrim`, `left`, `right`, `substring`, `split`, `replace`, `reverse`, `char_length`, `byte_length`/`octet_length`, `contains`, `starts_with`, `ends_with`); conversion (`to_string`, `to_integer`, `to_float`, `to_boolean`, `to_list`); list (`size`/`length`, `head`, `last`, `tail`, `append`, `range`, `reverse`, `list_union`, `intersection`, `difference`, `list_contains`, `list_sort`); graph (`labels`, `type`, `keys`, `element_id`); and `coalesce` / `nullif`. An unknown function is a loud `ErrorCode.UnknownFunction` error, never a silent `null`. The set-style list functions (`list_union`/`intersection`/`difference`) dedup with first-occurrence order; `list_contains` returns the numeric `1`/`0` (per the ISO Return Type, not a boolean); `list_sort(list, [order], [nullOrder])` reuses the `ORDER BY` total order.
- **Set operators** — `UNION`, `EXCEPT`, `INTERSECT`, each with optional `ALL`.
- **Writing** — `INSERT`, `SET`, `REMOVE`, `[DETACH] DELETE`, and `FINISH`.

Both engines (this TS engine and the Rust core) produce **byte-identical** results for every one of the above; the parity is pinned by a table-driven differential test (`@lenke/native`'s `gql-functions-conformance.test.ts`).

### Documented divergences

- **`substring` is 1-based** (SQL / ISO GQL convention: `substring('crystal', 1, 3)` → `'cry'`), not the 0-based Cypher form.
- **String length and slicing count UTF-16 code units** (JS `.length` parity), not Unicode code points. `split('')` and `reverse` therefore operate on UTF-16 units; splitting or reversing _across_ an astral (surrogate-pair) character is inherently lossy and yields U+FFFD on both engines — a deliberate divergence from JS `String.split('')`, which preserves lone surrogate halves.
- **`null` is a first-class stored property value** (distinct from absent); remove a property with `REMOVE`, never `SET x.k = null`.
- **Ordering across unlike types.** ISO GQL doesn't define an order between different value types, so `ORDER BY` / `min` / `max` / `list_sort` impose a deterministic **total order across type groups** — `number < string < boolean < other` (graph elements/lists) — with **nulls last** by default (overridable with `NULLS FIRST`/`LAST`). The relational operators `< > <= >=` are unaffected: comparing unlike types there is still `UNKNOWN`, per ISO.

### Temporal values (`DATE` / `LOCAL DATETIME` / `DURATION`)

ISO temporal types are first-class stored values (zone-less; `ZONED DATETIME`/`TIME` are future work), byte-identical between the TS and Rust engines.

- **Literals**: `DATE '2020-01-01'`, `DATETIME '2020-01-01T10:15:30'` (or `TIMESTAMP '…'`), `DURATION 'P1Y2M3DT4H5M6S'`. Written as a type keyword before a string.
- **Comparison**: `< > <= >=` on dates/datetimes is chronological; a `DURATION` (like a SQL interval) and any cross-kind pair are `UNKNOWN`. `ORDER BY` uses a deterministic total order (durations sort lexicographically). So valid-time as-of filtering just works: `MATCH (f) WHERE f.vfrom <= DATE '2021-06-01' AND DATE '2021-06-01' < f.vto RETURN f`.
- **Constructors** (the function form of the types — takes any expression, so it converts a loaded string column): `date(x)`, `local_datetime(x)` (alias `datetime`), `duration(x)`. Parse a string, or convert a temporal by kind (`date(datetime)` → the date part). A null / bad string / unconvertible pair → null. E.g. `SET n.hired = date(n.hiredStr)`.
- **`duration_between(a, b)`** — the **exact** elapsed span (a measurement between two pinned points, so never calendar months): whole days for two dates, seconds for two datetimes. `duration_between(DATE '2020-01-15', DATE '2020-04-20')` → `P96D`.
- **Arithmetic** — `date/datetime ± duration` anchors the (nominal) duration to the concrete date: **calendar months are added first, clamping the day to the new month's length** (`DATE '2020-01-31' + DURATION 'P1M'` → `2020-02-29`), then days, then time. `instant − instant` → the exact span; `duration ± duration` is component-wise; `duration × integer` scales.
- **`current_date` / `current_timestamp` / `local_timestamp`** — the current instant, kept **deterministic and byte-identical by never reading a clock**: each reads a reserved `$__now` DATETIME the host supplies (`current_timestamp`/`local_timestamp` → `$__now`; `current_date` → its date part). Pass it like any binding — `query(g, 'RETURN current_date AS today', { __now: parseDateTime('2026-07-12T10:30:45') })` → `2026-07-12`. With no `$__now` supplied they read as `null` (the engine never invents a time). Call with or without parens (`current_timestamp` ≡ `current_timestamp()`).

**JavaScript interop.** lenke is not a date library — it stores and queries; do date math and formatting in your library of choice and bridge cleanly. Reading a temporal from a result gives a `LocalDate`/`LocalDateTime`/`Duration` (from `@lenke/core`):

```ts
import { LocalDate, LocalDateTime, parseDate } from '@lenke/core';

date.toISOString(); // '2020-01-01' — the universal bridge (also `String(date)`)
duration.toISOString(); // 'P14M3DT…'   — round-trips with Temporal.Duration / Luxon Duration.fromISO
date.toTemporal(); // a TC39 `Temporal.PlainDate` (if the runtime has Temporal)

// Constructing / storing a temporal — any of:
parseDate('2020-01-01'); // from an ISO string
Temporal.PlainDate.from('2020-01-01'); // a TC39 `Temporal.Plain*` is accepted at the value boundary (duck-typed, no dep)
LocalDateTime.fromJSDate(jsDate, { zone }); // a native Date is a zoned instant — convert EXPLICITLY (a bare Date throws)
```

A native `Date` is deliberately **not** auto-coerced (it's a zoned instant; our types are zone-less, so a silent timezone guess would corrupt the value) — pass an ISO string, a `Temporal.Plain*`, or use `fromJSDate(d, { zone })`.

### Known gaps (future work)

The `^` power operator and `list[i]` element indexing are not yet parsed (both engines reject them identically). They await the exact spec precedence / indexing base rather than a guess.

Index-backed seeking is automatic: when a graph has property indexes (`graph.createVertexIndex(key)`), equality, range, and `IN` constraints in patterns or `WHERE` are planned as index seeks rather than full scans. This holds per-anchor across a comma-joined `MATCH (a {id: $x}), (b {id: $y})` — **each** anchor seeks its own index (whether the key is an inline `{id: $x}` or a `WHERE a.id = $x AND b.id = $y` conjunct), so a two-anchor lookup is two seeks, not a cross-product scan. (An `OR` predicate or a var-to-var comparison like `a.k = b.k` is not a seekable hint and falls back to a scan, staying correct.)

A syntactically invalid query throws `GqlSyntaxError` (exported by `@lenke/gql`), which carries the source offset (`error.pos`) and the stable `ErrorCode.Syntax` code. **Note:** on the native/wasm engines (`@lenke/native`, `@lenke/node`) the same syntax error surfaces as a plain coded `LenkeError` (`ErrorCode.Syntax`) with the offset in the message text — the structured `GqlSyntaxError`/`error.pos` surface is the pure-TS engine's.

Two more runtime errors worth knowing:

- **Unbound parameter** — a `$name` the query references but the params bag doesn't supply throws `ErrorCode.MissingParameter` (naming the param), rather than binding to a silent `null`. A forgotten/typo'd binding fails loud.
- **Reserved words** — an ISO GQL keyword used **bare** (unquoted) in any _name_ position — a **node/edge label**, a **variable**, a **property key**, or a **column alias** — is an `ErrorCode.Syntax` error. lenke follows ISO here: to use a reserved word as a name in any of those positions you must **backtick-quote it** as a delimited identifier. The rejection is uniform and now names the fix, keeping your exact casing — `MATCH (x:Order)` reports ``` `Order` is a reserved word and can't be used bare as a label name; quote it as a delimited identifier with backticks: `Order` ```. This bites several common cases: a property named after a keyword (`project`, `order`, `value`, `group`, `key`); an **aggregate aliased to its own name** — `RETURN count(*) AS count` fails, so write `` AS `count` `` (or a different alias like `AS n`); a **label that happens to be reserved** — `MATCH (x:Group)` and `MATCH (x:Order)` both throw (`group`/`order` are reserved), which stings for authz-/commerce-style schemas; and a **variable** named after a keyword (`MATCH (order) …`). The remedy in every case is a backtick:

  ```ts
  // A reserved-word label — quote it, and the query runs:
  query(g, 'MATCH (x:`Order`) RETURN x');
  ```

  Function/aggregate names (`count`, `sum`, `avg`, `min`, `max`) and words like `group`/`value`/`key`/`order` are all reserved; the full list is the ISO/IEC 39075 `<reserved word>` + `<pre-reserved word>` set (verbatim in `lexer.ts`).

## Upsert: unique constraints + `_MERGE`

ISO GQL's write clauses are `INSERT` / `SET` / `REMOVE` / `[DETACH] DELETE` / `FINISH` — there is **no** `MERGE`/upsert clause (that's a Cypher extension the standard deliberately omits). lenke fills the gap with two pieces: a **unique-constraint** primitive and a sigil-marked **`_MERGE`** extension. Both behave byte-identically on the pure-TS and native engines, and are covered by a cross-engine differential.

### Unique constraints (a host-language primitive)

`graph.createUniqueConstraint(label, key)` declares that at most one live vertex carrying `label` may hold a given (non-null) value for `key`. It is index-backed (seeks, not scans), and it's the _key_ `_MERGE` upserts on.

```ts
g.createUniqueConstraint('User', 'email'); // throws ConstraintViolation if data already violates it
query(g, `INSERT (:User {email: 'a@x.io'})`);
query(g, `INSERT (:User {email: 'a@x.io'})`); // ← throws ErrorCode.ConstraintViolation
```

A plain `INSERT`/`SET` that would duplicate a constrained value throws `ErrorCode.ConstraintViolation`. Null values are exempt (SQL semantics — NULLs are distinct). It's a host API, not GQL DDL, so it can never collide with a future GQL constraint syntax. (`dropUniqueConstraint`, `uniqueKeys`, `hasUniqueConstraint`, `uniqueConstraints` round out the surface.)

### `_MERGE` — keyed upsert (a lenke extension, not ISO GQL)

`_MERGE` is a **non-standard extension**, so it wears a leading-underscore **sigil** — a reader sees `_MERGE` and knows it's non-portable, and it can never collide with a future ISO keyword. It's recognized only under the default `lenke` dialect; parse with `{ dialect: 'iso-strict' }` and any extension is a syntax error (that's how the conformance harness proves the ISO surface stays pure).

**Node form** — the conflict key is inferred from the pattern's properties ∩ the label's unique constraints (no applicable constraint → error; more than one → ambiguous → error):

```ts
// presence: a bare _MERGE clobbers the payload, so the cursor tracks
query(g, `_MERGE (p:Presence {sid: $s, x: $x, y: $y})`);

// full form
query(
  g,
  `
  _MERGE (u:User {email: $e, name: $n})
    _ON_CREATE SET u.created = $now      -- birth-only extras
    _ON_UPDATE SET u.lastSeen = $now     -- replaces the default clobber
`,
);
```

The **update path** has one disposition:

| Disposition                  | Meaning                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| _(bare, default)_            | clobber the non-key payload to the pattern's values                |
| `_ON_UPDATE SET … [WHERE p]` | **replaces** the default; runs only if `p` holds (last-write-wins) |
| `_ON_UPDATE_NOTHING`         | leave the existing element untouched (`ON CONFLICT DO NOTHING`)    |

`_ON_CREATE SET …` adds birth-only fields. WHERE-gating gives optimistic concurrency:

```ts
// only overwrite if the incoming version is newer
query(
  g,
  `_MERGE (d:Doc {id: $id}) _ON_UPDATE SET d.body = $b, d.version = $v WHERE d.version < $v`,
);
```

**Edge form** — endpoints are matched by their key, and the single edge between them (keyed structurally by `from`/`to`/type) is upserted. This is the "ensure-tuple" idiom:

```ts
g.createUniqueConstraint('User', 'id');
g.createUniqueConstraint('Team', 'id');
// ensure a MEMBER edge exists between two existing vertices, idempotently
query(
  g,
  `_MERGE (u:User {id: $u})-[m:MEMBER {since: $t}]->(t:Team {id: $g}) _ON_CREATE SET m.role = 'member'`,
);
```

A missing endpoint errors (`ErrorCode.InvalidGraphOp`). Multi-hop compound patterns (where an interior node might be created) are not yet supported.

### How this diverges (documented on purpose)

- **vs Cypher `MERGE`**: `_MERGE` is element-keyed (not whole-pattern), so it can't duplicate a node the way Cypher's `MERGE (a)-[:R]->(b)` can; it **clobbers the payload by default** (Cypher never clobbers — its inline props are all match key); it uses `_ON_UPDATE` (data-op framing) not `ON MATCH`; and it **requires a unique constraint** to define the key.
- **vs SQL upsert**: same conflict-target / `WHERE` / `DO NOTHING` shape, but `_MERGE` **clobbers by default** where SQL's minimal form leaves the row.
- A payload `null` is **stored** (present, first-class), not deleted — consistent with lenke's null policy. Delete with `REMOVE`.

Full spec: `docs/design/gql-extensions.md`.

## License

Apache-2.0
