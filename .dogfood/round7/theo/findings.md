# Dogfood Round 7 — Theo: React dashboard on a live graph

Built a live analytics dashboard over `@lenke/native`'s `createStore` /
`liveQuery` and `@lenke/react`'s `useLiveQuery`. Contract under test: after every
mutation, `live.getSnapshot()` must equal a fresh one-shot `graph.query(text)`
for the same text+params, byte-for-byte.

Files: `dashboard.ts` (harness + `expectLiveEqualsFresh`), `run-correctness.ts`
(16-step mutation stream, correct deps), `probe-deps.ts` (epoch/deps model),
`probe-inferdeps.ts` (`inferDeps` under-grab), `probe-reserved.ts` /
`probe-quote.ts` (reserved words + quoting), `hooks.test.tsx` (real
`useLiveQuery`), `happydom.preload.ts`.

Verdict: the epoch-gated live-query engine is exactly correct when deps are
declared exactly (`run-correctness.ts` 16/16, `hooks.test.tsx` 3 pass). Every
rough spot is the deps contract being sharp and under-defended — it is
`useEffect`-style manual dependency tracking, and an under-declared dep produces
a silently stale render with no runtime signal.

## HIGH-1 — A shipped guide example under-declares deps and would render stale

- Severity: HIGH; Category: BUG (docs)
- Repro: `docs/guides/frontend-worker.md:64`:
  `client.liveQuery('MATCH (p:Person) RETURN p.name', { deps: ['Person'] })`.
  Reads `p.name`, deps omits key `name`. In-place `SET p.name` touches only
  `epoch('name')`, never `epoch('Person')` → fingerprint never moves → stale.
- Evidence: structurally identical to `probe-deps.ts §A` (`sum(o.amount)` /
  `deps:['Purchase']`): after `SET o.amount=999`, live=`[{"total":180}]`,
  fresh=`[{"total":1079}]`, notified, version bumped, no throw.
- Contradiction: `packages/react/README.md:76` uses `deps:['Person','name']`.
- Fix: `deps:['Person','name']` or `null` deps.

## HIGH-2 — Under-declared deps → silent stale live query (quantified)

- Severity: HIGH (whole risk surface; by-design but undefended)
- probe-deps.ts §A: `sum(o.amount)` deps `['Purchase']`; after `SET o.amount=999`
  → live 180 / fresh 1079, STALE, subscriber fired, version bumped.
- §B latent-trap timing: safe through INSERT (live=fresh=185, label epoch moves),
  stales on first in-place SET (live 185 / fresh 680).
- §C under-declared edge type: `MATCH (:Purchase)-[c:CONTAINS]->(:Item) count(*)`
  deps `['Purchase','Item']`; after new CONTAINS edge → live lines:1 / fresh
  lines:2.
- React layer (hooks.test.tsx): under-declared test → DOM stuck at 180 while
  fresh=1079; 3 pass / 0 fail (deterministic).
- No runtime signal (no throw/warn). `store.ts:270` docstring warns.
- Fix direction: dev-mode assertion recomputing vs `null` deps; over-declaring is
  always correct (§E) so a guard could auto-widen.

## MED-3 — inferDeps() silently misses inline-map filter keys

- Severity: MED; Category: BUG (helper under-grabs)
- probe-inferdeps.ts: `inferDeps("MATCH (o:Purchase {status:'paid'}) RETURN
count(*)")` → `["Purchase"]`, missing `status`.
- Cause: `packages/native/src/store.ts:276` regexes `:Label` (`/:([A-Za-z_]\w*)/`)
  and `.key` (`/\.([A-Za-z_]\w*)/`); inline-map `{status:'paid'}` has no dot.
- Effect: README-recommended `deps: inferDeps(Q)` → stale. After
  `SET o2.status='paid'`: live paidOrders:2 / fresh paidOrders:3.
- Correct for dotted access + edge types (probe-deps §D: `WHERE o.status`,
  `[:CONTAINS]` captured). Only no-dot inline-map form leaks.
- Fix: capture inline-map keys, or parse instead of regex.

## MED-4 — Reserved-word rejection inconsistent and hint-free for keyword-lexed labels

- Severity: MED; Category: ERGONOMICS (error quality)
- probe-reserved.ts: Product/Group/Value/Sum → "'Product' is a reserved word;
  quote it as a delimited identifier" (actionable). Order/Count/Match/Return →
  "Expected a label name, got 'order'" (no hint; lowercased echo).
  OK: Item, Purchase, Customer, User, Status, Category, Node, Edge.
- Cause: `parser.rs:175` bind_name does `expect(Tt::Ident)` then is_reserved
  (good msg :180); keyword-lexed tokens fail expect and fall to generic
  `Expected {what}, got '{got}'` (:168).
- Impact: Order + Product (first two e-commerce labels) give different errors,
  the more common one unhelpful.
- Fix: route keyword-lexed label-position tokens through the reserved-word
  message; echo original casing.

## LOW-5 — "delimited identifier" hint names no delimiter; SQL-natural guess fails

- Severity: LOW; Category: ERGONOMICS/DOCS
- probe-quote.ts: ``INSERT (:`Order` {oid:1})`` OK, round-trips
  (``MATCH (o:`Order`)`` → `[{"oid":1}]`); `INSERT (:"Order" {oid:2})` FAIL
  "Expected a label name, got 'Order'" (double-quotes = string literal).
- Fix: make hint concrete — "quote it with backticks: `` `Order` ``".

## What worked well

- Correct deps are exactly correct: run-correctness.ts 16/16 (inserts, in-place
  SET on amount/status/category, DETACH DELETE, REMOVE, re-SET, batched multi-
  statement mutate, read-only no-op, category mass-delete) — live === fresh at
  every step, exit 0.
- React hook faithful: hooks.test.tsx drives real @lenke/react useLiveQuery over
  real native store via @testing-library/react; correct deps update DOM 180→1079;
  3 pass/0 fail; under-declared deterministically stale.
- Epoch gating fine-grained (§B): INSERT bumps label epoch, SET x.k bumps only
  epoch(k).
- inferDeps right for dotted access + edge types (§D).
- Over-declaring safe (§E): only needless recomputes, never wrong answers.
- Backtick delimited ids round-trip; `null` deps coarse mode is a documented
  always-correct escape hatch; Symbol.dispose teardown clean.

## Doc accuracy

- docs/guides/frontend-worker.md:64 — WRONG (HIGH-1): under-declared deps example.
- packages/native/README.md:80 — presents inferDeps as ergonomic default without
  flagging the inline-map hole (MED-3).
- packages/react/README.md:76 — correct (`['Person','name']`), contradicting the
  worker guide.
- store.ts:270 inferDeps docstring accurately describes the risk; nothing at
  runtime enforces it.
