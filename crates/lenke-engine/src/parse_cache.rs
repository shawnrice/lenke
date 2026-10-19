//! A bounded cache of PREPARED plans, keyed on query text, so a serving call stops re-deriving a
//! plan from text it has already seen.
//!
//! `lnk_query` parsed and optimized on every call. Audit item 318 priced that: a native serving
//! call is `gql::parse` 1163ns + `optimize_indexed` 334ns + `exec` ~300ns, so **83% of it
//! re-derives a plan**, and `bench:usage`'s indexed point lookup read **ts 1.20M ops/s against the
//! native engine's 239.9k** — the pure-TypeScript engine beating this one by 5x, because it has had
//! this cache since audit item 228.
//!
//! The policy is item 228's, deliberately, down to the cap: that one has already been measured and
//! mutation-tested, and the two decisions that look like refinements are the ones that matter.
//!
//! # Why a PREPARED plan
//!
//! A cache has to hold one plan and reuse it for different parameter values, so it must be parsed
//! in prepared mode (`$n` stays an `Expr::Param`, bound per run) rather than direct mode (`$n` is
//! substituted to an `Expr::Lit` DURING the parse). Those are two different parses of the same
//! text, and item 318 verified they converge: twenty shapes, against a store with and without an
//! index on the gated key, and the optimized plans are identical for every one except a parameter
//! in `LIMIT`/`SKIP` (prepared mode refuses it) and ~~a parameter in an INSERT value~~ — **the
//! INSERT divergence is GONE as of item 596**: `bind::bind_plan` re-applies
//! `ir::lower_insert_literal` once the params are bound, so the bound prepared plan IS the literal
//! `Insert` the direct path produces, and a parameterized INSERT is admitted like anything else.
//! It had been recorded here as self-excluding, which was true and cost the whole cache benefit
//! on that shape: self-exclusion means re-parsing on every call, plus parameter marshalling,
//! which `bench:usage` showed as the parameterized write being SLOWER than the interpolated one.
//! Varying the parameter VALUE (a 2-element list, a 40-element one past item 267's chain
//! cap, NULL, a cross-type number, a cross-type list) changes no plan in either mode, because both
//! hand the optimizer an `Expr::Lit` before it runs.
//!
//! # Why admission VERIFIES rather than carving out
//!
//! The INSERT divergence could be excluded by a rule about INSERT. It is not, because a rule
//! covers the divergence that was found and nothing else. Instead a text is admitted only if its
//! prepared plan, bound to the parameters in hand, is **structurally identical to what the direct
//! path produces** — and a text that fails that check is remembered as refused and always takes
//! the direct path. The INSERT case excluded itself until item 596 removed the divergence, and so
//! does any divergence a later change introduces: the cache cannot start returning a different
//! plan than the uncached path without this comparison failing first. That is load-bearing in a
//! way item 596's mutation testing made concrete — dropping the `Plan::Row` guard on the
//! re-lowering produces a plan that would insert ONCE instead of once per input row, and this
//! check refuses it rather than caching it, so the only observable damage is a lost cache slot.
//!
//! The comparison costs one extra parse and two `Debug` renders, ONCE, on the call that admits a
//! text. Nothing on a hit.
//!
//! Single-threaded by design, like [`crate::prepared`] — bun:ffi and wasm drive the ABI on one
//! thread — so this is a `thread_local` and needs no lock on the hot path.

use crate::ir::Plan;
use crate::value::Value;
use std::cell::RefCell;
use std::collections::HashMap;

/// Item 228 chose 64 and explained why: a true-LRU hit costs a delete plus an insert, which is
/// affordable at this size, and a larger cap would have meant FIFO eviction — free per hit, but it
/// keeps the wrong entries.
const CAP: usize = 64;

/// An admitted plan and its bookkeeping. Boxed inside [`Slot`] because a `Plan` is ~248 bytes
/// and a `Refused` entry would otherwise carry a plan-sized hole: the allocation is paid once per
/// ADMITTED text, never per call.
struct Admitted {
    /// Stored and VERIFIED on a hit rather than folded into the key. The expression-depth
    /// ceiling is a construction-time graph setting that almost never varies, and a composite
    /// key would mean building a string on the hot path to avoid a collision that costs one
    /// integer compare to detect.
    max_depth: usize,
    /// LRU position. A `HashMap` has no insertion order to evict by, so the order is explicit
    /// — which keeps a hit O(1) (bump a counter) and pays the O(CAP) scan only when a full
    /// cache has to evict.
    stamp: u64,
    plan: Plan,
}

/// What the map holds for a text: a plan to reuse, or a standing decision not to.
enum Slot {
    Cached(Box<Admitted>),
    /// The prepared parse is refused, or its plan does not match the direct one. Remembering this
    /// is what keeps a `LIMIT $k` query from paying a FAILED prepared parse on top of its real
    /// one, every call, forever.
    ///
    /// In the same map as a cached plan, not a second set, because the all-miss path has to be as
    /// cheap as possible and two sets meant hashing the query text twice to learn nothing.
    Refused,
}

/// The admission filter: a fixed ring of query-text HASHES, with no allocation and nothing to
/// evict.
///
/// Item 228's TypeScript twin uses a `Set<string>`, because there the string already exists and
/// the cost it was avoiding was GC retention of a ~2KB AST. In Rust the allocation IS the cost:
/// the first version of this filter was a `HashSet<String>`, and it made the all-miss row
/// (`INSERT (:Event {name: 'ev${i}'})`, fresh text every call) **0.883x** — two `String`
/// allocations per call, one to insert the text and one to clone the victim it evicted.
///
/// A hash collision admits a text one sighting early. That is harmless: the filter decides WHEN a
/// text is considered, and correctness comes from the admission check that follows it.
struct Filter {
    hashes: [u64; CAP],
    cursor: usize,
}

impl Default for Filter {
    fn default() -> Self {
        Self {
            hashes: [0; CAP],
            cursor: 0,
        }
    }
}

fn hash_of(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);

    // 0 marks an empty slot, so never hand it back as a real hash.
    h.finish() | 1
}

impl Filter {
    /// Record a sighting. `true` means this was the FIRST, so the caller should not admit yet.
    fn note(&mut self, hash: u64) -> bool {
        if self.hashes.contains(&hash) {
            return false;
        }

        self.hashes[self.cursor] = hash;
        self.cursor = (self.cursor + 1) % CAP;

        true
    }

    fn forget(&mut self, hash: u64) {
        for h in &mut self.hashes {
            if *h == hash {
                *h = 0;
            }
        }
    }

    fn len(&self) -> usize {
        self.hashes.iter().filter(|h| **h != 0).count()
    }
}

#[derive(Default)]
struct Cache {
    slots: HashMap<String, Slot>,
    seen_once: Filter,
    clock: u64,
}

impl Cache {
    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    /// One lookup answers both questions a miss has to ask: is there a plan, and is this text
    /// known to be uncacheable? `Hit` carries the UNBOUND prepared plan, cloned; the caller binds.
    fn look_up(&mut self, text: &str, max_depth: usize) -> Lookup {
        let stamp = self.tick();

        match self.slots.get_mut(text) {
            Some(Slot::Refused) => Lookup::Refused,
            Some(Slot::Cached(a)) => {
                if a.max_depth != max_depth {
                    return Lookup::Miss;
                }

                a.stamp = stamp;

                Lookup::Hit(a.plan.clone())
            }
            None => Lookup::Miss,
        }
    }

    fn evict_if_full(&mut self, text: &str) {
        if self.slots.len() < CAP || self.slots.contains_key(text) {
            return;
        }

        // A `Refused` slot has no stamp and is cheap to re-derive, so it goes first; otherwise the
        // least recently used plan.
        let victim = self
            .slots
            .iter()
            .min_by_key(|(_, slot)| match slot {
                Slot::Refused => 0,
                Slot::Cached(a) => a.stamp.saturating_add(1),
            })
            .map(|(k, _)| k.clone());

        if let Some(victim) = victim {
            self.slots.remove(&victim);
        }
    }

    fn admit(&mut self, text: &str, max_depth: usize, plan: Plan) {
        self.seen_once.forget(hash_of(text));
        self.evict_if_full(text);

        let stamp = self.tick();

        self.slots.insert(
            text.to_string(),
            Slot::Cached(Box::new(Admitted {
                max_depth,
                stamp,
                plan,
            })),
        );
    }

    fn refuse(&mut self, text: &str) {
        self.seen_once.forget(hash_of(text));
        self.evict_if_full(text);
        self.slots.insert(text.to_string(), Slot::Refused);
    }
}

/// Deliberately NOT boxed, unlike [`Slot`]: this is a by-value return on the hot path, consumed
/// immediately by the caller. Boxing `Hit` would add an allocation to every HIT — the thing this
/// whole module exists to make cheap — to save 248 bytes of stack that is about to be dropped.
#[allow(clippy::large_enum_variant)]
enum Lookup {
    Hit(Plan),
    Refused,
    Miss,
}

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}

/// The cache's occupancy, the admission filter's, the refusal set's, and the cap.
///
/// Exported because BOUNDEDNESS is the property this was chosen for, and because item 228 recorded
/// the trap: **"single-use texts do not grow the cache" is true either way once the cache sits at
/// its cap**, so a test asserting that passes with the admission filter deleted. Asserting on
/// `seen` instead is what gives the filter teeth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub size: usize,
    pub seen: usize,
    pub refused: usize,
    pub cap: usize,
}

pub fn stats() -> Stats {
    CACHE.with(|c| {
        let c = c.borrow();

        Stats {
            size: c
                .slots
                .values()
                .filter(|s| matches!(s, Slot::Cached(_)))
                .count(),
            seen: c.seen_once.len(),
            refused: c
                .slots
                .values()
                .filter(|s| matches!(s, Slot::Refused))
                .count(),
            cap: CAP,
        }
    })
}

/// Drop everything. For tests, which must not inherit another test's occupancy.
pub fn clear() {
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.slots.clear();
        c.seen_once = Filter::default();
    });
}

/// Is the prepared parse of `text` equivalent to `direct` for `params`? Returns the UNBOUND
/// prepared plan when it is — that is what gets stored, since the bound copy is specific to the
/// values in hand.
fn prepared_equivalent(
    text: &str,
    params: &[(String, Value)],
    max_depth: usize,
    direct: &Plan,
) -> Option<Plan> {
    // A now-function folds the host's `$__now` clock into the plan AT PARSE TIME, so such a plan
    // is not a function of (text, max_depth) at all — and a prepared parse, which runs with no
    // params, folds it to `Lit(Null)`. The equality check below CANNOT catch it: it compares one
    // parameter set, and the sighting that admits a text may be one with no clock injected, where
    // both sides agree on `Lit(Null)` and the text is admitted with null baked in as the clock.
    // Every later call then reads that null. The GQL conformance differential caught exactly
    // that (`RETURN current_date AS d`, first called with no clock and then with a wired one), and
    // it is the reason this is a refusal by SHAPE rather than another comparison.
    if crate::gql::text_may_read_clock(text) {
        return None;
    }

    let prepared = crate::gql::parse_prepared_limited(text, max_depth).ok()?;
    let mut bound = prepared.clone();

    crate::bind::bind_params(&mut bound, params).ok()?;

    // `Plan` derives `Clone, Debug` and not `PartialEq`, so the comparison goes through `Debug`.
    // That is the right currency anyway: `Debug` is what item 318's probe compared, and a plan
    // whose rendering is identical cannot route differently.
    if format!("{bound:?}") == format!("{direct:?}") {
        Some(prepared)
    } else {
        None
    }
}

/// Parse `text` for a run, through the cache. Equivalent to
/// [`crate::gql::parse_with_params_limited`] in every case, and that is enforced rather than
/// asserted — see the module header.
pub fn parse_for_run(
    text: &str,
    params: &[(String, Value)],
    max_depth: usize,
) -> Result<Plan, String> {
    match CACHE.with(|c| c.borrow_mut().look_up(text, max_depth)) {
        Lookup::Hit(mut plan) => {
            // The direct path's unbound-parameter error carries the wire code inline and `bind_params`
            // does not, so prefix it here. `ffi.rs` recovers `E_MISSING_PARAMETER` from the direct
            // arm by `strip_prefix`, and a cached call must hand it the same string rather than rely
            // on the caller to special-case which arm produced it.
            return match crate::bind::bind_params(&mut plan, params) {
                Ok(()) => Ok(plan),
                Err(e) => Err(format!("E_MISSING_PARAMETER: {e}")),
            };
        }
        Lookup::Refused => {
            return crate::gql::parse_with_params_limited(text, params, max_depth);
        }
        Lookup::Miss => {}
    }

    // The direct parse is what this call returns either way — on a miss the cache is a side
    // effect, never a different answer. A parse that FAILS stores nothing: a failing query is not
    // a hot path, and remembering the failure would make the first one permanent for that text.
    let direct = crate::gql::parse_with_params_limited(text, params, max_depth)?;

    if CACHE.with(|c| c.borrow_mut().seen_once.note(hash_of(text))) {
        return Ok(direct);
    }

    // A repeat: it has earned a slot, if the prepared parse agrees.
    match prepared_equivalent(text, params, max_depth, &direct) {
        Some(prepared) => CACHE.with(|c| c.borrow_mut().admit(text, max_depth, prepared)),
        None => CACHE.with(|c| c.borrow_mut().refuse(text)),
    }

    Ok(direct)
}

// ---------------------------------------------------------------------------------------------
// The GREMLIN twin (audit item 361).
//
// `lnk_query`'s Gremlin arm called `gremlin::parse` on every call, where its GQL sibling has had
// this cache since item 318. Measured on a serving-sized traversal: parse ~725ns and
// `optimize_indexed` ~390 against `exec::try_run`'s ~325, so **~78% of the in-engine work was
// re-derived every call** — the same proportion item 318 cited for GQL (83%) before building the
// cache above. Item 360 found the Gremlin lexer had missed item 317's fix; this is the same drift,
// one layer up, and the two surface languages are supposed to be parallel.
//
// # Why this one needs no admission CHECK
//
// The cache above verifies each text, because a GQL plan is not a function of the text alone: a
// parameter can be substituted during the parse, and a now-function folds the host's `$__now`
// clock in. Neither applies here. `gremlin::parse(query: &str) -> Result<Plan, String>` takes
// nothing but the text, its one limit (`MAX_TRAVERSAL_DEPTH`) is a compile-time constant, and
// **the Gremlin ABI arm refuses parameters outright** ("Gremlin query parameters are not
// implemented yet"), which is also what makes a clock fold impossible — `$__now` arrives as a
// PARAMETER. So the parse is a pure function of its text and the key is the text.
//
// That is an argument from the signature, so it has an expiry: **if Gremlin ever accepts
// parameters or grows a step that reads ambient state at parse time, this cache needs the
// admission check its GQL sibling has.** The test `a_gremlin_parse_is_a_function_of_its_text`
// compares cached against uncached across shapes, which is what would fail first.
//
// The one-sighting admission filter IS kept: a workload of unique traversals must not pay an
// insert and an eviction per call (item 228's `HashSet<String>` finding — the all-miss row went
// 0.883x when admission allocated).
/// The sighting filter, DIRECT-INDEXED rather than the ring [`Filter`] above uses.
///
/// Measured, and the reason it is not the shared one: the ring answers a sighting with
/// `hashes.contains(&hash)`, a linear scan of all 64 slots, and that scan is the whole cost of a
/// MISS. On a workload of entirely fresh traversal texts the cache read **379 -> 438 ns, 1.16x
/// WORSE** than parsing directly, with near-disjoint ranges.
///
/// That shape is not hypothetical here, and this is the asymmetry that forced the change:
/// **Gremlin accepts no parameters on this path, so a client varying a value has to emit different
/// TEXT every call** — `has('name','name7')` against `has('name','name8')`. A value-varying
/// serving workload is therefore all-miss by construction, where the GQL sibling's equivalent is
/// one cached text with bound params. The ring's cost is affordable for GQL and not for Gremlin,
/// for a reason that is about parameters and not about either cache.
///
/// Indexing by `hash % CAP` makes a sighting one load and one compare. A collision evicts another
/// text's sighting, which delays an admission by one call and loses nothing — the same tolerance
/// the ring already accepts, since it admits a colliding text one sighting early.
struct SightingSlots {
    hashes: [u64; CAP],
}

impl Default for SightingSlots {
    fn default() -> Self {
        Self { hashes: [0; CAP] }
    }
}

impl SightingSlots {
    /// Record a sighting. `true` means this was the FIRST, so the caller should not admit yet.
    fn note(&mut self, hash: u64) -> bool {
        let slot = &mut self.hashes[(hash % CAP as u64) as usize];

        if *slot == hash {
            return false;
        }

        *slot = hash;

        true
    }

    fn forget(&mut self, hash: u64) {
        let slot = &mut self.hashes[(hash % CAP as u64) as usize];

        if *slot == hash {
            *slot = 0;
        }
    }

    fn len(&self) -> usize {
        self.hashes.iter().filter(|h| **h != 0).count()
    }
}

#[derive(Default)]
struct GremlinCache {
    slots: HashMap<String, (u64, Plan)>,
    seen_once: SightingSlots,
    clock: u64,
}

impl GremlinCache {
    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    fn look_up(&mut self, text: &str) -> Option<Plan> {
        let stamp = self.tick();
        let (slot_stamp, plan) = self.slots.get_mut(text)?;
        *slot_stamp = stamp;

        Some(plan.clone())
    }

    fn evict_if_full(&mut self, text: &str) {
        if self.slots.len() < CAP || self.slots.contains_key(text) {
            return;
        }

        let victim = self
            .slots
            .iter()
            .min_by_key(|(_, (stamp, _))| *stamp)
            .map(|(k, _)| k.clone());

        if let Some(victim) = victim {
            self.slots.remove(&victim);
        }
    }

    fn admit(&mut self, text: &str, plan: Plan) {
        self.seen_once.forget(hash_of(text));
        self.evict_if_full(text);

        let stamp = self.tick();

        self.slots.insert(text.to_string(), (stamp, plan));
    }
}

thread_local! {
    static GREMLIN_CACHE: RefCell<GremlinCache> = RefCell::new(GremlinCache::default());
}

/// The Gremlin cache's occupancy and the admission filter's. Separate from [`stats`] because the
/// two caches are separate, and because a test that asserts on the wrong one would pass for the
/// wrong reason.
#[must_use]
pub fn gremlin_stats() -> Stats {
    GREMLIN_CACHE.with(|c| {
        let c = c.borrow();

        Stats {
            size: c.slots.len(),
            seen: c.seen_once.len(),
            refused: 0, // no refusal state: there is nothing to refuse (see the module note)
            cap: CAP,
        }
    })
}

/// Drop everything. For tests, which must not inherit another test's occupancy.
pub fn clear_gremlin() {
    GREMLIN_CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.slots.clear();
        c.seen_once = SightingSlots::default();
    });
}

/// Parse a Gremlin traversal for a run, through the cache. Equivalent to
/// [`crate::gremlin::parse`] in every case — see the note above for why that needs no per-text
/// verification here, and what would invalidate the argument.
pub fn parse_gremlin_for_run(text: &str) -> Result<Plan, String> {
    if let Some(plan) = GREMLIN_CACHE.with(|c| c.borrow_mut().look_up(text)) {
        return Ok(plan);
    }

    // The direct parse is what this call returns either way — on a miss the cache is a side
    // effect, never a different answer. A FAILING parse stores nothing, for the GQL arm's reason:
    // a failing traversal is not a hot path, and remembering it would make the first failure
    // permanent for that text.
    let plan = crate::gremlin::parse(text)?;

    if GREMLIN_CACHE.with(|c| c.borrow_mut().seen_once.note(hash_of(text))) {
        return Ok(plan);
    }

    GREMLIN_CACHE.with(|c| c.borrow_mut().admit(text, plan.clone()));

    Ok(plan)
}

#[cfg(test)]
mod tests;
