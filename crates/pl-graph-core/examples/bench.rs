//! Throughput bench: SIMD vs scalar exclusive-scan, and full CSR build.
//! Run with: cargo run --release --example bench

use pl_graph_core::scan::{exclusive_scan_neon, exclusive_scan_scalar};
use pl_graph_core::{build_csr, ScanKind};
use std::hint::black_box;
use std::time::Instant;

/// best-of-N wall time, in milliseconds.
fn bench<F: FnMut()>(reps: usize, mut f: F) -> f64 {
    // warm up
    f();
    let mut best = f64::INFINITY;
    for _ in 0..reps {
        let t = Instant::now();
        f();
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    best
}

fn xorshift(seed: &mut u32) -> u32 {
    let mut s = *seed;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    *seed = s;
    s
}

fn main() {
    let n: usize = 1_000_000; // vertices
    let e: usize = 4_000_000; // edges (avg degree 4)

    let mut seed = 0x1234_5678u32;
    let src: Vec<u32> = (0..e).map(|_| xorshift(&mut seed) % n as u32).collect();
    let dst: Vec<u32> = (0..e).map(|_| xorshift(&mut seed) % n as u32).collect();

    println!("graph: {n} vertices, {e} edges\n");

    // ---- 1. Standalone scan kernel (degree histogram -> offsets) ----
    let mut degree = vec![0u32; n];
    for &s in &src {
        degree[s as usize] += 1;
    }
    let mut out = vec![0u32; n];

    // black_box the input and output so the calls can't be optimized away.
    let scalar = bench(50, || {
        exclusive_scan_scalar(black_box(&degree), &mut out);
        black_box(out.as_ptr());
    });
    let neon = bench(50, || {
        exclusive_scan_neon(black_box(&degree), &mut out);
        black_box(out.as_ptr());
    });
    let elems_per_ms = n as f64;
    println!("exclusive-scan over {n} u32:");
    println!(
        "  scalar: {scalar:.3} ms  ({:.0} M elem/s)",
        elems_per_ms / scalar / 1e3
    );
    println!(
        "  neon:   {neon:.3} ms  ({:.0} M elem/s)",
        elems_per_ms / neon / 1e3
    );
    println!("  speedup: {:.2}x\n", scalar / neon);

    // ---- 2. Full CSR build (histogram + scan + scatter) ----
    let build_scalar = bench(10, || {
        let _ = build_csr(&src, &dst, n, ScanKind::Scalar);
    });
    let build_neon = bench(10, || {
        let _ = build_csr(&src, &dst, n, ScanKind::Neon);
    });
    println!("full CSR build ({e} edges):");
    println!(
        "  scalar scan: {build_scalar:.3} ms  ({:.0} M edge/s)",
        e as f64 / build_scalar / 1e3
    );
    println!(
        "  neon scan:   {build_neon:.3} ms  ({:.0} M edge/s)",
        e as f64 / build_neon / 1e3
    );
    println!("  whole-build speedup: {:.2}x", build_scalar / build_neon);
    println!("  (scan is one of 3 phases; histogram + scatter are scatter-bound and stay scalar)");
}
