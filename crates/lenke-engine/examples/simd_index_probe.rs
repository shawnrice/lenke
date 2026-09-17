//! Probe: where do SIMD tricks actually buy speed over a bitmap index — and can we
//! SHAPE the data so the index needs to scan less of itself?
//!
//! Follows `bitmap_layout_probe`, which established that a bit-sliced index (BSI)
//! and a recursive frequency encoding (RFE) beat a dense scan by 4-8x and 20-123x
//! respectively, and that both auto-vectorize to ymm without intrinsics. The open
//! questions this one attacks, in order:
//!
//!   1. Do hand-written AVX2 intrinsics beat the auto-vectorized loop at all?
//!   2. Can the BSI circuit EXIT EARLY once no row is still tied?
//!   3. Does reordering dictionary codes BY FREQUENCY concentrate the entropy in
//!      low slices, making the high ones skippable? ("skew the skew")
//!   4. Can per-block emptiness flags skip slices without reading them?
//!   5. Is the win in the index at all, or in ANDing several predicates together?
//!
//! Native x86-64. Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example simd_index_probe
//!
//! ═══ 24 EXPERIMENTS, 1M rows, min-of-N, release, x86-64-v3 ═══
//!
//! Compare only columns measured SIDE BY SIDE in one table: the same call measured
//! 67.7us in one section and 40.2us in another of the same process (allocator
//! warm-up and turbo ramp), so cross-section comparisons here mean nothing.
//!
//! WHAT WORKED
//!
//! ```text
//! E8/E12/E17  conjunction over a BROAD predicate       masks 79.9us vs seed+filter 1086us
//!               … with ids materialized on both sides   192.6us vs 1096us      5.7x
//!               … crossover: bitmaps lose below ~2% leading selectivity
//! E15         three predicates ANDed                    7.9x -> 14.6x -> 10.8x
//! E9/E24      COUNT — the mask IS the answer            1.79us; 0.02us from block counts
//! E6/E13      block skipping on a clustered column      up to 6.1x
//! E18         equality from a ready-made value bitmap   1.6x inside a conjunction
//! E21         partial clustering, 25/50/75/100%         1.1x / 1.2x / 1.4x / 1.7x
//! ```
//!
//! WHAT DID NOT — each of these is a rejected optimization, kept so it is not
//! re-attempted:
//!
//! ```text
//! E1   hand-written AVX2 intrinsics      67.7 vs 71.1us — LLVM already emits the same
//! E2   early exit on an all-zero `eq`    68.6 vs 67.7us — the tie-check costs the pass it saves
//! E3   early exit accumulated for free   68.8 vs 67.7us — the accumulator breaks vectorization
//! E4   frequency-ordered codes           high-slice density 2.51% -> 1.96%; nothing
//! E5   per-block emptiness, scattered    0 of 192 blocks empty; never fires
//! E11  sparse slices as (index, word)    128% of dense SIZE and 2x slower
//! E23  block-wise conjunction            0.5-0.6x — slower at every selectivity
//! ```
//!
//! ═══ WHAT THE CAMPAIGN ACTUALLY FOUND ═══
//!
//! **1. SIMD is not the lever; it is already pulled.** E1 settles it: hand-written
//! AVX2 matches the auto-vectorized loop to within noise, because at
//! `target-cpu=x86-64-v3` LLVM compiles `for (o, s) in a.iter_mut().zip(b)` over
//! `u64` slices straight to `vandps`/`vorps`/`vandnps` on ymm. There is no SIMD
//! trick left to add. The wins below are algorithmic, and they are large.
//!
//! **2. Every skipping idea needs CLUSTERING, and scattered data defeats all of
//! them.** E5, E10 and E23 fail identically: rare values, or surviving rows, spread
//! across every block, so no block can be skipped. E13 shows the cliff is the RATIO
//! of run length to block size — and the block size is ours to choose. 16,384-row
//! blocks are the balance point: up to 5.4x when runs match, only +6% when they
//! never do (1,024-row blocks cost +72% for the same insurance). E21 shows partial
//! clustering degrades gracefully rather than falling off a cliff, and E22 prices
//! the fix: sorting 1M rows is 3.5ms, i.e. ~91 scans to amortize.
//!
//! **3. "Skewing the skew" means reordering ROWS, not relabelling VALUES.** E4
//! recoded values by frequency and moved almost nothing, because the tail of a real
//! distribution is flat — ranking arbitrary values arbitrarily concentrates nothing.
//! What concentrates entropy is co-locating the rows that share a value. A graph
//! store cannot reorder dense node ids (they are stable for the life of the store),
//! so the lever is INSERTION ORDER: an import that groups by a hot filter column
//! buys the clustering for free, and E21 says even 25% of it pays.
//!
//! **4. The win is in conjunctions and counts, NOT in object indices.** A point
//! lookup is already served by the hash index. What bitmaps own is (a) ANDing
//! several predicates — 5.7x end-to-end, 13.5x before materialization, compounding
//! to three predicates — and (b) questions whose answer IS the mask: COUNT, EXISTS,
//! aggregates. E20 is the constraint on everything else: finding 539k rows costs
//! 40us, DELIVERING them costs 288us, and the fused version (no `Vec`) still costs
//! 253us because the price is per set bit. So a row-returning query keeps only a
//! fraction of the win, while `count(*) WHERE …` keeps all of it.
//!
//! **5. There is a routing rule, and the engine can already evaluate it.** E12/E17
//! put the crossover near 2% leading selectivity: above it masks win by 5.7x, below
//! it seed-then-filter wins by up to 1.6x. E19 shows a hybrid picking correctly with
//! ~1-4% decision overhead — and `cost.rs` already estimates cardinality, so this is
//! a routing decision the planner could make today without new statistics.

// Experiments retire from `main` as the campaign moves on, but their code stays:
// the point of a probe is the record of what was tried, including what failed.
#![allow(dead_code)]

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use harness::{best_us, section, Cfg, Lcg};
use std::hint::black_box;

const ROWS: usize = 1_000_000;

struct Col {
    keys: Vec<u32>,
    present: Vec<u64>,
    rows: usize,
}

/// Zipf-ish: value `v` gets frequency ~ 1/(v+1), so a handful dominate and a long
/// tail trails off — the distribution real categorical columns have.
fn zipfish(rows: usize, distinct: u32) -> Col {
    let mut rng = Lcg::seeded();
    let mut keys = Vec::with_capacity(rows);

    for _ in 0..rows {
        // Inverse-ish sampling without floats: bias hard toward small values.
        let r = rng.next(1000);
        let k = match r {
            0..=399 => 0,
            400..=599 => 1,
            600..=729 => 2,
            730..=819 => 3,
            820..=879 => 4,
            880..=919 => 5,
            920..=949 => 6,
            _ => rng.next(distinct),
        };
        keys.push(k.min(distinct - 1));
    }

    let mut present = vec![0u64; rows.div_ceil(64)];

    for i in 0..rows {
        if rng.next(100) >= 10 {
            present[i / 64] |= 1u64 << (i % 64);
        }
    }

    Col {
        keys,
        present,
        rows,
    }
}

struct Bsi {
    slices: Vec<Vec<u64>>,
    present: Vec<u64>,
    rows: usize,
}

impl Bsi {
    fn build(c: &Col, bits: usize) -> Self {
        let words = c.rows.div_ceil(64);
        let mut slices = vec![vec![0u64; words]; bits];

        for i in 0..c.rows {
            let (w, b) = (i / 64, i % 64);

            for (bit, slice) in slices.iter_mut().enumerate() {
                if c.keys[i] >> bit & 1 == 1 {
                    slice[w] |= 1u64 << b;
                }
            }
        }

        Self {
            slices,
            present: c.present.clone(),
            rows: c.rows,
        }
    }

    /// E0: the auto-vectorized circuit from the previous probe — the thing to beat.
    fn gt(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];

        for bit in (0..self.slices.len()).rev() {
            let slice = &self.slices[bit];

            if t >> bit & 1 == 1 {
                for (e, s) in eq.iter_mut().zip(slice.iter()) {
                    *e &= *s;
                }
            } else {
                for ((g, e), s) in gt.iter_mut().zip(eq.iter_mut()).zip(slice.iter()) {
                    *g |= *e & *s;
                    *e &= !*s;
                }
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }

    /// E1: hand-written AVX2. Same circuit, 256 bits (4 words / 256 rows) per step.
    #[cfg(target_arch = "x86_64")]
    fn gt_avx2(&self, t: u32) -> Vec<u64> {
        use std::arch::x86_64::*;

        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];
        let chunks = words / 4;

        // SAFETY: the crate targets x86-64-v3, which includes AVX2; every load and
        // store below is inside `chunks * 4 <= words` elements of each buffer.
        unsafe {
            for bit in (0..self.slices.len()).rev() {
                let slice = self.slices[bit].as_ptr();
                let tbit = t >> bit & 1 == 1;

                for c in 0..chunks {
                    let off = c * 4;
                    let s = _mm256_loadu_si256(slice.add(off).cast());
                    let e = _mm256_loadu_si256(eq.as_ptr().add(off).cast());

                    if tbit {
                        _mm256_storeu_si256(
                            eq.as_mut_ptr().add(off).cast(),
                            _mm256_and_si256(e, s),
                        );
                    } else {
                        let g = _mm256_loadu_si256(gt.as_ptr().add(off).cast());
                        _mm256_storeu_si256(
                            gt.as_mut_ptr().add(off).cast(),
                            _mm256_or_si256(g, _mm256_and_si256(e, s)),
                        );
                        _mm256_storeu_si256(
                            eq.as_mut_ptr().add(off).cast(),
                            _mm256_andnot_si256(s, e),
                        );
                    }
                }

                // The ragged tail, scalar.
                for w in (chunks * 4)..words {
                    let s = self.slices[bit][w];

                    if tbit {
                        eq[w] &= s;
                    } else {
                        gt[w] |= eq[w] & s;
                        eq[w] &= !s;
                    }
                }
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }

    /// E2: early exit. Once NO row is still tied with `t`, no lower slice can change
    /// the answer — every remaining row has already won or lost. Checking costs one
    /// pass over `eq`; skipping saves a pass over a slice, so it pays iff it fires
    /// early. (This is the "short-circuited predicate evaluation" the BitWeaving
    /// line is named for, applied to the whole column rather than per word.)
    fn gt_early(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];

        for bit in (0..self.slices.len()).rev() {
            let slice = &self.slices[bit];

            if t >> bit & 1 == 1 {
                for (e, s) in eq.iter_mut().zip(slice.iter()) {
                    *e &= *s;
                }
            } else {
                for ((g, e), s) in gt.iter_mut().zip(eq.iter_mut()).zip(slice.iter()) {
                    *g |= *e & *s;
                    *e &= !*s;
                }
            }

            if eq.iter().all(|&w| w == 0) {
                break;
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }

    /// Equality as a mask: AND the slices where `v` has a 1, ANDNOT the rest.
    fn eq_mask(&self, v: u32) -> Vec<u64> {
        let mut out = self.present.clone();

        for (bit, slice) in self.slices.iter().enumerate() {
            if v >> bit & 1 == 1 {
                for (o, s) in out.iter_mut().zip(slice.iter()) {
                    *o &= *s;
                }
            } else {
                for (o, s) in out.iter_mut().zip(slice.iter()) {
                    *o &= !*s;
                }
            }
        }

        out
    }

    /// E3: early exit made FREE. The separate `eq.iter().all()` pass in E2 costs as
    /// much as the slice it saves, so accumulate the tie state while the words are
    /// already in registers: OR every `eq` word as it is written, and if the
    /// accumulator is zero nothing is tied any more.
    fn gt_early_free(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];

        for bit in (0..self.slices.len()).rev() {
            let slice = &self.slices[bit];
            let mut alive = 0u64;

            if t >> bit & 1 == 1 {
                for (e, s) in eq.iter_mut().zip(slice.iter()) {
                    *e &= *s;
                    alive |= *e;
                }
            } else {
                for ((g, e), s) in gt.iter_mut().zip(eq.iter_mut()).zip(slice.iter()) {
                    *g |= *e & *s;
                    *e &= !*s;
                    alive |= *e;
                }
            }

            if alive == 0 {
                break;
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }
}

/// E4: reorder the value codes BY FREQUENCY — most frequent gets code 0 — so the
/// high bits are set only by rare values. "Skewing the skew": the same column, the
/// same answers, but its entropy concentrated into the low slices, which is what
/// makes the high ones cheap to skip.
fn frequency_recode(c: &Col, distinct: u32) -> (Col, Vec<u32>) {
    let mut counts = vec![0u32; distinct as usize];

    for (i, &k) in c.keys.iter().enumerate() {
        if c.present[i / 64] >> (i % 64) & 1 == 1 {
            counts[k as usize] += 1;
        }
    }

    // Rank by descending frequency; ties by value so the recode is deterministic.
    let mut order: Vec<u32> = (0..distinct).collect();
    order.sort_by_key(|&v| (std::cmp::Reverse(counts[v as usize]), v));

    let mut code_of = vec![0u32; distinct as usize];

    for (rank, &v) in order.iter().enumerate() {
        code_of[v as usize] = rank as u32;
    }

    (
        Col {
            keys: c.keys.iter().map(|&k| code_of[k as usize]).collect(),
            present: c.present.clone(),
            rows: c.rows,
        },
        code_of,
    )
}

/// How much of each slice is actually set — the measurement that says whether
/// frequency recoding concentrated anything.
fn slice_density(bsi: &Bsi) -> Vec<f64> {
    bsi.slices
        .iter()
        .map(|s| popcount(s) as f64 * 100.0 / bsi.rows as f64)
        .collect()
}

/// E5: per-(slice, block) emptiness flags. A slice whose block is all zeros
/// contributes nothing to the circuit for those rows, so the words are never read.
/// With frequency-ordered codes the high slices are mostly empty, so this is where
/// the recoding turns into skipped work rather than just smaller numbers.
struct BlockedBsi {
    slices: Vec<Vec<u64>>,
    /// `empty[bit][block]` — block `b` of slice `bit` holds no set bit.
    empty: Vec<Vec<bool>>,
    present: Vec<u64>,
    rows: usize,
    block_words: usize,
}

/// Words per skip-block. 1024 words = 65,536 rows, matching the SMA block size the
/// scan-layout probe used, so the two structures agree on what a "block" is.
const BLOCK_WORDS: usize = 1024;

impl BlockedBsi {
    fn build(bsi: &Bsi) -> Self {
        Self::build_with(bsi, BLOCK_WORDS)
    }

    fn build_with(bsi: &Bsi, block_words: usize) -> Self {
        let empty = bsi
            .slices
            .iter()
            .map(|s| {
                s.chunks(block_words)
                    .map(|c| c.iter().all(|&w| w == 0))
                    .collect()
            })
            .collect();

        Self {
            slices: bsi.slices.clone(),
            empty,
            present: bsi.present.clone(),
            rows: bsi.rows,
            block_words,
        }
    }

    fn empty_blocks(&self) -> (usize, usize) {
        let total: usize = self.empty.iter().map(Vec::len).sum();
        let empty = self.empty.iter().flatten().filter(|&&e| e).count();

        (empty, total)
    }

    fn gt(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];

        for bit in (0..self.slices.len()).rev() {
            let slice = &self.slices[bit];
            let tbit = t >> bit & 1 == 1;

            for (b, flags) in self.empty[bit].iter().enumerate() {
                let lo = b * self.block_words;
                let hi = (lo + self.block_words).min(words);

                if *flags {
                    // Every row here has a 0 in this bit. If `t` has a 1, none of
                    // them can still be tied; if `t` has a 0, they all stay tied and
                    // none pulls ahead. Either way: no read of the slice.
                    if tbit {
                        for e in &mut eq[lo..hi] {
                            *e = 0;
                        }
                    }

                    continue;
                }

                if tbit {
                    for (e, s) in eq[lo..hi].iter_mut().zip(slice[lo..hi].iter()) {
                        *e &= *s;
                    }
                } else {
                    for ((g, e), s) in gt[lo..hi]
                        .iter_mut()
                        .zip(eq[lo..hi].iter_mut())
                        .zip(slice[lo..hi].iter())
                    {
                        *g |= *e & *s;
                        *e &= !*s;
                    }
                }
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }
}

/// E6: the CLUSTERING ceiling. E5 found no empty blocks because rare values are
/// scattered across every block. Sorting the rows by value co-locates them, which
/// is the most clustering any ordering could achieve — so this measures the CEILING
/// on block skipping, not a proposal (a graph store cannot reorder node ids at
/// will; dense ids are stable for the life of the store). If the ceiling is low,
/// clustering is not worth pursuing by any means.
fn sorted_by_value(c: &Col) -> Col {
    let mut idx: Vec<u32> = (0..c.rows as u32).collect();
    idx.sort_by_key(|&i| c.keys[i as usize]);
    let mut present = vec![0u64; c.rows.div_ceil(64)];

    for (new, &old) in idx.iter().enumerate() {
        if c.present[old as usize / 64] >> (old as usize % 64) & 1 == 1 {
            present[new / 64] |= 1u64 << (new % 64);
        }
    }

    Col {
        keys: idx.iter().map(|&i| c.keys[i as usize]).collect(),
        present,
        rows: c.rows,
    }
}

/// E8: several predicates ANDed. The engine today seeds from whichever leaf looks
/// most selective and re-applies the rest per surviving row. With bitmap indexes
/// each leaf is already a mask, so the conjunction is one AND pass — and the second
/// predicate costs nothing per row that the first eliminated.
fn and_masks(a: &[u64], b: &[u64]) -> Vec<u64> {
    a.iter().zip(b.iter()).map(|(x, y)| x & y).collect()
}

/// The shape the engine uses instead: take the surviving rows of the first
/// predicate, then probe the second column per row.
fn seed_then_filter(mask: &[u64], keys: &[u32], want: u32) -> Vec<u32> {
    let mut out = Vec::new();

    for (w, &word) in mask.iter().enumerate() {
        let mut bits = word;

        while bits != 0 {
            let k = bits.trailing_zeros() as usize;
            let row = w * 64 + k;

            if keys[row] == want {
                out.push(row as u32);
            }

            bits &= bits - 1;
        }
    }

    out
}

/// E10: how much clustering is ENOUGH? E6 measured the ceiling with a full sort,
/// which a graph store cannot do — dense node ids are stable for the life of the
/// store. But real columns are often PARTIALLY clustered for free: nodes of a kind
/// are inserted together, timestamps arrive in order, an import lands grouped. This
/// builds a column whose value changes only every `run` rows and asks how long the
/// runs must be before block skipping starts paying.
fn clustered(rows: usize, distinct: u32, run: usize) -> Col {
    let mut rng = Lcg::seeded();
    let mut keys = Vec::with_capacity(rows);

    while keys.len() < rows {
        // Same zipf-ish value choice as `zipfish`, held for `run` rows.
        let r = rng.next(1000);
        let k = match r {
            0..=399 => 0,
            400..=599 => 1,
            600..=729 => 2,
            730..=819 => 3,
            820..=879 => 4,
            880..=919 => 5,
            920..=949 => 6,
            _ => rng.next(distinct),
        }
        .min(distinct - 1);

        for _ in 0..run.min(rows - keys.len()) {
            keys.push(k);
        }
    }

    let mut present = vec![0u64; rows.div_ceil(64)];

    for i in 0..rows {
        if rng.next(100) >= 10 {
            present[i / 64] |= 1u64 << (i % 64);
        }
    }

    Col {
        keys,
        present,
        rows,
    }
}

/// E11: a sparse slice as POSITIONS instead of words — the array container Roaring
/// would choose. The high slices are ~2.5% dense, so the positions are 40x smaller
/// than the bitmap; the question is whether the circuit can use them without
/// materializing the bitmap back, or whether density-adaptive storage only saves
/// space and not time.
struct SparseSlice {
    /// Word index -> the word, for the few words that are non-zero.
    entries: Vec<(u32, u64)>,
}

impl SparseSlice {
    fn build(slice: &[u64]) -> Self {
        Self {
            entries: slice
                .iter()
                .enumerate()
                .filter(|(_, &w)| w != 0)
                .map(|(i, &w)| (i as u32, w))
                .collect(),
        }
    }

    fn bytes(&self) -> usize {
        self.entries.len() * 12
    }

    /// The `t`-bit-is-0 arm of the circuit, driven by the sparse slice: only the
    /// words that hold a set bit can change anything. Everywhere else `eq` keeps
    /// its value and `gt` gains nothing, so those words are never touched.
    fn apply_zero_arm(&self, gt: &mut [u64], eq: &mut [u64]) {
        for &(w, s) in &self.entries {
            let i = w as usize;
            gt[i] |= eq[i] & s;
            eq[i] &= !s;
        }
    }
}

/// Materialize ids from a mask — what every consumer in the engine currently wants.
/// E17 exists because comparing a mask against a `Vec<u32>` prices only half the
/// work, and that is how a bitmap index flatters itself.
fn ids_of(mask: &[u64]) -> Vec<u32> {
    let mut out = Vec::with_capacity(popcount(mask));

    for (w, &word) in mask.iter().enumerate() {
        let mut bits = word;

        while bits != 0 {
            out.push((w * 64) as u32 + bits.trailing_zeros());
            bits &= bits - 1;
        }
    }

    out
}

/// E18: the frequent values of a column as ready-made bitmaps (the RFE layers from
/// the previous probe). Equality against one is not a circuit at all — the mask
/// already exists, so a conjunction pays only the AND.
struct ValueBitmaps {
    maps: Vec<(u32, Vec<u64>)>,
}

impl ValueBitmaps {
    fn build(keys: &[u32], present: &[u64], rows: usize, top: usize) -> Self {
        let mut counts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();

        for (i, &k) in keys.iter().enumerate() {
            if present[i / 64] >> (i % 64) & 1 == 1 {
                *counts.entry(k).or_insert(0) += 1;
            }
        }

        let mut ranked: Vec<(u32, u32)> = counts.into_iter().collect();
        ranked.sort_by_key(|&(v, c)| (std::cmp::Reverse(c), v));

        let maps = ranked
            .into_iter()
            .take(top)
            .map(|(v, _)| {
                let mut m = vec![0u64; rows.div_ceil(64)];

                for (i, &k) in keys.iter().enumerate() {
                    if k == v && present[i / 64] >> (i % 64) & 1 == 1 {
                        m[i / 64] |= 1u64 << (i % 64);
                    }
                }

                (v, m)
            })
            .collect();

        Self { maps }
    }

    fn get(&self, v: u32) -> Option<&Vec<u64>> {
        self.maps.iter().find(|(mv, _)| *mv == v).map(|(_, m)| m)
    }
}

/// E21: a column that is only PARTLY clustered — `pct` percent of rows sit in long
/// runs, the rest are scattered. Real columns look like this: an import lands
/// grouped, later edits scatter. The question is whether partial clustering gives
/// partial benefit or nothing at all.
fn partly_clustered(rows: usize, distinct: u32, run: usize, pct: u32) -> Col {
    let mut rng = Lcg::seeded();
    let mut keys = Vec::with_capacity(rows);

    while keys.len() < rows {
        let clustered_here = rng.next(100) < pct;
        let k = rng.next(distinct);

        if clustered_here {
            for _ in 0..run.min(rows - keys.len()) {
                keys.push(k);
            }
        } else {
            for _ in 0..run.min(rows - keys.len()) {
                keys.push(rng.next(distinct));
            }
        }
    }

    let mut present = vec![0u64; rows.div_ceil(64)];

    for i in 0..rows {
        if rng.next(100) >= 10 {
            present[i / 64] |= 1u64 << (i % 64);
        }
    }

    Col {
        keys,
        present,
        rows,
    }
}

/// E23: consume the mask WITHOUT building a `Vec` — the fused shape, where the
/// caller does its work per set bit as the words are walked. If the engine's
/// consumers could take a mask, this is what the conjunction would actually cost.
fn fold_mask(mask: &[u64]) -> u64 {
    let mut acc = 0u64;

    for (w, &word) in mask.iter().enumerate() {
        let mut bits = word;

        while bits != 0 {
            acc = acc.wrapping_add((w * 64) as u64 + u64::from(bits.trailing_zeros()));
            bits &= bits - 1;
        }
    }

    acc
}

/// E23: evaluate a CONJUNCTION block by block, and stop touching a block the moment
/// nothing in it can still match. The first predicate's mask for a block is often
/// all zeros; every later predicate can then skip that block's words entirely. This
/// is the conjunction version of block skipping, and unlike E5 it does not need the
/// DATA to be clustered — it needs the RESULT to be, which a selective leading
/// predicate produces for free.
fn and_blockwise(left: &[u64], right_slices: &Bsi, v: u32, block_words: usize) -> Vec<u64> {
    let words = left.len();
    let mut out = vec![0u64; words];

    for lo in (0..words).step_by(block_words) {
        let hi = (lo + block_words).min(words);

        // Nothing survived the leading predicate here — the rest of the conjunction
        // cannot change that, so this block's slices are never read.
        if left[lo..hi].iter().all(|&w| w == 0) {
            continue;
        }

        for (i, o) in out[lo..hi].iter_mut().enumerate() {
            *o = left[lo + i] & right_slices.present[lo + i];
        }

        for (bit, slice) in right_slices.slices.iter().enumerate() {
            let one = v >> bit & 1 == 1;

            for (i, o) in out[lo..hi].iter_mut().enumerate() {
                let sw = slice[lo + i];
                *o &= if one { sw } else { !sw };
            }
        }
    }

    out
}

/// E24: per-block popcounts kept alongside the mask, so a COUNT over a whole
/// predicate is a sum of precomputed numbers rather than a pass.
fn block_counts(mask: &[u64], block_words: usize) -> Vec<u32> {
    mask.chunks(block_words)
        .map(|c| c.iter().map(|w| w.count_ones()).sum())
        .collect()
}

fn popcount(m: &[u64]) -> usize {
    m.iter().map(|w| w.count_ones() as usize).sum()
}

fn main() {
    let cfg = Cfg::from_env();
    let rows = cfg.scale.unwrap_or(ROWS);
    let distinct = 4096u32;
    let c = zipfish(rows, distinct);
    let bsi = Bsi::build(&c, 12);
    let c2 = zipfish(rows / 3, distinct);
    let keys2: Vec<u32> = (0..rows).map(|i| c2.keys[i % c2.keys.len()]).collect();
    let bsi2 = Bsi::build(
        &Col {
            keys: keys2.clone(),
            present: c.present.clone(),
            rows,
        },
        12,
    );

    section("E23: block-wise conjunction — skip blocks the first predicate emptied");
    println!(
        "  {:<30} {:>10} {:>12} {:>9}",
        "x > t AND y = 1", "flat AND", "block-wise", "speedup"
    );

    for t in [0u32, 512, 2048, 4000] {
        let left = bsi.gt(t);
        let survivors = popcount(&left);
        let want = and_masks(&left, &bsi2.eq_mask(1));
        assert_eq!(
            and_blockwise(&left, &bsi2, 1, 256),
            want,
            "block-wise disagrees"
        );

        let flat = best_us(cfg.reps, || and_masks(&bsi.gt(t), &bsi2.eq_mask(1)));
        let blk = best_us(cfg.reps, || and_blockwise(&bsi.gt(t), &bsi2, 1, 256));
        println!(
            "  t = {:<26} {:>10.1} {:>12.1} {:>8.1}x",
            format!("{t} ({survivors} survive)"),
            black_box(flat),
            black_box(blk),
            flat / blk
        );
    }

    section("E24: COUNT from precomputed per-block popcounts");
    let mask = bsi.gt(64);
    let counts = block_counts(&mask, 256);
    let direct = best_us(cfg.reps, || popcount(&mask));
    let summed = best_us(cfg.reps, || {
        counts.iter().map(|&x| x as usize).sum::<usize>()
    });
    assert_eq!(
        counts.iter().map(|&x| x as usize).sum::<usize>(),
        popcount(&mask)
    );
    println!(
        "  popcount the mask {direct:.2} us · sum {} block counts {summed:.2} us  ({:.0}x)",
        counts.len(),
        direct / summed
    );
    println!(
        "  (both are dwarfed by the {:.0} us the circuit spends producing the mask)",
        best_us(cfg.reps, || bsi.gt(64))
    );
}
