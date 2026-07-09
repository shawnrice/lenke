# @lenke/inspect

> Debugging & inspection helpers for lenke graphs: `describe()` a graph's shape, render a query result as a table, and pretty-print vertices and edges.

When you're poking at a graph in a REPL, a test, or a `console.log`, the raw
objects aren't much to look at. `@lenke/inspect` turns a graph and its query
results into readable text. It's a dependency-light dev aid — nothing here
mutates the graph or is needed at runtime by an app.

## Usage

```ts
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { describe, formatGraph, formatRows, formatElement } from '@lenke/inspect';

const g = new Graph();
const marko = g.addVertex({ labels: ['Person'], properties: { name: 'marko', age: 29 } });
const josh = g.addVertex({ labels: ['Person'], properties: { name: 'josh', age: 32 } });
g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1 } });

console.log(formatGraph(g));
// Graph — 2 vertices, 1 edges (version 3)
//
// Vertex labels
//   Person  2
//
// Edge labels
//   KNOWS  1
//
// Indexes
//   vertices: (none)
//   edges:    (none)

console.log(formatRows(query(g, `MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name, b.name`)));
// a.name  b.name
// ──────  ──────
// marko   josh
//
// (1 row)

console.log(formatElement(marko));
// (#... :Person { name: "marko", age: 29 })
```

## API

- **`describe(graph): GraphSummary`** — a structured snapshot: `vertices` /
  `edges` counts, `version`, per-label breakdowns (`vertexLabels` / `edgeLabels`,
  most-populated first), and the indexed property keys (`vertexIndexes` /
  `edgeIndexes`). The machine-readable half.
- **`formatGraph(graph): string`** — `describe()` rendered as a `console.log`-
  friendly summary.
- **`formatRows(rows, { maxColWidth? }): string`** — a result set (the array of
  row objects both the GQL and Gremlin engines return) as an aligned table.
  Shows a stored `null` distinctly from an absent property; truncates wide cells
  (default 40 columns) without cutting header names.
- **`formatElement(vertex | edge): string`** — one vertex or edge as a compact
  line, with labels and quoted property values; edges also show their endpoints.

Everything is a pure function over a [`@lenke/core`](../core) `Graph` (and query
rows), so it works the same in a test, a script, or a REPL.

## License

Apache-2.0
