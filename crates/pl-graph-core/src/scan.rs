//! Exclusive prefix-sum (scan): `out[i] = sum(in[0..i])`, `out[0] = 0`.
//!
//! This is the SIMD-acceleratable core of bulk index construction. Building a
//! CSR adjacency structure from an edge list is a counting sort: histogram the
//! per-vertex degree, **prefix-sum it into row offsets**, then scatter. The
//! histogram and scatter are gather/scatter-bound (hard to vectorize), but the
//! scan is pure data-parallel arithmetic — the part where SIMD earns its keep.

/// Scalar exclusive scan. Trivially auto-vectorizable in spirit, but the loop
/// carries a dependency (`acc`), so the compiler keeps it serial — which is
/// exactly what the SIMD version below breaks.
pub fn exclusive_scan_scalar(input: &[u32], out: &mut [u32]) {
    debug_assert_eq!(input.len(), out.len());
    let mut acc: u32 = 0;
    for i in 0..input.len() {
        out[i] = acc;
        acc = acc.wrapping_add(input[i]);
    }
}

/// The running total of `input` (i.e. what `out[len]` would be). Handy because
/// CSR offsets want an `n+1`-length array ending in the edge count.
pub fn total(input: &[u32]) -> u32 {
    input.iter().copied().fold(0u32, u32::wrapping_add)
}

#[cfg(target_arch = "aarch64")]
pub use neon::exclusive_scan_neon;

/// On non-aarch64, fall back to scalar so the crate stays portable.
#[cfg(not(target_arch = "aarch64"))]
pub fn exclusive_scan_neon(input: &[u32], out: &mut [u32]) {
    exclusive_scan_scalar(input, out);
}

#[cfg(target_arch = "aarch64")]
mod neon {
    use std::arch::aarch64::*;

    /// NEON exclusive scan over u32. Processes 4 lanes per iteration with a
    /// Hillis–Steele in-register inclusive scan, then shifts to exclusive and
    /// adds the running block carry. NEON is mandatory on aarch64 (ARMv8), so
    /// no `is_aarch64_feature_detected!` gate is needed.
    pub fn exclusive_scan_neon(input: &[u32], out: &mut [u32]) {
        debug_assert_eq!(input.len(), out.len());
        let n = input.len();
        let chunks = n / 4;
        // SAFETY: NEON is baseline on aarch64; all loads/stores below are
        // bounds-checked by the `chunks * 4` / tail split.
        unsafe {
            let zero = vdupq_n_u32(0);
            let mut carry: u32 = 0;
            for c in 0..chunks {
                let base = c * 4;
                let v0 = vld1q_u32(input.as_ptr().add(base));
                // Hillis–Steele inclusive scan within the 4-lane vector:
                //   v1 = v0 + (v0 << 1 lane)   -> [a, a+b, b+c, c+d]
                //   v2 = v1 + (v1 << 2 lanes)  -> [a, a+b, a+b+c, a+b+c+d]
                // "<< k lanes" (toward higher indices, zero-filled) is vext of
                // (zero, v) starting at lane 4-k.
                let v1 = vaddq_u32(v0, vextq_u32::<3>(zero, v0));
                let incl = vaddq_u32(v1, vextq_u32::<2>(zero, v1));
                // Exclusive within block = inclusive shifted up one lane.
                let excl = vextq_u32::<3>(zero, incl);
                // Add the carry from all previous blocks (broadcast).
                let res = vaddq_u32(excl, vdupq_n_u32(carry));
                vst1q_u32(out.as_mut_ptr().add(base), res);
                // Next carry = carry + this block's total (= inclusive lane 3).
                carry = carry.wrapping_add(vgetq_lane_u32::<3>(incl));
            }
            // Scalar tail for the remaining < 4 elements.
            for i in (chunks * 4)..n {
                *out.get_unchecked_mut(i) = carry;
                carry = carry.wrapping_add(*input.get_unchecked(i));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(input: &[u32]) -> Vec<u32> {
        let mut out = vec![0u32; input.len()];
        exclusive_scan_scalar(input, &mut out);
        out
    }

    #[test]
    fn neon_matches_scalar_across_lengths() {
        // Cover every tail remainder (0..3) and multi-block inputs.
        for len in [0usize, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 1000, 4096, 100_003] {
            let input: Vec<u32> =
                (0..len as u32).map(|i| i.wrapping_mul(2654435761).wrapping_rem(97) + 1).collect();
            let mut neon = vec![0u32; len];
            exclusive_scan_neon(&input, &mut neon);
            assert_eq!(neon, reference(&input), "mismatch at len={len}");
        }
    }
}
