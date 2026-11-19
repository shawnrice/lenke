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

## Name the properties you need — and what it costs depends on where the rows go

`RETURN n` hands back the live element itself, which is a reference and costs almost nothing to produce.
`RETURN n.name` reads a field. So inside your own process, returning the element is the _cheaper_ of the
two — and if you then send the rows anywhere, that reverses sharply, because serializing an element means
writing out its whole `{id, labels, properties}` map.

| 20,000 rows                             | kept in process | serialized to JSON |
| --------------------------------------- | --------------- | ------------------ |
| `RETURN n.name AS name`                 | 20.5 ns/row     | 43.3 ns/row        |
| `RETURN n.name AS name, n.team AS team` | 35.9 ns/row     | 66.1 ns/row        |
| `RETURN n AS n`                         | **15.6 ns/row** | **502.8 ns/row**   |

So the advice depends on what you do with the result. **Sending rows to a client, name the properties** —
the element is 11.6x a named projection once serialized, and that gap grows with how many properties your
vertices carry. **Consuming rows in the same process**, `RETURN n` is fine and marginally cheaper, and it
gives you the live element to traverse on from.

**A second column is not free.** It costs about 75% more in process and 53% more serialized, on the same
element, so ask for the columns you will use:

```ts
// a client is going to read this, so name the fields
query(g, 'MATCH (p:Person) WHERE p.team = $t RETURN p.name AS name', { t: 'core' });
```

Reading two properties of _different_ elements costs more again — a two-hop projection measured 82.1 ns/row
for `RETURN a.name, b.name` against 31.2 for `RETURN b.name` alone — because each element has to be reached
before it can be read.

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

How much it costs, measured on a matched comparison — the same hot query either way, with a second query
alongside it so both arms do the same amount of work:

| 2 queries per operation                    | operations/second |
| ------------------------------------------ | ----------------- |
| both texts reused                          | **749,000**       |
| one text reused, one built fresh each call | **370,000**       |

So a query text built fresh each call costs about twice as much as the same query with its values bound,
and the reason is not only that it has to be parsed: the engine keeps a bounded number of recent texts, and
a stream of single-use ones pushes out the entries your other queries were relying on. A caller that
interpolates values into its text is slower itself and makes everything around it slower.

**There is a second, sharper limit, and it is about how many different queries you have rather than how
they are written.** A query whose values are bound still has one text, but an application with a great many
_structurally_ different queries — different return names, different shapes — can exceed what the engine
keeps. Past that point each query is forgotten before it comes round again:

| distinct query texts in rotation | operations/second |
| -------------------------------- | ----------------- |
| 480                              | **641,000**       |
| 520                              | **60,000**        |

The drop is about tenfold and it happens over a span of forty texts. Few applications have five hundred
genuinely different queries, so this is unlikely to be your problem — but if you generate query texts
programmatically, say one per report definition or per tenant, it is worth counting them. The fix is the
same either way: fewer distinct texts, with the variation moved into parameters.

## Index the key you look it up by

The single largest effect in this guide, and the one most easily missed: a `WHERE u.name = $n` with no index
scans every vertex of that label to find one.

```gql
MATCH (u:User) WHERE u.name = $n RETURN u.score AS s
```

| 20,000 users, same answer           | no index | indexed on `name` |
| ----------------------------------- | -------- | ----------------- |
| point lookup                        | 0.30 ms  | **under 2 µs**    |
| 2-hop recommendation from that user | 0.43 ms  | **under 2 µs**    |

That is **hundreds of times**, not tens. The range is wide — 188x to 847x across runs — because once the
index is in place the query takes well under a microsecond and the measurement sits at the timer's own
resolution; the unindexed side is the stable half (0.30-0.43 ms). Quoting one ratio would be false
precision, so take the shape of the claim: an unindexed lookup costs a fraction of a millisecond, and an
indexed one costs almost nothing.

```ts
graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
```

**A filtered write wants the same index.** `MATCH … WHERE … SET …` has to find its rows before it can
change them, and without an index that search is the same full scan:

| 200,000 rows, 2,062 matched     | no index | indexed     |
| ------------------------------- | -------- | ----------- |
| `WHERE a.k = 5 RETURN count(*)` | 2.64 ms  | **0.03 ms** |
| `WHERE a.k = 5 SET a.n = $v`    | 9.46 ms  | **1.76 ms** |

The write keeps 1.66 ms of real work — about 0.8 µs per row changed, which is what the change itself costs —
but the 7.7 ms of searching goes. So an index earns its keep on the write path as well as the read path,
and a workload that writes to rows it selects by key benefits twice.

Two things worth knowing. The index can be created **after** the data, which is how an application adds one
to a graph it already has. And the **two-hop query gains more than the point lookup** — once the starting
vertex is pinned, the hops are cheap, so the scan was almost the whole cost either way. That is also why
this effect dwarfs everything else here: the rules below shave a walk, while this one removes it
(`packages/native/idxguide-2301.mjs`, one shape per process).

## Any predicate on a hop count leaves the closed form

Counting a hop without a predicate does not have to touch an edge at all — the engine answers it from degree
bookkeeping. **Adding any predicate gives that up**, and the clearest evidence is `WHERE true`, which cannot
change the answer and still costs about fifty thousand times as much:

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
| hop count, no predicate    | **~24 ns**                 | 180,000 |
| hop count, `WHERE true`    | **1.17 ms**                | 180,000 |
| hop count, near-end filter | **1.02 ms**                | 45,000  |
| hop count, far-end filter  | **1.74 ms**                | 44,962  |

The first row is not a rounding of a small number: the unfiltered count is answered from bookkeeping in
constant time, so it needed over a million repetitions to register on a clock at all. **Adding any
predicate is four orders of magnitude**, and most of that is **having** a predicate rather than what the
predicate reads: `WHERE true` already pays 1.17 of the 1.74 ms.

**The same holds when you project rows rather than count them**, and there the ratio is smaller while the
output is byte-for-byte identical. A 1-hop projection over 50,000 vertices at fan-out 5 returns the same
250,000 rows either way:

| 1-hop projection, 250,000 rows both ways | ms            |
| ---------------------------------------- | ------------- |
| `RETURN x.name AS n`                     | **12.6-15.3** |
| `WHERE true RETURN x.name AS n`          | **64.2-66.6** |

So a predicate costs 4.2-5.3x on a projection against four orders of magnitude on a count — the count has
further to fall because it starts from a constant-time answer, not because a projection escapes the
problem (`packages/native/startcost-2309.mjs`). This is not a defect — a filtered count genuinely needs the walk — but the step is a cliff
rather than a slope, so if you want a plain total, ask for it without a predicate rather than filtering on a
condition that keeps everything (`packages/native/farfilter-2286.mjs`, one shape per process).

## Prepare a hot GQL query once

`prepare()` parses and compiles a query into a reusable plan, so a hot path can skip both on every call:

```ts
const findUser = prepare('MATCH (u:User) WHERE u.name = $n RETURN u.score AS s');

// then, per request
findUser(graph, { n: name });
```

| Warm, indexed, per call | `query()` | `prepare()` once |
| ----------------------- | --------- | ---------------- |
| `count(*)` over a label | 33 ns     | **25 ns**        |
| point lookup            | 201 ns    | **183 ns**       |
| 2-hop from that user    | 288 ns    | **257 ns**       |

The saving is a fixed 8-31 ns — the work of hashing the text and finding the cached plan — so it is worth
most on the cheapest queries, where it is 24%, and least on ones that do real work. `query()` already caches
both the parse and the plan, so this is the last slice of that overhead rather than a different order of
magnitude; the numbers above are also a useful floor to know, since they say what a warm query costs when
nothing is wrong (`packages/native/prepare-2305.mjs`).

## Hoist a Gremlin traversal out of the request path

A Gremlin traversal is a plan object you build, and the engine remembers what it worked out about that
object — so building an identical one per request throws that away and the analysis runs again. Building
the plan is the smaller half of the cost:

| 20,000 vertices                                | reused plan | rebuilt each call |       |
| ---------------------------------------------- | ----------- | ----------------- | ----- |
| indexed point lookup                           | 702 ns      | **1190 ns**       | 1.70x |
| whole-label projection                         | 122.6 µs    | **130.2 µs**      | 1.06x |
| _constructing the plan alone, running nothing_ | —           | _202 ns_          |       |

Constructing the plan costs 202 ns, but rebuilding costs 488 ns on the small query and 7.6 µs on the large
one — more than construction either way, because the discarded analysis has to be redone.

So the cost is roughly fixed per call and the _share_ depends on the query: it nearly doubles a point
lookup and is a rounding error on a whole-label scan. Build the plan where you build the rest of your
application, not inside the request:

```ts
const recentHires = traversal(V(), hasLabel('Person'), has('startedAt', gte(cutoff)), count());
// build once at module scope, call per request
```

## Ask a Gremlin traversal for the values you want, not the elements

A traversal that ends on a vertex has to hand you the vertex: a live element, wired to the graph so that
reading a property later still works. A traversal that ends in `values('score')` hands you a number, and
the element is never built. Naming the property is therefore **cheaper than not naming it**, which is the
opposite of what it looks like — you are asking for less work, not more.

| 50,000 vertices, one match              | returns the element | ends in `values('score')` |
| --------------------------------------- | ------------------- | ------------------------- |
| `V(), has('name', n)`                   | 1.85 µs             | **1.13 µs**               |
| `V(), hasLabel('User'), has('name', n)` | 2.22 µs             | **1.21 µs**               |

So about 0.7–1.0 µs per matched element, on a query whose other work is under a microsecond. The same rule
as naming properties in a GQL `RETURN`, and for the same reason — but on the Gremlin side the step that
ends the traversal is what decides it.

Keep the element when you actually want the element: to read several properties, to traverse on from it, or
to hand it to code that expects a vertex. The cost is the price of a usable object, not waste.

## For a bulk load, insert rows near the ones they share an index key with

An index hands a query the rows matching a key. Reading those rows then means following each reference into
the graph, and how long that takes depends on where they are in memory. Rows written one after another sit
near each other; rows written far apart do not, and at a large enough graph the difference stops being
theoretical.

| 5,000 matched rows per query         | 20,000 vertices | 200,000 vertices |
| ------------------------------------ | --------------- | ---------------- |
| rows sharing a key written far apart | 13.7 ns/row     | **64.1 ns/row**  |
| rows sharing a key written together  | 12.2 ns/row     | **15.4 ns/row**  |

Written together, the cost per row barely moves as the graph grows tenfold. Written far apart, it grows
about five times — the index is doing the same work, but every row it hands back is a fresh trip to memory.

This only matters when you control the write order, which in practice means a bulk load or an import. If
you are loading records that will be queried by `team`, inserting them grouped by `team` costs nothing and
keeps those queries fast as the data grows. Records arriving one at a time from an application cannot be
ordered this way, and should not be contorted to try.
