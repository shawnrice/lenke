//! C ABI for bun:ffi (and, later, the same surface under wasm-bindgen).
//!
//! Buffers are caller-owned: JS allocates the typed arrays, passes pointers,
//! and reads the results back out. No allocation crosses the boundary, so there
//! is nothing to free and no ownership ambiguity — the simplest contract that
//! still moves bulk data at native speed.

use crate::{build_csr, ScanKind};

/// Build out-edge CSR.
///
/// Inputs: `src`/`dst` are `e`-length u32 edge endpoints over `n` vertices.
/// Outputs (caller-allocated): `out_offsets` is `n + 1` u32s, `out_neighbors`
/// is `e` u32s. `simd != 0` selects the NEON scan. Returns 0 on success.
///
/// # Safety
/// All pointers must be valid for their stated lengths and properly aligned
/// for `u32`. `src`/`dst` are read-only; the out buffers are written fully.
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

/// Version probe so the JS side can confirm it loaded the right library.
#[no_mangle]
pub extern "C" fn plg_abi_version() -> u32 {
    1
}
