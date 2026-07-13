# Dogfood round 5 — Yuki — @lenke/sync multiplayer / CDC

**App built:** a live collaborative kanban board with presence, on the documented
multiplayer topology — one authoritative server (shared `Store` + `WriteLog` +
`DedupRegistry`, one `createSyncHost` per connection), N clients each with its own
optimistic `createSyncEngine` + `createSyncClient`, wired over an in-process
"socket" I can cut and re-dial. Cards are `INSERT`/`SET`; presence is `_MERGE`
upsert + `onDisconnect` ephemeral teardown; cross-client changes flow via
`subscribeWrites` -> `engine.ingest`.

**Could I build a real 2-client app from the docs alone?** _Partially — no._ The
sync README's "Multiplayer: the CDC write stream" section gets you the core
topology (shared store+writeLog, host-per-socket, `subscribeWrites`->`ingest`) and
that part is accurate and worked first try. But three things I needed for a
_real_ app are absent from the README and only exist in source JSDoc: **presence
teardown** (`client.onDisconnect` + `host.close` broadcast — the word
"onDisconnect" never appears in the sync README), **exactly-once wiring**
(`createDedupRegistry` + the `dedup` host option — the README only says
"exactly-once needs server-side request-id dedupe" and stops), and the
**schema-mirroring requirement** (every client's optimistic store must
`createUniqueConstraint`/index identically — mentioned nowhere). I had to read
`client.ts`, `host.ts`, `dedup.ts`, and `cdc.test.ts` to wire presence and
exactly-once. What worked cleanly: basic CDC propagation, `_MERGE` presence
updates (no dup), `onDisconnect` teardown, interest routing, and clean reconnect
catch-up.

Repros are runnable: `bun 01-smoke.ts`, `02-presence.ts`, `03-reconnect.ts`,
`04-crownjewel.ts`, `05-robustness.ts` (shared harness in `lib.ts`).

---

## 1. Origin-skip is not stable across reconnect -> a client re-applies its OWN write

- **Severity:** HIGH
- **Category:** BUG
- **Repro** (`04-crownjewel.ts`, both variants confirmed):
  1. Client A commits `INSERT (:Item {id:'x1'})`. The host applies it, appends it
     to the shared `WriteLog` (seq 1, origin = A's connection id), and sends A the
     ack + the empty CDC cursor-tick.
  2. A's socket drops _after the write commits server-side but before A receives
     the ack + tick_ — the canonical lost-ack reconnect race the `DedupRegistry`
     exists to handle. A's write-cursor is now behind seq 1; the write is pending.
  3. A re-dials. A real reconnect creates a **new** `createSyncHost` ->
     `writeLog.register()` -> a **new** origin id (exactly the README's
     `onConnection((socket) => createSyncHost(store, { writeLog }))`).
  4. `client.replay()` re-sends the pending mutate (server dedup re-acks, no
     re-apply — good) **and** re-subscribes the write stream from A's stale cursor.
     `writeLog.since(cursor)` returns A's own seq-1 write, which now carries a
     _stale_ origin id, so the new host's origin-skip (`entry.origin !== thisOrigin`)
     does **not** recognize it and forwards it back to A -> `engine.ingest` re-applies it.
  - **Expected:** A.local Item count = 1; server = 1 (exactly-once end to end).
  - **Actual — Variant A (label with no unique constraint):** A.local = **2**,
    server = 1. **Silent optimistic/authoritative divergence.**
  - **Actual — Variant B (`INSERT` under a unique constraint, e.g. `Card.id`):**
    the re-`ingest` throws `E_CONSTRAINT_VIOLATION` **out of `client.receive()`
    out of `client.replay()`** -> the reconnect is aborted (standing queries after
    the throw never re-subscribe, `onDisconnect` never re-registers).
- **Why the existing guards miss it:** `DedupRegistry` guards the _mutate-replay_
  path (server-side, keyed on `req`). The CDC catch-up path has no equivalent —
  there is no dedupe on `ingest`, and the client's cursor ordering-guard is
  defeated because the cursor is _behind_ (that's the trigger). Origin-skip is the
  only thing meant to stop self-echo, and it is keyed to a **per-connection** id
  that changes on every reconnect. The README states "The writer never gets its
  own echo (origin-skip)" as unconditional; it does not hold across reconnect.
- **Why the test suite doesn't catch it:** `cdc.test.ts`'s reconnect test calls
  `a.replay()` against the **same** host (same origin) — it never rebuilds the
  host, so the origin stays stable and the bug is masked. A faithful reconnect
  rebuilds the host.
- **Workaround:** make _all_ replicated writes idempotent (`_MERGE` everywhere),
  so a re-applied own-write is a no-op. This is the documented "idempotent writes
  make at-least-once replay-safe" advice — but (a) it's not stated in the context
  of _self_-echo across reconnect, and (b) it doesn't save the constraint variant:
  a non-idempotent `INSERT` under a unique constraint **crashes `replay()`** rather
  than degrading to a no-op. A real fix needs a stable per-_client_ origin id
  (carried across reconnect) rather than a per-connection one, or ingest-side
  dedupe on the write stream.

## 2. One poison write in a CDC batch escapes `receive()` and partially applies

- **Severity:** MED
- **Category:** BUG / ERGONOMICS
- **Repro** (`05-robustness.ts` part b): drive
  `client.receive({ type:'writes', cursor:1, writes:[{text:'INSERT (:Item {id:1})'},{text:'THIS IS NOT GQL'}] })`
  with `subscribeWrites(w => engine.ingest(w))`.
  - **Expected:** a malformed/failing replicated write is contained (skipped +
    reported), the stream keeps flowing.
  - **Actual:** `engine.ingest` wraps the whole batch in one `store.mutate`; the
    second write throws a parse error that propagates **out of `client.receive()`**,
    and — no transaction — the first write has **already applied** (local Item
    count = 1). So a single bad op in the stream both wedges `receive()` and leaves
    a partial apply.
- **Impact:** any write that is valid on the authoritative server but fails
  locally (schema drift, a constraint the local store lacks, an engine version
  skew) becomes a poison pill that throws out of the client's message pump. There
  is no try/catch around the `writeHandler` invocation in `client.receive`, and
  `engine.ingest` offers no per-write isolation or `onIngestError` hook.
- **Workaround:** wrap your own `subscribeWrites` handler in try/catch and ingest
  writes one-at-a-time yourself — but then you own atomicity and error reporting
  that the engine should arguably provide.

## 3. Schema (constraints/indexes) is not replicated by CDC — mismatch crashes ingest

- **Severity:** MED
- **Category:** CAPABILITY / DOCS
- **Repro** (`05-robustness.ts` part c): a client whose optimistic store was built
  _without_ `createUniqueConstraint('Presence','sid')` ingests a replicated
  `_MERGE (p:Presence {sid:$s})` from a peer.
  - **Expected:** replicated writes behave identically on every store.
  - **Actual:** ingest throws `_MERGE could not determine a unique key from the
pattern — declare a unique constraint on the label` (clear message, at least),
    which then escapes `receive()` per finding #2.
- **Impact:** statement-based replication assumes byte-identical engines _and_
  identical schema, but schema setup is entirely out-of-band and undocumented.
  Every client's optimistic store, the server store, and any snapshot-hydrated
  store must run the same `createUniqueConstraint`/`createVertexIndex` calls, in a
  way that never rides the wire. A `_MERGE`-based presence app (the headline use
  case) is exactly the one that depends on this. Nothing in the sync README
  mentions it; I only discovered it because `_MERGE` requires a constraint.
- **Workaround:** factor schema into one function and call it when constructing
  every store (I did — `installSchema` in `lib.ts`). Document this loudly.

## 4. Presence + exactly-once wiring lives only in source, not the multiplayer doc

- **Severity:** MED
- **Category:** DOCS
- **Repro:** read `packages/sync/README.md` "Multiplayer" section end-to-end and
  try to build presence-with-teardown and exactly-once writes.
  - **`onDisconnect`** (the ephemeral presence-teardown primitive the charter
    centers on) is **not in the README at all** — no mention of the message, the
    `host.close` broadcast, or the `_MERGE`+`DETACH DELETE` pattern. It exists only
    as JSDoc on `SyncClient.onDisconnect`.
  - **`createDedupRegistry` / the `dedup` host option** — the README's v1
    boundaries say "exactly-once needs server-side request-id dedupe" but never
    show the API or that all hosts must **share one** registry. Wiring it needs
    `dedup.ts` + `cdc.test.ts`.
- **Impact:** the two things that turn "CDC demo" into "real collaborative app"
  (presence teardown, exactly-once) both require reading source. The README's
  self-description over-promises.
- **Workaround:** read `client.ts`/`host.ts`/`dedup.ts` JSDoc + `cdc.test.ts`.

## 5. No in-process client<->host pair helper — every consumer hand-rolls circular wiring

- **Severity:** LOW
- **Category:** ERGONOMICS
- **Repro:** wiring even one client to the server is a circular-reference dance
  (`host.send -> client.receive`, `client.send -> host.receive`, one assigned after
  the other). `cdc.test.ts` solves it with a `link` box; my `lib.ts` re-solves it
  with cuttable links; the README shows it with yet another box. The exported
  `port.ts` helpers (`servePort`, `serveSharedWorker`, `connectSharedWorker`) only
  target `MessagePort`/`SharedWorker`, not an in-process or plain-WebSocket pair.
  - **Expected:** a `connectInProcess(host)` / test-transport helper returning a
    wired `{ client, host }`.
  - **Actual:** ~15 lines of boilerplate per connection, re-invented in every test
    and example. It's also the easy place to get reconnect wrong (I initially
    forgot to restore the host->client direction on re-dial).
- **Workaround:** copy the `link`-box pattern.

## 6. `mutate` promise never rejects/settles on a dropped ack (no timeout)

- **Severity:** LOW
- **Category:** ERGONOMICS / CAPABILITY
- **Repro:** cut the host->client link, then `client.mutate(...)`. The returned
  promise stays pending forever (until `close()` rejects it or a reconnect+replay
  re-sends and gets an ack). The engine's write-back queue keeps it counted.
- **Impact:** there's no per-request timeout; a UI awaiting `mutate()` for a toast
  or spinner hangs across a silent disconnect until the reconnect manager acts.
- **Workaround:** don't await `mutate()` for UI; rely on the optimistic local
  apply + `onStatus` for connectivity.

---

## What worked (verified, no defects)

- Basic 2-client CDC propagation and cross-client `SET` updates — all three stores
  converged (`01-smoke.ts`).
- `_MERGE` presence: repeated upserts update in place with no duplicate node;
  peers see the moved cursor (`02-presence.ts`).
- `onDisconnect` ephemeral teardown: `host.close()` runs the cleanup write and
  broadcasts the `DETACH DELETE` over CDC — presence vanished everywhere
  (`02-presence.ts`).
- Interest routing: a `:Card`-only watcher did **not** receive a `:Note` write
  (`05-robustness.ts` part a).
- Clean reconnect catch-up (ack received before the drop): a client that missed
  peer writes while offline caught up exactly once, no drop, no double
  (`03-reconnect.ts` part 1).
- Error messages on the failure paths I hit were clear and coded.
