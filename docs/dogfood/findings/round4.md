# Round 4 findings — ambitious, multi-subsystem apps at scale

Five personas, each a real application built to find the **ceiling** (missing
capabilities, scale limits), not papercuts. Verdict: **the library is
structurally solid — it scales, primitives are sound, and every doc _example_
ran verbatim.** Findings are missing higher-level capabilities + doc gaps.
Code: `.dogfood/round4/<persona>/`.

---

## Priyanka — ReBAC authorization service (Zanzibar-style)

**Built:** `check(user, perm, resource)` over User/Group/Resource + MEMBER_OF/
OWNER/PARENT/VIEWER/EDITOR, resolving transitive group membership + resource-
hierarchy inheritance + role→perm in one GQL query. Native (napi/ffi). Files:
`authz.ts`, `gen.ts`, `sync-replica.ts`, `merge-ingest.ts`, `gremlin-probe.ts`.

**Scale/perf (174k vertices / 403k edges):** load `graphFromNdjson` ~520–670ms
(53MB ndjson, parallel decoder); 3 indexes +27ms; `check()` **0.003–0.03ms/op**,
~**36.7k checks/s** single-thread prepared loop; deep 3-hop-group×2-hop-hierarchy
correct; reverse "resources U can view" 3 in 77ms; "who can edit dense resource"
110 users in **425ms** (reverse fan-out — the one query she couldn't make fast);
`mergeNdjson` append 4.5ms; RSS ~430MB (~1KB/element). Sync tuple→replica PASS.
Correctness 7/7; Gremlin agrees 5/5.

**Findings:**

- HIGH: second comma-joined `{k:$x}` anchor **full-scans** (175×) → C4 / R-SEED.
- MED-HIGH: reserved-word **labels** (`MATCH (x:Group)` throws) → C6.
- MED: no batch check / UNWIND / list params → R-BATCH.
- MED: Gremlin `emit()`/`emit().repeat()` **drop the start vertex** (zero-hop
  owner check false); `emit(true)` errors; `__in` not a step → V1.
- Capability gaps: multi-anchor join index, batch check, negative/deny rules,
  consistency tokens/result cache, traversal depth cap on `->*`, materialized
  reverse-closure.
- Doc: index-seek claim incomplete (C4); var-length placement `-[:X]->*(b)`
  undocumented (C5); reserved-word list omits labels (C6). Everything else ran
  as documented.

## Marcus — graph analytics / feature engineering

**Built:** degree/weighted centrality, PageRank, connected components, label
propagation → **Arrow** feature matrix. Native. Files: `gen.ts` (Barabási–Albert),
`analytics.ts`. Run `N=100000 M=10 bun analytics.ts`.

**Scale/perf:** 100k/1M — load 1.39s, PageRank 265ms/iter, CC 2.0s, LP(JS) 1.2s,
Arrow export 58ms+14ms decode, peak RSS 2.1GB. 300k/3M — load 3.9s, RSS 5.3GB.
600k/6M — load 9.3s, PageRank 2.5s/iter, CC 24.6s, **peak RSS 11GB, nothing fell
over**. In-memory graph ≈ **7× the ndjson size** → RAM is the ceiling (~1–1.5M
before RAM bites). PageRank sum=1.0; components exact; in-engine PR vs JS ref
matched ~15 sig-digits; integer columns survived float64 round-trip.

**In-engine vs pulled-to-JS:** degree/weighted = in-engine (grouped-agg `SET`);
PageRank per-iter math in-engine, loop+dangling-mass scalar in JS; CC in-engine
(min-label), loop in JS; **label propagation argmax = JS (no `mode`)**; Gremlin
PageRank not expressible (no `sack`).

**Findings:**

- HIGH: no `mode`/argmax aggregate → F1.
- MED: no in-engine fixpoint/loop; can't carry whole-graph scalar between
  statements; `SET` returns no affected-row count → R-FIXPOINT.
- Arrow float64/bool/utf8 only, scalar-only (list/element flatten to text) — fine
  here (int idx<2^53 exact) but embeddings/vector columns can't use Arrow.
- Doc: all examples ran as written. Wants a prominent "no in-engine fixpoint / no
  mode aggregate" note for analytics users.

## Lena — schema-validated data layer ("Prisma for graphs")

**Built:** typed entity/relationship defs, constraints (required/unique/
cardinality) enforced via `graph.on(...)` + `preventDefault()` veto, a migration
runner (`disableEvents()` during migrations, state as `:_Migration` vertices), a
fluent GQL query builder. Pure TS. Files: `schema.ts`, `repository.ts`,
`query.ts`, `migrate.ts`, `demo.ts`.

**Worked:** rejected duplicate unique email / missing required / second-author
cardinality / required-prop removal; 3 migrations + `graphContentEqual`
round-trip; builder query. Constraints, indexes, GQL all held.

**Findings:**

- HIGH: **silent veto** (vetoed call returns normal-looking value) — built a
  violation side-channel → C2 / R-VETO.
- HIGH: **no transactions/atomic multi-write** — hand-rolled compensating
  `removeVertex`; "exactly one" only enforceable as "at most one" → R-TX.
- MED: bulk `VertexPropertiesChanged` lacks `previous`, fires once for N keys →
  C3.
- Capability gaps: transactions, uniqueness primitive (index permits dupes; the
  reject is your listener), cardinality, cascade rules, migration story (easy to
  build — `disableEvents` was exactly right), typed entities (R-TYPED).
- **Elegant:** `graph.on` unsubscribe (clean attach/detach), pre-commit events
  with readable current state, `previous` on singular events, index-backed GQL
  seeking, `disableEvents`. Good foundation; missing piece is transactional +
  non-silent veto.
- Doc: all event claims held; omission — README never says the veto is silent
  (C1/C2).

## Kenji — real-time multiplayer state server

**Built:** `Bun.serve({ websocket })` authoritative server (one shared store, one
`createSyncHost`/socket) + N real `new WebSocket` clients via
`createReconnectingClient`; per-viewport keyed live queries, presence, high-rate
writes, reconnection storm, snapshot checkpoint. Files: `canvas.ts`,
`restore-check.ts`.

**Scale/concurrency:** 8c 483w/s p99 62ms; 32c 313w/s p99 220ms converge 68ms;
48c 240w/s p99 573ms converge 262ms. **Convergence YES at every scale**; storm
survived (all 24 killed sockets reconnected); checkpoint restored 749 vertices.
Memory a non-issue (70→132MB). Only anomaly: **+2 counter over-count** from
at-least-once replay (not a store bug).

**Findings:**

- 🔴 **Optimism + shared-server don't compose over a socket** — protocol carries
  `rows`, no server→client write stream for `engine.ingest` → C7 / R-CDC (his
  biggest).
- 🟠 **Fan-out O(N²) single-thread** — every write re-scans+diffs+sends every
  subscription; throughput drops as clients rise; ~100-client wall → R-FANOUT.
- at-least-once replay double-applies (no request-id dedupe) → R-DEDUPE; no
  `MERGE` → duplicate presence inserts (64 cursors/32 clients) → R-MERGE;
  ephemeral nodes leak into checkpoints → R-EPHEMERAL; no send backpressure.
- MED: unused-param silently dropped → C8; reserved-word alias tax.
- Doc: examples ran verbatim. `frontend-worker.md` steers away from the socket-
  server topology; no server guide; the no-write-stream gap unflagged → C7.

## Sofia — bitemporal knowledge graph

**Built:** valid-time (`validFrom`/`validTo` on edges + GQL range predicates) +
transaction-time (append-only event log from `@graph/mutate`, seq/txTime/actor,
ndjson snapshot checkpoints + tail replay). Files: `temporal.ts`, `demo.ts`.

**Worked:** as-of org chart (GQL ranges); point-in-time "who reported to Bob";
entity audit trail; reconstruct tx-state at seq from snapshot+replay + diff; full
bitemporal (reconstruct tx-state, then run valid-time query on it). null fidelity
through ndjson preserved.

**Findings:**

- HIGH: **event value access undocumented** (`e.value.original.value`); bad guess
  (`e.data`) throws unhandled-microtask; core README `previous` note is a trap →
  C1.
- MED: `@graph/mutate` payload untyped (`{ original: EmitterEvent<any,any> }`) —
  hand-wrote a 12-case normalize switch (wants discriminated union).
- MED: edge-property events don't self-identify endpoints for entity audit
  (denormalize `edge.from.id` at emit).
- MED: no app metadata channel on mutations (bolted on ambient `tx()` context).
- LOW: `*PropertyRemoved` carries no `previous` → C3.
- Capability gaps: no native temporal/interval types, no half-open "as-of" index,
  no append-only mode, no `graph.replay(ops)`/op codec → R-TEMPORAL. Snapshots as
  checkpoints = strongest piece (ndjson + null fidelity trivial).
- Doc accuracy: core README `previous` note is misleading (`event.value.previous`
  vs `event.previous`) → C1; no README shows the `event.value.…` access pattern.
