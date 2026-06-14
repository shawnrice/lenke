//! Experimental columnar LPG core, focused on bulk-index-build throughput.
//!
//! The TS core stores edges as objects and indexes them in nested hash maps
//! (`Map<id, Map<label, Set<Edge>>>`). That's flexible but scatter-heavy and
//! pointer-chasing. Here ids are dense `u32`s and adjacency is a **CSR**
//! (compressed sparse row): a per-vertex `offsets` array into one flat,
//! contiguous `neighbors` array. Building it is a counting sort whose prefix-sum
//! step is SIMD-accelerated (see `scan`).
//!
//! This is the binding-agnostic crate; `ffi` exposes a C ABI for bun:ffi (and
//! later wasm-bindgen) over the same functions.

pub mod arrow;
pub mod ffi;
pub mod gql;
pub mod gremlin;
pub mod graph;
pub mod ndjson;
pub mod query;
pub mod scan;

/// CSR adjacency: `neighbors[offsets[v] .. offsets[v + 1]]` are v's out-edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Csr {
    /// Length `n + 1`. `offsets[v]` is where v's neighbor block starts;
    /// `offsets[n]` is the edge count.
    pub offsets: Vec<u32>,
    /// Length `E`. Destination vertex of each edge, grouped by source.
    pub neighbors: Vec<u32>,
}

/// Which prefix-sum implementation to use for the offsets — lets the bench
/// isolate the SIMD kernel's contribution to the whole build.
#[derive(Clone, Copy)]
pub enum ScanKind {
    Scalar,
    Neon,
}

/// Build out-edge CSR from a `(src, dst)` edge list over `n` vertices.
///
/// Three phases: (1) degree histogram, (2) prefix-sum → offsets, (3) scatter
/// destinations into their source's block. Only phase 2 is SIMD; phases 1 and 3
/// are scatter-bound and stay scalar — which is the honest story of how much
/// SIMD moves a memory-bound build.
pub fn build_csr(src: &[u32], dst: &[u32], n: usize, kind: ScanKind) -> Csr {
    assert_eq!(src.len(), dst.len(), "src/dst length mismatch");
    let e = src.len();

    // (1) Degree histogram.
    let mut degree = vec![0u32; n];
    for &s in src {
        degree[s as usize] += 1;
    }

    // (2) Exclusive prefix-sum into offsets (length n + 1, ending in E).
    let mut offsets = vec![0u32; n + 1];
    let (head, _tail) = offsets.split_at_mut(n);
    match kind {
        ScanKind::Scalar => scan::exclusive_scan_scalar(&degree, head),
        ScanKind::Neon => scan::exclusive_scan_neon(&degree, head),
    }
    offsets[n] = e as u32;

    // (3) Scatter: place each edge's dst at its source's running cursor.
    let mut cursor = offsets.clone();
    let mut neighbors = vec![0u32; e];
    for i in 0..e {
        let s = src[i] as usize;
        let pos = cursor[s] as usize;
        neighbors[pos] = dst[i];
        cursor[s] += 1;
    }

    Csr { offsets, neighbors }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csr_groups_edges_by_source() {
        // 0->1, 0->2, 2->0, 1->2  over 3 vertices
        let src = [0u32, 0, 2, 1];
        let dst = [1u32, 2, 0, 2];
        let csr = build_csr(&src, &dst, 3, ScanKind::Scalar);
        assert_eq!(csr.offsets, vec![0, 2, 3, 4]); // v0:2 edges, v1:1, v2:1
        assert_eq!(&csr.neighbors[0..2], &[1, 2]); // v0 -> {1,2}
        assert_eq!(&csr.neighbors[2..3], &[2]); // v1 -> {2}
        assert_eq!(&csr.neighbors[3..4], &[0]); // v2 -> {0}
    }

    #[test]
    fn scalar_and_neon_builds_agree() {
        let n = 5000usize;
        let mut s = 2_463_534_242u32; // xorshift
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            s
        };
        let e = 50_000;
        let src: Vec<u32> = (0..e).map(|_| next() % n as u32).collect();
        let dst: Vec<u32> = (0..e).map(|_| next() % n as u32).collect();
        let a = build_csr(&src, &dst, n, ScanKind::Scalar);
        let b = build_csr(&src, &dst, n, ScanKind::Neon);
        assert_eq!(a, b);
    }
}
