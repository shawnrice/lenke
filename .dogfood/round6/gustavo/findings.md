# Dogfood Round 6 — Gustavo: Audit / Versioning Layer Findings

Built an event-sourced HR audit/versioning layer on `@lenke/core` events +
`@lenke/sync` `WriteLog` + `@lenke/serialization` ndjson snapshots. Reconstructed
history "as of seq N", verified against ground-truth clones, diffed versions, and
answered a bitemporal (valid-time × transaction-time) question.

Files: `audit.ts` (the ledger), `hr-audit.ts` (scenario + reconstruction + verify),
`probes.ts`, `probe-liveref.ts`, `probe-observability.ts`.

Verdict up front: **yes, you can build a correct audit/versioning layer today —
but only via id-stable content snapshots (`serialize(g,'ndjson')` / `clone()`),
NOT via the event stream alone and NOT via `@lenke/sync`'s statement replay.**
The event stream is a lossy change-notification, not a sufficient journal.

---

## HIGH-1 — Purely-event-driven undo/redo silently corrupts state (README overclaim)

- **Severity:** HIGH
- **Category:** BUG (docs overclaim -> silent data corruption)
- **Repro:** `packages/core/README.md` states the property-change events are
  "enough to build an undo/redo stack **purely from events** without reading
  pre-commit state yourself." Build such a stack (capture only event payloads),
  then on one `Employee` vertex do: `setProperty('salary',...)` (singular),
  `setProperties({title,salary,level})` (bulk), `removeProperty('ssn')`. Undo by
  reversing the captured payloads.
  - Expected: original state restored.
  - Actual: `title` and `ssn` are **lost** (`undefined`) — silently. See
    `hr-audit.ts` -> "CROWN JEWEL" output.
- **Cause:** `VertexPropertiesChanged` / `EdgePropertiesChanged` carry `next` but
  **no `previous`**; `VertexPropertyRemoved` / `VertexPropertiesRemoved` carry the
  key(s) but **not the removed value**. (`probes.ts` PROBE B & C.) So a reverse
  from the event payload cannot restore a bulk-set-overwritten key or a removed
  key. The claim holds ONLY for singular `VertexPropertyChanged` (which has
  `previous`). This is the crown jewel: a real undo built to the README's spec
  produces wrong history and never errors.
- **Workaround:** Do NOT trust event payloads for reversal. Read the pre-commit
  value off the live element **synchronously in the listener** (events fire
  pre-commit, so `event.value.vertex.getProperty(key)` is still the OLD value) —
  this is what `audit.ts` does. Or snapshot the whole element/graph per tx.
  Either way you are working _around_ the payload, not _from_ it.

## HIGH-2 — `graph.truncate()` emits no events -> a full wipe is invisible to the journal

- **Severity:** HIGH (for an audit/observability use case)
- **Category:** BUG / CAPABILITY (observability gap)
- **Repro:** Populate a graph, attach listeners for `VertexRemoved`/`EdgeRemoved`,
  call `graph.truncate()`. Expected: N removal events (an audit log must record a
  mass deletion). Actual: **0 events**; the graph goes from 2 vertices to 0 with
  zero journal entries. See `probe-observability.ts` PROBE I.
- **Impact:** The single most destructive operation in the API (erase everything)
  is the one operation a listener-based audit log cannot see. A compliance trail
  would show the graph simply "ending" with no recorded cause.
- **Workaround:** Wrap/ban `truncate()` in the audited layer; force mass deletes
  through `removeVertex` loops (which do cascade + emit). Or diff snapshots to
  detect the drop after the fact (but then you've lost the actor/time).

## MED-3 — Statement replay (`@lenke/sync` WriteLog model) can't be verified by the documented verifier

- **Severity:** MED
- **Category:** CAPABILITY / DOCS
- **Repro:** Journal each GQL write into a `createWriteLog()` (statement-based
  replication, exactly the `@lenke/sync` CDC model). Replay the statements into a
  fresh `Graph` and compare with `graphContentEqual(replay, original)` (the
  serialization README's documented round-trip verifier).
  - Expected (naively): equal.
  - Actual: **`false`.** `graphContentEqual` compares **by id**, and vertex/edge
    ids are random `crypto.randomUUID()` (`@lenke/utils` `rando()`), so a replay
    mints fresh ids for every element. `probes.ts` PROBE E, `hr-audit.ts` QUERY 3.
- **Impact:** The two "replay" stories collide. `@lenke/sync`'s whole premise is
  statement replay being "deterministic because the two engines are byte-
  identical" — but that determinism does **not** extend to element ids, and the
  only exported structural-equality check keys on ids. There is no exported
  id-ignoring equality, so you cannot assert a replay reproduced a prior state.
- **Workaround:** Reconstruct from id-stable content snapshots
  (`serialize(g,'ndjson')` or `clone()`) instead of statement replay — these ARE
  id-stable and pass `graphContentEqual` (verified for all 8 tx boundaries,
  `hr-audit.ts` QUERY 2). If you must replay statements, hand-roll id-ignoring
  content equality (`graphContentEqualIgnoringIds` in `audit.ts`).

## MED-4 — Event element references are live, not snapshots; deferred reads lose removed state

- **Severity:** MED
- **Category:** ERGONOMICS / DOCS
- **Repro:** In a `VertexRemoved` (or `EdgeRemoved`) listener, store `event.value`
  (the element) and read it _after_ the mutation commits — as any async/batched/
  end-of-tick journal flush would. `probe-liveref.ts` PROBE H + `probe-observability.ts`
  PROBE K.
  - At emit: `{name:'Ivy', salary:100}` / edge `Mgr -> Report`.
  - After commit: vertex reads `{properties:{}}` (evicted); **edge ref throws**
    `null is not an object (evaluating 'this.#graph.getVertexById')`.
- **Impact:** A journal that captures the ref and serializes lazily silently
  records empty/garbage for every deletion — the exact records an audit log most
  needs. Also: an `INSERT` emits only `VertexAdded` (no per-property events), so
  initial property values _only_ exist on that live ref — miss the synchronous
  read and you never captured them. The README says events fire pre-commit and
  carry old state, but never warns the element handle is valid _only_ synchronously.
- **Workaround:** Snapshot everything you need (`{...v.properties}`, `[...v.labels]`,
  edge `from.id`/`to.id`) **inside** the listener, synchronously. Never store the
  raw element ref in the journal.

## MED-5 — `@lenke/sync` snapshot machinery is bound to the native `Store`; unusable from pure `@lenke/core`

- **Severity:** MED
- **Category:** CAPABILITY / DOCS
- **Repro:** `createSnapshotStore` / `encodeSnapshot` (the encryption + OPFS +
  pending-write persistence layer the sync README documents for warm boot) take a
  `Store` from `@lenke/native` and call `store.graph.toNdjson()`. A core `Graph`
  has **no `toNdjson`** (`grep` confirms; `typeof g.toNdjson === 'undefined'`).
  So a pure-TS `@lenke/core` app cannot use the sync snapshot/encryption path at
  all.
- **Impact:** The charter's "pure-TS `@lenke/core` + `@lenke/sync`" persistence
  story has a seam: the _statement_ log (`createWriteLog`) is portable, but the
  _snapshot_ half of "replay + snapshot" only exists for the native store. You
  must hand-roll snapshots via `@lenke/serialization` (`serialize/deserialize`)
  and re-implement encryption/OPFS yourself.
- **Workaround:** Use `@lenke/serialization` ndjson for snapshots (id-stable,
  verified). Accept that AES-GCM/OPFS/pending-write persistence from `@lenke/sync`
  is native-only.

## LOW-6 — No-op writes emit change events -> phantom entries in the audit trail

- **Severity:** LOW
- **Category:** ERGONOMICS
- **Repro:** `v.setProperty('salary', 100)` twice when salary is already 100 ->
  **2** `VertexPropertyChanged` events (`100 -> 100`). `probe-observability.ts`
  PROBE L.
- **Impact:** An audit trail records "salary changed" events where nothing
  changed — noise, and misleading in a compliance context ("who changed the
  salary?" -> nobody, it was a no-op re-save).
- **Workaround:** Drop records where `value === previous` (structurally) in the
  ledger.

## LOW-7 — Silent veto is invisible to the writer (re-confirmed, quantified)

- **Severity:** LOW (known from round 4; re-confirmed with new detail)
- **Category:** ERGONOMICS
- **Repro:** A listener calls `event.preventDefault()` on `VertexPropertyChanged`.
  The write is dropped, but `v.setProperty(...)` **returns `undefined`** — no throw,
  no boolean, no signal. `probes.ts` PROBE F. The writer cannot distinguish a
  vetoed write from a successful one; only later listeners see `defaultPrevented`.
- **Workaround:** Read back the value after writing, or expose a veto channel out
  of band. (Good news: direct `.properties` mutation is _blocked_ — `probe-observability.ts`
  PROBE M throws — so the journal can't be bypassed that way.)

---

## What worked well

- GQL mutations (`INSERT`/`SET`/`REMOVE`/`DETACH DELETE`) **do** emit the full
  event stream, so you can journal a GQL-driven app from `graph.on(...)` (PROBE A).
- Singular `VertexPropertyChanged` carries a correct `previous` (incl. through GQL
  `SET`, and `null` as a first-class value — PROBE A2, PROBE G).
- Cascade edge removal on `removeVertex` **does** emit `EdgeRemoved` (PROBE D).
- `clone()` and `serialize/deserialize('ndjson')` are **id-stable** -> reconstruction
  "as of seq N" verified byte/id-equal to ground truth for all 8 tx boundaries.
- `createWriteLog` is backend-agnostic and works fine as a statement journal
  (just not as a _verifiable_ reconstruction source — see MED-3).
- Bitemporal (valid-time × transaction-time) works when you carry a `validTime`
  on each record and index by seq — the graph doesn't help, but doesn't fight you.
