# The var-length traversal budget — context for a decision

You said the budget has to exist because a var-length expansion can fan out without bound and
either stall or OOM us. That is right, and it is the reason this note is not arguing about whether
to have one. It is about **what the knob currently means**, which turns out to be five different
things depending on which internal path answers the query, and two of the five mean nothing at all.

Nothing here proposes an answer. It is the material I would want before shaping one.

---

## 1. The one insight that organises everything else

**The two failure modes you named are two different quantities, and they are not substitutes.**

| failure mode | the quantity that bounds it | what happens if unbounded                                                                                                    |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **OOM**      | **ROWS emitted** (or bytes) | a materializing expansion accumulates paths until the allocator or the wasm heap gives out                                   |
| **Stall**    | **HOPS explored**           | the walk keeps descending; a `count(*)` emits nothing and allocates nothing, so memory is flat while the query never returns |

A `count(*)` over a cyclic dense graph **cannot OOM from rows — it has none** — but it can run
effectively forever. A materializing `RETURN p` can do both. So a single number cannot express both
guards, and today `limits.trail` is asked to be both.

---

## 2. What `limits.trail` is documented to mean

From `GraphLimits` in `store.rs`:

> Cap on total variable-length / `repeat` traversal **rows** a single expansion may emit — the guard
> against exponential blowup on a dense graph (the TS engine's `trail`).

Default **1,000,000**. So the documented intent is a **row** cap — the OOM guard.

**The TS engine does not implement that.** TS counts **hops** (`steps += 1` per admitted hop inside
`trailEnds`, per call, i.e. per source) and throws when it passes `graph.limits.trail`. It has no row
cap at all. So the doc comment describes native's row cap, and the parenthetical "(the TS engine's
`trail`)" points at a quantity TS never had.

---

## 3. What each path actually enforces

Native dispatches a var-length expansion to one of five code paths depending on what is asked of
it. They do not agree.

| path                   | used for                                                                 | per-source HOP budget                         | emitted cap                                                                                                                | effect                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CollectEmit`          | materializing rows                                                       | yes                                           | **yes** — `keep.len() > trail`, and `keep` is **never cleared between sources**, so the cap is **global to the expansion** | the only path that implements the documented row cap                                                                                    |
| `CountEmit`            | `count(*)` via `var_length_count`                                        | yes                                           | none (emits no rows)                                                                                                       | agrees with TS **exactly** — measured 270/270                                                                                           |
| `DistinctEndpointEmit` | `DISTINCT` / `min` / `max` over the endpoint                             | **none** (`should_stop` is literally `false`) | none                                                                                                                       | **deliberate**: memory is bounded by a seen-bitset over \|V\|, so it explores fully and completes shapes the materializing walk refuses |
| `StreamPropEmit`       | streaming a property out as JSON                                         | yes                                           | **a BYTE cap** (`out.len() > byte_cap`)                                                                                    | a third quantity again                                                                                                                  |
| `varlen_scan_walk`     | the lean `count`/`agg` fast paths (`try_varlen_count`, `varlen_agg_dfs`) | **none**                                      | **none**                                                                                                                   | takes a `visit` closure and no sink, so **no guard of any kind**                                                                        |

TS, by contrast, has exactly one quantity on every path: hops, per source.

**Measured consequences of that disagreement** (binary-searching the smallest limit at which each
engine stops raising):

- One source, `SIMPLE k=2 {1,3}`: TS 510, native 510 — equal, after item 254.
- One source, `SIMPLE k=1 {1,3}` count: TS **110**, native answers at a limit of **1** — the
  `varlen_scan_walk` gap.
- Six sources, materializing: native needs **6× the limit** TS does, exactly the source count,
  because its row cap is global while TS's hop budget is per-source.

---

## 4. The separate knob that actually guards the cross-product

`limits.intermediate`, default **50,000,000**, checked by `guard_intermediate` on the materialized
frontier between fixed-length segments:

> an intermediate frontier of N rows exceeded the limit of M. A multi-segment pattern is
> materializing a large cross-product before it is filtered — add a more selective anchor, reorder
> the pattern so the selective hop comes first, or raise the intermediate limit.

This is worth knowing because it means **the cross-product OOM already has its own guard**, and it
is 50× the trail limit. Whatever `trail` becomes, it is not the only thing standing between a wide
pattern and memory.

---

## 5. Properties of the current shape that a decision should know about

**A per-source hop budget does not bound total query time.** It bounds work _per starting vertex_.
A scan with 200,000 sources can legitimately do 200,000 × `trail` hops. So the per-source framing
protects against one pathological vertex, not against a pathological query.

**A global row cap gets stingier as a query gets wider.** Shared across all sources in the
expansion, so a 200,000-source scan has the same total row allowance as a one-source lookup — which
is arguably correct for memory (it _is_ one allocation) and surprising as a user-facing limit,
because adding sources makes a previously-fine query fail.

**`exhausted` is sticky, and that is load-bearing.** Once any source blows the hop budget the whole
query ends, which is what makes native's error match TS's throw rather than silently truncating.

**Two paths enforcing nothing are not symmetric.** `DistinctEndpointEmit` is a reasoned exemption —
its memory is bounded by \|V\| whatever the graph does, so only time is at risk. `varlen_scan_walk`
is an unreasoned one: it is the same exposure, but it arrived by a fast path forgetting the guard
rather than by anyone deciding the guard was unnecessary.

**The quantities are observable, so they are semantics.** Byte-identity means which queries raise is
part of the contract. Any change here moves the boundary between "answers" and
`E_RESOURCE_EXHAUSTED` for real queries, and both engines must move together.

---

## 6. The dimensions a decision has to settle

Not options — these are the independent axes, each of which the current design answers
inconsistently or not at all.

1. **How many quantities?** One knob meaning two things has produced the bugs in items 78, 254 and
   this note. Rows-for-memory and hops-for-time are genuinely different guards; they could be one
   number applied to both, two numbers, or one number with a derived relationship.

2. **What scope does each have?** Per source, per expansion, or per query. The hop budget is
   per-source today and the row cap per-expansion, which is why they diverge by the source count.
   Per-query is the only scope that bounds a whole query's work, and it is the only one that makes
   a query's success independent of how many sources precede it.

3. **Do the non-materializing paths get a guard at all?** A count and a distinct-endpoint walk
   cannot OOM. If stalls matter as much as OOM, they need the hop guard; if a stall is acceptable
   for a query that provably cannot exhaust memory, the current exemption is defensible — but then
   it should be stated, and `varlen_scan_walk` should get it deliberately rather than by omission.

4. **Does the limit mean "refuse" or "truncate"?** Today it always refuses, loudly, and
   byte-identically across engines. A truncating cap would be a different contract and would need a
   way to tell a complete answer from a clipped one.

5. **Where is it configured?** `limits.trail` is a construction-time graph setting. If the right
   budget depends on the query rather than the graph — a `LIMIT`ed query needs far less headroom
   than an unbounded one — then a per-query override is a different feature, and the knob's shape
   would follow from that.

---

## 7. What I would measure to inform it, if you want numbers first

- **The real distribution of hops per source** on the AML/HRIS-shaped fixtures, so a per-source
  number can be set against observed traffic rather than against a dense synthetic graph. Today's
  1,000,000 was not derived from a measurement I can find.
- **Peak RSS against rows emitted** for the materializing path, which converts the row cap into the
  memory number it exists to protect — and tells us whether 1,000,000 rows is the right order of
  magnitude for the wasm heap, which is the tightest target.
- **What the lean count walker costs to guard.** It is the fast path precisely because it carries no
  sink; a counter increment per hop is cheap but it is on the hottest loop in the engine, so it
  wants the two-binary A/B rather than an assumption.

---

## 8. What is already decided, for the record

- The budget **exists and stays** — unbounded fanout can stall or OOM us (**user, 2026-10-08**).
- Native's mid-unit closing hop no longer charges a step, so the per-source hop budget now agrees
  with TS exactly on `k > 1` units (item 254).
- `limits.trail` driving both a per-source hop budget and a global row cap is **not** a design
  anyone chose; it is `let budget = store.limits().trail` reused twice in one function.
