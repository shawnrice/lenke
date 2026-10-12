//! How many heap allocations does `gql::parse` make, and of what sizes?
//!
//! Item 294 recorded `gql::parse` at ~1300ns for a 57-byte query and established the cost is
//! "structural rather than allocational", with ~82% attributed to "the scanning loop, the
//! recursive descent and the plan build" and no split between them. Item 317 split it:
//!
//!   lex alone                                    334 ns   (26%)
//!   descent + plan build                        1000 ns   (74%)
//!
//! and then bounded the two obvious suspects inside the descent, both of which came back too
//! small to be it:
//!
//!   74 keyword comparisons -- the count the descent actually performs      84 ns  (ceiling)
//!   plan.clone(), i.e. re-allocating the whole plan tree                   60 ns
//!
//! leaving ~856ns with no owner. There is no profiler on this box, so count allocations: a
//! counting global allocator says in one number whether the answer is "many small allocations"
//! (an arena / SmallVec question) or "something else entirely" (control flow, hashing, copying).
//!
//! What it found: **50 allocations and 4187 bytes for a 57-byte query**, of which 32 are tiny.
//! The sizes name them, which is why the histogram resolves the small end exactly rather than
//! bucketing it:
//!
//!   - **12 of exactly 8 bytes, all in `lex`** — one per identifier. `b[start..i].iter().collect()`
//!     reserves the char COUNT as a byte count, and Rust's first grow for a 1-byte element type is
//!     capacity 8, so a 1-to-5-character identifier allocates 8 bytes. Already one allocation
//!     each: only borrowing (`Tok<'a>`) removes them, and that needs the char pre-pass to go too.
//!   - **20 in the recursive descent, at exact string lengths** (1Bx10, 4Bx4, 5-7Bx5) — identifier
//!     `String` CLONES. Ten of them are one byte: the variable name `u`, cloned ten times for a
//!     query that mentions it three.
//!   - **7 Vec growth reallocations** — 3 for the char pre-pass, 4 for the token vector. Item 317
//!     sized both and took **1297 -> 1163 ns of parse (1.115x)**.
//!
//! Three suspects this probe ELIMINATED, each cheaper to check than to assume: the 74 keyword
//! comparisons the descent performs are 84ns (a keyword-classifying lexer's whole ceiling, 6.3%);
//! `bump()` clones every consumed token but only **5** of them carry a String; and `plan.clone()`,
//! the entire output tree re-allocated, is 9 allocations and 60ns.
//!
//! This binary exists to answer that one question. It must not be merged into `percall_probe`:
//! a counting allocator perturbs every other case in the process.
use core::alloc::{GlobalAlloc, Layout};
use core::sync::atomic::{AtomicU64, Ordering};
use std::alloc::System;

// The NDJSON fixture builder, for the decode cases below.
#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static COUNTING: AtomicU64 = AtomicU64::new(0);
/// A histogram of allocation SIZES, bucketed by size class. The size names the allocation: 48
/// bytes is a boxed enum node, 24 a short String's buffer, and a power-of-two run is one Vec
/// growing rather than many Vecs. Without it, "31 allocations" has no fix attached to it.
static HIST: [AtomicU64; 17] = [
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
];

fn bucket(size: usize) -> usize {
    match size {
        1 => 12,
        2..=3 => 13,
        4 => 14,
        5..=7 => 15,
        8 => 16,
        0 => 0,
        9..=16 => 1,
        17..=24 => 2,
        25..=32 => 3,
        33..=48 => 4,
        49..=64 => 5,
        65..=96 => 6,
        97..=128 => 7,
        129..=256 => 8,
        257..=512 => 9,
        513..=1024 => 10,
        _ => 11,
    }
}

const BUCKET_NAMES: [&str; 17] = [
    "0", "<=16", "<=24", "<=32", "<=48", "<=64", "<=96", "<=128", "<=256", "<=512", "<=1k", ">1k",
    "1B", "2-3B", "4B", "5-7B", "8B",
];

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Ordering::Relaxed) == 1 {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
            HIST[bucket(layout.size())].fetch_add(1, Ordering::Relaxed);
        }

        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // A realloc is a grow, which is what a Vec without `with_capacity` does repeatedly --
        // counted separately because "one Vec that grew six times" and "six Vecs" cost
        // differently and point at different fixes.
        if COUNTING.load(Ordering::Relaxed) == 1 {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
            HIST[bucket(new_size)].fetch_add(1, Ordering::Relaxed);
        }

        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn count<T>(label: &str, f: impl Fn() -> T) {
    // Warm first, OUTSIDE the counter: a first call can allocate lazily-initialised statics that
    // every later call reuses, and counting those would blame the query for the process.
    let _ = f();

    ALLOCS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    for h in &HIST {
        h.store(0, Ordering::Relaxed);
    }
    COUNTING.store(1, Ordering::Relaxed);

    let out = f();

    COUNTING.store(0, Ordering::Relaxed);
    core::hint::black_box(&out);

    let sizes: Vec<String> = HIST
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            let n = h.load(Ordering::Relaxed);
            if n == 0 {
                None
            } else {
                Some(format!("{}x{}", BUCKET_NAMES[i], n))
            }
        })
        .collect();

    println!(
        "  {:<52} {:>4} allocs {:>7} B   {}",
        label,
        ALLOCS.load(Ordering::Relaxed),
        BYTES.load(Ordering::Relaxed),
        sizes.join(" "),
    );
}

fn main() {
    let hit = "MATCH (u:User) WHERE u.name = 'name7' RETURN u.score AS s";
    let tiny = "MATCH (u) RETURN 1 AS s";
    let two_hop = "MATCH (a:User)-[:KNOWS]->(b:User)-[:KNOWS]->(c:User) RETURN count(*) AS c";

    println!("=== allocations per gql::parse (item 317) ===");
    println!("  the 57-byte serving query, and two others for the shape dependence\n");

    count("parse: MATCH + WHERE + RETURN (57 bytes, 18 toks)", || {
        lenke_engine::gql::parse(hit).expect("parses")
    });
    count("parse: MATCH (u) RETURN 1 AS s (tiny)", || {
        lenke_engine::gql::parse(tiny).expect("parses")
    });
    count("parse: a two-hop count", || {
        lenke_engine::gql::parse(two_hop).expect("parses")
    });

    // The two pieces already priced, for scale: how much of the allocation count is the lexer's.
    count("s.chars().collect::<Vec<char>>() alone", || {
        hit.chars().collect::<Vec<char>>()
    });

    let plan = lenke_engine::gql::parse(hit).expect("parses");
    count("plan.clone() -- the whole tree re-allocated", || {
        plan.clone()
    });

    // --- the NDJSON decode (items 329/330) ---
    //
    // Item 329 priced borrowing the staged records (`NodeRec`/`EdgeRec` hold a fresh `String`
    // per id, label and property key) at 1.2-1.4x of the decode, from a MICRO that put the
    // build-up at 161ms. Item 330 then removed ~8M allocate-and-free pairs from the same parse
    // in situ and measured 35ms -- 5-7ns a pair, not the 25-40 the micro implied -- so that
    // estimate needs re-deriving from a COUNT rather than a micro. This is the count.
    //
    // Read it by SIZE bucket: a record `String` is a few bytes (an id `v12345`, a label
    // `Person`, a key `k0`), the records' `Vec`s are tens, and the store's columns are the >1k
    // rows. So the small buckets ARE the borrow target, and their total times the measured
    // per-pair cost is the win -- no micro in the loop.
    let n = 50_000;
    println!("\n=== allocations per NDJSON decode (items 329/330) ===");
    println!("  {n} nodes x2 props, with and without 5 edges/node\n");

    let nodes_only = harness::social_ndjson(n, 2, 0);
    count("from_ndjson: nodes x2 props", || {
        lenke_engine::ndjson::from_ndjson(&nodes_only).expect("decodes")
    });
    drop(nodes_only);

    let with_edges = harness::social_ndjson(n, 2, 5);
    count("from_ndjson: nodes+5edges x2 props", || {
        lenke_engine::ndjson::from_ndjson(&with_edges).expect("decodes")
    });

    // A bulk count says HOW MANY; it does not say WHICH. Differencing SMALL documents does not
    // answer that -- tried, and at a few lines the store's own HashMap growth swamps the line
    // cost, so a per-line difference comes out negative in places. What does work is varying
    // ONE field of the fixture at the same 50k scale, where growth amortizes to nothing: each
    // row below changes exactly one thing, so the bucket that moves by ~50k names itself.
    println!("\n  attribution: vary one field of the fixture, at the same {n} lines\n");
    for props in [0usize, 1, 2, 4] {
        let text = harness::social_ndjson(n, props, 0);
        count(&format!("nodes, {props} props (2-byte keys k0..)"), || {
            lenke_engine::ndjson::from_ndjson(&text).expect("decodes")
        });
    }
    // The edge side: `social_ndjson` always writes one 1-byte prop key (`w`), and the bulk row
    // above shows THREE 1-byte allocations per edge. Widening just that key says how many of
    // the three are the key.
    for key in ["w", "ww", "wwww"] {
        let text: String = (0..n)
            .map(|i| {
                format!(
                    r#"{{"type":"node","id":"v{i}","labels":["Person"],"properties":{{}}}}"#
                )
            })
            .chain((0..n).map(|i| {
                format!(
                    r#"{{"type":"edge","id":"e{i}","labels":["KNOWS"],"from":"v{i}","to":"v{}","properties":{{"{key}":1}}}}"#,
                    (i + 1) % n
                )
            }))
            .collect::<Vec<_>>()
            .join("\n");
        count(
            &format!("nodes+1edge, edge prop key {:?} ({}B)", key, key.len()),
            || lenke_engine::ndjson::from_ndjson(&text).expect("decodes"),
        );
    }
}
