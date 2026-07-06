//! Columnar labeled-property-graph (LPG) core: a mutable in-memory graph with
//! dense `u32` vertex ids and typed, contiguous property columns, plus the query
//! and serialization surfaces built on it.
//!
//! Versus the TS core (edges as objects indexed in nested hash maps), adjacency
//! and properties are stored columnar — cache-friendly, and de-boxed on the hot
//! paths. On top sit two query engines (ISO-GQL and Gremlin), the (de)serialization
//! codecs, and an Apache Arrow result surface. Everything above the graph is
//! feature-gated (see the `[features]` table in Cargo.toml) so a minimal build —
//! e.g. a frontend wasm bundle — ships only what it uses.
//!
//! Binding-agnostic: `ffi` exposes a C ABI for bun:ffi (and later wasm-bindgen)
//! over a stateful graph handle.

// Core (always compiled): the columnar graph, the fingerprint query subset, and
// the C-ABI surface.
pub mod error;
pub mod error_codes;
pub mod ffi;
pub mod ffi_error;
pub mod graph;
pub mod query;

// Composable capabilities — gated so a minimal (e.g. frontend wasm) build ships
// only what it uses. See the `[features]` table in Cargo.toml.
#[cfg(feature = "arrow")]
pub mod arrow;
#[cfg(feature = "codecs")]
pub mod codec;
#[cfg(feature = "gql")]
pub mod gql;
#[cfg(feature = "gremlin")]
pub mod gremlin;
// Shared JSON writer primitives (js_number + string escaper), used by every
// serde-free JSON surface. gql hand-rolls its own tabular output and omits it.
#[cfg(any(feature = "gremlin", feature = "ndjson"))]
mod jsonfmt;
#[cfg(feature = "ndjson")]
pub mod ndjson;
