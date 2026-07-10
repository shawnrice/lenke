# @lenke/gremlin

> An Apache TinkerPop-style Gremlin traversal engine in TypeScript: build declarative graph traversals and run them against a `@lenke/core` graph.

Graph queries are expressed as a `Plan` — a plain-data AST assembled from composable step constructors (`V`, `out`, `has`, `order`, `count`, ...). A `Plan` is built once and run against any `Graph`, yielding a lazy stream of results. Reach for this package when you need expressive, Gremlin-familiar traversals (multi-hop movement, filtering by predicates, projection, grouping, path/loop logic) over an in-memory labeled-property graph.

## Install

```bash
bun add @lenke/gremlin
```

## Usage

```ts
import { Graph } from '@lenke/core';
import { run, toArray, traversal, V, has, out, values, gt } from '@lenke/gremlin';

// Build a graph (vertices + edges) with @lenke/core.
const g = new Graph();
const marko = g.addVertex({ id: '1', labels: ['PERSON'], properties: { name: 'marko', age: 29 } });
const josh = g.addVertex({ id: '4', labels: ['PERSON'], properties: { name: 'josh', age: 32 } });
const lop = g.addVertex({
  id: '3',
  labels: ['SOFTWARE'],
  properties: { name: 'lop', lang: 'java' },
});

g.addEdge({ id: '7', from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1.0 } });
g.addEdge({ id: '9', from: marko, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });
g.addEdge({ id: '11', from: josh, to: lop, labels: ['CREATED'], properties: { weight: 0.4 } });

// Build a traversal plan: software created by people over 30.
const plan = traversal(V(), has('age', gt(30)), out('CREATED'), values('name'));

// Run it. `run` returns a lazy Iterable; `toArray` is an eager terminal.
console.log(toArray(plan, g)); // ['lop']

for (const name of run(plan, g)) {
  console.log(name);
}
```

## Building traversals

A `Plan` is built by composing step constructors. Each constructor returns a `StepFn` (`(plan) => plan`); two equivalent entry points combine them:

- `traversal(...steps)` — produces a `Plan`, ready to pass to `run`.
- `pipe(...steps)` — produces a single composed `StepFn`, used to build inline sub-plans (e.g. `where(pipe(out('KNOWS'), count()))`). Sub-plan slots accept either a `pipe(...)` `StepFn` or a `traversal(...)` `Plan`.

`explain(plan)` renders a plan's step sequence, with nested sub-traversals (`where`, `repeat`, `union`, …) indented beneath their step — a faithful EXPLAIN, since this AST _is_ what the executor walks:

```ts
import { explain, traversal, V, hasLabel, out, values, where } from '@lenke/gremlin';

console.log(
  explain(traversal(V(), hasLabel('Person'), where(traversal(out('KNOWS'))), values('name'))),
);
// V {}
// hasLabel {"labels":["Person"]}
// where
//   plan:
//     out {"labels":["KNOWS"]}
// values {"keys":["name"]}
```

Steps span the usual Gremlin categories, all importable from the package root:

- **Sources** — `V(...ids)`, `E(...ids)`, `inject(...values)`.
- **Movement** — `out`, `in_`, `both`, `outE`, `inE`, `bothE`, `outV`, `inV`, `bothV`, `otherV` (each takes optional edge labels).
- **Filters** — `has`, `hasLabel`, `hasId`, `hasKey`, `hasNot`, `hasValue`, `is`, `where`, `filter`, `and`, `or`, `not`, `dedupe`, `simplePath`, `cyclicPath`.
- **Projection** — `values`, `valueMap`, `properties`, `propertyMap`, `elementMap`, `id`, `label`, `value`, `project`, `path`, `select`, `as_`.
- **Aggregation / terminals** — `count`, `sum`, `min`, `max`, `mean`, `fold`, `toList`, `order`, `group`, `groupCount`, `tree`.
- **Branching / iteration** — `union`, `coalesce`, `choose`, `branch`, `optional`, `local`, `repeat`, `loops`, `match`.
- **Cardinality** — `take`/`limit`, `skip`, `range`, `tail`, `sample`.
- **Side effects** — `aggregate`, `store`, `cap`, `barrier`, `subgraph`.
- **Mutation** — `addV`, `addE`, `property`, `drop`.

## Predicates

Filter steps such as `has` and `is` take predicate values, built by predicate constructors: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` (half-open `[min, max)`), `inside`, `outside`, `within`, `without`, `startsWith`, `endingWith`, `containing`, `notContaining`, `regex`, and `not(predicate)`. `has(key, value)` is shorthand for `has(key, eq(value))`.

```ts
import { traversal, V, has, between } from '@lenke/gremlin';

// PERSON vertices whose age is in [28, 33).
traversal(V(), has('PERSON', 'age', between(28, 33)));
```

## Running and binding

- `run(plan, graph)` — runs a plan, returning a lazy `Iterable<unknown>`. Every step is a stream, so terminals like `count`/`fold` yield exactly one value.
- `toArray(plan, graph)` / `toSet(plan, graph)` — eager terminals.
- `bind(graph)` — returns a `GremlinBound` (`query` / `toArray` / `toSet`) with the graph closed over, for running many queries against one graph.

Closure-free plans are pure data: `serialize(plan)` / `deserialize(json)` round-trip a `Plan` over the wire, and `isSerializable(plan)` reports whether a plan contains closure-bearing steps (e.g. `filter(fn)`, `map(fn)`). `createTestTinkerGraph()` returns the canonical TinkerPop "Modern" graph for examples and tests.

## License

Apache-2.0
