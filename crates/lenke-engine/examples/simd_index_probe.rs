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
//!
//! ═══ SECOND HALF (E25-E36): ATTACKING DELIVERY, AND AGGREGATES ═══
//!
//! E20 left delivery as the dominant cost, so the campaign turned there — and found
//! that the biggest wins come from NOT delivering at all.
//!
//! ```text
//! E25  mask -> ids, AVX2 byte table       53.9% dense 288.6 -> 108.9us   2.7x
//!        …but the crossover is DENSITY     4.5% dense  29.5 -> 250.9us   0.1x
//! E28  sum(x) WHERE p, iterating set bits  327.2us vs 618.0us materialized  1.9x
//!        …and 30.7 vs 51.9us at 3.9% dense — it wins at every density
//! E27  GROUP BY count, popcounts vs hash   5757.5 -> 14.7us              393x
//! E30  GROUP BY sum,   bitmaps vs hash     6106.9 -> 930.4us             6.6x
//! E31  by group count  4: 796x · 8: 389x · 32: 100x · 128: 24.8x · 512: 4.5x · 2048: 0.9x
//!        …memory is k x rows/8, so 128 groups is 15MB/M rows and 2048 is 250MB
//! E32  maintained counters                 2.57ns/write, answer read in 0.010us
//! E33  FILTERED group-by, AND + popcount   6181 -> 35.3us               175x
//!        …and CONSTANT in the filter: 35.3us whether 539k rows pass or 1003
//! E34  10x scale, 1M -> 10M rows           BSI 0.070 -> 0.045 ns/row (no cliff)
//! E35  build cost, 10M rows                BSI 84ms · 8 bitmaps 127ms · counters 9ms
//! E36  capstone: WHERE age > t GROUP BY dept
//!        scan + hash group      1598.7us   1.0x   (what the engine does today)
//!        BSI filter + hash       295.1us   5.4x   (half the change)
//!        BSI filter + bitmaps     69.2us  23.1x   (all the way)
//! ```
//!
//! **6. The answer is three tiers, not one structure.** An unfiltered
//! `GROUP BY x COUNT(*)` should never touch a bitmap: maintained per-value counters
//! answer it in 10 NANOSECONDS for 2.57ns per write (E32). Value bitmaps earn their
//! place on the shapes counters cannot answer — a FILTERED group-by is 175x and,
//! more importantly, CONSTANT in the filter's selectivity (E33) — but only up to
//! ~128 groups, where memory (k x rows/8) overtakes the win long before the 2048
//! break-even (E31). BSI covers what neither does: ranges, at a cost independent of
//! cardinality.
//!
//! **7. The delivery tax is real but avoidable, and the SIMD trick for it is
//! density-gated.** AVX2 extraction (a byte-indexed position table, widened and
//! stored 8 ids at a time) is 2.7x on a dense mask and 10x WORSE on a sparse one,
//! because a sparse mask still has most words non-zero while most of their bytes
//! are empty. Pick by density. Better still, do not extract: an aggregate that
//! walks the set bits beats materialize-then-gather at every density (E28).
//!
//! **8. In the REAL engine the filter is not half the cost — it is 91% of it.** E36
//! measured 5.4x for the filter side alone against a hand-written baseline, which
//! implied grouping was the rest. E38, run through the actual GQL path, says
//! otherwise: `count(*)` with no filter is 0.2us (the engine's existing count
//! shortcut), `count(*)` WITH the filter is 340us, and adding the grouping takes it
//! to 372us. The predicate is the cost; grouping is 9%. So the recommendation
//! sharpens to: index the FILTER side.
//!
//! ═══ AGAINST THE REAL ENGINE (E37-E40) ═══
//!
//! ```text
//! E37  MATCH (n:Person) WHERE n.age > 50 RETURN n.dept, count(*)   [200k rows]
//!        engine, exec only (parse + optimize hoisted)      371.9 us
//!        BSI filter + bitmap group, same data                6.6 us    56.4x
//!
//! E38  engine breakdown        count(*) alone            0.2 us  <- count shortcut
//!                              count(*) + filter       340.4 us  <- shortcut dies
//!                              group, no filter        371.2 us
//!                              filter + group          372.4 us
//!
//! E40  the engine's OWN range index on `age`:
//!        WHERE age > 50 (49% pass)   no index  320.9us · indexed 1184.2us   0.3x
//!        WHERE age > 50, + group     no index  377.1us · indexed 1138.2us   0.3x
//!        WHERE age > 98 ( 1% pass)   no index  303.2us · indexed   30.8us   9.8x
//! ```
//!
//! ═══ WHY A FILTERED TRAVERSAL IS SLOW (E44-E54) ═══
//!
//! The campaign had only ever measured scan+filter. A graph query's distinguishing
//! step is the EXPAND, so E44 asked where the time goes in one — and the answer was
//! that a predicate costs 15x the traversal it sits on at one hop, 44x at two. The
//! rest of the experiments took that apart. 200k `Person` nodes, 8 `KNOWS` edges
//! each (1.6M edges):
//!
//! ```text
//! count(*) over the expand                        453.2 us   0.28 ns/edge
//! count(b.age) — reads one property per edge     6854.9 us   4.28 ns/edge
//! WHERE b.age >  0  (99% pass)                   3019.4 us   1.89 ns/edge
//! WHERE b.age > 49  (50% pass)                   8205.0 us   5.13 ns/edge
//! WHERE b.age > 98  ( 1% pass)                   2824.3 us   1.77 ns/edge
//! ```
//!
//! **10. The unfiltered count is a SHORTCUT, not a traversal.** 453us is 15.1x
//! cheaper than merely READING a property per edge, so it never walks — which means
//! "filtering costs 16x the expand" (my first reading of E48) was comparing against
//! a number that was never traversal's price. Traversal's price is ~6.9ms; the
//! shortcut's is 0.45ms; a predicate forfeits the shortcut and pays the walk.
//!
//! **11. Mid-selectivity costs 3.30 ns/edge in BRANCH MISPREDICTION.** 8205us at 50%
//! against 2922us averaged over the predictable ends (99% and 1%) is the textbook
//! signature, and it is precisely the premium a branch-free mask evaluation does not
//! pay — `scan_layout_probe`'s variant C was FLAT in selectivity at 189us. This is
//! the strongest argument in the whole campaign for mask-based predicate evaluation,
//! and it appears only on the traversal path, which is where the cost is.
//!
//! **12. A NEGATED NUMERIC LITERAL WAS NOT FOLDED — 7x, FIXED.** `gql.rs` desugared
//! unary minus to `Arith { Sub, Lit(0), x }` unconditionally, so `-1` never became a
//! literal, the typed comparison fast paths (which match `prop <op> literal`)
//! declined, and every row went through the boxed evaluator:
//!
//! ```text
//!                            before     after
//!   scan       n.age > -1   2354.3 ->   298.2 us   7.9x
//!   traversal  b.age > -1  19652.2 ->  2743.7 us   7.2x   (level with `b.age >= 0`)
//! ```
//!
//! Two spellings of one predicate differing by the plan alone — the exact class
//! `spelling_probe` polices, which had no negative-literal group until now (it does
//! now, and it reports a 5.71x cliff with the fold removed). Folded as `0.0 - x`
//! rather than `-x`, so the constant is bitwise what the evaluator produced before
//! and `-0.0` still folds to `+0.0`.
//!
//! **13. What the engine is NOT saving, priced.** Composing the stages it already
//! runs, at their own measured speeds: an anchor filter leaves ~6.7x on the table and
//! a far-side filter ~10.6x. Predicate pushdown below an Expand DOES fire (E45 prints
//! the plan: `Expand <- Filter <- Scan`), so the gap is not a missing rewrite — it is
//! per-path evaluation where per-distinct-endpoint would do, boxed reads where typed
//! would do, and branch misprediction where a mask would not care.
//!
//! ═══ THE POOL, NOT THE PREDICATE (E55-E59) ═══
//!
//! The campaign spent itself making filtering FASTER — masks, bitmaps, branch-free
//! evaluation, 5-8x. Shrinking the pool is worth 40-100x on the same query, and in
//! a graph it COMPOUNDS, because a node removed at the anchor removes its edges and
//! its edges' edges:
//!
//! ```text
//! E57  all nodes             200,000      0.2 us   (a shortcut)
//!      anchor admits 1%        2,000     30.1 us
//!      1 hop from all      1,600,000    485.8 us
//!      1 hop from the 1%      16,000     32.2 us   100x smaller pool
//!      2 hops from all    12,800,000   4736.8 us
//!      2 hops from the 1%    128,000    118.5 us   100x smaller pool, 40x less time
//! ```
//!
//! **14. The seek threshold is not a property of the predicate.** E40 measured a
//! range index making a SCAN 3.7x slower at 50% selectivity. E55 measures the SAME
//! index making a 2-HOP TRAVERSAL 17.3x FASTER at the same 50%. So finding 9's
//! "seed below ~2%" is right for a scan and badly wrong for a traversal: the
//! threshold depends on the downstream FAN-OUT, not on the leaf alone.
//!
//! **15. THE NATIVE ENGINE DOES NOT ORIENT A FIXED-LENGTH PATTERN — 43x.** A
//! predicate on the FAR end never reaches an index, because the optimizer does not
//! score both ends and reverse:
//!
//! ```text
//! E58  (a)-[:KNOWS]->(b) WHERE b.age > 98   1652.0 us   Filter <- Expand <- Scan
//!      (b)<-[:KNOWS]-(a) WHERE b.age > 98     31.6 us   Expand <- RangeSeek
//!      (a)-[:KNOWS]->(b) WHERE a.age > 98     32.1 us   Expand <- RangeSeek
//!
//! E59  forwards vs backwards:  1% -> 43.0x · 10% -> 52.7x · 50% -> 6.3x
//! ```
//!
//! Identical answers, differing by the written DIRECTION alone. The TS engine
//! already does this (`orient`/`reversePath` in gql/src/executor/matching.ts score
//! both ends and reverse when the far end is more selective), and PropertyIndex.md
//! documents the behaviour without marking it TS-only — so the two engines disagree
//! on cost for the same query, and the docs side with the one that is faster.
//! Logged as audit item 10 and guarded by a new `spelling_probe` group.
//!
//! **16. So the ranking flips.** Everything measured here says pool-shrinking beats
//! predicate-speeding for traversal queries, which is what a graph query IS. The
//! bitmap work remains the right answer for the shapes that CANNOT shrink — a scan
//! with no selective anchor, a filtered GROUP BY, a count over a broad predicate —
//! and the branch-misprediction premium (finding 11) is real wherever a predicate
//! runs per row. But the first question about any slow graph query is how big a pool
//! it started from, not how fast it filtered.
//!
//! **9. THE RANGE INDEX HAS NO SELECTIVITY CHECK, AND THAT IS A LIVE FOOTGUN.** E40
//! is the most actionable thing this campaign found, and it has nothing to do with
//! bitmaps. The planner seeds a `RangeSeek` from a vertex range index whenever one
//! exists on the key: a 9.8x win at 1% selectivity, and a 3.7x LOSS at 49%, because
//! seeking 98,000 rows through the index costs more than scanning 200,000. The
//! engine behaviour is not new, but `IndexKind: "range"` only became expressible
//! from TypeScript this week, so a user can now create the index and make their
//! broad queries four times slower — with no way to see why. `cost.rs` already
//! estimates cardinality; the seek decision needs to consult it, exactly as E19's
//! hybrid does for the mask-vs-seed choice. Fix that BEFORE any of the bitmap work:
//! it is smaller, it is a regression rather than an enhancement, and it is reachable
//! today.

// Experiments retire from `main` as the campaign moves on, but their code stays:
// the point of a probe is the record of what was tried, including what failed.
#![allow(dead_code)]

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use harness::{section, Cfg, Lcg};
use lenke_engine::ir::Plan;

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

/// E25: extracting ids from a mask with SIMD. E20 made this the dominant cost —
/// 288us to deliver 539k rows against 40us to find them — and the scalar loop is
/// one unpredictable branch per set bit. The vector form processes a BYTE of the
/// mask at a time: look up that byte's 8 positions, widen them to u32, add the
/// base, store all 8 unaligned, then advance the write pointer by the byte's
/// popcount. Branch-free per byte, and the store overlaps the next iteration.
static POSITIONS: [[u8; 8]; 256] = build_positions();

const fn build_positions() -> [[u8; 8]; 256] {
    let mut table = [[0u8; 8]; 256];
    let mut b = 0usize;

    while b < 256 {
        let mut n = 0usize;
        let mut bit = 0usize;

        while bit < 8 {
            if b >> bit & 1 == 1 {
                table[b][n] = bit as u8;
                n += 1;
            }

            bit += 1;
        }

        b += 1;
    }

    table
}

#[cfg(target_arch = "x86_64")]
fn ids_of_simd(mask: &[u64]) -> Vec<u32> {
    use std::arch::x86_64::*;

    let mut out: Vec<u32> = Vec::with_capacity(popcount(mask) + 8);
    let mut len = 0usize;

    // SAFETY: the crate targets x86-64-v3 (AVX2). `out` is reserved for every set
    // bit plus 8 slack, so the 8-wide store at `len` never runs past the allocation.
    unsafe {
        let base_ptr = out.as_mut_ptr();

        for (w, &word) in mask.iter().enumerate() {
            if word == 0 {
                continue;
            }

            for byte in 0..8usize {
                let b = (word >> (byte * 8)) as u8;

                if b == 0 {
                    continue;
                }

                let base = (w * 64 + byte * 8) as u32;
                // The byte's 8 candidate positions, widened 8-bit -> 32-bit.
                let pos = _mm_loadl_epi64(POSITIONS[b as usize].as_ptr().cast());
                let widened = _mm256_cvtepu8_epi32(pos);
                let shifted = _mm256_add_epi32(widened, _mm256_set1_epi32(base as i32));
                _mm256_storeu_si256(base_ptr.add(len).cast(), shifted);
                len += b.count_ones() as usize;
            }
        }

        out.set_len(len);
    }

    out
}

/// E26: aggregate straight off the mask. A `sum(x) WHERE p` never needs the rows —
/// only the values under the set bits — so the delivery cost E20 measured is
/// avoidable entirely for this shape. Branch-free: multiply by the bit rather than
/// branch on it, so the loop stays vectorizable.
fn masked_sum(mask: &[u64], data: &[f64]) -> f64 {
    let mut acc = 0.0;

    for (w, &word) in mask.iter().enumerate() {
        let base = w * 64;
        let lanes = 64.min(data.len() - base);

        for k in 0..lanes {
            acc += data[base + k] * f64::from((word >> k & 1) as u32);
        }
    }

    acc
}

/// E28: the same aggregate, but skipping empty words. E26's branch-free form
/// touched every row whatever the mask said, so it could not profit from a
/// selective predicate — a fixed cost is only a win when the answer is broad. One
/// zero-check per 64 rows restores the proportionality without reintroducing a
/// branch per row.
fn masked_sum_skip(mask: &[u64], data: &[f64]) -> f64 {
    let mut acc = 0.0;

    for (w, &word) in mask.iter().enumerate() {
        if word == 0 {
            continue;
        }

        let base = w * 64;
        let lanes = 64.min(data.len() - base);

        for k in 0..lanes {
            acc += data[base + k] * f64::from((word >> k & 1) as u32);
        }
    }

    acc
}

/// E28b: iterate only the SET bits — a gather, but without materializing ids.
/// Where the mask is sparse this touches nothing else at all.
fn masked_sum_bits(mask: &[u64], data: &[f64]) -> f64 {
    let mut acc = 0.0;

    for (w, &word) in mask.iter().enumerate() {
        let mut bits = word;

        while bits != 0 {
            acc += data[w * 64 + bits.trailing_zeros() as usize];
            bits &= bits - 1;
        }
    }

    acc
}

/// The shape it replaces: materialize the ids, then gather.
fn materialize_then_sum(mask: &[u64], data: &[f64]) -> f64 {
    ids_of(mask).iter().map(|&i| data[i as usize]).sum()
}

fn popcount(m: &[u64]) -> usize {
    m.iter().map(|w| w.count_ones() as usize).sum()
}

fn main() {
    let cfg = Cfg::from_env();
    let rows = cfg.scale.unwrap_or(200_000);
    let plain = harness::social_store(rows as u32, 8);
    let mut seeded = harness::social_store(rows as u32, 8);
    seeded.create_range_index("age");

    section("E66: orientation with the far node's label lifted onto the seed");
    let cases: [(&str, &str); 4] = [
        (
            "far node UNLABELLED (b)",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "far node LABELLED (b:Person)",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "hand-written backwards (the target)",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "labelled, and projecting both ends",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN a.name AS an, b.name AS bn",
        ),
    ];

    println!("  {:<38} {:>10} {:>10}", "query", "us", "rows");

    for (label, q) in cases {
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        let dbg = format!("{opt:?}");
        let mut chain: Vec<&str> = Vec::new();

        for tok in dbg.split(|c: char| !c.is_alphanumeric() && c != '_') {
            if matches!(
                tok,
                "Scan" | "Expand" | "Filter" | "Aggregate" | "Project" | "IndexSeek" | "RangeSeek"
            ) && chain.last() != Some(&tok)
            {
                chain.push(tok);
            }
        }

        // Answers must match the unoriented plan exactly.
        let ctrl = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &plain,
        );
        let mut want: Vec<String> = lenke_engine::exec::run(&ctrl, &plain)
            .rows
            .iter()
            .flatten()
            .map(|v| format!("{v:?}"))
            .collect();
        let mut got: Vec<String> = lenke_engine::exec::run(&opt, &seeded)
            .rows
            .iter()
            .flatten()
            .map(|v| format!("{v:?}"))
            .collect();
        want.sort();
        got.sort();
        assert_eq!(want, got, "orientation changed the answer for: {q}");

        if let Ok((us, _)) = harness::time_query(q, false, &seeded, cfg.reps.min(5)) {
            println!("  {label:<38} {us:>10.1} {:>10}", got.len());
            println!("  {:<38} {}", "", chain.join(" <- "));
        }
    }

    // E67 ------------------------------------------------------------------
    //
    // E66 left a 15x residual: the oriented plan seeks and expands exactly like the
    // hand-written backwards one, and was 499us against 32us. The obvious reading is
    // that the `Filter` the oriented plan keeps above `Expand` costs 15x per edge,
    // which would make a node-id bitmap the fix.
    //
    // Checking that reading first found a much larger and much dumber problem, so
    // this section is what the check turned up and E68 is the original question.
    //
    // A PREDICATE STOPPED PUSHING BECAUSE A LABEL WAS WRITTEN NEXT TO IT. Both ends
    // of `(a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98` lower to stacked filters;
    // the merge rule fuses them into one `And`; and the Expand pushdown arm was
    // all-or-nothing (`refs_below` over the WHOLE predicate), so one slot-1 label
    // check next to the slot-0 range predicate pinned both above the hop. The seek
    // never happened and the walk ran from every Person. Writing `(a)` instead of
    // `(a:Person)` — no semantic difference on this fixture, where every node is a
    // Person — was 300x faster.
    //
    // The fix is the split the VarLength/ShortestPath arms had already been given for
    // exactly this reason (opt.rs's own comment: "otherwise a mixed `a.age = 1 AND
    // b.age = 2` refuses to push at all and the walk runs from every node").
    section("E67: the Expand pushdown, now split per conjunct");

    let pairs: [(&str, &str, &str); 2] = [
        (
            "count(*)",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "both ends projected",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN a.name AS an, b.name AS bn",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN a.name AS an, b.name AS bn",
        ),
    ];

    println!(
        "  {:<28} {:>10} {:>10} {:>8}  plan",
        "shape", "forwards", "backwards", "ratio"
    );

    for (label, forwards, backwards) in pairs {
        let f = harness::time_query(forwards, false, &seeded, cfg.reps.min(5));
        let b = harness::time_query(backwards, false, &seeded, cfg.reps.min(5));
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(backwards).expect("parses"),
            &seeded,
        );

        if let (Ok((fus, _)), Ok((bus, _))) = (f, b) {
            let ratio = if bus > 0.0 { fus / bus } else { 0.0 };
            println!(
                "  {label:<28} {fus:>10.1} {bus:>10.1} {ratio:>7.2}x  {}",
                chain_of(&opt)
            );
        }
    }

    println!("  (before the split: 9382us backwards, against 31.6us for the same");
    println!("   query with the far node left unlabelled — a 300x spelling cliff)");

    // E68 ------------------------------------------------------------------
    //
    // Now the original question, with a control that actually isolates it. E66's 32us
    // reference was NOT an unfiltered expand — `count(*)` over a bare `Expand` sums
    // DEGREES and never walks an edge, so comparing against it measures the count
    // shortcut, which is the mistake E48 already made once in this file.
    //
    // The honest control is the same plan shape with and without the residual filter:
    // same seek, same expand, same output rows (every node here is a Person, so the
    // label check passes everything). The difference is the filter and nothing else.
    //
    // Measured, and the 15x turns out to be TWO costs that wanted separating:
    //
    //   count   NO filter (degree sum)     31.1us
    //   count   residual IsLabeled        475.5us    15.3x
    //   project NO filter                 320.7us
    //   project residual IsLabeled        625.6us     1.95x
    //
    // MOST OF IT IS NOT THE FILTER. The 1.95x on the projection is the filter; the
    // 15.3x on the count is something else, and E69-E71 spend four attempts finding
    // out what. The short version, which E71 proves: `count(*)` over a bare `Expand`
    // sums adjacency LENGTHS — O(sources), never looking at a single edge — and any
    // predicate on the endpoint must look at every edge to know which endpoints to
    // test. The two are not the same question, so the 15x is not a penalty anyone can
    // optimize away. Read E71 before treating this row as a target.
    //
    // THE FILTER ITSELF IS 1.95x. 305us over 16,065 rows is ~19ns per row, which is
    // roughly what a binary search into a 200k-id label bucket costs. That one is
    // real, and small.
    section("E68: what does the residual frontier filter actually cost?");

    let filt: [(&str, &str); 4] = [
        (
            "count   NO filter (degree sum)",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "count   residual IsLabeled",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "project NO filter",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN a.name AS an, b.name AS bn",
        ),
        (
            "project residual IsLabeled",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN a.name AS an, b.name AS bn",
        ),
    ];

    println!("  {:<34} {:>10} {:>10}  plan", "shape", "us", "rows");

    for (label, q) in filt {
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        let rows = lenke_engine::exec::run(&opt, &seeded).rows.len();

        if let Ok((us, _)) = harness::time_query(q, false, &seeded, cfg.reps.min(5)) {
            println!("  {label:<34} {us:>10.1} {rows:>10}  {}", chain_of(&opt));
        }
    }

    // E69 ------------------------------------------------------------------
    //
    // E68 named the count shortcut as the prize, so this is the attempt to claim it —
    // and the record of it failing, because "obviously correct so it must be faster"
    // is not evidence here and this is the second time on this branch.
    //
    // The attempt: make `try_fused_count` fold a filter on the hop's ENDPOINT into the
    // degree sum (`simple_nbr_preds` + `nbr_pred_ok` per neighbour, no row built),
    // instead of declining and letting the plan enumerate every path to count it.
    //
    // It is SLOWER, in every shape, and the reason generalizes: the filter it replaces
    // is evaluated COLUMNARLY over a batch — one gather, one vectorized compare — and
    // a per-neighbour scalar test cannot beat that even when it materializes no row.
    //
    //   endpoint compare  a.age > 50        112.5us -> 344.8us   3.1x WORSE
    //   endpoint exists   a.name            211.9us -> 207.4us   noise
    //   endpoint conjunction                532.7us -> 724.1us   1.4x WORSE
    //
    // For a bare `IsLabeled` endpoint filter — the shape that started this —
    // `try_frontier_count` already propagates a per-node count array and beats the
    // fold 474us to 560us, so there was nothing to win there either.
    //
    // Reverted; the full note lives next to `try_fused_count` in fastpath.rs. The rows
    // below are the CURRENT (unfolded) costs, kept as the regression baseline and
    // because they answer the question E68 actually asked: what an endpoint filter
    // costs a count, by kind of predicate.
    section("E69: folding a non-label endpoint filter into the degree sum");

    let folded: [(&str, &str); 4] = [
        (
            "baseline: no endpoint filter",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "endpoint compare  a.age > 50",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 AND a.age > 50 RETURN count(*) AS c",
        ),
        (
            "endpoint exists   a.name",
            "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 AND a.name IS NOT NULL RETURN count(*) AS c",
        ),
        (
            "endpoint conjunction",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 AND a.age > 50 RETURN count(*) AS c",
        ),
    ];

    println!("  {:<34} {:>10} {:>14}  plan", "shape", "us", "answer");

    for (label, q) in folded {
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        // The fold must not change the answer — check against the UNINDEXED store,
        // which cannot take any of these paths.
        let ctrl = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &plain,
        );
        let want = format!("{:?}", lenke_engine::exec::run(&ctrl, &plain).rows);
        let got = format!("{:?}", lenke_engine::exec::run(&opt, &seeded).rows);
        assert_eq!(want, got, "the endpoint fold changed the answer for: {q}");

        if let Ok((us, _)) = harness::time_query(q, false, &seeded, cfg.reps.min(5)) {
            let n = lenke_engine::exec::run(&opt, &seeded)
                .rows
                .iter()
                .flatten()
                .next()
                .map_or(String::new(), |v| format!("{v:?}"));
            println!("  {label:<34} {us:>10.1} {n:>14}  {}", chain_of(&opt));
        }
    }

    // E70 ------------------------------------------------------------------
    //
    // Everything E68 and E69 concluded about the cost of a far-end label check was
    // measured against a label carried by EVERY node in the fixture and by nothing
    // else — `social_store` gives all 200k nodes exactly `Person`. That is the
    // degenerate case in both directions at once: the filter removes no rows, and its
    // bucket is the largest one the graph can offer, so the membership bitset costs
    // the most it ever could. "Match the fixture to the claim", and this one did not.
    //
    // So: same query, same shape, with the far-end label carried by a VARYING fraction
    // of the graph. If the cost tracks the bucket, the 15x was an artefact of a
    // degenerate label and a realistic one is far cheaper.
    section("E70: does the far-end label cost track the label's size?");

    println!(
        "  {:>8} {:>10} {:>10} {:>10} {:>9}",
        "labelled", "bucket", "no filter", "filtered", "delta"
    );

    for pct in [1u32, 10, 50, 100] {
        let mut st = {
            use lenke_engine::store::Builder;
            use lenke_engine::value::Value;
            let mut b = Builder::default();
            let n = rows as u32;
            for i in 0..n {
                // Every node is a Person; a fraction also carries `Staff`.
                let staff = i % 100 < pct;
                let labels: &[&str] = if staff {
                    &["Person", "Staff"]
                } else {
                    &["Person"]
                };
                b.node(
                    labels,
                    &[
                        ("name", Value::Str(format!("name{i}").into())),
                        ("age", Value::Num(f64::from(i % 100))),
                    ],
                );
            }
            let mut rng = Lcg(0x5EED_1234);
            for i in 0..n {
                for _ in 0..8 {
                    b.edge(i, rng.next(n), "KNOWS");
                }
            }
            b.build()
        };
        st.create_range_index("age");

        let bare = "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c";
        let filtered = "MATCH (b:Person)<-[:KNOWS]-(a:Staff) WHERE b.age > 98 RETURN count(*) AS c";
        let bucket = st.nodes_with_label("Staff").len();

        if let (Ok((bus, _)), Ok((fus, _))) = (
            harness::time_query(bare, false, &st, cfg.reps.min(5)),
            harness::time_query(filtered, false, &st, cfg.reps.min(5)),
        ) {
            println!(
                "  {:>7}% {bucket:>10} {bus:>10.1} {fus:>10.1} {:>8.1}x",
                pct,
                fus / bus
            );
        }
    }

    // E71 ------------------------------------------------------------------
    //
    // E70 killed the "degenerate label" explanation: a 2000-node label costs almost
    // as much as one covering the whole graph, so the cost is not the bucket. Nor is
    // it the membership structure — a sparse binary-search path and three settings of
    // the dense/sparse threshold all moved it by under 20%.
    //
    // Which leaves the possibility that the comparison was never about filtering at
    // all. `count(*)` over a bare `Expand` sums adjacency LENGTHS: O(sources), and it
    // never looks at an edge. Any predicate on the hop's endpoint must look at every
    // edge to know which endpoints to test. If that is the real difference, the cost
    // is proportional to EDGES, not to the filter, and holding the source count fixed
    // while scaling the degree will show it directly.
    section("E71: is the gap the filter, or is it visiting edges at all?");

    println!(
        "  {:>7} {:>9} {:>11} {:>10} {:>10} {:>11}",
        "degree", "sources", "edges walked", "no filter", "filtered", "ns/edge"
    );

    for deg in [2u32, 4, 8, 16] {
        let mut st = harness::social_store(rows as u32, deg);
        st.create_range_index("age");

        let bare = "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c";
        let filtered =
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c";

        // The edges the filtered plan must visit = the answer the bare count returns.
        let edges = lenke_engine::exec::run(
            &lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(bare).unwrap(), &st),
            &st,
        )
        .rows
        .iter()
        .flatten()
        .next()
        .map_or(0.0, |v| {
            format!("{v:?}")
                .trim_start_matches("Num(")
                .trim_end_matches(')')
                .parse()
                .unwrap_or(0.0)
        });

        if let (Ok((bus, _)), Ok((fus, _))) = (
            harness::time_query(bare, false, &st, cfg.reps.min(5)),
            harness::time_query(filtered, false, &st, cfg.reps.min(5)),
        ) {
            let per_edge = if edges > 0.0 {
                (fus - bus) * 1000.0 / edges
            } else {
                0.0
            };
            println!(
                "  {deg:>7} {:>9} {:>11.0} {bus:>10.1} {fus:>10.1} {per_edge:>10.2}",
                (rows / 50).max(1),
                edges
            );
        }
    }

    // E72 ------------------------------------------------------------------
    //
    // Orientation past ONE hop. `reverse_one_hop` required an `Expand` directly over a
    // `Scan`, so `(a)-[:T]->(b)-[:T]->(c) WHERE c.k > v` kept whatever direction it was
    // written in and walked the whole frontier before filtering. An earlier pass put
    // 83x on two hops, but that was BEFORE the pushdown split (E67) changed what
    // reaches an index in this exact shape, so it was re-taken here before implementing.
    //
    // The comparison is E66's: what the engine plans, against the same query written
    // backwards by hand — the best a perfect orientation could do. Both now produce the
    // SAME PLAN, which is a stronger result than two times that happen to agree.
    //
    // Measured before / after `reverse_chain`:
    //
    //   2 hops   178357us -> 2148us      83x   (at 200k nodes)
    //   3 hops   263502us ->   59.5us  4429x   (at 50k nodes — it did not finish at 200k)
    //
    // Three hops is where the rename stopped being a single swap: the permutation is
    // 0<->3 AND 1<->2, so swapping only the ends leaves the two middles crossed. That
    // returns wrong rows exactly when the middle nodes are distinguishable — which the
    // probe's fixture cannot show, so the guard for it is a unit test.
    section("E72: orienting a multi-hop pattern onto its far-side predicate");

    println!("  {:<40} {:>10}  plan", "query", "us");

    let small_plain = harness::social_store(5_000, 8);
    let mut small_seeded = harness::social_store(5_000, 8);
    small_seeded.create_range_index("age");

    let two: [(&str, &str); 6] = [
        (
            "1 hop  forwards (oriented)",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "1 hop  backwards (hand)",
            "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "2 hops forwards",
            "MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) WHERE c.age > 98 RETURN count(*) AS n",
        ),
        (
            "2 hops backwards (hand)",
            "MATCH (c:Person)<-[:KNOWS]-(b:Person)<-[:KNOWS]-(a:Person) WHERE c.age > 98 RETURN count(*) AS n",
        ),
        (
            "3 hops forwards",
            "MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person)-[:KNOWS]->(d:Person) WHERE d.age > 99.5 RETURN count(*) AS n",
        ),
        (
            "3 hops backwards (hand)",
            "MATCH (d:Person)<-[:KNOWS]-(c:Person)<-[:KNOWS]-(b:Person)<-[:KNOWS]-(a:Person) WHERE d.age > 99.5 RETURN count(*) AS n",
        ),
    ];

    for (label, q) in two {
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        // Correctness is checked on a SMALL store, perf on the big one. The control
        // has to run unoriented by construction, and at 200k the unoriented three-hop
        // form materializes 102 MILLION intermediate rows and trips the frontier limit
        // — which is the cost this section is about, but makes it useless as an
        // oracle. (The real answer guards are the unit tests; a uniform-label fixture
        // cannot see a crossed middle slot at all.)
        let want = format!(
            "{:?}",
            lenke_engine::exec::run(
                &lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &small_plain,
                ),
                &small_plain,
            )
            .rows
        );
        let got = format!(
            "{:?}",
            lenke_engine::exec::run(
                &lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &small_seeded,
                ),
                &small_seeded,
            )
            .rows
        );
        assert_eq!(want, got, "orientation changed the answer for: {q}");

        if let Ok((us, _)) = harness::time_query(q, false, &seeded, cfg.reps.min(3)) {
            println!("  {label:<40} {us:>10.1}  {}", chain_of(&opt));
        }
    }

    // E73 ------------------------------------------------------------------
    //
    // `RangeSeek`/`IndexSeek` carry a REQUIRED label, and that requirement shows up in
    // two places: a pattern written without one cannot seek, and orientation has to
    // decline an unlabelled far node because the reversed seed could never become a
    // seek. Both have been treated as facts of life.
    //
    // They may not be. The range index is GLOBAL — `store.range_lookup(key, op, value)`
    // is keyed by property, and `range_seek_ids` applies the label afterwards as a
    // post-filter over the candidates, with an explicit shortcut for when the label
    // covers every live node. So the label is a filter on a seek's OUTPUT, not part of
    // how the seek is performed.
    //
    // This priced what the requirement cost, and the answer was enough to remove it:
    //
    //   scan  labelled   (n:Person)     30.6us  ->   26.3us   (unchanged; it already sought)
    //   scan  UNLABELLED (n)           303.1us  ->   26.3us   11.5x
    //   hop   far node labelled        495.6us  ->  485.5us   (unchanged)
    //   hop   far node UNLABELLED     1710.8us  ->  447.8us    3.8x
    //
    // `MATCH (n) WHERE n.age > 98` is not an exotic query, and it could not touch an
    // index for no reason beyond the IR node demanding a label. Both seeks now carry
    // `label: Option<String>`.
    //
    // The far-node row needed a second change. Removing the label requirement means an
    // unlabelled far node CAN seed, so orientation's "no label, no reversal" gate lost
    // its stated reason — but dropping it outright regressed the unselective case 2.6x
    // (`b.age > -1` went 0.95ms to 2.44ms), because reversing something that filters
    // nothing still pays a residual check above the hop. The gate is now the thing it
    // was always standing in for: measured selectivity against E64/E65's 15.4%
    // crossover, via a CAPPED index probe so an unselective predicate costs a bounded
    // walk rather than a full one. Both cases now land right.
    section("E73: what does the REQUIRED label on a seek cost?");

    println!("  {:<40} {:>10}  plan", "query", "us");

    let labelled: [(&str, &str); 4] = [
        (
            "scan  labelled   (n:Person)",
            "MATCH (n:Person) WHERE n.age > 98 RETURN count(*) AS c",
        ),
        (
            "scan  UNLABELLED (n)",
            "MATCH (n) WHERE n.age > 98 RETURN count(*) AS c",
        ),
        (
            "hop   far node labelled",
            "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c",
        ),
        (
            "hop   far node UNLABELLED",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 98 RETURN count(*) AS c",
        ),
    ];

    for (label, q) in labelled {
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        if let Ok((us, _)) = harness::time_query(q, false, &seeded, cfg.reps.min(5)) {
            println!("  {label:<40} {us:>10.1}  {}", chain_of(&opt));
        }
    }

    // E74 ------------------------------------------------------------------
    //
    // E40 found the planner seeding a range index whenever one existed, with no check
    // on how much it would filter — so declaring an index made a BROAD query 3.7x
    // slower (320.9us unindexed against 1184.2us indexed at 49% selectivity). The
    // planner now consults the measured crossover before seeding. This is that
    // measurement re-taken, on the same shape, against the same store with and
    // without the index declared.
    //
    // What it must show: the selective query still seeds and still wins, and the broad
    // one no longer loses. If declaring an index ever costs a query time again, this
    // row goes red.
    section("E74: does declaring a range index still cost a broad query?");

    println!(
        "  {:<34} {:>11} {:>11} {:>8}  plan",
        "query", "no index", "indexed", "ratio"
    );

    for (label, q) in [
        (
            "age > 98   (1% pass, selective)",
            "MATCH (n:Person) WHERE n.age > 98 RETURN n.name AS x",
        ),
        (
            "age > 50   (49% pass, broad)",
            "MATCH (n:Person) WHERE n.age > 50 RETURN n.name AS x",
        ),
        (
            "age > 50, GROUP BY",
            "MATCH (n:Person) WHERE n.age > 50 RETURN n.dept AS d, count(*) AS c",
        ),
    ] {
        let bare = harness::time_query(q, false, &plain, cfg.reps.min(5));
        let ixed = harness::time_query(q, false, &seeded, cfg.reps.min(5));
        let opt = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &seeded,
        );
        if let (Ok((b, _)), Ok((i, _))) = (bare, ixed) {
            let ratio = if i > 0.0 { b / i } else { 0.0 };
            println!(
                "  {label:<34} {b:>11.1} {i:>11.1} {ratio:>7.2}x  {}",
                chain_of(&opt)
            );
        }
    }
}

/// The optimized plan as an operator chain, for printing next to a measurement.
fn chain_of(plan: &Plan) -> String {
    let dbg = format!("{plan:?}");
    let mut chain: Vec<&str> = Vec::new();

    for tok in dbg.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if matches!(
            tok,
            "Scan"
                | "Expand"
                | "Filter"
                | "Aggregate"
                | "Project"
                | "IndexSeek"
                | "RangeSeek"
                | "IntervalExpand"
        ) {
            chain.push(tok);
        }
    }

    chain.join(" <- ")
}
