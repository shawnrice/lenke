# Bitemporal modeling on lenke

**A recipe, not a feature.** lenke ships the _primitives_ you need to model bitemporality — `DATE` properties, parameterized `WHERE` predicates, a host clock, and atomic transactions — but it does **not** ship a bitemporal engine. There is no `PERIOD` type, no system-time column, no `AS OF` keyword. You compose bitemporality from the pieces below, and you keep full control over the schema. This guide shows the working pattern end to end; every query here is executable (verified against `@lenke/gql` on the pure-TS engine, and byte-identical on the Rust core).

> The [`.dogfood`](../../.dogfood/round9/sofia/bitemporal.ts) scratch script is the reference implementation this guide is distilled from — a cold reader built the whole slice from public docs and exported types alone.

## The model: four DATE columns on the fact

A _bitemporal_ fact is true along two independent time axes:

- **Valid time** — when the fact is true in the modeled world. Two columns: `validFrom`, `validTo`.
- **Transaction time** — when the _system_ believed the fact. Two columns: `txFrom`, `txTo`.

Put all four on whichever element carries the fact. Relationships are the natural home (an employment, a price, a role assignment is an _edge_), but nodes work identically.

```ts
import { Graph, LocalDateTime } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.createUniqueConstraint('Person', 'id');
g.createUniqueConstraint('Company', 'id');

query(g, `INSERT (:Person {id: 'alice', name: 'Alice'})`);
query(g, `INSERT (:Company {id: 'acme', name: 'Acme Corp'})`);

// v1 belief (recorded 2020-01-05): Alice employed by Acme from 2020-01-01,
// believed permanent (both "to" columns open-ended).
query(
  g,
  `MATCH (p:Person {id: 'alice'}), (c:Company {id: 'acme'})
   INSERT (p)-[:EMPLOYED_BY {
     validFrom: DATE '2020-01-01', validTo: DATE '9999-12-31',
     txFrom:    DATE '2020-01-05', txTo:    DATE '9999-12-31'
   }]->(c)`,
);
```

### Half-open intervals `[from, to)`

Every interval is **half-open**: `from` is inclusive, `to` is exclusive. This is the one convention that makes the predicates clean — adjacent versions abut without overlap (`validTo` of one equals `validFrom` of the next), and a point-in-time test is always `from <= t AND t < to`, never a fencepost puzzle.

### The open-end sentinel

An interval that is still open has no natural "to" value. Use a fixed far-future sentinel — **`DATE '9999-12-31'`** — rather than `null`. Two reasons:

1. The `t < to` half of every predicate stays a plain comparison; you never special-case `IS NULL`.
2. `null` is a _stored, present value_ on lenke (not absence — see the null policy), so it wouldn't shortcut the comparison anyway. A sentinel is both correct and faster to reason about.

Define it once as a constant and interpolate it into the _query text_ (it's a literal, not a value binding):

```ts
const INF = "DATE '9999-12-31'";
```

## As-of queries: a parameterized WHERE clause

An "as-of" query asks: _at transaction time `$tx`, believing what we believed then, what was true at valid time `$valid`?_ That is one four-term predicate over your chosen period columns — no special syntax:

```ts
function asOf(txDate: string, validAt: string) {
  return query(
    g,
    `MATCH (p:Person {id: 'alice'})-[e:EMPLOYED_BY]->(c:Company)
     WHERE e.validFrom <= date($valid) AND date($valid) < e.validTo
       AND e.txFrom    <= date($tx)    AND date($tx)    < e.txTo
     RETURN c.name AS employer,
            e.validFrom AS vFrom, e.validTo AS vTo,
            e.txFrom AS tFrom, e.txTo AS tTo`,
    { tx: txDate, valid: validAt },
  );
}
```

`date($valid)` and `date($tx)` cast a string param to a `DATE` engine-side, so the comparison is date-vs-date. **Send the instants as params — never build the query text from user input.** The same clause drives every temporal question: freeze `$tx` at today and sweep `$valid` to get a valid-time timeline; freeze `$valid` and sweep `$tx` to get the belief history.

## "Current belief" via the host clock

For _right now_ on both axes, you don't want a hardcoded date — you want the wall clock. Install a **host clock** and query with `current_date`:

```ts
g.setClock(() => LocalDateTime.fromJSDate(new Date(), { zone: 'utc' }));

const currentBeliefs = query(
  g,
  `MATCH (p:Person)-[e:EMPLOYED_BY]->(c:Company)
   WHERE current_date < e.txTo                                  -- belief still open
     AND e.validFrom <= current_date AND current_date < e.validTo  -- true today
   RETURN p.name AS person, c.name AS company
   ORDER BY person`,
);
```

`current_date` reads the clock you installed, so it's deterministic and testable — pin the clock to a fixed instant in tests, let it track `new Date()` in production. `current_date < e.txTo` selects only the _currently-believed_ version of each fact (the row whose transaction interval is still open); the two valid-time terms then keep only what is true today.

## A correction is an atomic event

The bitemporal payoff is that you _never mutate history_ — you record a new belief and close the old one, atomically. Suppose on 2021-06-10 we learn Alice actually left Acme on 2021-05-31. Two writes, one transaction:

1. **Close the old belief**: set the currently-open version's `txTo` to the correction date (we stopped believing "permanent" on 2021-06-10).
2. **Insert the corrected version**: same valid-time start, a real valid-time end, and a fresh transaction interval that is now open.

```ts
g.transaction(() => {
  query(
    g,
    `MATCH (p:Person {id: 'alice'})-[e:EMPLOYED_BY]->(c:Company {id: 'acme'})
     WHERE e.txTo = ${INF}
     SET e.txTo = DATE '2021-06-10'`,
  );
  query(
    g,
    `MATCH (p:Person {id: 'alice'}), (c:Company {id: 'acme'})
     INSERT (p)-[:EMPLOYED_BY {
       validFrom: DATE '2020-01-01', validTo: DATE '2021-05-31',
       txFrom:    DATE '2021-06-10', txTo:    ${INF}
     }]->(c)`,
  );
});
```

`graph.transaction(fn)` makes the pair atomic: either both writes land or neither does (undo-log rollback on throw), and downstream events fire once at commit. After this:

- An as-of query at `tx = 2021-01-01` still returns the _old_ belief (she was believed permanently employed) — history is intact.
- An as-of query at `tx = today, valid = 2021-06-15` returns **no row** — the corrected belief says she had left by then.
- The full transaction-time history is queryable by simply dropping the `txTo` filter, giving you a superseded-belief audit trail for free.

## Why no `AS OF` keyword

An as-of query on lenke is _just a `WHERE` clause over the period columns you chose_. Adding an `AS OF` keyword would buy nothing here — worse, it would be a lie about what the engine does.

SQL:2011 earns `AS OF SYSTEM_TIME` only because it also mandates `PERIOD FOR SYSTEM_TIME (sys_start, sys_end)` — the engine _owns_ those two columns, auto-stamps them on every write, and forbids you from setting them. The keyword is sugar over an engine-managed schema contract. lenke deliberately declines that contract: **you** pick the column names, **you** decide how many axes you model (uni- or bitemporal), and **you** stamp them in your own writes (a correction's `txFrom` is _your_ correction date, not the engine's commit instant). That flexibility is the point — a knowledge graph often wants valid time without system time, or four columns with domain-specific names. A hardcoded `AS OF` over engine-owned `PERIOD` columns would impose exactly the schema mandate lenke avoids. The predicate is three lines; keep the control.

## Durability

Because the temporal columns are ordinary `DATE` properties, they survive serialization with everything else — snapshot the whole graph (`serialize(g, 'ndjson')`), restore into a fresh `Graph`, and every as-of query answers identically against the restored copy. Bitemporality needs no special persistence path.
