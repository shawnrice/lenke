# Round 6 findings — cracks-deepening + new domains + adversarial

Five personas: an adversarial robustness/fuzz pass, pathfinding/routing, geospatial
+ numeric, event-sourced audit/versioning, and a deep-Gremlin expressiveness sweep.
Code: `.dogfood/round6/<persona>/`. Verdict: **no hangs, no stack overflows, and
the two engines agreed on 71/73 realistic GQL queries and all numeric/haversine
work** — but the adversarial + deep passes found several genuine bugs (two uncoded
native crashes + a silent CSV corruption, all fixed this round) plus important
**semantic divergences from TinkerPop** in Gremlin `repeat().until()` and a
**silently-wrong `WHERE bigint > n`**, both held for a design call.

**[FIXED]** = committed this round; **[HOLD]** = needs a design decision.

---

## Priyamvada — adversarial robustness / fuzz (~450 hostile inputs)

Surfaces: GQL `query` (TS vs native), native Gremlin parser, all 5 codec
`deserialize` on both engines. **No stack overflow / no hang anywhere** (nesting to
100k, traversal chains to 20k all coded-or-correct). Files: `gql-fuzz.ts`,
`codec-fuzz.ts`, `gremlin-fuzz.ts`, `gql-realistic.ts`, `probe-*.ts`.

- **[FIXED — 7ce214b]** F1 HIGH (CRASH): 0-byte input crashed *every* native FFI
  entrypoint (`query('')`, all 5 `deserialize`, `gremlin('')`) with a raw
  `TypeError` from bun:ffi `ptr()`. Now reaches Rust → same coded/empty result as
  TS. Whitespace-only was already fine; only exact-empty tripped it.
- **[FIXED — 5024079]** F2 HIGH (WRONG-RESULT): TS CSV stripped the last char of
  every **bare/untyped** header (`name`→`nam`); silent corruption of every plain
  CSV, diverging from native.
- **[FIXED — 7ce214b]** F3 (part) MED (DIVERGENCE): bigint param → native uncoded
  `TypeError` from `JSON.stringify`. Now coded `E_INVALID_VALUE`. (The full bigint
  model is a separate HOLD — see Mireille #1.)
- **[HOLD → canonical-behavior decisions]** F4–F11 divergences (both coded, pick a
  canonical): expression nesting cap native ≥42 vs TS ≥166 (F4); `RETURN NaN` → TS
  drops column vs native `null` (F5); `toString(1e100)` TS `"1e+100"` vs native
  101 digits, `toString(-0)` TS `"0"` vs native `"-0"` (F6); NDJSON BOM TS-strips
  vs native `E_INVALID_JSON` (F7); NDJSON `"labels":"A"` (string) TS coerces to
  `["A"]` vs native `[]` (F8, silent data diff); blank/huge CSV cell TS-errors vs
  native-ok (F9); lone surrogate in a GQL string literal TS keeps vs native U+FFFD
  (F10, same class as the substring fix); assorted error-code mismatches (F11).

## Tobias — routing / pathfinding

Weighted directed grid + JS reference (BFS/Dijkstra/countPaths). Reachability,
k-hop, cycle detection, path enumeration all byte-correct. Files: `graph.ts`,
`reach.ts`, `shortest.ts`, `weighted.ts`, `cycles.ts`, `semantics.ts`, …

- **[HOLD → R-SHORTESTPATH-DIR]** HIGH (Tobias framed as bug; really a MISSING
  OPTION): Gremlin `shortestPath()` is undirected BFS (`bothEdgesOf`) — which
  **matches TinkerPop's `Direction.BOTH` default** and is documented as
  "incident-edge BFS", so NOT a correctness bug — but there is no
  `ShortestPath.edges` option to request directed, so on a one-way graph it
  returns wrong-way routes with no way to constrain. 400/600 directed-unreachable
  pairs got a (backward) path. Workaround: `repeat(out).until().times(N)`+`path()`.
- **[HOLD → R-GQL-PATH]** MED: GQL can't bind or return a path (`MATCH p = …` →
  syntax error), no `ANY SHORTEST`; var-length can't bind an edge var (so no
  weighted cost along a var-length path); var-length `WHERE` filters only the
  ENDPOINT, not intermediates ("avoid blocked node" inexpressible). Fixed-length
  binds edges + sums weights fine.
- **[DOCS]** LOW: GQL var-length is TRAIL semantics (edge-distinct, node-repeat OK)
  — `(a)-[:R]->{1,6}(a)` counts closed trails, not walks. Worth a doc note.

## Mireille — geospatial + numeric

410 places, in-query haversine, ranking, aggregation. **TS-vs-Rust: 0 numeric
divergences / 23 cases; haversine byte-identical to JS (max rel err 0.0);
aggregates exact incl. fp artifacts.** Files: `places.ts`, `probe-functions.ts`,
`differential.ts`, `bigint-*.ts`, `analytics.ts`.

- **[HOLD → R-BIGINT-MODEL]** #1 HIGH (BUG, silent-wrong): `WHERE bigintProp > n`
  silently returns ZERO rows (no error); an identical number-typed store returns
  the rows. bigint is handled **five inconsistent ways**: ORDER BY sorts it,
  min/max preserve it, sum/avg/abs/to_float coerce it, `+` throws
  `E_DATA_EXCEPTION`, and relational `> >= < =` (vs number) silently drop rows.
  Both engines agree (not a drift) — it's a coherent-model gap. Needs a policy
  decision: is bigint first-class or coerced-to-number?
- **[HOLD → R-MATH2]** missing math a geospatial/analytics feature needs: `atan2`
  (bearings; haversine has an `asin` workaround), percentile/median aggregate,
  k-th list element (`list[i]`/`nth` — blocks in-engine percentile), native
  `stddev`/`variance`. Plus `trunc`, `cbrt`, `log2`, etc. (niceties).
- **[HOLD/DOCS]** #2 MED: `mod(x,0)`→null but `x % 0`→data exception (surface
  inconsistency, both engines agree). #3 MED: Infinity/NaN/overflow silently →
  null (consistent policy, undocumented). #4 MED (ergo): integer literal capped at
  2^53−1 with an error that doesn't hint `.0`/param fixes it. #5 LOW: Gremlin
  `math()` is arithmetic-only (no `sqrt`/`sin`/… — diverges from TinkerPop).

## Gustavo — event-sourced audit / versioning

Append-only journal from `graph.on(...)` + WriteLog + id-stable snapshots; HR
history with reconstruct-as-of, diff, bitemporal. **Id-stable snapshots reconstruct
"as of seq N" byte/id-equal for all 8 tx boundaries.** Files: `audit.ts`,
`hr-audit.ts`, `probe-*.ts`.

- **[FIXED-docs pending → C3 feature]** HIGH-1: README claims undo/redo is buildable
  "purely from events" — false: `VertexPropertiesChanged` carries `next` but no
  `previous`, and property-removal events omit the removed value, so an
  event-only undo silently loses fields. (The `previous`-on-bulk/removal gap is the
  round-4 **C3** feature; the README overclaim is a doc bug to fix now.)
- **[HOLD → R-TRUNCATE-EVENTS]** HIGH-2: `graph.truncate()` emits ZERO events — the
  most destructive op is invisible to every listener/journal.
- **[HOLD → R-REPLAY-VERIFY]** MED-3: statement replay mints fresh random UUIDs, so
  `graphContentEqual` (id-based) returns false vs the original — no id-ignoring
  equality is exported, so `@lenke/sync` statement-replay can't be asserted.
- **[HOLD/DOCS]** MED-4: event element refs are live, not snapshots (a deferred
  journal records empty deletions; `EdgeRemoved` ref throws); INSERT emits only
  `VertexAdded` (no per-property events). MED-5: `@lenke/sync` snapshot machinery
  is native-only (`toNdjson` on a native Store; core Graph lacks it). LOW-6:
  no-op writes still emit `PropertyChanged`. LOW-7: silent veto (known).
- **Verdict:** a correct audit layer is buildable today ONLY via id-stable content
  snapshots, never from the event stream alone.

## Anouk — deep Gremlin expressiveness

Full step vocabulary vs TinkerPop "modern", every step hand-checked; native parity
verified for the crown jewel. Files: `01`–`10`*.ts, `util.ts`.

- **[HOLD → R-REPEAT-UNTIL]** #1 HIGH (DIVERGENCE, crown jewel): `repeat(body)
  .until(cond)` is **while-do, not do-while** — lenke checks `until` BEFORE the
  body regardless of placement, so the post-form doesn't guarantee one iteration.
  `V(marko).repeat(out('KNOWS')).until(hasLabel('PERSON'))` → lenke `["marko"]`,
  TinkerPop `["josh","vadas"]`. Self-contradicts TinkerPop's `times(n) ≡
  until(loops().is(n))`. **Byte-identical TS==native (shared divergence FROM
  TinkerPop, not a drift).** Held: fixing loop control-flow touches both engines +
  `ported_divergences.rs` currently LOCKS IN the wrong results, mislabeled
  "(TinkerPop)".
- **[DOCS]** #2 MED: mid-traversal `V()` unsupported ("V can only appear as the
  first step") — but the `addE` docstring advertises exactly that form, so the
  doc example throws. Fix the docstring (or support it).
- **[HOLD]** #3 LOW-MED: `choose(test).option(...)` map form missing; a 1-arg
  `choose` crashes with an internal `sub is not a function` (needs a coded arity
  error). #4 MED: `group().by().by(count())` returns lists (same as Omar).
- **[DOCS]** #5–7: `propertyMap()` list-wraps values while GAPS.md says "flat
  values"; `ported_divergences.rs` "(TinkerPop)" loop annotations are wrong;
  `group`/`groupCount` return a JS `Map` → `JSON.stringify` silently `{}`.
- **Meta:** **GAPS.md's "aggregation gap-free / no skipped tests" claim is
  inaccurate** (Omar + Anouk both disproved) — a doc-honesty fix.

---

## New roadmap codes proposed

- **R-BIGINT-MODEL** — a coherent bigint policy (first-class vs coerce-to-number);
  today it silently drops rows on `>`/`<` and behaves 5 different ways. HIGH.
- **R-REPEAT-UNTIL** — `repeat().until()` do-while semantics for the post-form +
  fix `loops()` off-by-one; unlock the mislabeled `ported_divergences` cases. HIGH.
- **R-MATH2** — `atan2`, percentile/median, k-th list element (`list[i]`/`nth`),
  native `stddev`/`variance` (+ trig/`trunc`/`cbrt` niceties).
- **R-SHORTESTPATH-DIR** — a `ShortestPath.edges`/direction option (matches
  TinkerPop; today undirected-only).
- **R-GQL-PATH** — bind/return a path (`MATCH p = …`), `ANY SHORTEST`, edge-var +
  intermediate `WHERE` in var-length patterns.
- **R-TRUNCATE-EVENTS** — `graph.truncate()` must emit removal (or a clear) event.
- **R-REPLAY-VERIFY** — export an id-ignoring content equality (or deterministic
  ids) so statement replay is assertable.
- **Canonical-behavior sweep** (fuzz F4–F11) — pick the canonical side for NaN
  projection, `toString` of extreme/`-0` floats, BOM handling, `labels` string
  coercion, string-literal lone-surrogate, nesting-depth cap, and error codes.
- **Docs**: README undo/redo overclaim; GAPS.md aggregation claim; `addE`/mid-`V()`
  docstring; var-length trail semantics; overflow→null; CAST-excludes-temporal;
  `-0`→`0` codec note; `group()` returns a Map (JSON.stringify gotcha).
