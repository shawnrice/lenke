//! SIMD predicate-scan kernel: count + sum of a contiguous `f64` column where
//! `value > thr`, vectorized on aarch64 (NEON) with a scalar fallback elsewhere.
//!
//! BENCHMARK / MEASUREMENT SURFACE — not on the product query path. The GQL
//! engine's `WHERE` filter runs through the vectorized expression interpreter
//! (`gql::eval`), which handles arbitrary predicate trees and three-valued null
//! logic; it never calls this kernel. This exists to measure raw SIMD-vs-scalar
//! throughput over the graph's real numeric columns — exercised via the
//! `plg_predicate_scan` FFI export and `benchmarks/compare.ts`. The
//! `eval_vs_columnar` example contrasts this hand-kernel floor against the
//! interpreter the product actually uses.
//!
//! Absent values are stored as NaN, and `NaN > thr` is false, so the presence
//! bitmap need not be consulted here.

pub fn predicate_gt_scalar(data: &[f64], thr: f64) -> (u64, f64) {
    let mut count = 0u64;
    let mut sum = 0.0f64;
    for &x in data {
        if x > thr {
            count += 1;
            sum += x;
        }
    }
    (count, sum)
}

#[cfg(target_arch = "aarch64")]
pub fn predicate_gt_neon(data: &[f64], thr: f64) -> (u64, f64) {
    use std::arch::aarch64::*;
    let n = data.len();
    let chunks = n / 2;
    // SAFETY: NEON is baseline on aarch64; loads bounded by chunks*2 + scalar tail.
    unsafe {
        let thrv = vdupq_n_f64(thr);
        let mut sumv = vdupq_n_f64(0.0);
        let mut cntv = vdupq_n_u64(0);
        for c in 0..chunks {
            let v = vld1q_f64(data.as_ptr().add(c * 2));
            let mask = vcgtq_f64(v, thrv); // all-ones lane where v > thr
                                           // masked value (0.0 where predicate false) added to running sum
            let masked = vreinterpretq_f64_u64(vandq_u64(vreinterpretq_u64_f64(v), mask));
            sumv = vaddq_f64(sumv, masked);
            // mask lane is 0xFFFF.. (== u64 max); >>63 gives 1 per true lane
            cntv = vaddq_u64(cntv, vshrq_n_u64::<63>(mask));
        }
        let mut count = vaddvq_u64(cntv);
        let mut sum = vaddvq_f64(sumv);
        for &x in &data[chunks * 2..] {
            if x > thr {
                count += 1;
                sum += x;
            }
        }
        (count, sum)
    }
}

#[cfg(not(target_arch = "aarch64"))]
pub fn predicate_gt_neon(data: &[f64], thr: f64) -> (u64, f64) {
    predicate_gt_scalar(data, thr)
}

#[cfg(test)]
mod predicate_tests {
    use super::*;

    #[test]
    fn neon_predicate_matches_scalar() {
        for len in [0usize, 1, 2, 3, 7, 8, 1000, 4097] {
            let data: Vec<f64> = (0..len).map(|i| (i as f64 * 1.5) % 100.0).collect();
            let (cs, ss) = predicate_gt_scalar(&data, 50.0);
            let (cn, sn) = predicate_gt_neon(&data, 50.0);
            assert_eq!(cs, cn, "count mismatch len={len}");
            assert!((ss - sn).abs() < 1e-6, "sum mismatch len={len}");
        }
    }
}
