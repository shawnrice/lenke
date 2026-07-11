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

Top-level entry points (`serialize`, `deserialize`, `serializeStream`, `deserializeStream`, `serializeAsync`, `deserializeAsync`) take a `FormatName` and dispatch to the matching codec; an unknown format or an unsupported streaming request throws a `LenkeError`. The CSV codec also exposes its node/edge halves directly (`encodeNodes`, `decodeNodes`, `encodeEdges`, `decodeEdges`, and their `*Stream` variants) for Neo4j-`admin-import`-style paired files.

## License

Apache-2.0
