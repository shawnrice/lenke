# Query cost on the pure-TypeScript graph

Every figure here is measured, on the pure-TS engine, with the probe named beside it. They are the
differences large enough to change how you write a query — not micro-optimizations.

## Fetch a whole result once, rather than paging it

Paging re-runs the query for every page. A sorted result has to be sorted again each time, so walking the
whole thing costs far more than asking for it once.

20,000 rows, pages of 50 (`packages/native/paging-2275.ts`):

| How                              | Total  |
| -------------------------------- | ------ |
| One query returning every row    | 1.7 ms |
| Keyset pages (`WHERE k > $last`) | 136 ms |
| Offset pages (`SKIP k LIMIT 50`) | 229 ms |

If you need the whole result — an export, a recomputation, a sync — ask for it in one query. Paging is for
when a person is looking at one screenful.

## When you do page, resume from the last key

`SKIP k` counts past `k` rows and discards them, so later pages cost more than earlier ones. Carrying the
last key instead removes that entirely: keyset paging costs the same as fetching page one repeatedly.

```gql
-- offset: page 400 counts past 20,000 rows to return 50
MATCH (p:Person) RETURN p.surname AS s ORDER BY s SKIP 20000 LIMIT 50

-- keyset: resume where the last page stopped
MATCH (p:Person) WHERE p.surname > $lastSurname RETURN p.surname AS s ORDER BY s LIMIT 50
```

Keyset is **1.7x** cheaper over a full walk. Two things to know:

- **Add a tiebreak column.** A strict `>` on a key with duplicates skips the rows that tie with the last
  one — in the measurement above, 4 rows of 20,000 vanished. Order by the key _and_ something unique
  (an id), and compare the pair.
- **An index does not help here.** A range index on the cursor key made the same walk **27% slower**: early
  in a walk `k > $last` matches nearly every row, so the index adds maintenance without narrowing anything.
  A cursor is not a filter.

## Name the properties you need

Returning an element builds its whole `{id, labels, properties}` map. Returning the properties you asked
for does not.

| Projection                              | Per row |
| --------------------------------------- | ------- |
| `RETURN n.name AS name`                 | 27 ns   |
| `RETURN n.name AS name, n.team AS team` | 27 ns   |
| `RETURN n AS n`                         | 111 ns  |

So `RETURN n` is **4.1x** a named projection, and a _second_ property is free — the cost is reaching the
element, not reading its fields (`packages/native/scanfuse-2256.ts`).

## Updating a property is cheaper than changing the shape

A property write costs nothing beyond the write. Adding or removing a vertex or an edge invalidates the
adjacency structures the next read would have used, so the next read rebuilds them.

60 writes interleaved with reads, 20,000 vertices (`packages/native/tvtest-2252.ts`):

| Write kind     | Penalty on the next read |
| -------------- | ------------------------ |
| Set a property | none                     |
| Add a vertex   | +1.5 ms                  |
| Add an edge    | +1.1 ms                  |

At 80,000 vertices one topology write makes the next read about **3x** slower. Corrections and status
changes are free; **batch relationship and entity creation** rather than interleaving it with reads.

## Keep a session's distinct query texts bounded

Parsed statements are cached by text, up to 512 of them. A service whose query text varies per request —
interpolating a filter value rather than binding it — can walk out of that cache and pay to re-parse.

Use a parameter, so one text serves every value:

```gql
-- one cache entry, any number of callers
MATCH (p:Person) WHERE p.team = $team RETURN p.name AS name
```

A session over 512 distinct texts pays roughly **4x** per statement against a cached one
(`packages/native/stmtcache-2269.ts`). Parameters also keep values out of query text, which the
`no-raw-interpolation` lint asks for on its own grounds.

## Hoist a Gremlin traversal out of the request path

A Gremlin traversal is a plan object you build, and building one per request costs about **18%** (332 ns)
of a small traversal's time. Gremlin's caches key on the graph and the traversal's shape, not on the object,
so a reused plan and a rebuilt identical one hit the same caches — the saving is purely the construction
(`packages/native/gremstmt-2272.ts`).

```ts
const recentHires = traversal(V(), hasLabel('Person'), has('startedAt', gte(cutoff)), count());
// build once at module scope, call per request
```
