# pl-graph-core

> An in-memory columnar labeled-property-graph core with ISO-GQL and Gremlin engines, serialization codecs, and an Apache Arrow result surface, behind a C ABI.

`pl-graph-core` is a mutable in-memory labeled-property graph (LPG) written in Rust. Vertices are dense `u32` ids; properties and adjacency are stored in typed, contiguous columns rather than boxed per-element objects, which keeps the query hot paths cache-friendly. Two query engines sit on top of the graph — an ISO-GQL engine and a Gremlin traversal engine — alongside (de)serialization codecs and a columnar Arrow output. It is the native engine behind the `@pl-graph/native` JavaScript bindings (loaded via `bun:ffi`, or compiled to WebAssembly) and can equally be used directly as a Rust library.

## Modules

- `graph` — the columnar LPG: `Builder`/`NodeRec`/`EdgeRec`/`Value` ingest, typed property `Column`s, dense vertex ids, and optional property indexes. Always compiled.
- `query` — the fingerprint query subset and the shared `RowSet` result type. Always compiled.
- `scan` — a SIMD predicate-scan microbenchmark kernel (scalar and NEON `predicate_gt`). Always compiled.
- `ffi` / `ffi_error` / `error` / `error_codes` — the C-ABI surface (`plg_*` functions over a stateful graph handle) and its error reporting. Always compiled.
- `gql` — the ISO-GQL engine: `parse`, `prepare`, `Prepared::execute`/`execute_arrow`, and the `eval` types (`Params`, `Val`). Feature-gated (`gql`).
- `gremlin` — the Gremlin traversal engine (`parse`, `run`/`try_run`, heterogeneous JSON results). Feature-gated (`gremlin`).
- `ndjson` — the NDJSON load/snapshot codec (`decode`/`decode_serial`/`encode`). Feature-gated (`ndjson`).
- `codec` — the extra serialization formats (pg-json, pg-text, graphson, csv) with a combined `serialize`/`deserialize` dispatch. Feature-gated (`codecs`).
- `arrow` — the Apache Arrow columnar result surface (`to_arrow` over a `RowSet`, plus typed `execute_arrow`). Feature-gated (`arrow`).

## Features

`default = ["full"]`, and `full = ["gql", "gremlin", "ndjson", "codecs", "arrow", "parallel"]`. The crate is feature-composable: a minimal build (for example a WebAssembly frontend bundle) can drop everything it does not use and ship only the columnar graph plus the engines it needs, shrinking the binary with each capability removed.

| Feature | Adds |
| --- | --- |
| `gql` | The ISO-GQL engine (hand-rolled parser; carries no `serde_json`). |
| `gremlin` | The Gremlin traversal engine; pulls in `serde_json` for heterogeneous JSON results. |
| `ndjson` | The NDJSON load/snapshot codec; pulls in `serde_json`. |
| `codecs` | The extra formats (pg-json, pg-text, graphson, csv); implies `ndjson`. |
| `arrow` | The Apache Arrow columnar result surface (binary; no `serde_json`); implies `gql`. |
| `parallel` | `rayon` for bulk NDJSON decode (load-time win, no tradeoff). |
| `parallel-query` | Intra-query threading (parallel projection eval); off by default, implies `parallel`. |

`_fallible-ffi` is an internal marker feature pulled in transitively by the fallible FFI surfaces; it is not a public knob.

## Usage

```rust
use pl_graph_core::gql::eval::{Params, Val};
use pl_graph_core::gql::prepare;
use pl_graph_core::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

// Build a small graph: two Person vertices and one KNOWS edge.
let mut b = Builder::default();
b.nodes.push(NodeRec {
    id: "p0".to_string(),
    labels: vec!["Person".to_string()],
    props: vec![
        ("name".to_string(), Value::Str("alice".into())),
        ("age".to_string(), Value::Num(34.0)),
    ],
});
b.nodes.push(NodeRec {
    id: "p1".to_string(),
    labels: vec!["Person".to_string()],
    props: vec![
        ("name".to_string(), Value::Str("bob".into())),
        ("age".to_string(), Value::Num(29.0)),
    ],
});
b.edges.push(EdgeRec {
    src: "p0".to_string(),
    dst: "p1".to_string(),
    etype: "KNOWS".to_string(),
    props: vec![],
    id: None,
});
let mut g: Graph = b.finalize();

// Prepare a parameterized GQL query once, then execute it against the graph.
let plan = prepare("MATCH (n:Person) WHERE n.age > $min RETURN n.name AS name").unwrap();

let mut params = Params::new();
params.insert("min".to_string(), Val::Num(30.0));

let rows = plan.execute(&mut g, &params).unwrap();
println!("{} columns, {} rows", rows.cols.len(), rows.nrows);
```

## Build

```bash
# Native dynamic library (the cdylib that bun:ffi loads) + rlib.
cargo build --release

# Unit and conformance tests.
cargo test

# Run the GQL engine micro-benchmark from examples/.
cargo run --release --example gql_bench
```

## License

Apache-2.0
