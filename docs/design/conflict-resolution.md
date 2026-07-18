# Conflict resolution (LWW / HLC) — design note & threat model

Status: **Not shipped.** This is a design + threat-model note for last-write-wins
(LWW) conflict resolution in the multiplayer / CDC path, written *before* any
implementation so the one dangerous mistake is on record. The "documented recipe
vs built-in" decision is open; **either way, the host-validation requirements
below are non-negotiable.**

## Why

In multiplayer, two clients can write the same element concurrently — each before
seeing the other's write. Both writes eventually reach every replica. Something has
to decide which one wins, **deterministically on every replica**, or replica A keeps
client-1's value and replica B keeps client-2's and they diverge forever (no eventual
consistency).

LWW answers "the write with the latest timestamp wins," and lenke already exposes the
mechanism — `_MERGE (n {k:$k}) _ON_UPDATE SET … WHERE current.version < $incoming`.
The open question is only *what the timestamp is* and *who is trusted to assign it*.

## The trap: a client-assigned clock is untrusted metadata

The obvious design — each client stamps its own write with a Hybrid Logical Clock
(HLC) and the higher stamp wins — is **not safe against a malicious or buggy client.**
HLC (and Lamport, and wall-clock LWW) assume cooperative, roughly-honest participants.
Two concrete attacks break it:

1. **Skew-to-win.** A client stamps its writes at a far-future time (year 3000) and
   wins *every* conflict until real time catches up — i.e. never. It's just choosing a
   big number the loser agreed to honor.
2. **Clock poisoning (worse — it's persistent and it spreads).** HLC's defining rule is
   "on receiving a stamp higher than mine, advance to it." So one poisoned far-future
   write doesn't win once — every node that ingests it **ratchets its own clock
   forward**, and because HLC is monotonic it **cannot go back**. A single attacker
   drags the whole system's logical time into the far future permanently; afterward even
   honest writes carry the inflated stamp. The very feature that makes HLC track
   causality is the propagation vector.

The root cause is not the clock algorithm — it's **who assigns the clock.** No
client-side scheme fixes it.

## What the host MUST validate

lenke's advantage is that the sync/CDC path is **not** peer-to-peer: there is a
**trusted host** — the authoritative store plus the per-connection host that applies
every committed write. Conflict resolution must lean on that trust boundary:
**clients propose, the host decides.** A conforming implementation MUST enforce all of
the following at the host:

1. **The host assigns the ordering stamp, not the client.** On commit, the host stamps
   the write with a value from the host's own monotonic clock (an HLC or a
   `(hostSeq, region)` tuple). Any client-supplied timestamp/version is a **hint at
   most**, never the authoritative value used in the `WHERE current < incoming`
   comparison. This alone kills skew-to-win — the client no longer mints the winning
   number.
2. **Reject / clamp out-of-bound stamps.** If a client *is* allowed to propose a stamp
   (e.g. for an offline queue that must preserve intent), the host MUST reject or clamp
   any proposed time more than a small bound `ε` ahead of the host's own `now`. An
   unbounded proposed value must never enter the monotonic chain. This kills poisoning
   at the client→host boundary.
3. **`advance-on-receive` is host↔host only.** HLC's "advance my clock to a higher
   received stamp" step is permitted **only** between mutually-trusted hosts
   (multi-region infra), where skew is bounded and both parties are trusted. It MUST
   NOT advance the authoritative clock from a value that originated at a client. A
   client write never moves the host's clock forward except by the host's own
   `max(now, hostClock)+1` tick.
4. **Authorization gates *who may write*, before any clock compares *which write wins*.**
   Conflict resolution orders the writes that were **already authorized**; it is not an
   access-control mechanism. A client with no permission to touch an element must be
   rejected by authz regardless of any timestamp it presents. Never let "won the LWW
   compare" stand in for "was allowed to write."
5. **The stamp travels on the host-assigned CDC entry.** The value other replicas
   compare against is the host-assigned stamp carried on the write-log entry (the CDC
   stream), not anything a client attached. Replicas resolve against host truth.

In short: the timestamp is **server-authoritative, bounded, and advanced only by
trusted parties** — everything a client sends is a proposal subject to those checks.

## The recipe shape (if we document rather than build)

If lenke ships this as a documented recipe (the same "docs, not a built-in" call made
for [bitemporal](../guides/bitemporal.md)), it is a host-side pattern, not a client
convention:

- The host stamps each committed write with a monotonic `hlc` (a comparable
  string/tuple) from its own clock, writes it onto the element, and puts it on the CDC
  entry.
- Ingest/merge resolves with the host-assigned value:
  `_MERGE (n {id:$id}) _ON_UPDATE SET … WHERE n.hlc < $incomingHlc` — where
  `$incomingHlc` came off the CDC entry, never from a client body.
- A client's offline-queued write carries *intent* (the fields it wants), not the
  authoritative order; the host re-stamps on replay, subject to the ε bound.

A built-in would wire the same host-side stamping + comparison into `_MERGE` / the CDC
ingest path directly; the trust rules are identical.

## Boundaries worth stating out loud

- **LWW discards the loser.** Even host-stamped and un-poisonable, LWW *silently drops*
  the losing write. Fine for a presence field or a cursor position; wrong for anything
  you can't afford to lose. Those want a mergeable type (a CRDT) or to **surface** the
  conflict for the app to resolve, not auto-resolve by timestamp.
- **Trustless P2P is out of scope.** If clients ever sync directly with no trusted host
  in the path, none of the above holds and you need CRDTs or BFT consensus instead —
  much heavier. lenke deliberately does not put clients in that position: the host is
  always in the write path.

See also: the CDC write stream (`packages/sync/README.md` → "Multiplayer") and the
value-scope routing that decides *which* writes a client receives
(`../guides/frontend-worker.md`) — scope routing is likewise an optimization, not a
security boundary, and is enforced at the host.
