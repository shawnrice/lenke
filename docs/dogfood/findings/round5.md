# Round 5 findings — fresh domains + a hard stress-test of the new temporal layer

Five personas, each a real application. Focus: exercise the just-shipped temporal
functions (constructors, `duration_between`, arithmetic, `current_*`) to their
ceiling, and probe fresh domains (recommendations, ETL/codec fidelity, KB search,
live-collab CDC). Code: `.dogfood/round5/<persona>/`. Verdict: **the engines are
correct on the overwhelming majority of what was thrown at them** — temporal
*arithmetic* passed ~30 hand-checked calendar edge cases, GQL expressed every
recommendation/report/search query byte-identically to a JS ground truth. The
findings are (a) a handful of genuine byte-identity / confidently-wrong bugs
(mostly fixed this round), (b) one real CDC correctness bug, and (c) a coherent
"temporal v2" capability bundle + several silent-null ergonomics papercuts.

Fixed overnight are marked **[FIXED]** with the commit; design-holds are **[HOLD]**.

---

## Hana — bitemporal HRIS (temporal stress-test)

**Built:** effective-dated employees/positions/departments/comp with valid-time
(`vfrom`/`vto`) + transaction-time (`ttfrom`/`ttto`) intervals; as-of queries,
tenure, anniversaries, a full bitemporal correction. Files: `build-data.ts`,
`queries.ts`, `convert.ts`, `probe-*.ts`. **Bitemporal correction worked exactly**
(current belief 158000 vs as-recorded-2024-01-01 150000); all calendar arithmetic
correct (month-end clamp, leap, instant−instant, componentwise).

- **[FIXED — ccf/ae23597]** H2 (BUG): `DURATION × non-integer` silently truncated
  the multiplier (`* 1.5` → `×1`, `* 0.5` → `PT0S`). Now → null (no fractional
  multiple of a calendar duration).
- **[FIXED — ae23597]** L3 (BUG): `current_timestamp` returned a DATE-kind value
  when `$__now` was a DATE. Now coerces to DATETIME via `local_datetime(...)`.
- **[HOLD → R-TEMPORAL2]** H1 (CAPABILITY): `sum()`/`avg()` over DURATION → null
  (silently). Blocks "total/average tenure across roles". `min`/`max` work.
- **[HOLD → R-TEMPORAL2]** M1: no date-part extraction (`year`/`month`/`day`/
  `EXTRACT`). Blocks anniversary/"headcount by hire year"/age-in-years. Workaround
  `substring(to_string(d),…)` (stringly-typed, breaks at year wrap).
- **[HOLD → R-TEMPORAL2]** M2 / L4: a DURATION can't be converted back to a number
  in-query (`to_integer(dur)`→null; no `.days`/`.months`; no `DURATION / int`).
  Day-count is trapped in the Duration.
- **[HOLD → R-TEMPORAL2]** M3 (DOCS/CAP): `CAST(x AS DATE|DATETIME|DURATION)`
  unsupported though README advertises CAST + temporal-first-class. Use `date(x)`
  etc. Needs at minimum a doc note; ideally CAST support.
- **[HOLD → silent-null ergonomics]** M4/L1/L2: string-typed date columns make
  every temporal op silently null (the CSV-load footgun); DURATION relational
  compare is UNKNOWN so "tenure > 5y" silently returns nothing (workaround:
  `a.vfrom + DURATION 'P5Y' <= current_date`); cross-kind DATE-vs-DATETIME drops
  rows silently.

## Omar — recommendation engine

**Built:** user–item graph (2000 users / 500 items / 65,598 edges, seeded RNG),
collaborative filtering, item-item similarity, personalized top-N, category
affinity — in **both** GQL and Gremlin, every result checked against a JS ground
truth. **GQL expressed every query byte-identically** (co-occurrence top-N,
exclude-owned via `NOT EXISTS`, HAVING via `WITH … WHERE`, cosine similarity with
`sqrt` + `COUNT { }` subquery, `count(DISTINCT)`, per-group `sum`/`avg`). Files:
`data.ts` + `00`–`11`.

- **[HOLD → R-GREMLIN-AGG]** HIGH (BUG/CAP): Gremlin `order(Scope.local)` is
  silently ignored — `order()`'s signature has no Scope param, so `order(Scope
  .local)` spreads a Symbol → no-op, leaving a grouped map unsorted. **No error.**
  The canonical top-N-from-`groupCount` idiom is inexpressible; every `by()`
  modulator workaround also blocked. `limit(Scope.local)` *does* honor local scope,
  so it's an inconsistency. Forces JS-side ranking. (GQL has no gap.)
- **[HOLD → R-GREMLIN-AGG]** MED (BUG): `group().by(k).by(count())` /
  `.by(sum())` returns per-element **lists** (`{x:[1,1]}`) instead of the reduced
  value (`{x:2}`) — the reducing `by` runs per-traverser, not over the group. No
  working in-engine per-group sum/mean. `GAPS.md` wrongly claims TS aggregation is
  "gap-free".
- **[FIXED-partial? HOLD]** MED (ERGO): Gremlin `project(['a','b'])` is array-arg,
  not variadic; a bare-string `project('name')` silently char-splits into per-char
  keys, and `.by()` count mismatch throws a raw `TypeError`. Reject non-array with
  a coded error + document the shape. → see R-GREMLIN-ERGO.
- LOW: no fluent `g.V()` source (only `traversal(...)`); `has('Label')` checks a
  property key not a label (standard Gremlin, silent empty).

## Ingrid — ETL / multi-format integration

**Built:** ingest CSV+NDJSON+GraphSON from 3 "systems", reconcile via `_MERGE` +
`createUniqueConstraint`, round-trip 60+ tricky values through all 5 codecs. Files:
`value-matrix.ts`, `csv-*.ts`, `malformed.ts`, `dangling-edge.ts`, `pipeline.ts`.
`_MERGE` dedup + constraints work end-to-end; unicode/emoji/quoting/formula-leads/
temporals all round-trip through CSV.

- **[HOLD → R-CSV-LISTNULL]** HIGH (BUG, data loss): CSV turns a `null` list
  element into the string `"null"` (`[1,null,2]` → `[1,"null",2]`; wire bytes emit
  an explicit `\Ts:null` string override). **Only CSV** loses it (pg-json/ndjson/
  graphson preserve). Defeats the README "CSV exact round-trip" claim + the null-
  first-class policy. HELD because the fix needs a list-element sentinel rework
  (the element path lacks the scalar path's single/double-backslash + quoting
  discriminator, and `splitList` blindly unescapes) mirrored byte-for-byte in Rust
  + corpus. Verified independently: `.dogfood/round5/_triage/csv_null_repro.ts`.
- **[FIXED — ccf0b7d]** MED (BUG): CSV short row crashed with an uncoded
  `TypeError` (`row[1].text`). Now a coded `LenkeError`.
- **[HOLD → R-CODEC-STRICT]** MED (BUG): NDJSON's whole-string batch decode
  silently fabricates a phantom vertex for a dangling edge; pg-json/graphson/csv
  all throw `E_MISSING_VERTEX`. Inconsistent.
- **[HOLD → R-CODEC-STRICT]** MED (BUG): CSV nodes decode with a missing `:LABEL`
  column silently corrupts by position (`id,name:string` → label `["Alice"]`,
  `name` lost). Header names never validated.
- **[HOLD → R-CODEC-STRICT]** LOW/MED (ERGO): CSV + pg-text decode malformed input
  (unbalanced quote, unknown column type `age:banana`) silently → mangled/quietly-
  wrong data. No strict mode.
- **[DOCS]** LOW: `-0` collapses to `0` in all 5 codecs (JSON + `String(-0)`);
  `graphContentEqual` can't detect it. Document alongside NaN/Infinity/bigint.

## Wei — KB search + faceted reporting

**Built:** search + reporting over 300 Article/Author/Tag with emoji/CJK/combining
titles. Text search (CONTAINS/STARTS/ENDS, case-insensitive via `lower`/`upper` —
correct incl. İ/ß/Greek), CASE ranking, SKIP/LIMIT, GROUP-BY facets — every count
verified vs JS and Gremlin. Files: numbered `00`–`13`.

- **[FIXED — ae23597]** HIGH (BUG, parity): `substring`/`left`/`right` across a
  surrogate pair — TS returned a raw lone surrogate, native returned U+FFFD;
  `GROUP BY substring(title,1,1)` keys diverged. TS now lossy-decodes UTF-16
  slices like `split('')`/`reverse` already did.
- **[HOLD → grouping semantics]** MED (BUG/ERGO): an aggregate **only** in
  `ORDER BY` (`RETURN t.name ORDER BY count(*) DESC`) silently ungroups — 616 rows
  (one per edge), `count(*)` a global constant, sort a no-op. Both engines
  consistent. Workaround: alias the aggregate in RETURN.
- **[HOLD → R-PARAM-LIMIT]** MED (CAP): `SKIP`/`LIMIT`/`OFFSET` reject `$param`
  (literals only) → forces int-splicing for pagination.
- LOW/DOCS: `count(DISTINCT)` undocumented; string `contains()` returns a boolean
  while `list_contains` returns numeric 1/0 (mixed conventions); empty-group
  `sum`→0 but `avg`/`min`/`max`→null undocumented; native object-`$param` error
  message is opaque.

## Yuki — live collaborative app (sync / CDC)

**Built:** collaborative kanban with presence on the documented topology — one
authoritative server (`Store`+`WriteLog`+`DedupRegistry`, one `createSyncHost` per
connection), N optimistic clients, CDC `subscribeWrites`→`engine.ingest`, `_MERGE`
presence + `onDisconnect` teardown, cut/re-dial socket. Files: `lib.ts`, `01`–`05`.
Basic 2-client CDC convergence, `_MERGE` presence, `onDisconnect` broadcast,
interest routing, clean reconnect-when-ack-arrived — all verified working.

- **[HOLD → R-CDC-ORIGIN]** HIGH (BUG): **origin-skip is not stable across
  reconnect — a client re-applies its OWN write.** A drops post-commit/pre-ack →
  re-dials → new `createSyncHost` mints a NEW origin id → `replay()` from A's stale
  cursor re-fetches A's own write, now carrying a stale origin the new host doesn't
  recognize → forwarded back → `ingest` re-applies. No-constraint: silent
  optimistic/authoritative divergence (local=2, server=1). Under a unique
  constraint: `E_CONSTRAINT_VIOLATION` thrown out of `replay()` → reconnect
  aborted. Root cause: DedupRegistry guards only the mutate-replay path (keyed on
  `req`), not the CDC catch-up path; origin-skip is keyed to a per-*connection* id
  that changes each reconnect. `cdc.test.ts` masks it by reusing the same host.
  Repro: `04-crownjewel.ts`. Fix needs a stable per-*client* origin id or
  ingest-side write-stream dedupe — a protocol decision.
- **[HOLD → R-CDC-ORIGIN]** MED (BUG): one poison write in a CDC batch escapes
  `client.receive()` and partially applies (no try/catch around the ingest handler,
  no rollback, no `onIngestError`) — wedges the pump.
- **[HOLD → R-SCHEMA-REPL / DOCS]** MED: schema (constraints/indexes) isn't
  replicated by CDC; a client missing `createUniqueConstraint('Presence','sid')`
  throws on ingesting a `_MERGE` presence write. Statement-based replication
  assumes identical schema, set up entirely out-of-band + undocumented.
- **[DOCS]** MED: presence + exactly-once wiring (`onDisconnect`,
  `createDedupRegistry`, "share one registry") live only in source JSDoc, not the
  sync README. **Verdict: can't build a real 2-client app from the README alone.**
- LOW (ERGO): no in-process client↔host pair helper (re-hand-rolled per test);
  `mutate()` promise never settles on a dropped ack (no per-request timeout).

---

## New roadmap codes proposed (see ROADMAP.md)

- **R-TEMPORAL2** — temporal v2 value ops: duration aggregates (`sum`/`avg`),
  date-part extraction (`year`/`month`/`day`/`EXTRACT`), duration↔number, `CAST`
  to temporal, `DURATION / int`. Coherent bundle; the #1 temporal follow-on.
- **R-CDC-ORIGIN** — stable per-client origin id (or ingest-side write-stream
  dedupe) + ingest error isolation. The one real multiplayer correctness bug.
- **R-GREMLIN-AGG** — `order(Scope.local)` + `group().by().by(<reduce>)` so a
  grouped map can be ranked / reduced in-engine (both broken today).
- **R-CSV-LISTNULL** — CSV null-in-list round-trip (element-sentinel rework).
- **R-CODEC-STRICT** — consistent malformed-input handling / opt-in strict mode
  across codecs (dangling-edge, missing `:LABEL`, unbalanced quote, bad type).
- **R-PARAM-LIMIT** — bind `$param` in SKIP/LIMIT/OFFSET.
- **R-GREMLIN-ERGO** — `project()` variadic or coded error on non-array; doc shape.
- Silent-null ergonomics + several DOCS items (see per-persona above).
