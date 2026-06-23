//! C ABI for bun:ffi (and later wasm-bindgen). Exposes a stateful graph handle
//! (`plg_graph_*`) that owns a decoded columnar graph, so queries / encode run
//! without re-marshalling the whole graph on each call.
//!
//! Buffers passed in are caller-owned and read-only. Buffers handed back
//! (`plg_encode_ndjson`) are heap-allocated here and must be returned via
//! `plg_free_buf`. The graph handle must be returned via `plg_graph_free`.

#[cfg(feature = "_fallible-ffi")]
use crate::error_codes::ErrorCode;
use crate::graph::{Column, Graph};
use crate::{query, scan};

#[no_mangle]
pub extern "C" fn plg_abi_version() -> u32 {
    8 // 8: reactive change tracking (plg_graph_version/plg_graph_epoch); 7: codecs
      //    (plg_serialize/plg_deserialize); 6: inbound allocator; 5: Gremlin; 4: Arrow
}

// ---------- inbound allocator (wasm linear memory) ----------
//
// Over bun:ffi, JS hands us a pointer to a JS-owned buffer and we read it in
// place. In a browser there is only wasm linear memory: JS cannot point at its
// own heap, it must first copy bytes *into* the module's memory. These two
// exports are that inbound path — JS calls `plg_alloc(len)`, writes the query /
// NDJSON bytes into the returned offset, then passes (ptr, len) to any `plg_*`
// symbol exactly as the native binding does. They are the inverse of
// `plg_free_buf` (which frees buffers we hand *out*); same one-ABI-two-backends
// design. Harmless on native, so unconditionally exported.

/// Allocate `len` bytes inside the module and return a pointer the caller fills.
/// Free it with `plg_dealloc(ptr, len)` (or pass ownership to a `plg_*` call
/// that consumes it). Returns null for `len == 0`.
#[no_mangle]
pub extern "C" fn plg_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free a buffer obtained from `plg_alloc`. `len` must be the same value passed
/// to `plg_alloc`.
///
/// # Safety
/// `ptr`/`len` must come from a prior `plg_alloc` call and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn plg_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

// ---------- stateful columnar graph ----------

/// Decode NDJSON bytes into a graph and return an owning handle.
///
/// # Safety
/// `ptr`/`len` must describe valid UTF-8 NDJSON. Returns null on bad UTF-8.
#[cfg(feature = "ndjson")]
#[no_mangle]
pub unsafe extern "C" fn plg_graph_from_ndjson(
    ptr: *const u8,
    len: usize,
    parallel: u32,
) -> *mut Graph {
    crate::ffi_error::begin();
    if ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null NDJSON pointer");
        return std::ptr::null_mut();
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "NDJSON bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    let decoded = if parallel != 0 {
        crate::ndjson::decode(text)
    } else {
        crate::ndjson::decode_serial(text)
    };
    match decoded {
        Ok(g) => Box::into_raw(Box::new(g)),
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `g` must be a handle from `plg_graph_from_ndjson` (or null).
#[no_mangle]
pub unsafe extern "C" fn plg_graph_free(g: *mut Graph) {
    if !g.is_null() {
        drop(Box::from_raw(g));
    }
}

/// # Safety
/// `g` must be a valid graph handle.
#[no_mangle]
pub unsafe extern "C" fn plg_graph_vertex_count(g: *const Graph) -> u64 {
    if g.is_null() {
        return 0;
    }
    (*g).vertex_count() as u64
}

/// # Safety
/// `g` must be a valid graph handle.
#[no_mangle]
pub unsafe extern "C" fn plg_graph_edge_count(g: *const Graph) -> u64 {
    if g.is_null() {
        return 0;
    }
    (*g).edge_count() as u64
}

/// The graph's monotonic mutation version — an O(1) "did anything change?" read
/// for `useSyncExternalStore`-style snapshots. Always available (mutation is
/// core), so a minimal frontend build still gets reactive snapshots.
///
/// # Safety
/// `g` must be a valid graph handle.
#[no_mangle]
pub unsafe extern "C" fn plg_graph_version(g: *const Graph) -> u64 {
    if g.is_null() {
        return 0;
    }
    (*g).version()
}

/// The per-token change epoch for a label / edge-type / property-key `name`
/// (0 if never touched) — used for finer invalidation than the global version.
///
/// # Safety
/// `g` valid; `name_ptr`/`name_len` valid UTF-8.
#[no_mangle]
pub unsafe extern "C" fn plg_graph_epoch(
    g: *const Graph,
    name_ptr: *const u8,
    name_len: usize,
) -> u64 {
    if g.is_null() || name_ptr.is_null() {
        return 0;
    }
    match std::str::from_utf8(std::slice::from_raw_parts(name_ptr, name_len)) {
        Ok(name) => (*g).epoch(name),
        Err(_) => 0,
    }
}

/// Parse + run a GQL-subset query, writing the `(count, sum)` signature.
/// Returns 0 on success, -1 on a parse/null error.
///
/// # Safety
/// `g` valid; `q_ptr`/`q_len` valid UTF-8; out pointers writable.
#[no_mangle]
pub unsafe extern "C" fn plg_query(
    g: *const Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_count: *mut u64,
    out_sum: *mut f64,
    out_checksum: *mut u64,
) -> i32 {
    if g.is_null() || q_ptr.is_null() {
        return -1;
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let parsed = match query::parse(q) {
        Ok(p) => p,
        Err(_) => return -1,
    };
    let r = parsed.run(&*g);
    *out_count = r.count;
    *out_sum = r.sum;
    *out_checksum = r.checksum;
    0
}

/// Run many queries (newline-joined) in ONE crossing — amortizes the per-call
/// FFI tax. Results are written into the caller's `count`/`sum`/`checksum`
/// arrays (each sized to the query count). Returns the number run, or -1.
///
/// # Safety
/// `g` valid; `q_ptr`/`q_len` valid UTF-8; out arrays sized to the number of
/// newline-separated queries.
#[no_mangle]
pub unsafe extern "C" fn plg_query_batch(
    g: *const Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_count: *mut u64,
    out_sum: *mut f64,
    out_checksum: *mut u64,
) -> i64 {
    if g.is_null() || q_ptr.is_null() {
        return -1;
    }
    let text = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let g = &*g;
    let mut i = 0isize;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let r = match query::parse(line) {
            Ok(p) => p.run(g),
            Err(_) => return -1,
        };
        *out_count.offset(i) = r.count;
        *out_sum.offset(i) = r.sum;
        *out_checksum.offset(i) = r.checksum;
        i += 1;
    }
    i as i64
}

/// Parse + run a query and return the *real* result rows as a JSON document
/// (`{"columns":[...],"rows":[[...]]}`). The buffer is heap-allocated here;
/// the caller must return it via `plg_free_buf` with the written length. The
/// byte length is written to `out_len`. Returns null on a parse/null/UTF-8
/// error (and leaves `out_len` untouched).
///
/// This is the row-returning counterpart to `plg_query` (which only yields the
/// `(count, sum, checksum)` benchmark fingerprint). JSON is the carrier so the
/// same symbol serves both bun:ffi and a future wasm-bindgen binding with one
/// buffer crossing instead of per-cell marshalling. The graph handle is `*mut`
/// because a query may mutate it (`INSERT`/`SET`/`REMOVE`/`DELETE`).
///
/// # Safety
/// `g` valid and exclusively borrowed for this call; `q_ptr`/`q_len` valid
/// UTF-8; `out_len` writable.
#[cfg(feature = "gql")]
#[no_mangle]
pub unsafe extern "C" fn plg_query_rows(
    g: *mut Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    crate::ffi_error::begin();
    if g.is_null() || q_ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null graph or query pointer");
        return std::ptr::null_mut();
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "query bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    // Route to the full GQL engine (the complete ISO-subset port). A parse
    // failure carries its source offset; an execution failure (an unsupported
    // clause in this partial engine) carries the engine's message.
    let parsed = match crate::gql::parse(q) {
        Ok(p) => p,
        Err(e) => {
            crate::ffi_error::set(
                ErrorCode::Syntax,
                &e.message,
                &format!("{{\"pos\":{}}}", e.pos),
            );
            return std::ptr::null_mut();
        }
    };
    let rowset = match parsed.execute(&mut *g, &crate::gql::eval::Params::new()) {
        Ok(rs) => rs,
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            return std::ptr::null_mut();
        }
    };
    let bytes = rowset.to_json().into_bytes().into_boxed_slice();
    *out_len = bytes.len();
    Box::into_raw(bytes) as *mut u8
}

/// Parse + run a query and return the result as an **Apache Arrow** columnar
/// blob (see [`crate::arrow`]) instead of JSON. The buffer is heap-allocated here
/// **8-byte aligned** (so the caller's `Float64Array`/`Int32Array` views over the
/// column buffers are valid) and must be returned via `plg_free_arrow` with the
/// written length. The byte length is written to `out_len`. Returns null on a
/// parse / null / UTF-8 error (and leaves `out_len` untouched).
///
/// The columnar carrier is zero-copy on the caller side: a query result is
/// single-owner and consume-once, so the caller views the Arrow buffers in place
/// (browser: `apache-arrow` `makeData`; server: bun:ffi typed-array over the
/// pointer) — no serialize here, no parse there.
///
/// # Safety
/// `g` valid and exclusively borrowed for this call; `q_ptr`/`q_len` valid
/// UTF-8; `out_len` writable.
#[cfg(feature = "arrow")]
#[no_mangle]
pub unsafe extern "C" fn plg_query_arrow(
    g: *mut Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    crate::ffi_error::begin();
    if g.is_null() || q_ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null graph or query pointer");
        return std::ptr::null_mut();
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "query bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    // The error rides the last-error channel, never this return pointer — so the
    // binary Arrow carrier below stays a pure column blob with no error union.
    let parsed = match crate::gql::parse(q) {
        Ok(p) => p,
        Err(e) => {
            crate::ffi_error::set(
                ErrorCode::Syntax,
                &e.message,
                &format!("{{\"pos\":{}}}", e.pos),
            );
            return std::ptr::null_mut();
        }
    };
    // execute_arrow keeps numeric/bool result columns typed end-to-end (no
    // Val/Value boxing) for the common single-MATCH … RETURN shape.
    let blob = match parsed.execute_arrow(&mut *g, &crate::gql::eval::Params::new()) {
        Ok(b) => b,
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            return std::ptr::null_mut();
        }
    };
    *out_len = blob.len();
    // 8-byte-aligned copy so the caller can view f64/i32 column buffers directly.
    let len = blob.len().max(1);
    let layout = std::alloc::Layout::from_size_align(len, 8).unwrap();
    let p = std::alloc::alloc(layout);
    if !p.is_null() {
        std::ptr::copy_nonoverlapping(blob.as_ptr(), p, blob.len());
    }
    p
}

/// Free a buffer returned by `plg_query_arrow`. Must use the same `len` that was
/// written to `out_len` (the allocation is 8-byte aligned).
///
/// # Safety
/// `ptr`/`len` must come from `plg_query_arrow`.
#[cfg(feature = "arrow")]
#[no_mangle]
pub unsafe extern "C" fn plg_free_arrow(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        let len = len.max(1);
        std::alloc::dealloc(ptr, std::alloc::Layout::from_size_align(len, 8).unwrap());
    }
}

/// Parse + run a **textual Gremlin** query (the Groovy wire form, e.g.
/// `g.V().has('name','marko').out('knows').values('name')`) and return the
/// results as a JSON array. Heap-allocated; free with `plg_free_buf`. Byte length
/// written to `out_len`. Null on a parse/UTF-8 error (and `out_len` untouched).
///
/// JSON (not Arrow) because Gremlin results are heterogeneous per row — a stream
/// of mixed scalars / elements / maps — which doesn't fit a columnar carrier.
///
/// # Safety
/// `g` valid and exclusively borrowed; `q_ptr`/`q_len` valid UTF-8; `out_len` writable.
#[cfg(feature = "gremlin")]
#[no_mangle]
pub unsafe extern "C" fn plg_gremlin_json(
    g: *mut Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    crate::ffi_error::begin();
    if g.is_null() || q_ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null graph or query pointer");
        return std::ptr::null_mut();
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "query bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    let plan = match crate::gremlin::parse(q) {
        Ok(p) => p,
        Err(e) => {
            crate::ffi_error::set_code(ErrorCode::Syntax, &e);
            return std::ptr::null_mut();
        }
    };
    let vals = match crate::gremlin::try_run(&mut *g, &plan) {
        Ok(v) => v,
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            return std::ptr::null_mut();
        }
    };
    let bytes = crate::gremlin::exec::results_to_json(&*g, &vals)
        .into_bytes()
        .into_boxed_slice();
    *out_len = bytes.len();
    Box::into_raw(bytes) as *mut u8
}

/// Serialize the graph in a named format — `pg-json | pg-text | graphson | csv |
/// ndjson` (see [`crate::codec`]). Returns a heap buffer (free with
/// `plg_free_buf`) and writes its byte length to `out_len`. Null on an unknown
/// format / null / UTF-8 error.
///
/// # Safety
/// `g` valid; `fmt_ptr`/`fmt_len` valid UTF-8; `out_len` writable.
#[cfg(feature = "codecs")]
#[no_mangle]
pub unsafe extern "C" fn plg_serialize(
    g: *const Graph,
    fmt_ptr: *const u8,
    fmt_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    crate::ffi_error::begin();
    if g.is_null() || fmt_ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null graph or format pointer");
        return std::ptr::null_mut();
    }
    let fmt = match std::str::from_utf8(std::slice::from_raw_parts(fmt_ptr, fmt_len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "format bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    match crate::codec::serialize(&*g, fmt) {
        Ok(s) => {
            let bytes = s.into_bytes().into_boxed_slice();
            *out_len = bytes.len();
            Box::into_raw(bytes) as *mut u8
        }
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            std::ptr::null_mut()
        }
    }
}

/// Deserialize bytes in a named format into a fresh graph handle (free with
/// `plg_graph_free`). The format name is the same set as `plg_serialize`. Null on
/// an unknown format, a parse error, or bad UTF-8.
///
/// # Safety
/// `ptr`/`len` valid UTF-8; `fmt_ptr`/`fmt_len` valid UTF-8.
#[cfg(feature = "codecs")]
#[no_mangle]
pub unsafe extern "C" fn plg_deserialize(
    ptr: *const u8,
    len: usize,
    fmt_ptr: *const u8,
    fmt_len: usize,
) -> *mut Graph {
    crate::ffi_error::begin();
    if ptr.is_null() || fmt_ptr.is_null() {
        crate::ffi_error::set_code(ErrorCode::Ffi, "null input or format pointer");
        return std::ptr::null_mut();
    }
    let text = match std::str::from_utf8(std::slice::from_raw_parts(ptr, len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "input bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    let fmt = match std::str::from_utf8(std::slice::from_raw_parts(fmt_ptr, fmt_len)) {
        Ok(s) => s,
        Err(_) => {
            crate::ffi_error::set_code(ErrorCode::Ffi, "format bytes are not valid UTF-8");
            return std::ptr::null_mut();
        }
    };
    match crate::codec::deserialize(text, fmt) {
        Ok(g) => Box::into_raw(Box::new(g)),
        // The codec now carries a precise code (UnknownFormat / InvalidJson /
        // InvalidShape / …); surface it directly — no message-matching heuristic.
        Err(e) => {
            crate::ffi_error::set_code(e.code, &e.message);
            std::ptr::null_mut()
        }
    }
}

/// SIMD (or scalar) predicate scan `key > threshold` over a numeric column.
/// Returns -1 if the key isn't a numeric column.
///
/// BENCHMARK SURFACE: this exposes the `scan` microbenchmark kernel for
/// `benchmarks/compare.ts` (SIMD-vs-scalar over a real column). The product
/// query path does NOT use it — GQL `WHERE` vectorizes via `gql::eval`.
///
/// # Safety
/// `g` valid; `key_ptr`/`key_len` valid UTF-8; out pointers writable.
#[no_mangle]
pub unsafe extern "C" fn plg_predicate_scan(
    g: *const Graph,
    key_ptr: *const u8,
    key_len: usize,
    threshold: f64,
    simd: u32,
    out_count: *mut u64,
    out_sum: *mut f64,
) -> i32 {
    if g.is_null() || key_ptr.is_null() {
        return -1;
    }
    let g = &*g;
    let key = match std::str::from_utf8(std::slice::from_raw_parts(key_ptr, key_len)) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    match g.props.col(key) {
        Some(Column::Num { data, .. }) => {
            let (c, s) = if simd != 0 {
                scan::predicate_gt_neon(data, threshold)
            } else {
                scan::predicate_gt_scalar(data, threshold)
            };
            *out_count = c;
            *out_sum = s;
            0
        }
        _ => -1,
    }
}

/// Encode the graph to NDJSON. Returns a heap pointer (free with `plg_free_buf`)
/// and writes the byte length to `out_len`.
///
/// # Safety
/// `g` valid; `out_len` writable.
#[cfg(feature = "ndjson")]
#[no_mangle]
pub unsafe extern "C" fn plg_encode_ndjson(g: *const Graph, out_len: *mut usize) -> *mut u8 {
    if g.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = crate::ndjson::encode(&*g).into_bytes().into_boxed_slice();
    *out_len = bytes.len();
    Box::into_raw(bytes) as *mut u8
}

/// # Safety
/// `ptr`/`len` must come from `plg_encode_ndjson`.
#[no_mangle]
pub unsafe extern "C" fn plg_free_buf(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

/// Serialize the graph and write it straight to a file — the realistic
/// "serialize to disk" path: the bytes never cross back into JS as a string.
/// Returns the number of bytes written, or -1 on error.
///
/// # Safety
/// `g` valid; `path_ptr`/`path_len` valid UTF-8.
///
/// Native-only: there is no filesystem in the browser, so this symbol is absent
/// from the wasm build. Browser callers serialize via `plg_encode_ndjson` and
/// persist through the host (download, IndexedDB, …) instead.
#[cfg(all(feature = "ndjson", not(target_arch = "wasm32")))]
#[no_mangle]
pub unsafe extern "C" fn plg_write_ndjson(
    g: *const Graph,
    path_ptr: *const u8,
    path_len: usize,
) -> i64 {
    if g.is_null() || path_ptr.is_null() {
        return -1;
    }
    let path = match std::str::from_utf8(std::slice::from_raw_parts(path_ptr, path_len)) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let bytes = crate::ndjson::encode(&*g).into_bytes();
    match std::fs::write(path, &bytes) {
        Ok(()) => bytes.len() as i64,
        Err(_) => -1,
    }
}
