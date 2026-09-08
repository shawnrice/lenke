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
  crates/lenke-engine/target/wasm32-unknown-unknown/release/lenke_engine.wasm
```
