# Working in this repo

## The two surface languages: ISO-GQL and Gremlin

lenke implements exactly two query languages, and both lower to one `ir::Plan` run by
one `exec`:

- **ISO-GQL** — the ISO/IEC 39075:2024 standard graph query language (`MATCH … RETURN`,
  `INSERT`, `_MERGE`, `CALL`, …). This is **NOT Cypher.** Cypher is a _different_,
  Neo4j-specific language that inspired GQL but diverges from it in syntax, semantics, and
  scope. Do not reason about the GQL engine using Cypher knowledge, Cypher docs, or "how
  Neo4j does it" — Cypher is at most a loose analogy, **never** the contract. When a GQL
  question comes up ("is this valid?", "what does this mean?", "should this correlate
  per-row?"), answer it from the ISO grammar/semantics, not from Cypher. (This has been
  gotten wrong many times — GQL's `CALL` correlation, laterality, and procedure model in
  particular are ISO's, not Cypher's.)
- **Gremlin** — the Apache TinkerPop traversal language (`g.V().out()…`).

The two are intentionally parallel (a user picks one); parallel names across them are by
design, not a collision.

### Authoritative grammars — consult for VERIFICATION, do not copy

When you need to confirm a production, a keyword, or a syntactic shape, read the
authoritative grammar rather than trusting memory, prose docs, or AI/search summaries
(which confabulate GQL/Gremlin specifics). We implement these languages independently and
lower them to our own IR — we do **not** copy grammar text, vendor code, or "features"
into this repo. These are read-only references for checking that our surface syntax is
faithful; nothing from them is vendored here.

- **ISO-GQL grammar:**
  - The ISO BNF digital artifact — FREE and authoritative (the spec _text_ is paywalled,
    the grammar is not):
    `https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en).bnf.txt`
  - TuGraph `gql-grammar` — an ANTLR4 rendering of 39075 (`GQLLexer.g4` / `GQLParser.g4`),
    Apache-2.0, convenient to navigate: `https://github.com/TuGraph-family/gql-grammar`
  - See also `docs/conformance/references.md` (Ultipa function-semantics docs, Microsoft
    Fabric Graph as a GA'd ISO-GQL implementation, Neo4j's GQL-conformance appendix for
    Feature IDs).
- **Gremlin grammar:** Apache TinkerPop `Gremlin.g4`
  (`gremlin-language/src/main/antlr4/Gremlin.g4`), Apache-2.0:
  `https://github.com/apache/tinkerpop`. For runtime ground-truth semantics, run a real
  TinkerPop console (`podman run -i tinkerpop/gremlin-console < script.groovy`).

Both ANTLR grammars are Apache-2.0 (permissive); referencing them to verify syntax is
fine. Do not paste their text into repo files, and do not treat "TinkerPop/TuGraph does X"
as license to copy an implementation — verify the _shape_, then build it our way.

## Benchmarks: look before you build

The engine's benchmarks live under `crates/lenke-engine/examples/`, indexed by
question in `examples/README.md`. **Read the README (and the relevant module
header) before writing a new one** — your question is very likely already a case.

The corpus is a small set of themed group binaries (`ingest_bench`, `query_bench`,
`storage_bench`, `value_bench`, `algo_bench`, `scale_bench`), each with selectable
cases (`-- <substring>`), plus **`bench_all`** which runs every group in one
process for a regression sweep. They share one harness (`examples/support/`:
min-of-N timing, a dep-free deterministic LCG, common fixtures). Three focused
probes stay standalone because each has a bespoke fixture:

- `expand_bench` — the adjacency / edge-type question: what does a type-filtered
  `expand` pay to scan a node's whole adjacency and filter by edge type? It scales
  with degree and with how many types the degree spans (a selective type over a
  high-degree, many-type node is where an index could win; a degree-4 single-type
  fixture is where it can only lose).
- `interval_bench` — the bitemporal question: what does an "as of T" query pay to
  expand all of a node's edges and post-filter by validity interval, vs. an
  interval-index seek?
- `spelling_probe` — equivalent-spelling plan + perf coverage; see the section
  below.

Writing a new benchmark feels like progress and reading three file headers feels
like overhead. It is the other way round — re-deriving a question one of these
already answers is the expensive path. Add a new example only when the question
genuinely is not covered.

(This corpus is the consolidation of the ~40 separate example/ignored-test benches
that lived in the retired `lenke-core` crate. A few questions are still deferred —
the eval-vs-columnar floor needs crate-private `eval_vec`, temporal-column cost
needs host `Temporal` construction, and the AML/HRIS domain workloads are large
bespoke fixtures; see `examples/README.md`. The migration-era A/B benches
[`cross_engine_shortcuts`, the `arm_audit` family] are not coming back.)

### Three engines, two harnesses

Rust examples measure the **native** build only. They compile for
`wasm32-unknown-unknown` but cannot run there — `Instant::now()` panics (no
clock), no stdout, no runner — and they cannot reach the pure-TS engine at all.

For **wasm** or **pure-TS**, or to compare engines:

```
cd packages/native && bun run bench          # ts, ffi and wasm side by side
BENCH_ENGINES=ts,wasm bun run bench
BENCH_N=1000000 bun run bench
```

Roughly: the Rust core is 1.5-4x pure-TS depending on workload, and wasm gives
up about a third of that. The gap is widest on edge-heavy ingest and traversal —
which is where most optimization work lands, so those wins do not reach pure-TS
users. Check both when changing anything shared.

`bun run bench:usage` is the serving counterpart: small operations against a warm
graph, including interleaved read/write. Bulk throughput and per-operation cost
are different questions and a change can help one while hurting the other —
interleaving a write with a traversal already costs ~2.5x the traversal alone,
because a write invalidates the read-side snapshot.

### Before trusting a number

Each of these is here because a wrong conclusion was drawn and committed first.

- **Sweep the size.** Cache-resident and not are different questions; the
  transition is between 200k and 1M elements. A faster hash measured −5% at 200k
  and nothing at 1M.
- **Match the fixture to the claim.** One edge per node is sparse — per-edge costs
  scale with the edge:node ratio, per-node costs do not. A change measured flat at
  1:1 and −5% at 5:1. Likewise degree: an adjacency change that only helps
  low-degree vertices was judged against a degree-4 fixture, where it can only
  lose.
- **Give edges ids.** `encode` emits them, so every reloaded snapshot has them.
  Omitting them skips the external-id path entirely.
- **Match sample counts on both sides**, and prefer min or p25 over the mean.
  Several conclusions here were single-run against single-run and did not survive
  repetition.
- **Know the noise floor.** Some rows range 2x for the same binary. Anything under
  ~10% needs its own isolated harness, and "obviously correct so it must be
  faster" is not evidence — several such changes measured neutral or worse.

Record rejected optimizations with their numbers, next to the code they would
have changed. Several have been re-attempted otherwise.

### Equivalent spellings must cost the same

Every index-seeding bug found in the old engine had one shape: the planner
recognized one spelling of a predicate and scanned for another that meant exactly
the same thing — `$x = u.k` vs `u.k = $x`, `k = $a OR k = $b` vs `k IN [$a, $b]`, a
clause `WHERE` vs an inline `{k: $x}`, `5 <= u.n` vs `u.n >= 5`. Each cost 100-300x
and each returned the correct answer, so no correctness test could catch it.

This engine lowers BOTH GQL and Gremlin to one `ir::Plan` and runs one `exec`, so
speed is a property of the optimized plan, not the surface syntax — two spellings
that optimize to the same plan cannot differ. The `spelling_probe` example checks
that claim directly: for each group of queries that should be equivalent it prints
the canonicalized optimized plan and the measured time, and flags any group whose
members disagree on either. A plan mismatch is the real signal; the time is the
backstop. When adding a predicate form to the planner, add its spellings there.

## Gates

`bun run lint` and `cargo clippy --all-targets -- -D warnings` are separate from
`bun run fmt` (oxfmt) and `cargo fmt`. Run each as **its own command** and check
its exit code — piping clippy into `grep -c` and chaining with `&&` takes the
exit status from `grep`, which succeeds when it finds errors. That has let broken
lint through twice.

### Changing a planner rewrite

The optimizer has its own invariant, separate from cross-engine byte-identity and
guarded separately: **optimizing must not change the answer.** It is fuzzed in
`crates/lenke-engine/src/opt/rewrite_fuzz.rs` — generated plans over a generated
graph, raw vs optimized, compared as multisets.

```
cargo test --release --manifest-path crates/lenke-engine/Cargo.toml rewrite_fuzz
LENKE_OPT_FUZZ_SEEDS=200000 cargo test --release ... rewrite_fuzz   # deeper sweep
```

Three rules when you add or change a rewrite, all learned the hard way:

- **Mutate it and check the fuzzer catches it.** It passed on its first run, and so
  does a test that checks nothing. Four historical wrong-answer bugs were
  re-introduced to prove it had teeth; two of them needed the generator widened
  first. A generative test whose teeth were never verified is worse than no test,
  because it is believed.
- **Run every mutant under a timeout AND a memory cap.** A mutant is arbitrary broken
  code, so it can hang or allocate without bound — treat that as the normal case, not
  the exception. On 2026-09-28 an off-by-one on the block bound in
  `pull_top_output_streamed` (`min(ids.len())` → `min(ids.len() - 1)`) made `start = end`
  stop advancing: the loop pushed a `Batch` per iteration forever, filled RAM, then filled
  the 192 GB swapfile, and nothing killed it. The machine needed a hard reboot. A loop
  bound, a `while` condition and an index cap are where an off-by-one stops being a wrong
  answer and becomes non-termination.

  ```bash
  # BUILD FIRST, uncapped — rustc and the linker want GBs, and a cold compile inside the
  # cap would OOM for reasons that have nothing to do with the mutant.
  cargo build --release --manifest-path crates/lenke-engine/Cargo.toml --tests

  # Linux. Both limits are load-bearing and they catch DIFFERENT failures:
  #   MemoryMax    — runaway allocation. Verified: a bomb dies in <1s, exit 137.
  #   MemorySwapMax=0 — makes that kill immediate instead of an hours-long swap crawl.
  #   timeout      — an infinite loop that does NOT allocate never trips MemoryMax at
  #                  all. Verified: exit 124.
  timeout 600 systemd-run --user --scope -q \
    -p MemoryMax=16G -p MemorySwapMax=0 \
    cargo test --release --manifest-path crates/lenke-engine/Cargo.toml <filter>

  # macOS — no cgroups, so the timeout is the ONLY real protection. `timeout` is GNU
  # coreutils (often installed as `gtimeout`); there is no portable RSS cap, and
  # `ulimit -v` bounds ADDRESS SPACE, which Rust allocators over-reserve, so it
  # false-positives more than it protects.
  timeout 600 cargo test --release --manifest-path crates/lenke-engine/Cargo.toml <filter>
  ```

  **Why 16G and not less.** This is an in-memory database being fuzzed, so the tests
  legitimately need room — but nowhere near the machine. Measured peak RSS via the cgroup's
  `memory.peak`: **1.86 GB** for the whole suite (752 tests, including the 20,000-node
  fixtures) and **1.53 GB** for `LENKE_OPT_FUZZ_SEEDS=200000`. So 16G is ~8x the real
  ceiling — ample for an ad-hoc hunt at 50k-100k nodes — while leaving ~45 of this box's
  61 GB free, which is what keeps the machine usable while it runs. If a run genuinely
  needs more, RAISE the number deliberately and say why; do not drop the cap.

  Four rules that follow:

  - **A timeout (124) or an OOM kill (137) IS the mutant being caught.** Do not investigate
    it as a harness failure — a mutant that cannot terminate is one the test would have
    caught. Both codes are distinguishable from a test failure, so check them.
  - **Keep the pristine copy under `target/`** (gitignored, and it survives the reboot that
    a runaway mutant may force). `/tmp` does not: the scratchpad was wiped by the reboot
    and the file had to be reconstructed by hand from `git diff`.
  - **Restore before applying the next mutant, never only after the loop.** An interrupted
    loop leaves the mutant in the tree, and `git diff` is then the only thing standing
    between it and a commit.
  - **Prove the harness kills before trusting it with a mutant.** One allocator bomb and
    one bare `while true` under the cap, checking for 137 and 124, costs seconds and is the
    difference between a safety net and the belief in one.

- **A passing integration probe is not evidence of correctness.** The probes in
  `examples/` do assert answers, and they passed while the engine returned wrong
  rows — three times. Their fixtures give every node the same label and ask for
  `count(*)`, and a planner rewrite that permutes which slot holds which node is
  invisible to both. Correctness lives in the unit tests and this fuzzer.

Byte-identity between the TS and Rust engines is a hard invariant. Any change to
storage, ordering or codecs needs the fuzzers, not just the unit tests. Run them
through the unified runner (`packages/native/fuzz.ts`), which rebuilds exactly the
artifacts the selected fuzzers need before running — so you cannot fuzz a stale
build:

```
cd packages/native
bun run fuzz                      # all seven, random seeds — the regression sweep
bun run fuzz gremlin --seed 2977  # one fuzzer, deterministic replay
bun run fuzz codec differential --seed 7   # a subset, one shared seed
bun run fuzz --list               # names + what each needs
```

The runner exists mostly to defuse one trap: `backend-parity-fuzz` compares the
wasm build against the FFI build, and **neither `bun run build` nor `cargo build`
rebuilds the wasm** — only `bun run build:wasm` does. A stale `lenke_engine.wasm`
turns that fuzzer into a comparison between your change and an old copy of itself:
failures you did not cause, passes you did not earn (found once with the artifact
two days behind the `.so`, after chasing a `max()` "divergence" that was the
previous build). The runner rebuilds the wasm (and the `@lenke/gremlin` dist for
`gremlin`) itself; pass `--no-build` only when you just built. If a result still
surprises you, check the timestamps:

```
stat -c '%y %n' crates/lenke-engine/target/release/liblenke_engine.so \
  crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm
```
