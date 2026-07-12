# Round 7 findings — reasoning + business-data domains

Five fresh personas on domains that lean on stored values and derived state:
ontology reasoning (variable-length path closure), master-data management /
entity resolution, a double-entry accounting ledger, temporal/telemetry
analytics, and a React dashboard on a live graph. Code: `.dogfood/round7/<persona>/`.

Verdict: **the load-bearing capabilities held.** Variable-length path reasoning
is byte-correct against an independent JS closure oracle across all 460 classes
in both engines; integer `sum()` is exact at every ledger scale; the epoch-gated
live-query engine is exactly correct when deps are declared exactly (16/16
mutation steps, real React hook drives the DOM); exact-identifier entity
resolution is deterministic (precision 1.0, zero false merges over 2,376
records); and the temporal analytics surface passed 19/19 against a JS ground
truth. **No wrong-result correctness bug in any crown-jewel path, no hang, no
stack overflow.**

What the round _did_ surface: four contained defects (**fixed this round**), and
a cluster of **silent-when-wrong footguns** — the recurring theme this round is
that when the engine can't do what you asked, it tends to return `null`/`[]`/a
stale value rather than erroring, so the mistake surfaces as bad data, not a
throw. The rest are capability gaps (fuzzy strings, percentile aggregates,
date-part extraction) that already have clear "unknown function" errors and map
to existing ROADMAP items.

**[FIXED]** = committed this round; **[HOLD]** = needs a design decision;
**[GAP]** = capability gap / existing ROADMAP item.

---

## Fixed this round

- **[FIXED] Theo H1 (docs bug):** `docs/guides/frontend-worker.md` shipped a
  `liveQuery('… RETURN p.name', { deps: ['Person'] })` example that under-declares
  its deps — it reads the `name` key but doesn't list it, so an in-place
  `SET p.name` never invalidates the query and the UI renders stale. The
  `packages/react/README.md` example gets the same shape right (`['Person','name']`),
  so the docs contradicted. Fixed the example to `['Person','name']` with an
  inline note that `deps` must list every label **and** property key the query
  reads.
- **[FIXED] Theo M3 (`inferDeps` under-grab):** `inferDeps()` (native store)
  extracted `:Label` and `.key` tokens but missed **inline-map filter keys** —
  `(o:Purchase {status:'paid'})` returned `['Purchase']`, dropping `status`, so
  the README-recommended `deps: inferDeps(Q)` went stale after `SET o.status=…`.
  Added an inline-map key pass (`/[{,]\s*(key)\s*:/`). Over-grabbing is safe (only
  costs a needless recompute), so the occasional false positive is acceptable.
- **[FIXED] Rafael H1 (`LocalDate` silent-wrong-date footgun):** the `LocalDate`
  constructor takes **epoch-days** (arity 1), but `new LocalDate(2026, 1, 15)` — the
  natural calendar-fields guess — silently stored day 2026 (= `1975-07-20`) and
  dropped month/day. TS flags the excess args, but a `bun`/JS call strips types
  and runs, corrupting the date with no error. Added a **`LocalDate.of(year,
month, day)`** factory (the correct calendar-fields path) and made the
  epoch-days constructor **throw `E_INVALID_VALUE`** on excess args instead of
  silently mis-storing.
- **[FIXED] Rafael L6 (uncoded `addEdge` crash):** `addEdge({ from, to: undefined })`
  threw a raw `TypeError` ("undefined is not an object (evaluating 'params.to.id')")
  from dereferencing the missing endpoint before validation, instead of a coded
  error. Added a guard so a missing `from`/`to` surfaces as `E_MISSING_VERTEX`
  (matching `assertValidEdge`).

---

## Bianca — ontology reasoning (variable-length path closure)

Surfaces: GQL var-length patterns (`*`/`+`/`{1,N}`) + Gremlin
`repeat/until/emit/times`. Files: `smoke.ts`, `ontology.ts`, `reason.ts`,
`cycle_consistency.ts`, `sweep.ts`, `materialize_probes.ts`. **Clean round —
no correctness bug.**

- **Smooth (crown jewel):** `sweep.ts` — GQL `+ DISTINCT` and Gremlin
  `repeat(out).emit()` superclass closure matched a JS reflexive-closure oracle
  for **all 460 classes with 0 mismatches** (+ 39/39 type inference). `reason.ts`
  12/12: diamonds, a deliberate cycle (edge-distinct TRAIL terminates on
  `*`/`+`/`{1,10}`), zero-hop `*` honoring endpoint label filters, reverse `in_`
  closures, disjointness-contradiction detection.
- **[GAP → R-MERGE v2 / R-FIXPOINT]** Non-idempotent edge INSERT — no edge
  MERGE/upsert. A fixpoint materialization loop (`INSERT (i)-[:TYPE]->(p)`
  re-inserts every already-derived edge each round; raw edges grow ~2×/round to
  14.8M by round 12 while the _distinct_ pair set correctly converges at round 7).
  The closure is right; a naive loop just explodes memory. Maps to the deferred
  multi-hop `_MERGE` + in-engine fixpoint items.
- **[GAP]** GQL var-length `WHERE` filters the **endpoint only** — no
  per-hop/intermediate predicate ("stop climbing at class X"); intermediate nodes
  aren't bindable. Largely an ISO-GQL limitation; worth a docs note. Drop to
  Gremlin `repeat().until()` for the bounded form.

## Lars — master-data management / entity resolution

Surfaces: GQL string fns, CSV + NDJSON ingest/merge, `_MERGE` survivorship.
Files: `gen.ts`, `smoke.ts`, `probe.ts`, `mdm.ts`, `merge_probe.ts`,
`merge_order.ts`.

- **Smooth:** exact `email+phone` blocking scored **precision 1.0, zero false
  merges** over 2,376 records; `_MERGE` + `coalesce(nullif($x,''), x.k)`
  survivorship is correct in recency order; a bare `_MERGE` with fewer fields does
  **not** clobber existing values; string basics (`lower/trim/replace/split/
substring/||`) are byte-correct.
- **[GAP] No fuzzy/phonetic string toolkit** — `levenshtein`/`similarity`/
  `soundex`/`metaphone`/`regexp_*` (and the `=~` operator) are all unimplemented,
  so ER can only do exact blocking. Measured cost: recall caps at **0.80** (319 of
  1,572 true dup pairs — the typo-name + fresh-contact "hard" dupes — are
  unrecoverable in-engine); chasing them with an exact-name blocker collapses
  precision to 0.18. Clear "unknown function" errors → reads as _deferred_. **New
  capability gap** (see ROADMAP R-STRFN).
- **[HOLD] Recency-guarded `_MERGE` gives order-dependent golden records.** A
  `_MERGE … _ON_UPDATE SET x.phone = coalesce(nullif($phone,''), x.phone) …
WHERE x.updated <= $updated` produces the correct golden record when records
  arrive ascending, but **silently wrong** (`phone:""`) descending/shuffled,
  because the `WHERE` gates the _entire_ `_ON_UPDATE SET` as a unit — when the
  newest record merges first, every older record's per-field `coalesce` is skipped
  wholesale. Arguably working-as-specified (LWW WHERE-guard is documented), but the
  interaction with per-field survivorship is a real footgun. **Design call:** is
  per-field recency survivorship a use case `_MERGE` should express
  order-independently? Related to the `_MERGE` extension spec.
- **[HOLD] `decodeNodes` silently mis-ingests a plain business CSV.** `id,name,email`
  → column 1 (`name`) is consumed positionally as the `:LABEL` set and its header
  dropped; the row's `name` value becomes a label with no warning. `decodeNodes`
  is a Neo4j-`admin-import`-style codec (`id,:LABEL,…`), correctly documented in
  the source header — but there's no runtime guard and no user-facing doc warning
  that it is _not_ a general CSV loader. Cheap fix: warn in docs + optionally
  validate the column-1 header. (Extends C-CSV.)

## Rafael — double-entry accounting ledger

Surfaces: `sum()` aggregation, `LocalDate`, numeric precision, invariants.
Files: `smoke.ts`, `ledger.ts`, `invariants.ts`, `precision.ts`, `probe-reserved.ts`.

- **Smooth:** **integer `sum(cents)` is exact at every scale** — global 0, 0
  per-account mismatches across 200 accounts / 11,974 postings vs an independent
  BigInt oracle, no overflow. The load-bearing ledger feature just worked.
- **[FIXED]** H1 `LocalDate(y,m,d)` footgun and L6 uncoded `addEdge` — see above.
- **[GAP → C6]** `date`/`datetime` are reserved words; a bare `t.date` property
  (the canonical transaction field) throws `'date' is a reserved word` and aborts
  the script. Spec-compliant, clear message; backtick `` t.`date` `` works. Same
  class as C6 (reserved words break bare labels/keys) — a docs + maybe
  parser-accepts-keyword call.
- **[HOLD] `createUniqueConstraint` is enforced on the GQL write path but not core
  `addVertex`.** After `createUniqueConstraint('Account','code')`, a GQL `INSERT`
  duplicate throws `E_CONSTRAINT_VIOLATION`, but core `addVertex` of a duplicate
  does not (count=2). The `uniqueConflictOnSet` helper exists but core
  `addVertex`/`setProperty` never call it. Design call: is a unique constraint a
  GQL-layer concept or a core invariant? (If core, wire the helper into the
  ingestion gate.)
- **[GAP → R-TX]** No atomic multi-write — a mid-sequence failure leaves the books
  unbalanced (leg 1 written, leg 2 throws → `sum=1000`), and the debits==credits
  invariant can't be expressed via per-edge veto (one edge visible at a time).
  Maps to R-TX.
- **[GAP → C2]** Event veto is silent — a vetoed `addEdge` returns an Edge object
  that looks like success (`.has(bad)` is false). Re-confirms C2 / round-6 finding.
- **Not a bug:** float `sum(dollars)` drift is textbook IEEE-754
  (`0.1+0.2`→`0.30000000000000004`); a balanced ledger sums to `2.9e-11 ≠ 0`.
  Integer cents is the answer, and it's exact. Recorded so it isn't re-filed.

## Sunita — temporal / telemetry analytics

Surfaces: stored DATETIME comparison/ordering, percentile/bucket/hour-of-day
math. Files: `smoke.ts`, `telemetry.ts`, `probe-*.ts`. **All 9 ran clean;
`telemetry.ts` 19/19 vs a JS ground truth.**

- **Smooth:** stored-DATETIME ordering/comparison, both window forms, half-open
  `BETWEEN`, hourly/daily downsampling, z-score via `sum`+`sum(power())`,
  hierarchy rollups, `duration_between`, `WITH ORDER BY` + `collect_list`, and
  `current_timestamp` param injection (incl. DATE→DATETIME coercion) — all correct.
- **[HOLD] Stored STRING vs `DATETIME` literal silently compares to `null` → count 0.** A `ts` stored as a string compared against `DATETIME '…'` drops all rows
  (`{c:0}`) with no error; `datetime(r.ts)` fixes it. Defensible type policy (no
  implicit string→temporal coercion) but a silent all-rows-dropped footgun — the
  same "silent when wrong" theme. Design call: warn, or coerce?
- **[GAP → R-TEMPORAL]** No date-part extraction (`extract(HOUR FROM …)`, `hour()`,
  `year()`, `date_trunc()`); only `substring(to_string(ts),…)` works. No
  `percentile_cont/_disc`/`median`/`stddev` aggregates; manual median is blocked
  because list indexing `s[5]` is a parse error (`list[i]` is a known deferred
  item). No `DURATION → number` coercion for rate math, and `DURATION / number`
  is unimplemented while `DURATION * fractional` returns `null` **by documented
  design** (a calendar duration has no meaningful fractional multiple). All map to
  the R-TEMPORAL deferred set (+ `list[i]`).
- **[GAP, both engines]** An unknown function on an **empty** match returns `[]`
  with no error (`totallyfake(n.v)` on an empty graph → `OK []`), because the
  function name is only checked when the scalar is evaluated per-row. **Verified
  the native engine behaves identically** (it collects `unknown_fns` at plan time
  but only faults during per-row eval) — so this is a _shared, deliberate_
  lazy-eval consequence, not a divergence. Plan-time validation would be a
  behavior change to both engines (queries that succeed on empty inputs would
  start erroring) → owner design call, not a round-7 fix.
- **[GAP → C6]** `value`/`day` are reserved words needing backticks — clear error,
  pure friction. Same class as C6.

## Theo — React dashboard on a live graph

Surfaces: `@lenke/native` `liveQuery` + `@lenke/react` `useLiveQuery`, reserved
words/quoting. Files: `dashboard.ts`, `run-correctness.ts`, `probe-*.ts`,
`hooks.test.tsx`. **run-correctness 16/16; hooks.test.tsx 3 pass.**

- **Smooth:** with **correct** deps the live query is exactly correct across 16
  mutation kinds (INSERT / in-place `SET` / `DETACH DELETE` / `REMOVE` / batched /
  read-only / mass-delete), `live === fresh` at every step; the real `@lenke/react`
  `useLiveQuery` updates the DOM `180 → 1079` on an in-place `SET`; epoch gating is
  fine-grained; over-declaring deps is always safe.
- **[FIXED]** H1 (docs) and M3 (`inferDeps` inline-map keys) — see above.
- **[HOLD] Under-declared deps → silent stale live query, no runtime signal.** The
  deps contract is `useEffect`-style manual dependency tracking; an under-declared
  dep produces a stale render with no throw/warn (quantified across label/key/edge
  cases). By design, but undefended. Possible: a dev-mode assertion that recomputes
  against `null` deps and warns on mismatch (over-declaring is always correct, so a
  guard could auto-widen). Related to C8 (dev-mode param/usage warnings).
- **[GAP → C6] Reserved-word rejection is inconsistent + hint-free for
  keyword-lexed labels.** `:Product`/`:Group`/`:Value` give the actionable
  "'Product' is a reserved word; quote it as a delimited identifier"; but
  `:Order`/`:Count`/`:Match` give a generic "Expected a label name, got 'order'"
  (no quoting hint, lowercased echo) because keyword-lexed tokens fail `expect(Ident)`
  before the reserved-word check. `Order` and `Product` — the two most common
  e-commerce labels — give _different_ errors, the commoner one unhelpful. Routing
  keyword-lexed label-position tokens through the reserved-word message is a real
  parser improvement (both engines, byte-identity) — held with the C6 cluster.
- **[GAP] "delimited identifier" hint names no delimiter.** The good hint says
  "quote it as a delimited identifier" without saying _with backticks_; a SQL/ISO
  user reaches for `"Order"` (a string literal) and gets a confusing error. Cheap
  message fix (`` quote it with backticks: `Order` ``), bundled with the C6 parser
  work.

---

## Cross-cutting theme: "silent when wrong"

Five independent personas hit the same shape — the engine returns a plausible
non-error (`null`, `[]`, a stale snapshot, an unbalanced sum) instead of throwing,
so a mistake surfaces as bad data downstream:

- under-declared `deps` → stale render (Theo)
- recency-guarded `_MERGE` in the wrong order → dropped field (Lars)
- stored-string vs `DATETIME` literal → 0 rows (Sunita)
- unknown function on empty input → `[]` (Sunita)
- `DURATION / n` / fractional `*` → `null` (Sunita)
- vetoed write → success-looking return (Rafael)

The four fixes this round convert two of these into loud failures
(`LocalDate` misuse, `addEdge` missing endpoint) and close two stale-data paths
(the docs example + `inferDeps`). The remaining ones are HOLDs because "return
null vs throw vs warn" is a policy decision (three-valued logic, no implicit
coercion) rather than a clear bug — they're the candidate batch for a
"strict/dev mode" that turns silent-null into a diagnostic.
