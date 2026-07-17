# Round 12 findings — scale + robustness + byte-identity-adversarial (overnight run)

Four personas pushing the hardest surface yet: a deeper **differential fuzzer**, a
**scale-to-failure** load, a **concurrency/resource-exhaustion** chaos suite, and a
fully-**integrated app under load**. Verdict: the correctness core held byte-identical
across a very large surface, and the integrated app ran **zero-bug end-to-end** — but
the round found the **first real engine crash of the whole dogfood series**: a native
SIGSEGV on a pathological operator chain. Code: `.dogfood/round12/<persona>/` (gitignored).

> Note: this round was interrupted mid-run (the remote environment died, almost
> certainly the 10M scale tier exhausting host memory — see S1). It was resumed and
> completed on the main checkout at `8f18e8a`; MegaApp's driver was written during the
> resume (the modules existed but had never executed).

## Persona results

- **FuzzHunter2 — differential fuzzer** (`fuzz2/`). Big byte-identical surface held:
  38,400-statement mutation sequences (**0 divergences**), codec round-trips, the
  round-11 non-finite fixes re-verified (**0 divergences**), unicode keys/values.
  Found **3 divergences** (F1–F3 below), one of them HIGH.
- **ScaleStress — load to failure** (`scale/`). Clean, near-linear scaling through
  **6M nodes / 12M edges**: load 23.8s, ~13.1 GB resident (~763 B/element), each
  algorithm 2–5s, peak ~22 GB after algorithms. No crashes, no wrong results. The
  **10M tier exceeds this host's memory envelope** (S1). Quantified the known no-index
  traversal cliff at scale (below).
- **ChaosRobust — concurrency + resource exhaustion** (`chaos/`). Leak backstop,
  single-flight algorithm guard (200 hammer rounds, 0 ops leaked through), and
  transaction-invariant rollback all clean (**0 bugs** on those suites). Deep paren/list
  nesting rejects cleanly (`E_SYNTAX`, both engines). Found the crash **C1**.
- **MegaApp — everything integrated** (`mega/`). 3k users → 12k V / 30k E. **0 lenke
  bugs across 8 stages**: bulk load; unique/required/type/custom-validator constraints;
  algorithm feature write-back (degree/pagerank/labelProp); multi-hop retrieval
  (feed / FoF-recommend / trending / region facets / influencers, all with `LIMIT
$param`, `NOT EXISTS`, implicit `GROUP BY`); application-layer **bitemporal** (as-of +
  transaction-time travel + single-open-version invariant); **CDC** server→2-replica
  convergence over `engine.mutate`; **checkpoint** encode→restore round-trip (ephemeral
  `Presence` stripped); host-side `defineNode.parse` with structured issues.

## The crash (C1 — HIGH, headline)

`RETURN true AND true AND … (100k terms)` **SIGSEGVs the native engine** (core dump;
also reproduces at 35k terms over the napi backend). Root cause is precise and localized:

- `parse_and` / `parse_or_xor` build a left-associative chain **iteratively** (a `while`
  loop), producing a ~100k-deep left-nested `Expr::And(Box, Box)` AST.
- The parser's `descend` recursion guard (`MAX_DEPTH = 128`, `gql/parser.rs`) bounds
  _parser stack recursion_ — which the iterative loop never uses — so it **never trips**
  for a flat operator chain. Deep paren/list nesting _is_ guarded (hence those return a
  clean `E_SYNTAX`); a long `AND`/`OR`/comparison/arithmetic chain is not.
- The deep tree then overflows the native stack when it is **recursively evaluated or
  dropped** → SIGSEGV, killing the whole process (DoS-class from a single query string).

TS hits the same deep tree and throws an **uncatchable `RangeError`** ("Maximum call
stack size exceeded") — it survives under Bun's top-level catch but is uncoded, so the
two engines already diverge here. Fix needs a shared, byte-identical bound; see the
morning brief (it carries a cap-value / iterative-eval policy decision, so it was **not**
applied overnight).

## Divergences (FuzzHunter2)

- **F3 — UNIQUE constraint timing (HIGH).** Native defers unique-constraint checks to
  **commit**; TS checks them **eagerly per-statement** (at INSERT `uniqueConflict` and
  SET `uniqueConflictOnSet`). So a transaction that transiently duplicates a key and
  **resolves it before commit** (`DETACH DELETE` the dup, or `SET`-collide-then-revert)
  is accepted by native but wrongly rejected by TS with `E_CONSTRAINT_VIOLATION`.
  REQUIRED constraints already defer correctly in _both_ engines, and native matches the
  documented R-TX deferred-check design — TS-unique is the lone outlier. Aligning it is a
  cross-package change (move unique validation into the commit-time deferred pass) that
  existing autocommit constraint tests pin, so it is a morning-brief item, not an
  overnight fix.
- **F1 — lone UTF-16 surrogate (MEDIUM).** TS accepts a string containing a lone
  surrogate (`"\ud800"`) on both the NDJSON load path and the GQL INSERT `$param` path;
  native rejects it with `E_INVALID_JSON`. TS is the more permissive side (native refuses
  invalid Unicode). Same family as the round-11 "tighten TS param validation to match
  native" fixes, but it needs a stated policy (reject lone surrogates everywhere, and
  with which code?) → brief.
- **F2 — CSV nested-list flattening (WAI, not a bug).** A CSV round-trip flattens
  `[[1,2],[3,[4,5]],[]]` to `["1,2","3,4,5",""]`. This is a cross-_format_ lossy encoding
  (CSV cannot represent nested lists), not a cross-_engine_ divergence; TS and native
  agree. Documented as expected.

## Scale (ScaleStress, 6M tier)

- Near-linear load & memory 3M→6M (11.3s→23.8s; 6.9→13.1 GB resident).
- **No-index WHERE-anchored traversal cliff, quantified**: 4-hop `WHERE a.id=$x` = 32.5s
  vs inline-anchored `{id:$x}` = 171 ms (~190×) at 6M — the round-11 planner-seed
  deferral, now measured at scale. Indexed point-lookup 0.013 ms vs 598 ms unindexed
  (~46,000×). Both reinforce the existing "planner no-index multi-hop cliff" brief item.
- **S1 — 10M tier exceeds this host's memory envelope** (~37 GB projected after
  algorithms vs ~33 GB available on the 61 GB box shared with other tenants). The
  original run's 10M attempt is the likely cause of the environment death. Not re-run on
  resume to avoid re-killing the box; recorded as the practical scale ceiling here, and a
  reminder that whole-graph algorithms roughly double peak RSS over the resident graph.

## WAI / known (no action)

- `at` and `value` are reserved words — MegaApp re-hit the known reserved-word DX friction
  (round 7 C6 / round 10 domain-noun list, which already includes `Value`). The engine
  rejected with precise "quote it with backticks" guidance. Reinforces the deferred
  `quoteIdent`/safe-identifier helper item.
- RustGraph GC-backstop leak warnings fire as designed when replica stores aren't
  `free()`d deterministically (reinforces the `store.free()` ergonomics brief item).

## Cypher-vs-ISO gate (working)

No Cypher-ism was silently accepted anywhere this round; all ISO forms exercised by the
personas (label predicates, `NOT EXISTS`, `LIMIT $param`, `_MERGE`, bitemporal string
range predicates) worked.

## Fixes applied

**None this round.** Every finding is either WAI/known or carries a design decision
(cap policy, constraint-timing semantics, surrogate policy) and was deferred to
`DESIGN-DECISIONS-MORNING.md`. The round's value is the verification breadth, the
zero-bug integrated app, and locating C1.
