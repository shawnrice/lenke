//! `@lenke/node` — a native Node.js addon for the `lenke-core` graph engine,
//! built with napi-rs (N-API).
//!
//! This is the *fast* Node path. Where the bun:ffi / wasm backends cross a C ABI
//! and marshal pointers by hand, this addon speaks N-API directly: JS strings and
//! Buffers arrive as real Rust values, results go back as Buffers with no
//! serialize-then-reparse dance on the boundary. The engine is compiled straight
//! in (path dep on `lenke-core`), so there is no dynamic library to locate at
//! runtime either.
//!
//! The surface mirrors the C ABI's logical operations (see `lenke-core/src/ffi.rs`)
//! so a thin adapter can expose it as the shared `Backend` contract from
//! `@lenke/native` (see `backend.mjs`), which in turn lights up the whole
//! `RustGraph` / `createStore` / `liveQuery` facade on Node unchanged.

use lenke_core::error::CodeError;
use lenke_core::error_codes::ErrorCode;
use lenke_core::gql::eval::Params;
use lenke_core::graph::Graph as CoreGraph;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Turn a coded engine error into a JS exception: a human `lenke: <op>: <message>`
/// with the stable wire code in a machine-parseable tail (`[E_SYNTAX]`). The TS
/// adapter (`backend.mjs`) reads the tail and rebuilds a `LenkeError` carrying the
/// code, giving the napi addon full error-code parity with the bun:ffi and wasm
/// backends — while a direct `Graph` user still reads a plain message.
fn coded(op: &str, e: CodeError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("lenke: {op}: {} [{}]", e.message, e.code.as_str()),
    )
}

/// Coded error for a fixed message + code (parse failures, UTF-8 faults) — the
/// same channel as [`coded`], so these carry a stable code too.
fn coded_msg(op: &str, code: ErrorCode, message: impl Into<String>) -> Error {
    coded(op, CodeError::new(code, message))
}

/// Decode the optional params-JSON argument (a flat `{"name": value}` object of
/// `$name` bindings) via the crate's strict hand-rolled decoder. Values bind to
/// already-parsed param slots at execute time — they never touch the GQL
/// parser, which is the injection-safety contract of the params surface.
fn decode_params(op: &str, params_json: Option<&str>) -> Result<Params> {
    match params_json {
        None => Ok(Params::new()),
        Some(text) => lenke_core::gql::params_from_json(text).map_err(|e| coded(op, e)),
    }
}

/// A decoded, in-memory columnar graph. Owns its `lenke-core` graph; napi frees
/// it when the JS object is garbage-collected, so there is no explicit free.
#[napi]
pub struct Graph {
    inner: CoreGraph,
}

#[napi]
impl Graph {
    /// Decode NDJSON bytes into a graph. `parallel` (default true) uses the
    /// rayon bulk decoder; pass false for a serial parse.
    #[napi(factory)]
    pub fn from_ndjson(bytes: Buffer, parallel: Option<bool>) -> Result<Self> {
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            coded_msg(
                "fromNdjson",
                ErrorCode::Ffi,
                "NDJSON bytes are not valid UTF-8",
            )
        })?;
        let inner = if parallel.unwrap_or(true) {
            lenke_core::ndjson::decode(text)
        } else {
            lenke_core::ndjson::decode_serial(text)
        }
        .map_err(|e| coded("fromNdjson", e))?;

        Ok(Self { inner })
    }

    /// Deserialize bytes in a named format (`pg-json | pg-text | graphson | csv |
    /// ndjson`) into a new graph.
    #[napi(factory)]
    pub fn deserialize(bytes: Buffer, format: String) -> Result<Self> {
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            coded_msg(
                "deserialize",
                ErrorCode::Ffi,
                "input bytes are not valid UTF-8",
            )
        })?;
        let inner =
            lenke_core::codec::deserialize(text, &format).map_err(|e| coded("deserialize", e))?;

        Ok(Self { inner })
    }

    #[napi(getter)]
    pub fn vertex_count(&self) -> f64 {
        self.inner.vertex_count() as f64
    }

    #[napi(getter)]
    pub fn edge_count(&self) -> f64 {
        self.inner.edge_count() as f64
    }

    /// Monotonic mutation counter — the O(1) "did anything change?" signal for
    /// reactive snapshots.
    #[napi]
    pub fn version(&self) -> f64 {
        self.inner.version() as f64
    }

    /// Per-token change epoch (label / edge-type / property-key) for finer
    /// invalidation than the global version.
    #[napi]
    pub fn epoch(&self, name: String) -> f64 {
        self.inner.epoch(&name) as f64
    }

    /// Run a GQL query; returns the `{columns, rows}` JSON document as bytes.
    /// `params_json` optionally carries a flat JSON object of `$name` bindings.
    /// `&mut` because a query may mutate (`INSERT`/`SET`/`REMOVE`/`DELETE`).
    #[napi]
    pub fn query(&mut self, text: String, params_json: Option<String>) -> Result<Buffer> {
        let params = decode_params("query", params_json.as_deref())?;
        let parsed = lenke_core::gql::parse(&text).map_err(|e| {
            coded_msg(
                "query",
                ErrorCode::Syntax,
                format!("{} (pos {})", e.message, e.pos),
            )
        })?;
        let rows = parsed
            .execute(&mut self.inner, &params)
            .map_err(|e| coded("query", e))?;

        Ok(rows.to_json().into_bytes().into())
    }

    /// Run a GQL query; returns the Apache Arrow ("ARW1") columnar blob.
    /// Takes the same optional `params_json` bindings as [`Graph::query`].
    #[napi]
    pub fn query_arrow(&mut self, text: String, params_json: Option<String>) -> Result<Buffer> {
        let params = decode_params("queryArrow", params_json.as_deref())?;
        let parsed = lenke_core::gql::parse(&text).map_err(|e| {
            coded_msg(
                "queryArrow",
                ErrorCode::Syntax,
                format!("{} (pos {})", e.message, e.pos),
            )
        })?;
        let blob = parsed
            .execute_arrow(&mut self.inner, &params)
            .map_err(|e| coded("queryArrow", e))?;

        Ok(blob.into())
    }

    /// Run a textual Gremlin query; returns the JSON-array result as bytes.
    #[napi]
    pub fn gremlin(&mut self, text: String) -> Result<Buffer> {
        let plan = lenke_core::gremlin::parse(&text)
            .map_err(|e| coded_msg("gremlin", ErrorCode::Syntax, e))?;
        let vals = lenke_core::gremlin::try_run(&mut self.inner, &plan)
            .map_err(|e| coded("gremlin", e))?;

        Ok(
            lenke_core::gremlin::exec::results_to_json(&self.inner, &vals)
                .into_bytes()
                .into(),
        )
    }

    /// Serialize the graph in a named format (`pg-json | pg-text | graphson |
    /// csv | ndjson`).
    #[napi]
    pub fn serialize(&self, format: String) -> Result<Buffer> {
        let out = lenke_core::codec::serialize(&self.inner, &format)
            .map_err(|e| coded("serialize", e))?;

        Ok(out.into_bytes().into())
    }

    /// Serialize the whole graph back to NDJSON bytes.
    #[napi]
    pub fn encode_ndjson(&self) -> Buffer {
        lenke_core::ndjson::encode(&self.inner).into_bytes().into()
    }
}

/// The engine's ABI version — the same value the C ABI reports via
/// `lnk_abi_version`, exposed here so the `Backend` adapter can satisfy the
/// shared contract's `abiVersion` field.
#[napi]
pub fn abi_version() -> u32 {
    lenke_core::ffi::lnk_abi_version()
}
