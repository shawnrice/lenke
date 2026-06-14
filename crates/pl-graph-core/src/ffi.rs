//! C ABI for bun:ffi (and later wasm-bindgen). Two surfaces:
//!   * the raw CSR builder (`plg_build_csr`) from the index-build experiment, and
//!   * a stateful graph handle (`plg_graph_*`) that owns a decoded columnar
//!     graph so queries / encode run without re-marshalling the whole graph.
//!
//! Buffers passed in are caller-owned and read-only. Buffers handed back
//! (`plg_encode_ndjson`) are heap-allocated here and must be returned via
//! `plg_free_buf`. The graph handle must be returned via `plg_graph_free`.

use crate::graph::{Column, Graph};
use crate::{build_csr, gql, ndjson, query, scan, ScanKind};

// ---------- raw CSR builder (unchanged) ----------

/// # Safety
/// Pointers must be valid for their lengths and `u32`-aligned.
#[no_mangle]
pub unsafe extern "C" fn plg_build_csr(
    src: *const u32,
    dst: *const u32,
    e: usize,
    n: usize,
    out_offsets: *mut u32,
    out_neighbors: *mut u32,
    simd: u32,
) -> i32 {
    if src.is_null() || dst.is_null() || out_offsets.is_null() || out_neighbors.is_null() {
        return -1;
    }
    let src = std::slice::from_raw_parts(src, e);
    let dst = std::slice::from_raw_parts(dst, e);
    let kind = if simd != 0 { ScanKind::Neon } else { ScanKind::Scalar };
    let csr = build_csr(src, dst, n, kind);
    std::ptr::copy_nonoverlapping(csr.offsets.as_ptr(), out_offsets, n + 1);
    std::ptr::copy_nonoverlapping(csr.neighbors.as_ptr(), out_neighbors, e);
    0
}

#[no_mangle]
pub extern "C" fn plg_abi_version() -> u32 {
    4 // 4: added the Arrow columnar result surface (plg_query_arrow/plg_free_arrow)
}

// ---------- stateful columnar graph ----------

/// Decode NDJSON bytes into a graph and return an owning handle.
///
/// # Safety
/// `ptr`/`len` must describe valid UTF-8 NDJSON. Returns null on bad UTF-8.
#[no_mangle]
pub unsafe extern "C" fn plg_graph_from_ndjson(ptr: *const u8, len: usize, parallel: u32) -> *mut Graph {
    if ptr.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return std::ptr::null_mut(),
    };
    let g = if parallel != 0 { ndjson::decode(text) } else { ndjson::decode_serial(text) };
    Box::into_raw(Box::new(g))
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
#[no_mangle]
pub unsafe extern "C" fn plg_query_rows(
    g: *mut Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if g.is_null() || q_ptr.is_null() {
        return std::ptr::null_mut();
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    // Route to the full GQL engine (the complete ISO-subset port). Returns null
    // on a parse error or an unsupported clause.
    let parsed = match gql::parse(q) {
        Ok(p) => p,
        Err(_) => return std::ptr::null_mut(),
    };
    let rowset = match parsed.execute(&mut *g, &gql::eval::Params::new()) {
        Ok(rs) => rs,
        Err(_) => return std::ptr::null_mut(),
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
#[no_mangle]
pub unsafe extern "C" fn plg_query_arrow(
    g: *mut Graph,
    q_ptr: *const u8,
    q_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if g.is_null() || q_ptr.is_null() {
        return std::ptr::null_mut();
    }
    let q = match std::str::from_utf8(std::slice::from_raw_parts(q_ptr, q_len)) {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let parsed = match gql::parse(q) {
        Ok(p) => p,
        Err(_) => return std::ptr::null_mut(),
    };
    // execute_arrow keeps numeric/bool result columns typed end-to-end (no
    // Val/Value boxing) for the common single-MATCH … RETURN shape.
    let blob = match parsed.execute_arrow(&mut *g, &gql::eval::Params::new()) {
        Ok(b) => b,
        Err(_) => return std::ptr::null_mut(),
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
#[no_mangle]
pub unsafe extern "C" fn plg_free_arrow(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        let len = len.max(1);
        std::alloc::dealloc(ptr, std::alloc::Layout::from_size_align(len, 8).unwrap());
    }
}

/// SIMD (or scalar) predicate scan `key > threshold` over a numeric column.
/// Returns -1 if the key isn't a numeric column.
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
#[no_mangle]
pub unsafe extern "C" fn plg_encode_ndjson(g: *const Graph, out_len: *mut usize) -> *mut u8 {
    if g.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = ndjson::encode(&*g).into_bytes().into_boxed_slice();
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
#[no_mangle]
pub unsafe extern "C" fn plg_write_ndjson(g: *const Graph, path_ptr: *const u8, path_len: usize) -> i64 {
    if g.is_null() || path_ptr.is_null() {
        return -1;
    }
    let path = match std::str::from_utf8(std::slice::from_raw_parts(path_ptr, path_len)) {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let bytes = ndjson::encode(&*g).into_bytes();
    match std::fs::write(path, &bytes) {
        Ok(()) => bytes.len() as i64,
        Err(_) => -1,
    }
}
