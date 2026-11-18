# Query cost on the pure-TypeScript graph

Every figure here is measured, on the pure-TS engine, with the probe named beside it. Every snippet runs in
`packages/native/src/guide-query-cost.test.ts`, so this page cannot drift from the engine. They are the
differences large enough to change how you write a query — not micro-optimizations.

## Fetch a whole result once, rather than paging it

Paging re-runs the query for every page. A sorted result has to be sorted again each time, so walking the
whole thing costs far more than asking for it once.

20,000 rows, pages of 50 (`packages/native/paging-2275.ts`):

| How                                           | Total  |
| --------------------------------------------- | ------ |
| One query returning every row                 | 1.7 ms |
| Keyset pages (`WHERE k > $last`)              | 171 ms |
| Offset pages, bound (`OFFSET $s LIMIT $n`)    | 201 ms |
| Offset pages, literal (`SKIP 20000 LIMIT 50`) | 231 ms |

If you need the whole result — an export, a recomputation, a sync — ask for it in one query. Paging is for
when a person is looking at one screenful.

## When you do page, resume from the last key

`SKIP k` counts past `k` rows and discards them, so later pages cost more than earlier ones. Carrying the
last key instead removes that entirely: keyset paging costs the same as fetching page one repeatedly.

```gql
-- offset: page 400 counts past 20,000 rows to return 50
MATCH (p:Person) RETURN p.surname AS s ORDER BY s OFFSET $skip LIMIT $size

-- keyset: resume where the last page stopped
MATCH (p:Person) WHERE p.surname > $lastSurname RETURN p.surname AS s ORDER BY s LIMIT 50
```

**Bind the offset, and use `OFFSET` to do it.** `OFFSET` is the ISO-GQL keyword and takes a parameter;
`SKIP` is a Cypher alias kept for familiarity and accepts only a literal, so `SKIP $skip` is rejected
(`Expected a non-negative integer after SKIP/OFFSET`). That matters beyond spelling: a caller who cannot
bind the offset has to put it in the query text, which makes every page a distinct statement and walks out
of the parse cache described below. Binding it is **1.15x** cheaper over a full walk.

Keyset is **1.35x** cheaper again. Two things to know:

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
element, not reading its fields (`packages/native/scanfuse-2256.ts`). `RETURN n` also hands back the live
element, whose properties sit under `n.properties` rather than as direct fields — the flat
`{id, labels, properties}` map is what a serializer builds from it, and building it is the cost.

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

## Any predicate on a hop count leaves the closed form

Counting a hop without a predicate does not have to touch an edge at all — the engine answers it from degree
bookkeeping. **Adding any predicate gives that up**, and the clearest evidence is `WHERE true`, which cannot
change the answer and still costs 175x:

```gql
-- answered from bookkeeping
MATCH (p:Person)-[:WORKS_WITH]->(q:Person) RETURN count(*) AS c

-- SAME ANSWER, and it walks every edge
MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE true RETURN count(*) AS c

-- walks every edge and reads every far vertex
MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE q.team = $t RETURN count(*) AS c
```

| Query                      | 60k vertices, 3 edges each | rows    |
| -------------------------- | -------------------------- | ------- |
| hop count, no predicate    | **0.01 ms**                | 180,000 |
| hop count, `WHERE true`    | **1.75 ms**                | 180,000 |
| hop count, near-end filter | **1.20 ms**                | 45,000  |
| hop count, far-end filter  | **2.37 ms**                | 44,962  |

So most of the cost is **having** a predicate, not what the predicate reads: `WHERE true` already pays 1.75
of the 2.37 ms. This is not a defect — a filtered count genuinely needs the walk — but the step is a cliff
rather than a slope, so if you want a plain total, ask for it without a predicate rather than filtering on a
condition that keeps everything (`packages/native/farfilter-2286.mjs`, one shape per process).

## Hoist a Gremlin traversal out of the request path

A Gremlin traversal is a plan object you build, and building one per request costs about **18%** (332 ns)
of a small traversal's time. Gremlin's caches key on the graph and the traversal's shape, not on the object,
so a reused plan and a rebuilt identical one hit the same caches — the saving is purely the construction
(`packages/native/gremstmt-2272.ts`).

```ts
const recentHires = traversal(V(), hasLabel('Person'), has('startedAt', gte(cutoff)), count());
// build once at module scope, call per request
```
