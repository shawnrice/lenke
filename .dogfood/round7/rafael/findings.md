# Dogfood Round 7 — Rafael: Double-Entry Accounting Ledger Findings

Built a double-entry ledger on `@lenke/core` + `@lenke/gql`: chart of accounts,
balanced transactions posted as signed `POSTING` edges (integer `cents` and a
parallel IEEE-754 `dollars` encoding), trial balances via GQL `sum()`, date-range
account statements, unique-code constraints, and per-posting/per-transaction
invariants. Every aggregate was checked against an exact BigInt-cents ground truth
kept in lockstep in plain JS.

Files: `smoke.ts`, `ledger.ts` (3000 txns / 11974 postings), `invariants.ts`,
`precision.ts`, `probe-reserved.ts`.

Verdict up front: **the ledger works and the numbers are correct — but only if you
model money as integer cents and dodge two sharp ergonomic edges.** Integer `sum()`
is exact at every scale I threw at it. The two edges that will bite a real user are
(1) `new LocalDate(y, m, d)` silently writing the _wrong date_ with no error, and
(2) `date` being a reserved word so `t.date` crashes the parser. Float-dollar drift
is real but is textbook IEEE-754, not a lenke bug.

---

## HIGH-1 — `new LocalDate(y, m, d)` silently writes the WRONG date (no error)

- **Severity:** HIGH
- **Category:** BUG (API footgun -> silent data corruption)
- **Repro:** `smoke.ts:8` and `probe-reserved.ts:5`:
  `new LocalDate(2026, 1, 15)` — the natural java.time / `Temporal.PlainDate`
  spelling for "15 Jan 2026".
  - Expected: `2026-01-15`.
  - Actual: **`1975-07-20`.** (`probe-reserved.ts` -> `RETURN t.`date``returns`{"@date":"1975-07-20"}`.)
- **Cause:** The constructor is `LocalDate(days: number)` — _epoch days_, not
  `(year, month, day)` (`packages/core/src/temporal.ts:24`, ctor arity = 1). So
  `2026` is interpreted as "2026 days after 1970-01-01" (= 1975-07-20) and the `1`
  and `15` args are **silently ignored**. Verified:
  `new LocalDate(2026,1,15)` === `new LocalDate(2026)` === `1975-07-20`.
- **Why it slips through:** TypeScript _would_ flag the excess args in an editor,
  but the scripts run under `bun`, which strips types without checking, so it runs
  and writes garbage. There is **no `(y, m, d)` convenience factory** — the correct
  spellings are `parseDate('2026-01-15')` or `LocalDate.parse('2026-01-15')`
  (both verified correct). `ledger.ts` uses `parseDate(...)` and its dates are
  right (statement rows show `2025-01-01`, `2025-01-08`, ...).
- **Impact:** For a temporal domain (every ledger has transaction dates) the single
  most obvious constructor call produces a wrong date, no throw, no warning. A user
  reaching for the java.time idiom corrupts every date in the store.
- **Suggested fix direction:** either a `LocalDate.of(y, m, d)` factory, or a
  runtime arity guard that throws when called with >1 arg.

## MED-2 — `date` / `datetime` are reserved words, so `t.date` crashes the query

- **Severity:** MED (HIGH for this domain)
- **Category:** ERGONOMICS / SPEC-COMPLIANT-BUT-SURPRISING
- **Repro:** `smoke.ts:62-66` (the "DATE RANGE" query,
  `WHERE t.date >= DATE '2026-01-01' ...`) throws an **uncaught**
  `GqlSyntaxError: 'date' is a reserved word; quote it as a delimited identifier`
  (E_SYNTAX) and aborts the entire script (exit 1) before the last two console
  lines run. `probe-reserved.ts` isolates it:
  - `bare t.date` (WHERE) -> **THREW E_SYNTAX**
  - `RETURN t.date` (bare) -> **THREW E_SYNTAX**
  - `t.`date`` (backtick) -> works, returns the value
- **Cause:** `date` and `datetime` are in the ISO reserved-word set
  (`packages/gql/src/lexer.ts:130` — they're the temporal-literal keywords), and
  the parser rejects an unquoted reserved word even in a `.property` access
  position (`parser.ts:263`). So this is **spec-compliant** (ISO GQL does reserve
  `date`), and the error message is clear and gives the exact fix.
- **Impact:** `date` is the canonical property name on a transaction, so an
  accounting user hits this immediately, and a bare `t.date` anywhere aborts the
  whole statement if unguarded. `ledger.ts` already had to backtick every access
  (`t.`date``). The friction is real even though the behavior is defensible.
- **Note:** `t.date` after a dot is unambiguously a property access; a
  quality-of-life win would be to allow reserved words in post-`.` position (many
  engines do). Absent that, this is a docs item: warn that `date`/`datetime`/`time`
  property names require backticks.

## MED-3 — `createUniqueConstraint` is enforced only on the GQL write path, not core `addVertex`

- **Severity:** MED
- **Category:** BUG / DIVERGENCE (core API vs GQL)
- **Repro:** `invariants.ts:12-33` and `smoke.ts:40-56`:
  `g.createUniqueConstraint('Account', 'code')`, then add a duplicate `code:'1000'`
  two ways:
  - core `g.addVertex({labels:['Account'],properties:{code:'1000'}})` twice
    -> **NO throw**, `getVerticesByLabel('Account').size == 2`.
  - GQL `INSERT (:Account {code:'1000'})` -> **throws E_CONSTRAINT_VIOLATION.**
- **Cause:** `createUniqueConstraint` only records the constraint into
  `vertexUniqueConstraints` (`Graph.ts:768`); the enforcement helper
  `uniqueConflictOnSet` (`Graph.ts:889`) exists but is called from the GQL write
  path, **not** from core `addVertex`/`setProperty`. So the constraint is advisory
  at the core mutation API.
- **Impact:** A user who declares a unique constraint and then writes through the
  core API (the most direct path, and the one `smoke.ts`/`invariants.ts` naturally
  reached for) gets silent duplicates. The constraint's guarantee depends on which
  door you write through. Note `createUniqueConstraint` _does_ eagerly scan
  existing data for violations at declare time — so the enforcement gap is only on
  subsequent core writes, which makes it more surprising.

## MED-4 — No atomic multi-write: a mid-transaction failure leaves the books unbalanced

- **Severity:** MED
- **Category:** CAPABILITY GAP
- **Repro:** `invariants.ts:93-105`. A transaction is (Txn vertex + N posting
  edges) written over several calls. Write leg 1 (`cents: 1000`), then leg 2 throws
  -> `sum(p.cents)` over the graph = **1000** (expected 0 for a real double-entry
  txn). The half-written transaction persists; the ledger is left unbalanced.
- **Related:** The balanced-txn invariant (debits == credits) **cannot** be
  expressed with an event veto either: a per-`EdgeAdded` listener sees one posting
  at a time and can't know the full posting set (`invariants.ts:61-90`). You must
  validate + stage in app code and commit, but there's no transaction/rollback
  primitive, so a crash mid-commit is unrecoverable from the store alone.
- **Impact:** Correctness-critical for accounting. The workaround (validate the
  whole leg set in app code _before_ writing anything, as `postTransaction` does)
  works but doesn't survive a throw _during_ the write loop.

## LOW-5 — Event veto is silent: `addEdge` returns an Edge even when the write was vetoed

- **Severity:** LOW (re-confirms Round-6 LOW-7 in the edge/ledger context)
- **Category:** ERGONOMICS
- **Repro:** `invariants.ts:35-59`. A listener `preventDefault()`s a non-integer-
  cents posting. `const bad = lg.addEdge({...cents:9.9})` **returns an Edge object**
  (looks like success), but `lg.getEdgesByLabel('POSTING').has(bad)` is `false` and
  the edge count doesn't rise. No throw, no `null`, no boolean.
- **Impact:** The writer cannot tell a vetoed write from a committed one without
  re-querying. For an invariant-enforcement pattern (the whole reason to veto),
  that's the one signal you need. Good news: the veto _is_ honored (the bad edge
  never lands), so integrity holds; only the return-value feedback is missing.

## LOW-6 — `addEdge({ to: undefined })` throws a raw `TypeError`, not a coded `LenkeError`

- **Severity:** LOW
- **Category:** ERGONOMICS (error quality)
- **Repro:** `invariants.ts:100`. Passing `to: undefined` throws
  `undefined is not an object (evaluating 'params.to.id')` with **no `e.code`**,
  vs. the coded `LenkeError`s (e.g. `E_CONSTRAINT_VIOLATION`) the API gives
  elsewhere. A missing/undefined endpoint is exactly the kind of bad input that
  deserves a validation error like `E_INVALID_ARGUMENT`.

---

## Not a bug — float precision (documented here so it isn't re-filed as one)

Modeling money as IEEE-754 `dollars` drifts exactly as expected; the scripts are a
proof that **integer cents is the correct model**, and lenke's integer `sum()` is
exact:

- `sum(p.dollars)` accumulates rounding error: `0.1 + 0.2` -> `0.30000000000000004`
  (`smoke.ts`, `precision.ts` Exp B); a _perfectly_ balanced 20001-posting ledger
  yields `sum(dollars) = 2.9e-11 != 0` (`precision.ts` Exp C) and the full ledger's
  global `sum(dollars) = 3.0e-11` (`ledger.ts`). A naive `sum(dollars) <> 0`
  integrity check **false-alarms on a correct ledger.**
- `sum(p.cents)` (integer) is **exact everywhere**: global = 0, per-account 0
  mismatches across 200 accounts / 11974 postings (`ledger.ts`), and matches the
  BigInt ground truth in every `precision.ts` Exp A row _except_ the extreme
  `4,000,000 postings / $10,000,000,000` row, where the _rounded-float_ balance is
  off by 14c while integer cents stays exact. All values stay < 2^53, so no integer
  overflow.
- Minor note (not a bug): `sum` appears to use naive left-fold accumulation, so
  float error grows with N; a Kahan/pairwise sum would shrink it. Doesn't matter if
  you use integer cents.

## What was smooth

- **Integer `sum()` aggregation is exact at every scale** — global balance 0,
  per-account trial balance 0 mismatches vs. an independent BigInt ground truth,
  no overflow. This is the load-bearing feature for a ledger and it just worked.
- **Date-range statements** — `WHERE t.`date` >= DATE '2025-01-01' AND < ... ORDER
BY t.`date``over`parseDate`values returns correctly filtered, correctly
ordered rows with`$param` binding (`ledger.ts` account statement).
- **Event veto is honored** — the vetoed edge genuinely never lands (integrity is
  safe; only the return-value feedback is weak, LOW-5).
- **Reserved-word error message** — `'date' is a reserved word; quote it as a
delimited identifier` is clear and actionable (the friction is that it fires at
  all for a `.property` access, not the message).
- **`parseDate` / `LocalDate.parse`** — correct and unsurprising; the fix for
  HIGH-1 is right there, just not the path a user reaches for first.

## Doc accuracy

- `LocalDate`'s source doc is honest (`constructor(readonly days: number)`), but
  there's no `(y, m, d)` factory and nothing steers a user away from the java.time
  spelling — see HIGH-1.
- No doc warns that `date`/`datetime`/`time` property names collide with reserved
  words and need backticks — see MED-2.
- Nothing documents that `createUniqueConstraint` is enforced only through the GQL
  write path and is advisory for core `addVertex` — see MED-3.
