# In-engine graph algorithms

lenke runs whole-graph algorithms **inside** the engine — PageRank, connected components, label propagation, degree, shortest path, peer pressure, and betweenness/closeness centrality. They are not a bolt-on library that pulls your graph out into JS arrays; they execute against the live store (the Rust core uses its rayon parallelism; the pure-TS driver time-slices so it never blocks the event loop) and, on the native engine, run genuinely off the JS thread.

The same computation is reachable from **four surfaces**. Pick the one that fits your call site — the `config` shape and the results are identical across all of them, and the numeric output is **byte-identical** across the pure-TS and Rust engines (a fixed summation order is the rule that guarantees it, so a score computed in the browser matches one computed on the server bit for bit).

## The shipped algorithms

| Name                  | Result rows             | What it computes                                     |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| `pagerank`            | `{ node, score }`       | Influence / centrality by link structure.            |
| `connectedComponents` | `{ node, componentId }` | Weakly-connected component membership.               |
| `labelPropagation`    | `{ node, label }`       | Community detection by label spreading.              |
| `peerPressure`        | `{ node, label }`       | Community detection by majority vote.                |
| `degree`              | `{ node, degree }`      | In/out/total edge count per node.                    |
| `shortestPath`        | path result             | Shortest path between `source` and `target`.         |
| `betweenness`         | `{ node, centrality }`  | Brokerage — how often a node lies on shortest paths. |
| `closeness`           | `{ node, centrality }`  | Reciprocal of total distance to reachable nodes.     |

The shared `config` object (all fields optional) carries `edgeLabel`, `direction` (`'out' | 'in'`), `weightProperty`, `dampingFactor`, `iterations`, `source`/`target`, and `writeProperty`. It is portable _verbatim_ across the four surfaces below.

> **Centrality cost.** `betweenness` (Brandes' algorithm) and `closeness` are exact and byte-identical across engines, but **O(V·E)** — every node runs a full traversal. Fine for thousands of nodes; for very large graphs, sample or precompute. `betweenness`/`closeness` are directed and unnormalized (`closeness = 1 / Σ distance`, 0 when nothing is reachable).

## Surface 1 — `@lenke/core` async free functions

Data-last, always-async free functions. The `async` is deliberate: a long run never blocks the loop.

```ts
import { Graph, pagerank, connectedComponents, degree } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
query(g, `INSERT (:P {id:'a'}), (:P {id:'b'}), (:P {id:'c'})`);
query(g, `MATCH (a:P {id:'a'}),(b:P {id:'b'}) INSERT (a)-[:F]->(b)`);
query(g, `MATCH (b:P {id:'b'}),(c:P {id:'c'}) INSERT (b)-[:F]->(c)`);
query(g, `MATCH (a:P {id:'a'}),(c:P {id:'c'}) INSERT (a)-[:F]->(c)`);

const scores = await pagerank({ iterations: 20 }, g);
// → [{ node: '…', score: 0.197… }, { node: '…', score: 0.281… }, { node: '…', score: 0.520… }]
```

They compose data-last, so `pagerank(config)` partially applied also works under a `pipe`.

### Feature write-back with `writeProperty`

Give any algorithm a `writeProperty` and it writes each result back **onto its vertex** as a property — turning a computed score into queryable graph data:

```ts
await pagerank({ iterations: 20, writeProperty: 'pr' }, g);
const rows = query(g, `MATCH (p:P) RETURN p.id AS id, p.pr AS pr ORDER BY pr DESC`);
// → [{ id: 'c', pr: 0.520… }, { id: 'b', pr: 0.281… }, { id: 'a', pr: 0.197… }]
```

Now every downstream GQL/Gremlin query can filter, sort, and traverse on `pr` — the algorithm's output has become a first-class feature of the graph.

## Surface 2 — native `RustGraph` methods

The identical algorithms hang off the native graph handle, each returning a `Promise<Row[]>` and running on a libuv threadpool thread (off the JS thread, keeping the engine's parallelism):

```ts
const scores = await g.pagerank({ iterations: 20 });
await g.pagerank({ iterations: 20, writeProperty: 'pr' }); // same write-back
const comps = await g.connectedComponents();
```

**Single-flight:** while an algorithm promise is pending the graph is locked — any other engine call throws `E_INVALID_GRAPH_OP` until it settles. Always `await` one before issuing the next.

## Surface 3 — the ISO GQL `CALL` procedure

The conformant home for the algorithms inside a query: a named procedure with a config map, `YIELD`ing its result columns, which you then treat as an ordinary row source:

```ts
const top = query(
  g,
  `CALL pagerank({ iterations: 20 }) YIELD node, score
   RETURN score ORDER BY score DESC LIMIT 1`,
);
// → [{ score: 0.520… }]
```

`YIELD` names the columns the procedure produces (`node`, `score` for PageRank; `node`, `componentId` for components; and so on), and everything after it is normal GQL — `WHERE`, `ORDER BY`, `RETURN`, joins against other patterns.

## Surface 4 — Gremlin steps

The Gremlin frontend exposes the same computations as traversal steps:

```ts
// g.V().pageRank()  — and the degree/component analogues
```

## Which surface to reach for

- **A one-shot analysis in application code** → the `@lenke/core` free function or the native method.
- **A score you want to keep and query** → any surface with `writeProperty`, then read the property back.
- **An algorithm as one stage of a larger query** → the GQL `CALL … YIELD` form (compose with `WHERE`/`ORDER BY`/`RETURN`).
- **A Gremlin shop** → the traversal steps.

All four are the same engine code path — the choice is purely about where the call lives, never about what it computes.
