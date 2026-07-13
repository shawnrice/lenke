# @lenke/serialization

> (De)serialization codecs that convert `@lenke/core` graphs to and from text in several interchange formats.

Use this package to persist a labeled-property graph to disk, send it over the wire, or import one from an external tool. It speaks the core `Graph` API directly, preserves element identity and the full LPG property-value model across a round trip, and exposes both whole-string and streaming entry points so large graphs need not be held in memory at once.

## Install

```bash
bun add @lenke/serialization
```

## Usage

```ts
import { Graph } from '@lenke/core';
import { serialize, deserialize } from '@lenke/serialization';

const graph = new Graph();
const alice = graph.addVertex({ id: 'a', labels: ['Person'], properties: { name: 'Alice' } });
const bob = graph.addVertex({ id: 'b', labels: ['Person'], properties: { name: 'Bob' } });
graph.addEdge({ id: 'e1', from: alice, to: bob, labels: ['KNOWS'], properties: { since: 2020 } });

// Encode to a single string in any registered format.
const text = serialize(graph, 'pg-json');

// Decode back into a graph (mutates and returns the target graph).
const restored = deserialize(text, 'pg-json', new Graph());
```

For genuinely large graphs, line-oriented formats can be driven incrementally:

```ts
import { serializeStream, deserializeStream } from '@lenke/serialization';

for await (const chunk of serializeStream(graph, 'ndjson')) {
  // write chunk to a file, socket, etc.
}

await deserializeStream(chunkSource, 'ndjson', new Graph());
```

`serializeStream` yields **batched** chunks (~1024 records each), not one chunk per element — so a small graph (under a batch) streams as a single chunk. It's a throughput optimization for large graphs, not a fine-grained progress signal.

To verify a round trip, `graphContentEqual(a, b)` structurally compares two graphs (node ids + labels + properties; edges by id + endpoints + labels + properties; order-independent): `graphContentEqual(deserialize(serialize(g, fmt), fmt), g)`. It compares **by id**, so it correctly reports a `pg-text` round trip as unequal (that codec mints fresh edge ids — real loss, not a false negative).

`serializeAsync` / `deserializeAsync` offer the same whole-string result while yielding the event loop between batches.

## Formats

The registered codecs are exposed as the `codecs` record (`FormatName` is its key type) and individually as `Codec` values; `FORMATS` is the format names as a runtime `readonly FormatName[]` (for a `--format` flag or a `<select>`). A codec implements `encode(graph) => string` and `decode(input, graph) => Graph`; line-oriented formats additionally implement `encodeStream` / `decodeStream`.

| Name       | Codec export    | Streaming | Exact round-trip                                                                       |
| ---------- | --------------- | --------- | -------------------------------------------------------------------------------------- |
| `pg-json`  | `pgJsonCodec`   | no        | yes                                                                                    |
| `pg-text`  | `pgTextCodec`   | yes       | **lossy**: no edge-id slot (edges get fresh ids); `[]`/`[x]` collapse to absent/scalar |
| `ndjson`   | `ndjsonCodec`   | yes       | yes                                                                                    |
| `graphson` | `graphsonCodec` | yes       | yes                                                                                    |
| `csv`      | `csvCodec`      | yes       | yes                                                                                    |

Node ids and scalar / multi-element-list properties round-trip through every format. `pg-text` is the one lossy codec — its textual grammar has no edge-id column and encodes lists as repeated keys, so pick `ndjson` / `pg-json` / `graphson` when you need exact edge identity or faithful empty/singleton lists.

Top-level entry points (`serialize`, `deserialize`, `serializeStream`, `deserializeStream`, `serializeAsync`, `deserializeAsync`) take a `FormatName` and dispatch to the matching codec; an unknown format or an unsupported streaming request throws a `LenkeError`.

### CSV paired files (Neo4j `admin-import` style)

Neo4j exports a **nodes CSV** and a separate **edges CSV**. The CSV codec's halves are exported for exactly this shape (import both into one graph; `decode*` mutate-and-return the passed graph):

```ts
import { Graph } from '@lenke/core';
import { decodeNodes, decodeEdges, encodeNodes, encodeEdges } from '@lenke/serialization';

const g = new Graph();
decodeNodes(await readFile('nodes.csv', 'utf8'), g); // nodes first (edges resolve endpoints against them)
decodeEdges(await readFile('edges.csv', 'utf8'), g);
```

**`decodeNodes` is the Neo4j `admin-import` node codec, not a general CSV loader.** It expects the header's second column to be `:LABEL`: a plain business CSV like `id,name,email` silently consumes column 2 (`name`) as the label set and drops its header — no error, wrong graph. Point it at admin-import-shaped CSV only; for arbitrary CSV, map the columns yourself and build the graph via the normal API.

Header/column conventions: `id,:LABEL,key,key:integer,tags:string[]` for nodes; `:START_ID,:END_ID,:TYPE,key…` for edges. A node line's `id` and `:LABEL` (`;`-joined for multi-label) come first; a property column may carry a type (`:integer`/`:float`/`:boolean`/`:string[]`); `\N` is a stored null and a quoted empty `""` a present empty string. `decodeNodesStream` / `decodeEdgesStream` take a `ChunkSource` for large files. **One asymmetry to know:** batch `decodeEdges` **throws** `E_MISSING_VERTEX` on an edge whose endpoint isn't present, while `decodeEdgesStream` **creates** the missing endpoint as a bare vertex (stream decoding can't look ahead) — pre-validate endpoints if you need the strict behavior on the streaming path.

## License

Apache-2.0
