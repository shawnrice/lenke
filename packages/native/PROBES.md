# The TS-side probes, indexed by question

`packages/native` holds dozens of `*-probe.ts` files. Most answer one historical question and are
kept for the numbers in their header, which is where a rejected lever's evidence lives. This file
indexes only the **cross-cutting** ones — the instruments a new measuring pass should run BEFORE
hunting, because each checks a property of the whole engine rather than one shape.

CLAUDE.md states the rule for the Rust corpus: _"Writing a new benchmark feels like progress and
reading three file headers feels like overhead. It is the other way round."_ The same applies
here, and more so — the Rust side is indexed by question in `crates/lenke-engine/examples/README.md`
and this side was not indexed at all.

## Start here (GQL routes): `rung-gap-screen.mjs`, and what its flags mean NOW

It is the grid that finds a BETWEEN-RUNGS gap, which no profile can: the absence of a rung has no
hot frame. As of item 1885 its GQL half reads 11 flags, and they are NOT 11 open targets:

- `sum` and `collect` at depths 2-5 (24-60 ms) are the **byte-identity refusal** item 1829 states —
  f64 addition is order-sensitive in the last ulp and `collect`'s order IS its answer.
- `distinct2 depth1` (two-column DISTINCT) is unexamined.
- the `topk` / `skiponly` depth2-vs-depth3 non-monotonic flags are small and shared with the `rows`
  row's own shape.

**`skiponly` was the big one and item 1885 took it**: 26.9/36.2/49.6/59.5 → 5.5/3.0/3.6/4.4 ms at
depths 2-5. Its instruments:

- **`skip-chain-route-1885.mjs`** — reads `compileLinear` for `rows` / `SKIP` / `OFFSET` / `LIMIT` /
  `SKIP+LIMIT` / `OFFSET $s` at depths 1-5. The route question, answered without timing anything.
- **`skip-only-page-parity.ts`** — the CROSS-ENGINE oracle, and the thing that licences slicing a
  rung's rows at all: an IDENTICAL _unpaged_ verdict at depth k means the rung's order already equals
  native's, since the unpaged query IS the rung. Its second section checks that each engine's paged
  answer is its own unpaged answer sliced. Extend it before widening any page rung.
- **`chain-paged-mutants-1885.mjs`** — 5 caught, 1 EXPECTED survivor (removing the consumer's call
  site is answer-equivalent; exporting the composition pins the helper but not the call site).

**`distinct2` was the grid's other big flag and item 1886 took it** (a two-column key space):
`distinct2-key-1886.mjs` is the floor (it carries a `twocol` arm so "a second column costs
something" cannot be confused with "keying two columns costs something"),
`distinct2-ab-1886.mjs` the kill-switch A/B — **it kills THREE sites, and its first version killed
one, which made the `UNION` and set-op rows read 1.00x / 0.96x / 0.84x: a control-shaped result is
how an incomplete kill switch hides.** `CARD=` sweeps the cardinality axis that decides the nested
map against a string key. After it, every remaining flag on the grid is `sum`/`collect` — the
documented byte-identity refusal — or noise-sized.

## AND ASK WHAT THE SCREEN DOES NOT ASK (item 1898)

A clean screen means the shapes IT HAS are fast. Item 1898 added nine families the Gremlin screen had
never carried — `select`/`as`, `project`, `where(sub)`, `where(neq)`, `path`, `range`,
`dedupe().by(k)`, `aggregate`+`cap` — and **all five of the biggest shapes on the surface at 200,000
vertices turned out to be among them** (432 / 310 / 272 / 203 / 160 ms against a plain hop's 43).
~~Three of the five are path-gated by construction (`as_`/`select`/`path` make `planReadsPath`
true…)~~ **THAT IS STALE AND ITEM 1923 MEASURED IT FALSE** — `PATH_DEPENDENT_KINDS` contains
neither `as` nor `select`, so `V().as_(x).out(E).select(x)` has `readsPath = FALSE`. Those shapes
were slow because **no rung MATCHED them**, not because the gate excluded them: a different
diagnosis with a different fix, and item 1923 records having repeated the wrong framing while
choosing targets. Item 1986 was misled by this paragraph for a step, which is why the correction
is here rather than only in `CLOSED.md`.

The dedupe pair (`dedupe().by(k)` at 264 ms for EIGHT rows, bare `dedupe()` at 232) was the open
nomination and items 1899/1971/1972 worked it. `path()` and `simplePath()` genuinely ARE path-gated;
`simplePath` was taken at item 1923 (8.17x) and `cyclicPath` at item 1986 (3.85x — a one-hop cyclic
path is exactly the self-loop edges and needs no path tracking).

## SWEEP THE SIZE BEFORE BELIEVING A CLEAN SCREEN (item 1889)

Every screen in this directory runs at **20,000 vertices** by default, and at item 1889 both of them
were clean — the Gremlin workload screen had no shape above 7.2 ms and the GQL grid only its
documented refusals. Running the Gremlin screen at `NODES=200000 FANOUT=5` immediately showed
something six items had missed: the ONE-hop values walk cost **102 ns a row** where the TWO-hop walk
cost **16** while emitting four times the rows. At 20,000 the same pair reads 54 and 17 — a third of
the gap, which reads as a constant factor rather than a structural one.

**ITEM 1890 DID THE SAME ON THE GQL SIDE AND FOUND THE TWIN**: at `NODES=200000` the grid flagged
`count: depth2 (42.0 ms) costs 7.3x depth3 (5.7)` — a two-hop count slower than a three-hop one,
because item 1685 gave the three-segment degree product the CSR and the two-segment one never got
it. 67-86x warm with cold flat, via the same second-ask policy. Its instruments are
`count-depth-floor-1890.mjs`, `count-route-1890.mjs` (which rung answers a count at each depth),
`count-csr-ab-1890.mjs` (warm AND cold) and `count-csr-mutants-1890.mjs` (11/11, six of them
aimed at the gate and the policy because both routes return the same number).

**ITEM 1891 FOUND THE SIBLING 1889 LEFT BEHIND**: `optional(out(T))` was 4.1x its own unwrapped
twin on the same rows, 3.93x taken, and the Gremlin screen's row went 256 → 68.70 ms at 200,000.
**ITS MUTATION RUN IS THE LESSON FOR EVERY SECOND-ASK ARM: all five mutants aimed at the new
walk SURVIVED, because `seenBefore` declines the first ask and every single-`toArray` test therefore
measures the OLD route.** When an arm is gated on a second ask, its tests must ask twice — and the
mutation run is what proves they do. Three arms in this package are now gated that way
(`hopValuesCsr`, `oneHopValues`, `twoHopCsrProduct`).

**AND CHECK FOR A `drain` BEFORE PRICING ANY FUSED WALK.** Three items in a row found the eager
fill was most of the available win — 1889 (one-hop values), 1891 (optional) and 1893 (the edge
filter, 129.40 → 79.04 ms from twenty lines). `toArray` prefers `drain` when the walk offers one
(item 1412), so a walk WITHOUT one is being compared against neighbours that have it, with its
generator hand tied. `edge-csr-ceiling-1893.mjs` is the shape of probe that finds this: a `handSet`
arm (the same walk by hand over the same structure) separates DELEGATION from LAYOUT, and it said
2.08x of the gap was delegation before any structure was blamed.

**ITEM 1897 FOLLOWED THAT TO ITS END AND CLOSED A STANDING OPEN QUESTION**:
`wideproj-bag-ceiling-1897.mjs` measures the row-scope bag hoist `propOf`'s own note had left
unmeasured since item 1740 — **flat** (58.0 against 60.4) — and in the same reading shows the wide
projection's real gap is **2.8x of ROW OBJECT SHAPE**, which needs codegen and is therefore a
ceiling. Its engine arm spreads **14% across processes**, so its ratios come from alternated
rounds; a single pair cannot resolve the 1.12x it reports.

**ITEM 1896 ADDED THE ARM THAT MAKES THIS METHOD ANSWER "WHICH PART"**: a hand walk PLUS the
engine's own per-row work (label tests, bindings). On the two-hop projection it priced those at
**5 ms of a 28 ms delegation gap**, which redirected the item from "remove the per-row overhead" to
"it is the adjacency reads". `gql-hop2-ceiling-1896.mjs` has five arms for that reason — and its
other result is a NULL: a one-item projection fast path, which looked like item 1893's twenty-line
win, measured 78.36 → 76.67 ms and was reverted.

**ITEM 1895 RAN THE SAME `handSet` METHOD ON THE GQL SIDE AND GOT THE OPPOSITE ANSWER**, which is
why both probes are worth keeping: the Gremlin edge rung was 2.08x its hand walk (all delegation),
while the GQL hop projection is **1.09x** its hand walk — nothing left to remove — and its whole gap
was the per-vertex `Map` work. `gql-hop-ceiling-1895.mjs` has five arms, from the engine down to
bare values, so a reading lands between two bounds instead of beside one. The lever it found is
2.96x warm / 1.01x cold, and 3.8-4.7x on four depth-1 cells of the 200,000-vertex grid.
**Its first cut measured a FLAT NULL** because the gate read a label's vacuity from the AST — the
factory is compiled once and captures the pattern's label, so that declines every labelled pattern.
A 2.9x lever reading 1.00x means the arm never fired.

**ITEM 1894 THEN COUNTED THEM ALL** (one `grep` over the walk modules): the only missing fill that
mattered was the optional CHAIN's CSR walk — **1.57x warm, 1.32x cold** on the surface's largest
absolute (`chain-drain-ab-1894.mjs`, which kills the drain by RENAMING it in the dist). The four
walks in `node-values.ts` that still lack one serve scan shapes measuring 5.92-16.64 ms at 200,000
vertices, so they are left alone deliberately — four more loop copies in a hot module for a few
milliseconds is the trade item 1878 exists to stop.

So: **re-run the screens at 10x before concluding a surface is done.** The instruments:

- **`hop-csr-ab-1889.mjs`** — the warm AND cold A/B. Its cold column is the point: before the
  second-call policy the arm was **2.10x warm and 0.61x COLD** (the CSR build on the first query
  after any topology write). A warm-only A/B would have shipped a 1.64x regression as a 2.10x win.
- **`hop-csr-oracle-1889.mjs`** — the route differential, running each query THREE times because the
  rung declines its own first call: bucket walk, then the CSR's eager `drain`, then its lazy
  iterator.
- **`hop-csr-mutants-1889.mjs`** — 11/11. Read the off-by-one entries: the walk is written twice
  (iterator and `drain`), `toArray` prefers `drain`, and `toSet` CANNOT catch the iterator's
  off-by-one because a Set swallows the duplicate reads. Spreading `run` can.

## Start here (Gremlin): `gremlin-workload-screen.mjs` — what does an application's traversal cost?

Built at item 1881 because **Gremlin had no workload screen at all.** `bench-gremlin.ts` compares 31
shapes against NATIVE, `gremlin-route-screen.mjs` asks only which ROUTE answers a shape, and the
spelling probe compares spellings of one question — none of them asks what a traversal costs. Item
1868 recorded the gap and deferred it.

It is PER-SHAPE by construction (item 1880's lesson: a family total hides its worst shape) and sorted
by ABSOLUTE ms (item 1878's: a 4.7x that was 2 microseconds).

**ITS DEFAULT 1500 NODES IS TOO SMALL AND THAT IS DELIBERATE-ADJACENT, NOT A BUG TO IGNORE.** At
1500/4 every row is sub-millisecond, because this screen times ONE traversal per shape where the GQL
screen accumulates 60 queries a family. **Run it at `NODES=20000 FANOUT=5`** to get measurable rows;
the small default is kept because it is the GQL screen's size and makes the two comparable.

First run (20000/5): `edge: outE.has(w).inV` is the top shape at **21.56 ms / 45,713 rows = 472 ns a
row**, against `hop1: values` at 51 ns a row — **9.3x the per-row cost**.

**ITEM 1881 RECORDED THAT SHAPE AS "already fused (route-checked)" AND THAT WAS WRONG.** Item 1882
asked `gremlin-route-screen.mjs` instead of a one-off instrumentation: the shape is **GENERIC** (4
`applyStep` calls) while the same walk WITHOUT the predicate is fused, and every one of the family's
seven filtered spellings is generic. Priced one-shape-per-process at **225 ns an edge visit against
the fused sibling's 31 — 7.2x**. The two instruments are below; the rung is not built yet.

- **`edge-filter-prof-1882.mjs`** — the self-time profile of the nominated shape. It prints the
  fixture's own share of the process (item 1875 took two profiles that were 76% and 40% fixture);
  use `REPS=50` to get the query to 75%.
- **`edge-filter-floor-1882.mjs`** — its price. `SHAPE=filtered|unfiltered|hop`, ONE PER PROCESS,
  and it reports **ns per EDGE VISIT** as well as per row, because the filtered shape emits 46% of
  the rows and a per-row ratio flatters it (item 1858 declined a target for exactly that).
  **ITS `unfiltered` ARM IS NOT A FLOOR, AND READING IT AS ONE OVERSTATES THE PREDICATE'S COST
  BY MOST OF ITS 1.88x** (item 2016). `unfiltered` and `hop` take item 1889's vertex CSR from their
  SECOND ask; the filtered walk had no CSR arm at all, so the comparison is a flat-array walk
  against a `Set` walk. **A floor arm must take the same ROUTE, not merely visit the same edges** —
  one level up from CLAUDE.md's rule about hand ceilings. Use `edge-filter-series-2016.mjs` instead,
  or alongside: min-of-N structurally cannot see this, because with REPS >= 2 the armed rep is
  always the minimum.
- **`edge-filter-series-2016.mjs`** — the PER-REP SERIES for this family, plus the ceiling arms the
  floor probe lacks: `SHAPE=filtered|unfiltered|hop|hand|flat|flatlinear|flatclosure|flatdynkey`,
  one per process. `hand` is the engine's own `drain` over the same `Set`s; the four `flat*` arms
  decompose the rest. It is what showed that **closure dispatch costs ~3 ns while the DYNAMIC
  PROPERTY KEY costs 1.41x** — refuting item 1893's table row, which charged that term to the
  closures and prescribed plumbing the predicate's operator into the walk.
- **`edge-flat-order-2016.mjs`** — the flat edge array's ORDER against the bucket walk's, compared
  POSITIONALLY. The second-ask policy makes it self-checking: within one process ask 1 IS the
  bucket walk and ask 2 IS the flat array, so the two arms need no kill switch. It also asserts that
  a topology write sends the next ask back to the bucket walk AND that the write changes the answer
  — without the second half the staleness check cannot fail.
- **`edge-flat-ab-2016.sh`** / **`edge-flat-mutants-2016.sh`** — the flat arm's PRE/POST A/B with
  `hop`/`unfiltered` as controls (their `first/best` ratio is the check that the `'e'` namespace did
  not arm their CSR builds), and its 16-mutant round across three source files.
- **`edge-filtered-oracle-1883.mjs`** — the rung's contract against the route it DISPLACES. Two arms
  of one build (PRE = the dist call site replaced by `void 0`, POST = shipped), 23 traversals over 3
  fixtures, ORDERED comparison, with both arms asserted (the killed arm must claim nothing, the
  shipped arm everything). Use it, not only the unit test, when widening the rung's gate.
- **`edge-filtered-mutants-1883.mjs`** — whether `edge-filtered-hop-values.test.ts` still has teeth.
  Seven mutants, each anchor-asserted for its occurrence count, verdicts read from stdout+stderr
  concatenated before the exit code.

**Item 1883 built the rung: 18.04 → 6.14 ms, 2.94x, 225 → 77 ns an edge visit** against the
unfiltered floor's 36. The screen's top shape is now `optional: hop` at 10.11 ms.

### The `optional` rung's instruments (item 1884), and the estimator trap they are shaped by

**READ THIS BEFORE MEASURING ANY TRAVERSER-PIPELINE SHAPE WITH A SHORT REP WINDOW.** The
`optional` arm does NOT plateau for ~12 reps where its fused twin is flat from rep 4, so a 9-rep
median read **116 ns a row** where a 150-rep profile of the same shape read **70.3** — and the
first A/B on it reported a NULL that did not exist. Print the series.

- **`optional-hop-floor-1884.mjs`** — `SHAPE=optional|hop|optional_id|sparse_optional|sparse_hop`,
  one per process. **`SERIES=1` prints the per-rep series**, which is what found the trap above.
- **`optional-ab-1884.mjs`** — the two-build A/B: PRE kills the rung in the dist, POST is shipped,
  30 reps less 2, MEDIAN of rounds (not min — the min invented 0.85x of control movement once),
  three order-alternated rounds, with `hop` as a control the rung cannot reach. **1.37-1.38x on
  `optional`, 1.36-1.51x on its `id()` twin, control flat**, over three independent runs.
- **`optional-oracle-1884.mjs`** — the route differential, 51 pairs ORDERED, `undefined` kept
  distinct from `null`.
- **`optional-mutants-1884.mjs`** — 7/7 caught, after two survivors taught the file that `toEqual`
  ignores `undefined` entries and that `in()` is the only spelling where the bucket's direction flag
  is observable.

**Item 1887 extended all four to the multi-step chain** (`optional(out, out)`), 2.14x — and
`gremlin-generic-floor-1887.mjs` is the floor that chose it over three other generic shapes.
**Read that file's header before pricing anything off a route screen**: this shape's 4,002
`applyStep` calls looked like the whole bill and fusing the step measured 92.42 -> 91.64 ms. A
dispatch count says WHERE to measure, never HOW MUCH. **Item 1888 then took the remaining gap with
the CSR (`chainCsrFor`): 5.42x, 94.68 -> 17.47 ms.**

**`optional-mutants-1884.mjs` NOW TAKES A `which` OCCURRENCE** because that module holds three
near-identical walks, and its first splice was WRONG in a way worth knowing: it emitted both the
anchor and the replacement, the file stopped parsing, and **every mutant reported exactly `1
failing` — including the one expected to survive.** A uniform failure count across every mutant is
evidence of a broken harness, not of teeth.

**`optional-hop-floor-1884.mjs` REPORTS ITS COLD REPS** (`SERIES=1`), because a cached CSR build
is paid on rep 1 and invisible afterwards — item 1695's "safe iff the walk costs more than the
rebuild" can only be read there.

## Start here: `family-split-1880.ts` — which SHAPE owns a family's milliseconds

`workload-perf-screen.mjs` reports one number per family, and a family is a generator. Item 1879
found `var-length`'s 543 ms was ~70% ONE bound (`{2,3}` at 45.1 ms against its `{1,3}` twin's 0.8,
same eight rows), which no family total could show. This drives the real `WORKLOAD_FAMILIES`, dedupes
the realized texts, times each, and **sorts by absolute ms**.

Run it before hunting. As of item 1880 the four biggest shapes on the screen are each already
accounted for — `multi-pattern` a genuine product (1864), `chain-rows` a layout ceiling (1859),
`var-length` `{2,3}` a TRAIL correctness refusal (1879/1252), `aggregate` `sum`/`avg` the
byte-identity summation order (1830/376) — so a NEW big number from this probe is the signal.

**AN ACCOUNTING NOTE THAT EXPLAINS A SHAPE'S SIZE CAN HIDE A SEPARATE TERM INSIDE IT, and item
2017 is the worked example.** "`multi-pattern` a genuine product" is true of the ROW COUNT — a comma
pattern really is |E|x|F| rows — and says nothing about the 7.7 EXTRA SECONDS its `ORDER BY` added
on top, which was the largest single number on the GQL surface and had sat behind that label through
~15 items of sort work. **So read an accounted shape's note for WHAT it accounts for**: the same row
with and without its `ORDER BY` was 2206 against 9909 ms, and that difference was nobody's entry.
(Item 2017 took it: 1.49x on this shape and sixteen families flat or better.)

`worst owns N%` is a share of the sum over DISTINCT shapes, not weighted by the generator's draw
rate. It names the slowest shape, not necessarily the one owning the family's screen time.

### `range-scan` HAS A 1.72x NOISE FLOOR ON THIS SCREEN — ANYTHING UNDER ~1.7x ON THAT ROW IS UNINTERPRETABLE

Measured at item 2019 on ONE FIXED BINARY, eight consecutive `FAMILY=range-scan` runs:

```text
    54.8  35.6  33.1  31.9  33.3  32.5  34.0  47.5     1.72x, no code change
    union control (4 runs)   36.7 36.5 38.1 38.1        1.04x
```

So it is this family specifically, not the harness. **It has already cost one false regression**: item
2018's owed four-round sweep read `range-scan` at **0.69x** — PRE 32.4/33.5 against POST 49.1/47.0,
non-overlapping across both rounds, which is exactly what a real regression looks like. A three-arm
bisect (before / the extraction alone / the full change) then put the slow reading on whichever arm
ran FIRST in a pass, with all three arms at 32.4-32.7 at their best, and the eight-run series above
settled it. **Two slow draws landing in the two POST slots was coincidence.**

Two rules this earns:

- **A two-round A/B cannot resolve this row.** Give it the eight-run series, or bisect it against a
  control arm that the change cannot reach.
- **"Non-overlapping across both rounds" is not sufficient evidence on a bimodal row.** It was the
  reason the regression looked real, and it was wrong.

## `surface-parity-probe.ts` TIMES ONE CALL PER REP — its fast arms' ABSOLUTES are inflated ~6x

Item 1877 looped its `seek-count` arm 20,000 times inside the timed region and read **2.86 us against
the probe's 18.6**. `performance.now()` around a single 1.5-20 us call is close to its own resolution,
and four of the six arms land in that band. **The RATIO is still worth chasing** — it survived the
loop and grew, 2.17x to 2.6-3.6x — but the millisecond figure beside a fast arm is not worth quoting,
and a flag should be re-measured with a loop before it is priced.

## A PER-OP FIGURE FROM AN `OPS` LOOP UNDERSTATES A SINGLE QUERY BY 1.4-1.8x (item 2043)

Every probe here that reports `ms / N ops` divides a tight loop. Varying ONLY the ops-per-sample, on
one fixture, one shape per process:

```text
    OPS/sample   per-op (vacuous arm)   per-op (mixed arm)
    20                   2.31                  3.00
    5                    2.16                  3.38
    1                    4.20                  5.60
```

**A single call costs 1.4-1.8x what the same call costs as one of twenty.** A tight loop reuses the
plan, the graph and the inline caches; a single call pays a cold-ish entry. It is general — the
unlabelled CONTROL moves too (2.62 -> 3.70).

Two consequences:

- **Do not compare absolute per-op numbers across harnesses with different loop depths.** The
  workload screen times ONE call per sample; most probes here time twenty. A cross-instrument gap on
  one row was chased for three items (2038, 2039, 2042) and was entirely this.
- **A figure quoted as "X ms per query" from such a loop is a HOT-LOOP figure.** The screen's
  one-call-per-sample numbers are the closer analogue of a user's single query.

## FRAMES THAT ARE CLOSED — read this BEFORE nominating anything from a profile

Every profile taken in this package surfaces the same handful of frames, because a write is not
idempotent so the fixture is rebuilt per rep and the build is often most of the process. **All of
them are closed targets.** The list exists because item 1623 predicted the failure it prevents —
_"a seventh arrival at `indexEdgeLabel` by someone reading a fresh 27.2%"_ — and item 1876 confirmed
the prediction was about to come true.

| frame                                                        | why it is NOT a nomination                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexEdgeLabel`                                             | priced at **810 ns / 7 hash ops** (item 312), SPLIT across its three indexes (357/358), its only lever BUILT AND DISQUALIFIED (the dense ordinal, 1369-1372/1397), a variant DECLINED at 2.3% (1730) and another REVERTED at 0.999x (1819). **Six prior arrivals.** |
| `getEdgeById` / `getVertexById`                              | in write profiles these are largely **self-time misattribution**, already ablated to an upper bound (items 700, 1397, 1624). In read profiles they are usually the HARNESS resolving endpoints.                                                                     |
| `commitElementLabels`, `set labels`                          | label handling, ~36% of an edge write together with `indexEdgeLabel` and **priced three times** (item 1768).                                                                                                                                                        |
| `#commitNormalized`, `insertEdge`, `pushTokens`, `addVertex` | the rest of the construction path, "CLOSED as a constant factor" — `JSON.parse` + alloc + freeze, not a missing route (item 312; `addVertex` withdrawn at 7.4%).                                                                                                    |
| `(garbage collector)` in a write profile                     | priced with the rest of the decode at ~13% (item 1731).                                                                                                                                                                                                             |

**AND THE THREE PROFILE PROBES NOW PRINT THIS LIST THEMSELVES** (item 1985), to stderr, before
their JSON result. The reason is that this table already said the right thing in the right words and
the failure happened anyway: CLAUDE.md's rule is to read `PROBES.md` before BUILDING an instrument,
so RUNNING an existing probe never triggers it — item 1985 took a write profile, read
`indexEdgeLabel` at a fresh **30.1%**, and was stopped only by a habit of grepping `CLOSED.md` for
the frame name. That would have been the seventh arrival. **A warning filed where the reader is not
is a warning that does not fire.**

**So a profile whose top frames are these has measured the FIXTURE, not the thing you asked about.**
The fix is not to nominate them — it is to make the query dominate (`hop3-values-prof-1875.mjs`
prints the query's share of the process for exactly this reason) or to window the profile
(`windowed-profile.mjs`).

**And the NDJSON decode's four terms are all priced** (item 1731): parse 25.6% (a V8 builtin),
`indexEdgeLabel` ~19%, id resolution ~14%, GC ~13%. There is no unpriced remainder to find.

## Invariant probes — a property that must hold, not a number to beat

Each of these was built because a violation was FOUND. A violation is a planner choosing a route
for a reason other than cost, and it is invisible to every correctness test, because both routes
return the same rows.

| probe                             | the property                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | last run                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spelling-probe.ts`               | equivalent GQL spellings of one predicate cost the same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | clean; one flag is item 644's reverted product lever. **Gained TEMPORAL groups at 1490 (2.29x)**                                                                                                                                                                                                                                                                                                     |
| `gremlin-spelling-probe.ts`       | the same for Gremlin (item 1305)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | zero flagged AT `SPELL_N=200000`; **1M flagged a new 2.00x group** (item 1332)                                                                                                                                                                                                                                                                                                                       |
| `surface-parity-probe.ts`         | GQL and Gremlin cost the same for ONE question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | found 1322's 5.78x and 1334's 1.92x; `two-hop-count` now GQL 1.35x FASTER, gap reversed                                                                                                                                                                                                                                                                                                              |
| `index-never-hurts-probe.ts`      | adding an index never makes a query slower (item 1324)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | holds on 17 shapes, both surfaces                                                                                                                                                                                                                                                                                                                                                                    |
| `id-lookup-is-o1-probe.ts`        | lookup by id is FLAT in graph size (item 1326)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | holds on 8 arms over a 16x range                                                                                                                                                                                                                                                                                                                                                                     |
| `id-lookup-hotset-probe.mjs`      | whether that probe's residual drift is CACHE or COMPLEXITY (item 1395)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | CACHE: flat in N at a fixed hot set, rising in hot set at fixed N — O(1) confirmed at **~5 ns hot / ~18 ns cold**                                                                                                                                                                                                                                                                                    |
| `order-probe-1389.mjs`            | a rewritten adjacency walk yields the SAME SEQUENCE, not just the same multiset (item 1389)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | BASE vs HAND identical for both `out('E','F')` and `out('F','E')`                                                                                                                                                                                                                                                                                                                                    |
| `rung-precedence-census.mjs`      | **WHICH of the 20 rungs answers each shape, and which willing rungs are STARVED** (item 1775) — its 10 GENERAL-PATH shapes now have bench rows (item 1785), 2 of them CORRECT declines — **RUN IT WITH `bun`, NOT `node`**: it imports `rewrites.ts`, so node dies on `auto-param.js` resolution (item 1785 hit this; a dead oracle is what item 1775 itself was built after)                                                                                                                                                                                                                                                                                                                          | 79 shapes: only 5 contested, 3 pairs, all 3 correctly ordered. 10 shapes on the GENERAL PATH — that list is the open surface                                                                                                                                                                                                                                                                         |
| `executor-duplication-census.mjs` | **WHICH executor functions are NEAR-DUPLICATES, and which pair was MEASURED on only ONE side** (item 1787) — the companion to the rung census: that one asks which rung answers a shape, this one asks whether the same walk was written twice. A HIGH SCORE IS A CANDIDATE, NOT A FINDING: its top row (`stackedWalk`/`pairSlotWalk`, 122L byte-identical) is duplicated ON PURPOSE at item 1681, and collapsing it cost the depth-3 row 1.26x. Its ASYMMETRIC-CITATION screen reads COMMENTS, so it must scan the RAW body — the first cut scanned the comment-STRIPPED body and reported a pair BACKWARDS                                                                                           | 611 functions, 28 pairs >= 0.80. Found the subquery TRIPLET where item 1500's `for...in` fix reached 1 of 3 copies                                                                                                                                                                                                                                                                                   |
| `match-parallel-edges-1793.mjs`   | **DO BOTH ENGINES AGREE WITH TINKERPOP ON A MULTIGRAPH `match()`?** (item 1793) — three-way: TinkerPop 3.7.3's own answer (recorded in the header, re-checkable with the podman console), the TS engine and the Rust engine, on a 3-vertex graph with two parallel edges. IT READS `@lenke/gremlin`'s DIST, so `bun run build` is load-bearing — the first run after the fix still printed the OLD answer                                                                                                                                                                                                                                                                                              | TS answered 3 where TinkerPop and native both answer 4: the solver deduped solutions. Fixed at 1793; the three now agree                                                                                                                                                                                                                                                                             |
| `emitter-gap-census.mjs`          | **WHICH STEPS CANNOT CROSS THE TEXT BOUNDARY, AND WHOSE FAULT IT IS** (item 1795) — the differential fuzzer feeds native by emitting Gremlin TEXT, so a step `planToGremlin` cannot write has NO differential coverage and nothing reports it (the fuzzer's own emitter-gap check only fires for steps the GENERATOR builds). Three questions, each answered by RUNNING: does native parse the text, does the TS builder produce a plan, does the emitter render it. ITS FIRST CUT READ `emit.ts` FOR `case '<kind>'` AND LIED TWICE — `as` is handled by an `if` above the switch, and the controls were keyed by display name so `out` read as missing. The source scan is deleted; call the emitter | **19 PURE GAPS**: where, and, or, properties, propertyMap, elementMap, store, cap, aggregate, sample, barrier, index, none, hasId, hasNot, hasValue, sideEffect, subgraph, shortestPath. `loops` is a native-parser gap instead                                                                                                                                                                      |
| `coverage-union-census.py`        | **WHICH src lines NO test anywhere reaches** (item 1790) — a per-package coverage run cannot answer this: `packages/native`'s cross-engine suites import `@lenke/gql`/`@lenke/gremlin`, which resolve to DIST, so their hits land on `dist/esm/index.mjs` and nothing under `src/`. This decodes the dist sourcemap and projects those hits back onto src, then unions them with each package's own lcov. IT MODELS LINES, NOT BRANCHES — an `if` whose else-arm never ran reads as covered, so arms still need mutation. And the union direction means it can only SHRINK the gap list: a line it calls uncovered is a real candidate, a line it calls covered might be a mapping artifact            | **1,298 → 506** uncovered code lines; 792 were reached only from another package. Corrected item 1787's `sack()` claim (37 → 6) and found `boundedTop` DEAD (item 1790, −93 lines)                                                                                                                                                                                                                   |
| `page-rung-probe.mjs`             | what LOSING a projection rung to a page costs (1775); its `*param` arms were the BEFORE route at 1776/1777 and are SPELLING TWINS since 1778                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | page taken: node **7.27x**, hop START **8.14x**, hop FAR **4.87x**, parameterized **7.14x/7.98x/4.81x** (1776-1778); every spelling pair now flat. `hopoffset` is **1.28x FASTER than `hoplist`**, which item 1777 read as a suspect walk choice — ~~suspect~~ **it is this probe's own degenerate fixture: items 1438 and 1779 both decline the gate, 7 of 8 cells say the shipped route is right** |
| `offset-order-equiv.mjs`          | SPELLING (literal vs `$s`) and SELF (paged vs unpaged-sliced) for the paged rungs; it was the cross-ROUTE oracle until 1778 removed the last general-path spelling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | SPELLING identical on all 16 rows; SELF differs for the far-read hop, which is 1777's forced start-driven walk and expected                                                                                                                                                                                                                                                                          |
| `offset-rung-profile.mjs`         | the two profiles behind that 7.9x, windowed past the fixture build (item 1775)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | general path 3424 ms engine vs the rung's 426; **`internalSkip` is 3.7% — losing the rung is the other 96%**                                                                                                                                                                                                                                                                                         |
| `skip-only-page-parity.ts`        | do TS and NATIVE agree POSITIONALLY on an UNORDERED skip-only page — the shape every fuzzer is blind to (item 1776)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | node proj / 2col / `WHERE` IDENTICAL paged AND unpaged; **hop FAR's UNPAGED order already differs between the engines**                                                                                                                                                                                                                                                                              |
| `hop-walk-fanin-ab.sh`            | FAR-driven against START-driven on the SINGLE-type hop, the walk choice NO gate guards, swept over `FANIN` × `FANOUT` × `STRIDE` (item 1779)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | far-driven wins **7 of 8 cells, 1.91x-8.26x**, and its margin GROWS as fan-in concentrates; the sole dissenter is `small`/fanout 1. Reproduces item 1438's cells to **0.01x** on a harness sharing no code with it                                                                                                                                                                                   |
| `far-driven-predicated-parity.ts` | do TS and NATIVE still agree as MULTISETS on a filtered hop projection now that TS far-drives it (item 1781) — the shape `bun run fuzz` does NOT cover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | all 7 admitted shapes **SAME SET, DIFFERENT ORDER** against native, every DECLINED control **IDENTICAL** — so the order difference is attributable to the new route and the multiset never moves                                                                                                                                                                                                     |
| `order-residual-ab.sh`            | does admitting `order` as a residual over the bare hop pay, and what does it cost the rows it cannot reach (item 1783)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | target **1.536x** (79.4 -> 51.7 ms), 5/5 rounds below the base median, 11/11 arm assertions; a control read **0.95x at three rounds and 1.081x at five** — the 5% was never there                                                                                                                                                                                                                    |
| `gremlin-order-by-key-parity.ts`  | do TS and NATIVE agree POSITIONALLY on `V().out(T).order().by(k)` (item 1783) — the Gremlin fuzzer generates ZERO property-key `by()` modulators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | all 5 cases IDENTICAL incl. a TIED key; **it was VACUOUS on its first run** (key derived from the edge permutation, so walk order == sorted order) and now carries a can-fail GUARD                                                                                                                                                                                                                  |
| `walk-ab-aggregate.mjs`           | reduces that driver's log to one row per cell — `p25` per process, median across rounds — and REFUSES a table whose arms stopped answering the same question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | guard mutated (one arm's `rowCount` rewritten): **3 cells flagged, exit 1**                                                                                                                                                                                                                                                                                                                          |

**A PROBE CAN GO TAUTOLOGICAL WHEN THE CHANGE IT INFORMED SHIPS, and that is the dead oracle's
quieter sibling.** `offset-order-equiv.mjs` compares the UNPAGED query's rows, sliced, against the
PAGED query's. Before item 1776 those were two different ROUTES for the node shapes — the rung and
the general path — which is what made its `IDENTICAL` verdict evidence. Item 1776 gave the paged
shape to the same rung, so for the node rows it now compares the rung against itself and cannot fail.
Item 1775's rule was "run a probe before citing it"; this is the other half: **check that the probe
can still FAIL.** **AND IT HAPPENED TWICE MORE, TWO ITEMS APART**: item 1778 closed
the literal-vs-parameterized gap and so removed the last GENERAL-PATH spelling of a skip-only page
from the engine — which is what the cross-route oracle was made of. **A fix that closes a gap can
delete the instrument that proved the previous fix correct.** The answer is not to keep a slow route
alive as a test fixture: `skip-only-page.test.ts` now expects an ABSOLUTE enumerated row list, which
no route change can erode, and `skip-only-page-parity.ts` holds the cross-engine half. **AND IT WAS REPAIRED AT ITEM 1777 RATHER THAN LEFT WITH A NOTE**, once item
1777 gave the hop page to the same rung and the last falsifiable rows went with it. It now reports
two comparisons per case and labels them: **ROUTE**, the literal `OFFSET k` against the
parameterized `OFFSET $s` — which declines the rung on purpose, so this is the real cross-route claim
and the only one that decides the exit code — and **SELF**, the paged query against the unpaged query
sliced, which legitimately DIFFERS for a shape whose rung changes its walk when paged. The
cross-ENGINE half is `skip-only-page-parity.ts`, and the per-shape assertions are in
`skip-only-page.test.ts`.

**AND THE FUZZERS WERE BLIND TO THE WHOLE SHAPE** (item 1776). Every page the differential fuzzer
generates rides an `ORDER BY` — `… ORDER BY t SKIP n LIMIT m`, and `ORDER BY … OFFSET 1` in statement
position — so an UNORDERED `RETURN n.k OFFSET k` is outside its corpus, and `bun run fuzz` green said
nothing at all about the route item 1776 changed. Found by reading the generator, not by trusting the
suite; the same failure mode as `fuzzer-blind-to-one-column-group`. `skip-only-page-parity.ts` is the
oracle that covers it, and it reads each paged shape against its own UNPAGED control, because a page
cannot be expected to agree where the unpaged orders already do not.

**NEVER LABEL A BENCH ROW A "TWIN" FROM EXPECTATION — ASK `compileLinear` WHICH RUNG FIRES**
(item 1785). I added `hop2groupstart` as a rung-taking control for `hop2groupend` and wrote that it
"reaches a rung"; both are GENERAL PATH, so the 1.09x between them is two general-path shapes
differing by one property read, not a route gap. The real twin in that batch —
`hopgroupsumcrossend` (general) against `hopgroupsumsameend` (`groupedHopAggregate`) — prices losing
the rung at **2.38x**. Item 1775's own lesson from the other side: a corpus gap reads like a
starvation, and an assumed twin reads like a route gap.

**AND A SMALL FIXTURE OVERSTATED THAT GAP BY 2x.** The same pair read **5.04x** at 20,000 nodes
from one process per arm, and **2.38x** at 200,000 over three interleaved rounds. The direction held
and the magnitude did not — which is how a smoke-test number usually fails, and why a smoke test is
for liveness (is the answer non-vacuous?) rather than for a ratio.

**NORMALIZE BY THE QUANTITY THE LOOP IS OVER, NOT BY THE QUANTITY IT EMITS** (item 1784). A
re-rank after item 1783 put the four `hasLabel('Q')` hop rows at 2.1x-2.9x their unlabeled twins per
ROW — and they are CHEAPER per VERTEX SCANNED (`hopyieldq` 117.7 ns against `hopyieldsingle` 167.5;
`hopbareq` 85.7 against `hopbare` 88.0, so the label test costs ~2 ns). The fused walk is
`for (const v of graph.vertices)` and scans every vertex whatever the filter admits, so `VLABEL=3`
emits a third of the rows for the same scan and `ns/row` inflates the filtered shape by exactly the
selectivity. **A shape whose filter sits UPSTREAM of its row count has a row count that is an output
of the filter, so dividing by it divides by the thing under test.** Both columns are computable from
what the bench already prints (`nodes`, `rowCount`); neither is assumption-free, which is why the
ranking now carries both. Same family as item 1437's "divide before comparing", pointed the other
way: divide when the arms differ in rows for a reason OUTSIDE the change.

**READ THE GENERATOR'S SHAPE SPACE ON THE AXIS THE CHANGE MOVES** (item 1783). The Gremlin fuzzer
calls `order(` 59 times, so it looks like coverage for any order-step change. Every `by()` modulator
it generates is a COMPARATOR TOKEN — 8 × `.by(desc)`, 3 × `.by(Order.desc)`, **zero with a property
key** — so `order().by('s')` is outside its corpus entirely. The step is generated; the MODULATOR
KIND is not. Third blindness finding in one arc and all three are different: item 1776's page was
ABSENT, item 1781's shape was PRESENT UNDER A COUNTER THAT NAMED IT, this one's step is present with
the wrong argument.

**AND A PARITY PROBE CAN BE VACUOUS ON ITS FIRST RUN — ASK IT TO PROVE IT CAN FAIL.**
`gremlin-order-by-key-parity.ts` derived its sort key from the same permutation as its edge targets,
so the walk order already EQUALED the sorted order: sorted and unsorted output were byte-identical
and all five `IDENTICAL` verdicts held for a reason unrelated to sorting. A route that dropped the
sort entirely would have passed it. It now carries a GUARD rather than a comment — it exits 1 if
sorted ever equals the walk order. Items 1064, 1777 and 1781 each paid for this same fixture defect;
this is the fourth and the first to leave an automated check behind.

**RE-RANK A BENCH AFTER FUSION WORK, BECAUSE A FUSION PROMOTES THE SPELLING IT DID NOT REACH**
(item 1782). Item 1439 ranked the Gremlin bench with `hoporder` on top at 89.48 ms; items 1586, 1630
and 1713 fused and specialized the projected-order path and it now reads **24.07**, which puts
`hoporderbystr` — `order().by(k)`, the one sort spelling the fusion never reached — at the top at
**1537.5 ns/row**. Route markers confirm it takes NO shortcut at all (`projected=UNDEFINED`), because
`hopValuesShortcut` needs a `values()` step. **The new peak was created by the previous wins, and
only a re-rank shows it.**

**AND A HOT FRAME CAN BE HOT BECAUSE OF THE ROUTE THAT REACHES IT.** That row's profile puts
`iterLabeled` at 32.7% and the whole traversal cluster at 70%, which invites optimizing the adjacency
iterator. It is not slow: `hopbare` runs the IDENTICAL `V().out('E')` walk in 8.5 ms against this
row's ~43, because the fused route does not go through the generic traverser pipeline.
`frame-attribution-trap` in a new form — and the control that separates the two readings is the same
walk on the other route, not a deletion test.

**AND A COVERAGE COUNTER CAN NAME A SHAPE IT DOES NOT COUNT — `hopFilter` IS THE COUNT LADDER**
(item 1781). The differential fuzzer prints `hopFilter=172/156`, which reads as coverage of the
filtered one-hop family. Its test is

    /^MATCH \([ab]?[^()]*\)[-<]/.test(q) && q.includes(' WHERE ') && q.includes('count(*)')

so it tallies only the filtered **`count(*)`** ladder; `groupHopPred` is the GROUPED form. A plain
`MATCH (a:L)-[:E]->(b:L) WHERE <far pred> RETURN b.k` — a yielding projection — is tallied by
neither, so `bun run fuzz` green said nothing about the route item 1781 changed.
`far-driven-predicated-parity.ts` is the oracle that covers it.

**THAT IS THE THIRD TIME IN SIX ITEMS, AND THE FIRST TWO WERE DIFFERENT FAILURES.** Item 1776's
page was absent from the corpus entirely; this one is PRESENT UNDER A NAME THAT MATCHES, which is
worse, because the counter is non-zero and reading it is what convinces you not to look. The rule
is unchanged and now has a second form: **read the generator's PREDICATE, not its counter's name.**

**THE FILTERED-HOP ROWS WERE ALL ONE PREDICATE CLASS, AND IT IS THE CLASS THAT CANNOT TAKE THE
ROUTE** (item 1780). Every filtered row in `isolated-row-bench.mjs` was an ORDERING comparison
(`b.n > 5`, `b.n > -1`, `b.k > -1`), which can raise on a cross-type pair — so the whole family
declined item 936's candidate design (gate a far-driven filter on a raise-free predicate) for a
reason that is a property of the FIXTURE's predicates, not of the engine. `=`, `<>`, `IS [NOT] NULL`
and label tests cannot raise (`cross-type-comparison-no-error`), and the equality form is also the
only SELECTIVE one — every `>` row here passes ~100%. `hopfiltfareq` and `hopfiltneq` are those two
rows; the pair separates raise-freedom from selectivity, which one row would conflate. **A filter
family measured only with `>` is measuring neither property.**

~~**AND `truthCannotRaise` IS NOT THE KEY FOR SUCH A GATE**~~ **IT IS THE KEY, AND ITEM 1780 GOT
THIS WRONG — CORRECTED AT 1781.** I read its parenthetical about hoisting a faulting comparison as a
statement that comparisons fault. Its doc HEADER states the contract: "whether evaluating `e` as a
TRUTH VALUE cannot raise — the question a conjunct of a filter poses", which is precisely the
question a far-predicate gate asks. Verified against the engine rather than re-reasoned: 20 far
predicates, keys read for all 20, **zero cases of a key-true predicate raising**, and the only three
raising shapes (`b.k / 2 > 1`, a `CAST`, a bare `b.s`) all key false. Cross-type comparison yields
UNKNOWN in value position and no-match in filter position — it does not throw, so the
`cross-type-comparison-no-error` memory's "`<=` → throw" is stale. **The error mattered: it would
have narrowed the gate to equality and excluded `b.n > 5`, the top of the bench.** `predicateCannotRaise`
(the compiled-shape key) is the companion, not the replacement.

**AND THAT SAME COUPLING IS NOW A TOOL: `OFFSET 1` IS A START-DRIVEN FORCER** (item 1779). Item
1777 gave `hopOrderPlan` a `pageSkip !== 0` arm of its `startDriven` flag, so adding `OFFSET 1` to a
hop flips the walk while changing nothing else — same detector, same exit, one fewer row. **That
makes a route A/B two QUERIES IN ONE BUILD**, with no source patch and no rebuild between arms, so
item 737's cross-build trap cannot apply. It is how `hop-walk-fanin-ab.sh` swept a walk choice that
item 1438 could only reach by hand-patching `hop-projection.ts` — and the two agree to **0.01x** on
the cells they share, which is the check that says the forcer measures the route and not itself.

**AND IT INHERITS THE RISK ABOVE: this probe is DOWNSTREAM OF A SHIPPED BEHAVIOUR.** If item
1777's forced walk were removed, both arms would be far-driven and the sweep would compare a route
against itself — tautological, in the same way and for the same reason as the oracles above. The
guard is not in the probe: `skip-only-page.test.ts` pins the paged far-read hop's rows in
START-DRIVEN order and item 1777's mutant confirms dropping the force fails 3 of them. **When a probe
is built on a shipped route choice, say which test holds that choice up**, or the probe's silence
later looks like evidence.

**`rung-precedence-census.mjs` ASSERTS THE ASSUMPTION IT RESTS ON, and a reader changing either
file must know why.** It reads `compileLinear`'s non-null fields to name the rung that fires, which is
only sound because `compileLinear`'s returned field order is kept IDENTICAL to `runLinear`'s lazy
`if (linear.<rung>)` chain in `executor/clauses.ts` — deliberately, and `rewrites.ts` records that the
two once DRIFTED in their first five entries while matching in the last fourteen. The census
transcribes the chain and refuses to report if the orders disagree, rather than producing a confident
census of the wrong precedence. **AND A STARVED RUNG IS A CANDIDATE, NOT A FINDING** — item 418
measured a branch moved ahead of a hot dispatch costing the shape it does not claim 1.12x, so a
broader rung firing first is often right. All three contested pairs the census found were correct.

**`hop-distinct-route-probe.mjs` WAS DEAD FOR AN UNKNOWN NUMBER OF ITEMS** and item 1775 found it
by accident, copying its import. It read `../gql/src/executor.ts`, which stopped existing when the
executor was split into modules — so item 1583's own oracle, the instrument that found a 6.00x rung
starvation, had been silently unrunnable while `CLOSED.md` went on citing it. Nothing noticed, because
a probe has no gate. **A probe that imports engine internals is a probe that a refactor can kill
without failing anything**, so run the ones you cite before citing them, and prefer the import path a
TEST uses (`routes-fired.test.ts` names `./executor/rewrites.ts`) since a test's path is maintained.

`order-probe-1389.mjs` CARRIES ITS OWN VACUITY CHECK, and it needs one. Gremlin stream order is a
TinkerPop contract and the differential fuzzer compares ORDERED, so a walk that replaces
`iterLabeled` has to reproduce its sequence, not its multiset. But the obvious fixture cannot see
that at all: with one out-edge per vertex, vertex iteration order decides everything and
`out('E','F')` prints the same sequence as `out('F','E')` whatever the walk does — the first check
built for item 1389 reported exactly that and proved nothing. The fixture therefore gives every
vertex an `E`-only, an `F`-only and a both-labelled out-edge, and the probe FAILS LOUDLY if the two
spellings ever agree, because that means it has gone blind rather than that the engine is right. Any
driver using it should refuse to proceed on `efIsFe: true`; the item 1389 A/B does.

`surface-parity-probe.ts` is the one that earned its keep: the gap it catches is invisible to every
other harness here, because `bench:usage` runs GQL rows plus two native-only Gremlin rows,
`bench:gremlin` compares Gremlin against native, and the spelling probes compare spellings WITHIN
one surface.

## Standing benches

| command                                        | question                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `bun run bench`                                | bulk throughput, ts / ffi / wasm side by side                        |
| `bun run bench:usage`                          | per-operation cost on a warm graph, including interleaved read/write |
| `bun run bench:gremlin`                        | Gremlin traversal shapes, TS against native                          |
| `bun run spelling`, `bun run spelling:gremlin` | the two spelling probes                                              |
| `bun run fuzz`                                 | the seven byte-identity fuzzers                                      |

## Bespoke probes worth knowing about

| probe                          | question                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `keyed-dedup-probe.ts`         | the clause-vs-inline keyed count (item 1320), and the per-PROCESS estimator that resolved it |
| `branch-cost-probe.ts`         | what a `choose`/`coalesce`/`union` branch costs per row                                      |
| `enumeration-surface-probe.ts` | WHICH enumeration surface a route actually walks (item 1329)                                 |
| `pinned-chain-count-probe.ts`  | does an id-pinned START avoid the sweep for a 3+-segment count (item 1329)                   |
| `notfold-soundness-check.ts`   | are `hasKey(k)` and `not(hasNot(k))` equivalent off an ELEMENT stream? (item 1331)           |
| `two-hop-surface-probe.ts`     | the GQL/Gremlin two-hop count gap, swept by DEGREE, cold rep and warm median (item 1334)     |
| `product-inline-seed-probe.ts` | NEVER reproduced the gap it was built for — see item 1333 before trusting it                 |

`notfold-soundness-check.ts` is not a timing probe — it answers whether a rewrite is ALLOWED. Item
1331 folds `not(hasNot(k))` into `hasKey(k)` for 16.9x, and the two are exact duals on elements but
NOT on anything else: after `properties()` they give 1 and 3, after `values()` 0 and 2, because
`hasNot` returns false for a non-element. Run it before widening that fold's allow-list, and in
general whenever a rewrite's soundness depends on what the stream carries.

**A BESPOKE PROBE CAN FAIL TO REPRODUCE WHAT A SHARED ONE SHOWS.**
`product-inline-seed-probe.ts` was built to bisect item 1333's 2x and matched the spelling probe's
fixture on TEN dimensions — N, edge count, labels, property richness, the NDJSON load path,
index-build order, the second index, one-process multi-shape timing, two-pass min, the per-rep
`JSON.stringify` — and never showed the gap, before OR after the fix. So its flatness is not
evidence a change does nothing, and the cause is still open (`ts-closure-size-is-load-bearing` is
the standing suspect: that probe is ~1,500 lines, this one ~250). Item 1334 is the contrast worth
copying: when a gap shows on one instrument and not another, READ THE DECLINE in the planner rather
than bisecting the fixture further — the guard answered in one look what ten measured arms could not.

**AND SWEEP THE DEGREE, NOT JUST THE SIZE.** `two-hop-surface-probe.ts` exists because the parity
probe's fixture is a degree-1 CHAIN, where a two-hop degree product has nothing to multiply. The gap
held at degree 2 and 3 so the target was real — but the RATIO is locality-sensitive (1.81x on the
sequential chain, 1.42x on scattered targets, absolute costs 2.7x apart), so quote the fixture with
the number.

**RUN THE SPELLING PROBES AT MORE THAN ONE `SPELL_N`.** Item 1331 closed the last flagged group
at 200,000 and item 1332 found a new one worth 2.00x by changing nothing but the size — the group
had been UNDER the 1 ms floor and reported as "not compared", which is not the same as clean. The
sweep-the-size rule was already written for benchmarks; it applies here too. Note what raising N
canNOT fix: the 13 id-lookup groups are O(1) by design (item 1326), so they stay under the floor at
any size and need more REPS or a finer timer instead.

`enumeration-surface-probe.ts` is the one to reach for before asserting anything about which route
was taken. **A spy on ONE surface that reads zero has NOT shown there is nothing to find.** Item
1329's first spy wrapped `verticesById.values()`, read 0 for both arms at 2k / 8k / 50k / 200k, and
was believed — it was the wrong surface, and the swept route was walking the LABEL index the whole
time. This probe wraps `values`, `keys`, `entries`, `forEach` and `Symbol.iterator` on both vertex
maps plus the Sets behind `verticesByLabel.get`, and prints every counter that moved.

Two sweeps in the same engine use DIFFERENT surfaces: a pinned chain's swept route walks the label
set, an end-gated chain's sweep walks `verticesById.values()`. A route assertion that watches one
of them silently loses half its teeth.

## The UNPRICED-FRAME SCREEN — run this before hunting, and read its defect list first

A CPU profile finds what hand-placed timers cannot (item 919), but a profile's top frames are mostly
hot for reasons already written down. The screen's job is the cross-check: sum self time per frame,
then report which frames appear NOWHERE in `CLOSED.md` or the audit. A hot frame with ZERO mentions
is the one worth a tick.

| file                                | surface                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `runtime-profile-probe.mjs`         | GQL query shapes (`control point hopfilter sortedpage grouped`)   |
| `runtime-profile-gremlin-probe.mjs` | Gremlin traversals (item 1359 — the GQL probe never covered them) |
| `runtime-profile-write-probe.mjs`   | the WRITE path, incl. the O(1)-by-id control (item 1360)          |
| `runtime-profile-analyze.mjs`       | reads `.cpuprofile`, prints shares + mention counts + verdict     |
| `profile-frames.mjs`                | the shared cross-check — do NOT duplicate it, see below           |
| `windowed-profile.mjs`              | profiles a WINDOW, so the fixture build is not in the profile     |

```
PROF_OUT=$D/hopfilter.cpuprofile node runtime-profile-probe.mjs hopfilter 120
NODES=200000 PROF_OUT=$D/sortedpage.cpuprofile node runtime-profile-probe.mjs sortedpage 60
node runtime-profile-analyze.mjs $D
```

**`NODES` AND THE ANSWER GUARD INTERACT, AND THIS BLOCK USED TO GET IT WRONG** (item 1793). The
probe's `EXPECTED` answers are calibrated for the DEFAULT `NODES=20000` — `hopfilter` is pinned at
207 — so `NODES=200000 … hopfilter` throws "answered 2062, expected 207 — this arm is NOT
answer-equivalent". The guard is right to fire and the invocation was wrong. Raise `NODES` only for
the shapes with no `answer` in `EXPECTED`, or raise the pinned answer with it.

**ITS VERDICT HAS LIED IN SIX DISTINCT WAYS, each found by pointing it at a new surface or by two
instruments disagreeing — never by reading the code, and never by the item that introduced it.** The
list is the reason `profile-frames.mjs` is ONE module and not copied into each analyzer:

1. **`n/a` laundered into "recorded"** (1358). V8 names an anonymous closure after nothing, so the
   screen marked it unnameable and the verdict line then said "every hot frame is already recorded".
   It was hiding the LARGEST frame in three of five GQL shapes. `n/a` now has its own bucket.
2. **The fix for (1) was a silent NO-OP on its first run** (1358) — Node reports `file:///abs/path`
   and the guard required a leading `/`. Caught only because the frames it was built for were still
   printed.
3. **A SHORT accessor property bypassed the accessor rule** (1359): `get to` looks up `to`, which the
   4-char guard rejects, so it fell through to the enclosing-declaration scan and was attributed to
   `WIDE_BAG` at 3.1% in two shapes.
4. **The mention count was a SUBSTRING search** (1359): `pick` read 202 where 53 are the identifier.
   Now word-boundary matched — and measured first, because the obvious generalisation is wrong
   (`values` is 1118 substring / 974 inside backticks, i.e. genuinely covered).
5. **It flagged its OWN probe's fixture builders** (1360). The GQL probe's `build` escaped notice for
   two items only because "build" appears 841 times in the documents, which is luck not a guard.
6. **The profiler appeared in its own profile** (1362): `post @ node:inspector` read 15-25% of three
   windowed shapes. Harness frames are now out of the DENOMINATOR, not merely out of the verdict.

**"HAS MENTIONS" IS NOT "IS OPTIMIZED".** The signal is binary, so a frame can be 41.9% of its
shape and three passing references retire it. Chase the nominations by hand.

**`runtime-profile-probe.mjs` CANNOT RESOLVE A SUB-15% QUESTION (item 1477).** At 60 reps its
intra-arm spread on the projection shapes is **27-31%** — `proj1` PRE alone read 245.7, 300.8 and
322.0 — so more rounds do not help: the spread is WITHIN an arm, not between them. Fine for the 2-5x
findings it was built for; for anything smaller use the isolated row benches and their
median-of-medians-across-alternated-rounds protocol.

**A SHARE IS A NOMINATION; AN ABLATION IS THE PRICE.** Four instances now: `edgesOfTypes` read
37.9% self for a path that is a single `Map.get` (1104); a clean 3.8x micro landed at **1.11x** in the
engine (1364); `bucketsOf` profiled at 9.2% and ablated at **3.7%** (1368); and a pre-shaped row
template measured **1.52x in a 300,000-row micro and NOTHING in the engine** (1477). Expect the share
to overstate by ~2.5x and price in the engine, or say plainly that you have not.

**The micro case deserves its own statement**, because it is the seductive one: a micro that isolates
one operation measures that operation's share of ITSELF, which is 100%. In the engine it is whatever
the profile says — so **the profile's share is the CEILING on what a micro's ratio can become, not a
prediction of it.**

**WINDOW THE PROFILE ABOVE ~20k ELEMENTS.** `--cpu-prof` covers the whole process, so at 200,000
the fixture build INVERTS the ranking — `getVertexById`, `indexEdgeLabel` and `commitElementLabels`
at the top of every shape, all load, no query (item 1362). Raising reps is not the fix; it shrinks the
build's fraction while costing time in the dimension being swept.

**THE GQL PROBE RAN AT FANOUT=1 UNTIL ITEM 1488**, which CLAUDE.md itself calls sparse ("per-edge
costs scale with the edge:node ratio"). It now has `STRIDE` and `FANOUT` knobs — and two new shapes,
because the ones it had could not show per-edge cost at all: `hopfilter`'s `WHERE a.k = 5` leaves
~2,062 of 200,000 sources so it is SCAN-dominated (FANOUT 1→5 moved it 113.5→127.6 ms), and `hopall`
(a one-hop `count()`) is a **degree sum** at 2-8 ns/edge. `hoprows` materializes a row per edge and
cannot shortcut.

On `hoprows`, stride matters: **1.84x at FANOUT=1, 1.25x at FANOUT=5** (higher fan-out amortizes the
scattered bucket lookup over more edges). Its screen verdict: `farDrivenHopWalk` 51.6% (priced),
**`(garbage collector)` 44.8%**, and row construction **1.4% in total** — which is why item 1477's
row-template change measured a null. **That shape is GC-bound on the size of its own result.**

**WRITING AN ITEM ABOUT A FRAME RETIRES IT FROM THE SCREEN.** `topKNodeWalk` had ZERO mentions when
1358 flagged it and one afterwards — 1358's own entry. The ZERO signal is ONE-SHOT, so a flagged frame
must be taken or explicitly priced in the same pass, or the next run reads clean with the work open.

### What the screen found, so it is not re-run for the same answer

**ITS SURFACE WAS FIVE SINGLE-PATTERN GQL SHAPES, and that was the limit of "no unpriced frame
survives" (item 1473).** A real query joins two patterns, keeps an optional side, de-duplicates or
asks a subquery, and none of that machinery had ever been profiled. Six shapes added — `join`,
`optional`, `distinct`, `existssub`, `wideproj`, `unioned` (+ `unioneddistinct`, `excepted`,
`unionedbig`, `unionedbigdistinct`) — and they turned up **one ZERO-mention frame, `combineRows`,
which became a 4.63x fix**. Five of the six came back clean, so those five are now covered too.

**The Gremlin screen had the same gap (item 1474).** Its eight shapes covered hops, order,
grouping, filtering and dedupe — no set operation, no wide projection, no optional side, no
named-step select. Seven added (`unioned`, `projected`, `valuemapped`, `coalesced`, `selected`,
`groupreduce`, `folded`), which nominated **five** unpriced frames: `groupStep` 48.9% (taken, 1.27x),
`projectStep` 54%, `projectValueMap` 45%, `asStep` 7%, `foldStep` 10%. `unioned` came back at **1 ms
engine** — a count shortcut already answers it, so item 1473's GQL defect has no Gremlin twin.
Item 1475 then took two of those: **`projectValueMap` shipped at 1.14x** (a guard that could never
fail), while **`projectStep` was REJECTED as flat** — its per-row identity-`By` allocation costs
nothing because escape analysis keeps it off the heap, the second time that mechanism has retired a
nomination here. Item 1476 closed the last two: **`asStep`** is 7% of a shape whose cost is 68% the `tracksPath`
general tail (priced at 1464, fix declined at 1466), and **`foldStep`** is ~14 ns/element to build the
list `fold()` is defined as building. Neither is a target.

Item 1478 added the last three (`repeated`, `matched`, `localized`): **`repeat` is clean**, `matched`
is the **largest shape this probe has measured** (2914 ms at only 20,000 vertices, ~44% unpriced,
~486 ns/row against a bare hop's 95) and gave up `tupleKey`'s single-part fast path (**1.10x**), and
`localized`'s nominations were **TAKEN at item 1479: 20.7x**, the fused arm landing on a hand floor
(`local` paid sub-plan re-dispatch once per incoming traverser, the shape item 1470 fixed in
`shortestPath`).

**`localized` and `localvalues` measure DIFFERENT things and the probe keeps both.** A bare
`count()` tail can be answered by a chain count without walking at all (0.07 ms), and a `local`
wrapper blocks that — so `localized`'s 364x is "the dispatch removed PLUS the shortcut unblocked",
while `localvalues`' 20.7x (a `values('k')` tail, which no shortcut answers) is the dispatch alone.
The first floor read 377x and was entirely the shortcut. `localvaluesfloor` is the hand floor for the
honest pair.

Item 1480 then measured the PER-ELEMENT branch steps (`optionald`, `coalesced2`, `optionalvalues`,
`coalescevalues`, `branchvaluesfloor`): **`optional` 19.3x and `coalesce` 20.2x a bare hop**, and
item 1479's fusion **cannot transfer** — for them the per-traverser sub-plan IS the semantics. The
cause is not the dispatch switch (it does not appear in the profile at all) but that the fused walks
are **source-anchored**: `hopValuesShortcut` wants `V()` plus one or two steps and answers the whole
plan, so a sub-plan starting from a traverser has nothing to anchor on. **Third instance of that one
cause** — 1464's `tracksPath`, 1479's `local`, these. Priced, not built.

Item 1483 then took the WRAPPING half of it — `optional(<one vertex step>)` fused into one loop,
**1.26x** — and the number is the point: I expected ~11x from the same trick that gave `local` 20.7x,
and the wrapping turns out to account for about a QUARTER of `optional`'s gap. 1480's diagnosis was
right; the rest is the general-vs-fused walk, which still needs the stream-transformer contract.
`hopbare` first read 13% worse there and was FLAT (3/5, nominally better) when isolated over five
alternated rounds — its own spread across those was 23%.

**But re-profiling `folded` at 400 reps instead of 20 roughly DOUBLED both shares** (`projectValues`
45.83% → 49.22%, `foldStep` 10% → 20.83%), and the real find was `projectValues` — **1.39x, item
1476**. Its 72-sample profile had ranked the wrong frame. Below a few hundred samples the ranking is
noise, which is the caveat above, now measured on this corpus.

Both query surfaces at 20k AND 200k, plus the write path: **no unpriced frame survives**. Every
nomination resolved to work already measured — `topKNodeWalk` to item 1064, `compareCodePoints` to
921's declined hoist, `expandSlot`/`slotChainCount`/`bucketsOf` to 1104/1105/1108/1152, and
`drainMutations` priced at 1.7% and declined (1360). **The size sweep is the part worth repeating**:
`propOf` grows 1.4-3.5x and `degreeOfTypes` **7.2x** from 20k to 200k (item 1365), so a
cache-resident measurement understates anything on those paths.

**THE WRITE PROBE'S SETUP IS EXCLUDED, since item 1396 — and it was not before.** Four of
`runtime-profile-write-probe.mjs`'s six shapes built their fixture inside the function being profiled
and timed, including `pointLookups`, the O(1)-by-id control, which built N vertices and then did 10xN
lookups in one measured call. It also had no windowing at all. Each shape is now `{setup, run}` with
`setup` outside the window, and `PROF_OUT` profiles the `run` loop alone. **Item 1360's write screen
was taken on the old instrument and both its numbers were artifacts**: `drainMutations`, "the only
unpriced engine frame" at 3.2%, does not appear in ANY of the six windowed profiles, and its
"O(1)-by-id at 70.9 ns" is 19 ns once construction is out — which independently matches
`id-lookup-hotset-probe.mjs`'s ~18 ns cold. Two instruments agreeing is the reason to believe 19.

## The ALLOCATION screen — `--heap-prof` is UNFIT, calibrate before believing it

| file                       | what it does                                                             |
| -------------------------- | ------------------------------------------------------------------------ |
| `heap-prof-calibrate.mjs`  | allocates 128 MiB through ONE named function, in retained + garbage arms |
| `runtime-heap-analyze.mjs` | reads `.heapprofile`, same cross-check as the CPU analyzer               |
| `gc-cost-probe.mjs`        | GC pauses with duration and KIND, via `PerformanceObserver`              |

**`node --heap-prof` REPORTED 0.7 MiB FOR 128 MiB ALLOCATED** and never named the allocating
function, identically in both arms (item 1361). The analyzer is kept because its format reading is
correct and the defect is upstream — but conclude NOTHING from it until `heap-prof-calibrate.mjs`
passes. ~~This is the only instrument in this directory found wholly unfit rather than subtly
biased.~~ **QUALIFIED TWICE AT ITEM 2416, and the instrument is USABLE for a question nobody could
ask before — see `allocprof-2416.mjs` below.**

### Item 2416: the heap profiler is sound for RETAINED bytes and blind to CHURN

Driven as the INSPECTOR DOMAIN around a bounded in-process window instead of through the CLI
wrapper (which dumps at process exit, after collections), the two arms SPLIT:

```text
    2,097,152 small objects through one named site     reported      heapUsed
      RETAINED in an array                             183.3 MiB     203.3 MiB   frame NAMED
      dropped immediately                                0.0 MiB     188.3 MiB
```

So it measures LIVE bytes, which is the diagnosis this file already anticipated two paragraphs
below ("if `retained` shows up and `garbage` does not..."). That makes it the repo's only **per-frame
RETENTION** profiler — which frame's allocations SURVIVE — and not a churn instrument.

**AND ITS GARBAGE ARM WAS PARTLY RIGHT TO REPORT ~0.** Item 1361's arm is
`const obj = {...}; sink += obj.a;` — the object never escapes, so once TurboFan optimizes the loop
V8's ESCAPE ANALYSIS removes the allocation entirely. Measured: churn per object falls
**51.3 → 66.8 → 46.4 → 29.7 B** as the count grows 1x to 8x. A meter cannot be calibrated against an
allocation the compiler deleted, so `allocprof-2416.mjs` stores each object into a module-level slot
instead: it escapes (really allocated) and is overwritten (really garbage).

| file                   | what it does                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| `allocprof-2416.mjs`   | `MECH=churn` bytes/query, `MECH=retained` per-frame survivors, `MECH=gcshare`   |
| `alloccount-2418.mjs`  | allocation COUNT **per call site** — the Rust `GlobalAlloc` equivalent          |
| `peakmem-2419.mjs`     | PEAK LIVE memory and whether it GROWS with the walk — the OOM question          |
| `gcobs-check-2416.mjs` | five-line calibration: does a `gc` PerformanceObserver deliver in this runtime? |

**`MECH=churn` ACCOUNTS ACROSS COLLECTIONS RATHER THAN AVOIDING THEM.** `heapUsed` after minus
before is the allocated bytes only while nothing collects in the window, and here something always
does: `new_space` starts at **1 MiB** and V8 grows it adaptively, so `--max-semi-space-size` does not
prevent scavenges and the delta under-reports 4-5x. `v8.GCProfiler` reports `usedHeapSize` before and
after every collection, and between two collections the heap grows only by what was allocated:

    churn = SUM over collections of (usedBefore_i - usedAfter_{i-1}) + (usedEnd - usedAfter_n)

Calibrated by LINEARITY (absolute MiB is not a known quantity — item 1361's "64 B per object" is
really 67.3, so its "128 MiB" was ~134.6), **one multiplier per PROCESS** because arms in sequence
grow each other's heap and resize the nursery:

```text
    MULT   1      2      4      8      16
    B/obj  81.6   81.2   80.6   80.3   80.1      flat to +-1% over 16x
    cross-check via nursery events agrees within 2-5%
```

**AND THE FIRST `gc` PerformanceObserver IN A PROCESS IS DEAD — the drain rule below is necessary
and NOT sufficient.** Measured: the first observer delivers **0 collections** across 14 reps while a
second and third in the same process deliver 5 and 2; with one `await` placed between `observe()` and
the window, the first delivers 3. Entries emitted before the hook installs are dropped silently. So
`MECH=gcshare` awaits a macrotask after observing, FORCES a collection it then subtracts (a
`global.gc()` over a 200,000-vertex graph is a full mark-compact and charging it to the window read
**112.5 ms of pause inside a ~75 ms window — 67% of a time it exceeds**), and THROWS if it cannot see
even that forced collection rather than printing a 0.0% share.

`gc-cost-probe.mjs` is the one that works: it put the write path at **17.6% GC** against the CPU
profile's 18.6% for the same shape — two instruments agreeing within a point, which is what makes
either trustworthy. It also found the split that changes the reading: **93% is MINOR scavenge**, and
minor cost scales with what SURVIVES the nursery, so when the thing being built is a graph the caller
keeps, this is promotion of the data structure and not eliminable churn.

**DRAIN A `PerformanceObserver` BEFORE READING IT.** Entries arrive in a queued callback, so a
fully synchronous rep loop buffers every one and `disconnect()` fires first — the probe's first
version reported **0 pauses and 0.0% GC** for a run profiling at 18.6% (item 1361).

**A `Graph` KEEPS ITSELF ALIVE UNTIL THE HOST YIELDS.** Its first write schedules
`setTimeout(this.notify, 1)`, and a pending timer holds `this.notify`, which holds the Graph. A
synchronous loop building many graphs retains all of them: heap 148 / 614 / 1242 MiB at 10 / 45 / 90
reps, and a 256 MiB cap OOM-crashes. Not a leak — one macrotask drains it — but a benchmark that
builds graphs in a tight loop is measuring a different heap than it thinks.

### Item 2418: NODE DOES EXPOSE AN ALLOCATION HOOK, and item 2416's claim that it does not was never verified

`HeapProfiler.startTrackingHeapObjects({ trackAllocations: true })` — DevTools' "allocation
instrumentation on timeline" — makes V8 record every allocation against its CALL SITE, and the
snapshot taken afterwards carries a `trace_tree` whose nodes hold a COUNT and a SIZE per site. That
is the same two numbers the Rust counting allocator reports, and it is a THIRD API, distinct from
the `startSampling` one item 2416 tried and the `--heap-prof` wrapper item 1361 condemned.

Calibrated to **2.00 allocations per element exactly** at 250,000 and 1,000,000 iterations, site
named by file and line, and its 80.2 B/element independently matches the churn meter's 80.1-81.6 —
two unrelated mechanisms agreeing, which is this directory's standard for trusting either.

Two defects it was caught on, both by the calibration rather than by inspection:
`stopTrackingHeapObjects` emits a SECOND snapshot (two concatenated JSON documents, `JSON.parse`
fails at position 6705966, which reads as corruption rather than as two good snapshots), and the
inspector's own chunk transport allocates INSIDE the window (`#onMessage` 44.01 MiB against the
engine's 1.96, turning ~103 B/element into a reported 4949.0). Counts were never affected; byte
totals were.

**What it found at once, which a byte total cannot say:** `projectRow` appears ~34,600 times for
20,000 elements in the ONE-hop aggregate and is ABSENT from the TWO-hop one.

```text
    shape                     allocs/element   B/element    top sites
    hop1    20k rows OUT           4.18           336.3     next, projectRow, values
    hop1sum  ONE row out           5.13           375.6     next, projectRow, values
    hop2    20k rows OUT           5.21           277.7     next, projectRow, values
    hop2sum  ONE row out           0.19             7.8     levelWalk, foldLevel -- NO projectRow
    hop1count  CONTROL             0.07             4.5     the closed form; proves a ~0 reading
```

**27x for the same aggregate one hop apart**, because the 2-hop path rides `chainFoldLevels` and
never builds a row — so item 467's prescribed fix is implemented in this engine at 2+ hops and
missing at one. The one-hop aggregate also allocates MORE than the shape returning all 20,000 rows
(5.13 against 4.18) while returning one. **No time prize: the aggregate is already 0.59-0.90x its
row form in wall clock, so the prize is the GC share, not the 27x.**

### Item 2419: PEAK LIVE memory — the quantity that decides what the system can answer AT ALL

Churn can be enormous and harmless, retained says nothing about the middle, and an allocation count
says nothing about how many are alive SIMULTANEOUSLY. A shape whose peak is CONSTANT in the walk can
answer any size; one whose peak grows has an OOM size, and that size is a property of the SHAPE.

**THE OBVIOUS INSTRUMENT IS REFUTED BY ITS OWN CONTROLS.** Differencing
`process.resourceUsage().maxRSS` between a graph-only child and a graph-plus-query child gave
`count(*)` — whose peak must be flat and near zero — readings of 2.9 / 0.9 / 4.0 / **-11.0** MiB. A
negative peak is impossible. The cause is structural: **the graph BUILD peaks at 164-532 MiB while
the query peaks at a few, so the query never moves the process high-water mark**, and subtracting
two ~500 MiB readings recovers their noise. **A high-water mark can only measure the phase that IS
the process's peak** — for a phase underneath an earlier larger one, scope the mark to the window or
measure a THRESHOLD instead (a threshold is immune: it is not a difference of two measurements).

Two mechanisms that do work:

- `MECH=highwater` — max `usedHeapSize` inside the window from `v8.GCProfiler`. A LOWER BOUND
  (accurate to one nursery), acceptable because a shape that HOLDS memory holds it across
  collections. Read the END-TO-END exponent, not the pairwise one: the linear control swings
  n^1.01 / n^-0.49 / n^1.96 pairwise and reads n^1.35 end to end.
- `MECH=cap` — the smallest `--max-old-space-size` the shape completes in, by bisection, differenced
  against a graph-only arm. Resolution 8 MiB, so a `0 MiB` row means "below 8".

```text
    shape                      peak live 25k -> 200k    growth     extra heap, 50k -> 200k
    hop1count  CONSTANT ctl       0.07 -> 0.07 MiB      n^0.00
    hop1       LINEAR ctl         2.20 -> 36.57 MiB     n^1.35
    hop1sum    ONE value out      5.64 -> 28.41 MiB     n^0.78     8 -> 16 MiB
    hop2sum    ONE value out      1.25 ->  0.83 MiB     n^-0.20    8 ->  0 MiB
    hop1collect                   9.15 -> 15.51 MiB     n^0.25     (legitimate: it IS a list)
```

**The one-hop aggregate has an OOM size and the same query one hop deeper does not.** Three
instruments now agree on that split from three different quantities (5.16 vs 0.15 allocs/element,
n^0.78 vs n^-0.20 peak growth, 16 vs 0 MiB of required heap) — so item 2418's target buys a
CAPABILITY rather than the GC share it was bounded at, and a capability limit is not bounded by a
GC percentage.

## The ISOLATED ROW BENCHES — for a sub-10% question on ONE row

| file                                | surface                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isolated-row-bench.mjs`            | one GQL row (`SHAPE=hopfilter NODES= REPS= DROP=`)                                                                                                                                         |
| `isolated-gremlin-bench.mjs`        | one Gremlin row (item 1368)                                                                                                                                                                |
| `hop-proj-isolated-probe.mjs`       | one hop PROJECTION row, `SHAPE=hop1id                                                                                                                                                      | hop2id | hop1values        | hop2values`, rows asserted and the fixture's DISTINCT out-targets checked (item 1769). Overlaps `isolated-gremlin-bench.mjs`; prefer that one unless you need the row-count assertion |
| `properties-getter-probe.mjs`       | `v.properties` / `v.labels` / `v.id` on REAL vertices, random order, boxes pre-warmed, `NODES=` sweepable — the instrument that found items 1770-1772's cost to be scale (items 1772/1773) |
| `far-identity-probe.mjs`            | does a fused hop yield the CANONICAL `Vertex` per id, or fresh instances? (item 1770)                                                                                                      |
| `gremlin-hop-floor-probe.mjs`       | the Gremlin hop FLOOR, three arms (item 1411)                                                                                                                                              |
| `gremlin-multitype-floor-probe.mjs` | why `out('E','F')` costs 1.86x `out('E')` — six arms, `ARM=` (item 1441)                                                                                                                   |
| `gql-filtered-hop-floor-probe.mjs`  | how far the FILTERED GQL hop is above a hand floor — seven arms, `ARM=` (item 1444)                                                                                                        |
| `id-lookup-scaling-probe.mjs`       | is get-by-id O(1)? engine vs a raw `Map`, `MODE=hit                                                                                                                                        | seq    | miss` (item 1451) |
| `write-floor-probe.mjs`             | is a TS write's cost the QUERY LAYER or the CORE? three arms, `ARM=`/`OP=` (item 1457)                                                                                                     |

**A HAND FLOOR BRACKETS; IT DOES NOT ATTRIBUTE** (item 1448). `gql-filtered-hop-floor-probe.mjs`
correctly says `hopfiltyield` is ~1.9x off and that `engine-bare` is AT its floor — both useful, and
both are "how far off". Its component arms are a different matter: the step from
`floor-engine-shaped-poly` to `floor-pred-poly-row-direct` is 120 ns/row in the probe and **0 in the
engine**, measured twice with two different wirings (items 1447, 1448). The arms were built by adding
plausible costs until the total matched, which makes the bracket trustworthy and the attribution
worthless. So CLAUDE.md's "a share is a nomination; an ablation is the price" has a next layer: **an
ablation in a HAND FLOOR is still only a nomination for the engine.** Ablate in the engine — or
better, find the spelling pair that already isolates the term: `hopfiltyield` against
`hopsingleyield` is the predicate's price (61.47 against 26.78, **57% of the row**) and needed no hand
arm at all.
| `gql-undirected-floor-probe.mjs` | the GQL undirected hop, five-arm ablation (1414) |
| `cross-engine-chain3-probe.mjs` | GQL vs Gremlin, one graph, one arm per process (1426) |

**`hop-projection.ts` CHARGES A TOLL, so price a target against ~10% before attempting it**
(items 1413 and 1415). Two independent changes there — a dedupe skip and a per-row `EvalEnv` hoist —
had flat-to-small targets (−0.5%, +2.3% at degree 1) and each made rows on walks they CANNOT REACH
**3.4-5.8% slower**, with concordance against them (28/81, 12/81). The controls moved against the
change, so this is not a control flattering a target; it is the file. Every item that succeeded here
clears 10% easily (1408 at 26.8/42.1%, 1409 at 55.7/79.8%, 1410 at 31.2/49.1%) and both that failed
are under it. Put two per-edge walks the change cannot reach in every A/B on this file, and treat a
sub-10% nomination as already declined.

Per-rep timing, `p25` headline, full distribution, GC accounted, answer in the output so a driver can
assert the arms agree.

**`gcMs` IS 2-3x NOISIER THAN `p25`, so never read it as a share from one run** (item 1421). And when it DOES
move, read it as an OBJECT COUNT and not as bytes (item 1424): removing ~100,000 small per-slot
arrays took it **148 → 14.2**, while removing **1.6 MB** in two large typed arrays took it 14.2 →
14.3 — twice the bytes, four orders of magnitude fewer objects, no effect. Large typed arrays land in
large-object space and are cheap to collect, so an allocation hunt should count allocations, not
sizes. It is
a SUM over all reps while `p25` is one rep, so it is not a share to begin with — and it is far less
stable. Six processes on one build:

| row          | `gcMs` spread         | `p25` spread          |
| ------------ | --------------------- | --------------------- |
| `sortedpage` | 5.4 - 17.7 → **3.3x** | 4.25 - 5.61 → 1.32x   |
| `varlen14`   | 12.8 - 16.7 → 1.3x    | 28.49 - 32.08 → 1.13x |

The noise is shape-dependent: biggest on SHORT rows, where one collection landing inside or outside
the window moves the total by a third. `sortedpage` was nominated this session off a single 18.2 ms
reading that looked like ~29% of its wall time, and it was the top of that range — the row is already
a bounded top-K walk and had nothing to fix.

Used the other way it earned its keep: `chain4` read 11.8-14.2% CONSISTENTLY across runs and items
1417-1418 drove it to 1.4%. So the rule is the usual one — repeat it before believing it — and `gcMs`
needs more repeats than `p25` does, not fewer.

**THE EQUIVALENT-SPELLING PAIRS, which is the design that found the 110x.** Both benches carry a
`MULTILABEL` knob and a pair of shapes that select the IDENTICAL edges by different routes — GQL
`hopsingle`/`hopmulti` (`-[:E]->` against `-[:E|F]->`, item 1375) and Gremlin
`edgesingle`/`edgemulti` (`outE('E')` against `outE('E','F')`, item 1378). Every edge carries `E` and
a fraction also carry `F`, so the answer is fixed and only the route varies.

Two things make that knob load-bearing rather than a convenience:

- **`MULTILABEL=0` is the control that tells a GAP from a correct DECLINE.** With no two-label edge,
  `bucketSumsAreSound` licenses the fast path for the disjunction too and the pair is equally fast;
  the difference only appears when the dedupe is genuinely required. Item 1375 nearly filed a **5000x
  "spelling gap"** against a planner that was behaving correctly, and this arm is what refuted it.
  **Vary the property the guard keys on before calling a cost difference a gap.**
- **A fixture where EVERY edge carries both labels proves nothing.** A walk that deduped nothing and
  one that deduped everything agree on it. The fraction has to be partial, which is what makes the
  sum (6) differ from the union (4) in the tests at items 1377 and 1379.

**THE NOISE IS PROCESS-LEVEL, SO NO ESTIMATOR FIXES IT.** Replacing the loop-total with CLAUDE.md's
own median-of-14 moved the floor from 12% to 13.2% — no better (item 1367). Each process builds its
own fixture and gets its own heap layout, and that offset applies to every rep in it. **The unit of
sampling is the PROCESS**: `p25` within one, many processes per arm, arms interleaved.

**A LONG ROW MEASURES 4-5x BETTER THAN A SHORT ONE.** The Gremlin 3-hop row is ~300 ms a rep and
has a 2.9% floor; the GQL hop-filter row is ~3.5 ms and has 13.2% (item 1368). **Pick a fixture size
that makes the row long before adding reps.**

**RECORD THE CONCORDANCE, NOT JUST THE RATIO — n=8 WOULD HAVE SHIPPED A NO-OP.** An
answer-preserving four-line fast path read **+2.6% faster at n=8** and **−0.3% at n=24** (item 1367).
What stopped it was counting pairs: 43 of 64 favoured it, where 32 is chance. "Two medians 2.6% apart
with overlapping distributions" invites shipping; "43 of 64 pairs" does not.

**AND n=8 IS SIGN-UNSTABLE BELOW ~3% ON A ~300 ms ROW — three independent demonstrations, in both
directions, on targets AND controls:**

| item | what was measured                     | n=8       | n=24       |
| ---- | ------------------------------------- | --------- | ---------- |
| 1367 | `FAST1`, the TARGET                   | **+2.6%** | **−0.3%**  |
| 1374 | `walkBucket`'s CONTROL                | **−0.7%** | chance     |
| 1380 | the union count's `hopcount3` CONTROL | **−1.8%** | **+0.96%** |

So on this row **n=8 cannot establish the SIGN of an effect under about 3%**, let alone its size, and
a control that appears to move at n=8 is not evidence of a file-edit tax. Item 1367 established that
the noise is PROCESS-level and no within-process estimator removes it; this is the magnitude below
which the process COUNT is inadequate too. Three of this session's readings had to be redone for it.

**QUOTE p OR THE PAIR COUNT, NOT A RATIO ALONE.** Item 1380's +0.96% at n=24 looks like a small
win and is not one: U = 351 against an expected 288 with SD 48.5 gives z = 1.30, p ≈ 0.19. "No
detectable difference" is a result and should be written as one.

**`p25` PER PROCESS, MEDIAN ACROSS PROCESSES — a MEAN inverts verdicts.** Item 1380's faster arm
carried outliers at 350.31 and 324.15 where the slower arm's largest was 320.17, so a mean reads the
faster arm as a regression. Print the distribution beside the summary; a bimodal series summarised is
a lie, and this is the shape it takes.

**WITHIN one interleaved run, n=24 resolves ~1%; ACROSS runs the absolute level drifts ~3%.**
Compare arms inside a run; never against another run's number.

**EXTRACT THE BASELINE WITH `git show <ref>:<path>`, DO NOT RECONSTRUCT IT.** Item 1380's BASE came
from `git show HEAD~1:…`, which is the pre-change engine verbatim; a patch-reconstructed arm can drift
from the committed diff. Assert that both arms share every OTHER change you are not measuring — 1380
checked `walkBucket` appeared 4 times in both, without which it would have measured two items at
once.

## More bespoke probes

| probe                               | question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prop-bag-regime-probe.mjs`         | WHY the property read grows with size — and three refutations (item 1363/1364)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `engine-bag-shape-probe.mjs`        | does bag SHAPE reach the engine? **1.11x — no** (item 1364)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `token-drain-probe.mjs`             | `drainMutations`' duplicate-token array vs a count map (item 1360)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ordinal-churn-probe.mjs`           | what DELETES cost a never-reused dense ordinal (item 1372)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `keyed-load-micro.mjs`              | freeze x key-constancy x access ORDER x bag COUNT on synthetic bags (item 1770/1771). A MICRO: items 1770-1773 showed it cannot reach the engine's regime — see `prop-bag-regime-probe.mjs` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `chase-depth-micro.mjs`             | does dependent-load DEPTH explain the per-row read? **No — saturates at 18-20 ns at depth 4, in BOTH `ALLOC=interleaved` and `ALLOC=scattered`** (items 1771/1773)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `frontier-order-probe.mjs`          | holding ONE graph fixed, how much of a chain walk's cost is VISIT ORDER? (item 1816) Four arms — `dfs` (what `descend` does), `level` (materialize each frontier), `sorted` (frontier sorted by insertion index), `blocked` (level-synchronous in a reused `BLOCK=4096` window). **SORTING LOSES EVERYWHERE** (0.14-0.67x; the sort costs more than the locality it buys) and the UNBLOCKED frontier loses 1.4-1.7x at 200k on a cache-friendly topology, while `blocked` wins 1.49-2.79x where locality is poor and ties where it is good. Its `ordinal` key is captured at build time and EXCLUDED from the timed region, so a `sorted` win would have been an optimistic ceiling — it did not win, so that caveat never had to be cashed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `param-support-probe.mjs`           | **WHICH PARAMETER SPELLINGS DO BOTH ENGINES ACCEPT?** (item 1817) Twenty spellings — param on each side of `=`, inline `{k: $v}`, `IN $list`, `LIMIT`/`OFFSET`/`SKIP $k`, date/null/bool params, a missing param, a param inside `EXISTS {}`. Built because the differential fuzzer passed NO params at all and could not have: its `run` took only the query text, so the whole parameterized surface — the one the planner SEEKS on — had zero byte-identity coverage. Run it BEFORE adding a parameterized shape to any generator: a spelling one engine rejects makes the fuzzer red for a known question rather than for a regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **19/20 agree. The twentieth is a live divergence**: `SKIP $k` raises `E_SYNTAX` in TS (its parser allows a param only after the ISO `OFFSET`) and native accepts it. Pinned in `skip-param-divergence.test.ts`; `OFFSET $k` is generated instead |
| `workload-family-probe.mjs`         | **IS EVERY REALISTIC-WORKLOAD FAMILY VALID AND NON-VACUOUS?** (item 1817) Per family: how many draws parsed on each engine, how many returned ROWS, how many agreed, and how many distinct texts. Two silent failures it exists to catch — a family whose text does not parse errors on BOTH engines, which the differential reads as agreement; and a family that parses and matches nothing compares `[]` against `[]`. Run it after touching `workload-queries.ts`, before trusting a fuzzer run over it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | all 17 families parse, match and agree; 6,800 draws, 0 divergences. It also caught the item's own worst bug — with a `throw` in the chain rung it printed `chain-rows BROKEN`, which is how the rung was shown REACHED at all                     |
| `chain-depth-locality-probe.mjs`    | is a chain hop's marginal cost flat in DEPTH, and is a depth effect the ENGINE or the FIXTURE? **THE FIXTURE** (item 1815): depth x stride x working-set grid. Under a depth-invariant `chain` walk the rung is flat — 200k-node depth-1 `[12.3, 23.2]` ms OVERLAPS depth-4 `[20.2, 28.7]` — while the profile probe's own compounding `(7i+3)` stride goes 11.2x over the same span. Its row guard SCALES with N (`rows === N * reps`, valid only because every stride here is FUNCTIONAL), which is what let the size sweep run at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `correlated-call-probe.mjs`         | what does an inline `CALL` cost against the query it is EQUIVALENT to? (item 1818) Its value is the EQUIVALENCE ASSERTION, not the timing: it refuses to print a ratio for a pair whose two spellings disagree, and that fired on its first run — a bare `CALL { MATCH (n)… }` answers `outer x bodyRows` (1,250,000 against 2,500 at N=500) because ISO's unscoped form imports NOTHING, so `n` inside is a fresh variable. The floor was wrong, not the engine. The two tails need DIFFERENT floors for different reasons (a ROWS body's floor is the hop; an AGGREGATE body's is the OUTER pattern alone, since it emits one row per outer row whatever it matched)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | correlated ISO `CALL (n) { … }` **0.56x its floor — already fast**, which is what made item 521's "~3 µs an outer row" note stale                                                                                                                 |
| `uncorrelated-call-reuse-probe.mjs` | is an uncorrelated `CALL` body re-run per outer row, or run once with expensive plumbing? **A TOTAL CANNOT TELL THESE APART AND NEITHER CAN THE PROFILE** (item 1818) — a body run once still shows `matchPattern`/`seedVertices` frames, just as a small share of a large total, so `callinline`'s 633 ms was read as per-row matching. The instrument is to scale the two sides INDEPENDENTLY: vary the outer row count with a filter while the body is held fixed, then make the body cheaper while the outer count is held fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **run ONCE**: flat in the outer count (1 row 0.81 ms, 207 rows 0.99) and the per-row term is BODY-INDEPENDENT (12.01 -> 10.71 ms on a cheaper body), so ~550 ns a row is plumbing                                                                 |
| `addedge-callcount-probe.mjs`       | **HOW MANY TIMES does `addEdge` call each by-id lookup, and what does the lookup actually cost?** (item 1819) Built because a SHARE could not answer it: `addEdgeOnly` profiles `getEdgeById` at **16.8% self = 312 ns a call**, and the same function priced directly reads **30 ns** — a one-line `Map.get` cannot be both, so ~280 ns is inlined callee work V8 hung on that frame (`frame-attribution-trap`, 5th instance). It wraps the class-field arrows on ONE instance and tallies CALLERS, which is what located the real redundancy. It asserts a non-zero count, because if those lookups ever move to the prototype the wrapper silently counts nothing and a clean zero would read as a finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `getEdgeById` 1.000/edge at 30 ns; `getVertexById` **4.000/edge** — 2 load-bearing, 2 from the self-loop test. Halving it measured **0.999x** and was reverted                                                                                    |
| `workload-perf-screen.mjs`          | **WHICH REALISTIC QUERY SHAPE IS EXPENSIVE?** (item 1820) Times item 1817's 17 workload families at a size the fuzzer never runs them at, over the same schema and value domain so every literal stays selective. It is the one corpus here NOT assembled by someone hunting a lever, which is why it can find a shape nobody suspected. ONE CHILD PROCESS PER FAMILY, because a comma join materializes 25M rows at 5,000 vertices and an OOM kill arrives as a SIGNAL, not an exception — no try/catch survives it, so the measurement must be in a process you can lose. READ `empty%` FIRST: a family whose queries stopped matching at scale is the "fastest" row on the screen. ns/row is NOT comparable across families                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | found `RETURN DISTINCT` over a 3-hop chain at **5.8x the cost of emitting all 625,000 rows it dedupes** (item 1820, open)                                                                                                                         |
| `rung-gap-screen.mjs`               | **WHERE DOES A SHORTER OR SIMPLER QUERY COST MORE THAN A LONGER ONE?** (item 1823) A depth x modifier grid with two flags: NON-MONOTONIC IN DEPTH (item 1822's signature) and PAIR GAP, a modifier costing much more than its own `rows` twin (item 1821's lesson as a rule — `DISTINCT` can only be the walk plus a hash). A BETWEEN-RUNGS GAP IS INVISIBLE TO EVERY OTHER INSTRUMENT HERE: each rung's tests pass, and the general matcher is not a hot frame — it is the ABSENCE of a rung, and absence has no frame. `FANOUT=1` so every depth returns the same row count and a depth difference is ROUTE, not fixture (item 1815). `FLOOR_MS` exists because its first run flagged a 2.0x between two sub-millisecond closed-form counts — a ratio needs an absolute magnitude **SINCE ITEM 1826 IT SCREENS GREMLIN TOO** (`ENGINE=gremlin`), which 1823 advertised without building — a usage line for a knob that does nothing reads as coverage. Gremlin flags NOTHING (flat in depth on every row), and the CROSS-ENGINE marginal reading found what neither single-engine flag could: GQL's `ORDER BY` marginal is **42-55x Gremlin's past one hop**. A THIRD FLAG exists for it — `DEPTH_FLAG` only fires when a shallower cell costs more (this rises monotonically) and `PAIR_FLAG` excludes `orderby` BY DESIGN, so two individually-correct exclusions hid a 36x. The flag is on the MARGINAL over the same depth's `rows` cell, compared across depth: sorting N rows costs the same whatever walk produced them | 6 flags first run: multi-column `DISTINCT` at ONE hop is **22.7x its own twin and 3.3x the DEEPER cell**, and `count(DISTINCT)` is 4.8-10.3x across depths 2-5 (both open)                                                                        |
| `chain-walk-order-probe.mjs`        | **DOES THE CHAIN RUNG EMIT ROWS IN THE SAME ORDER AS THE GENERAL MATCHER?** (item 1831) The blocker for `sum`/`avg`/`collect`: those are order-sensitive (the first two in the last ulp, `collect` outright) and items 419/551 settled this for the ONE-HOP rung only. Its oracle is a spelling VERIFIED to decline by asking `compileLinear` — `LIMIT 100000000` fires no rung and returns every row in the general path's order. It checks BOTH internal branches, and the SWEEP was proved live by deletion (a `throw` in `sweepBlock`: far-end-only and far-`WHERE` reach it, start-reading takes the walk) — without that it would have tested the walk twice and reported a clean result for the sweep. A MATCH PROVES NOTHING UNIVERSAL; a mismatch settles it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **25 cases, 5 fixture shapes, both widths, identical row SEQUENCES every time** — evidence that the orders agree, not proof                                                                                                                       |

`prop-bag-regime-probe.mjs` closes three levers with numbers, so they are not re-attempted:
megamorphic bag shapes cost **nothing at 200k** relative to one hidden class, `Object.freeze` is
**free at every size**, and a `Map` per element is **3.18x WORSE**. The one thing that wins is a
`Float64Array` column — **3.55x and FLAT in size** — which is the layout lever, i.e. a data-model
change, not a local one.

**IT ALSO VIOLATED ONE-SHAPE-PER-PROCESS AND INVERTED ITS OWN TABLE** (item 1364). Its five arms
shared ONE read function in one process, so the megamorphic arm polluted the inline cache for every
later arm AND every later size. `ARM=<name> SIZE=<n>` is the mode to trust; the all-arms mode is kept
only to demonstrate the pollution. Item 1363 had defended the bad numbers as "reproducible across
three processes" — and all three ran the same polluted order. **A repeat only buys independence from
what it actually varies.**

`ordinal-churn-probe.mjs` carries the sharpest fixture trap in this directory. Its first version put
the live vertices at slots `0..LIVE-1`, contiguous at the start of the ordinal space, so the walk
touched LIVE ADJACENT cache lines however large the arrays were — and churn measured **free**,
non-monotonic, indistinguishable from the control. Interleaving the churn between live insertions
moved the same question to **6.18x at 200k churn and 11.34x at 1M**. **The cost of an oversized
zero-initialised typed array is in the pages you TOUCH, not the pages you allocate**, so any fixture
that keeps the touched set contiguous reports slot-space growth as free. `SPREAD=0` restores the old
layout so the difference stays visible rather than taken on trust.

**`FANIN` IS A LOAD-BEARING KNOB ON BOTH ISOLATED BENCHES, and a row measured only at the default
can be measuring the wrong thing entirely.** It sets how many DISTINCT far endpoints the edges reach:
`FANIN=1` (the default on both) gives every vertex in-degree 1, `FANIN=0.01` concentrates them onto
`NODES/100`. Two items needed it for opposite reasons and neither could have been settled without it.

- Item 1390 priced `farDrivenHopWalk`'s `projectRow` hoist, which has NOTHING to amortize at
  in-degree 1: unconditionally far-driven it measured **86.1 ms against the start-driven 69.3** at
  `FANIN=1` and **16.1** at `FANIN=0.01`. Judged on the default fixture alone it is a refutation.
- Item 1392 separated the per-row property read's two possible mechanisms. At `FANIN=1` the
  `far.properties` accessor is **42.967 ms** of a 61.197 ms read; at `FANIN=0.01` it is **1.990 ms**
  — **21.6x** — while the no-read control arm is FLAT across both (77.6 against 79.7). So the cost is
  the pointer chase to a cold far vertex, not the accessor's code, and there is no per-row lever
  there at all. Item 1066 had measured the same family at 9.3x from the other direction.

So: sweep `FANIN` for anything that touches a far endpoint, exactly as CLAUDE.md says to sweep the
SIZE. A per-vertex cost and a per-edge cost scale differently, and so do a hot far pool and a cold one.

**AND READ ITEM 1392 BEFORE PRICING A PER-ROW PROPERTY READ AT ALL.** Items 1770-1773 spent four
items re-deriving its conclusion — the cost is the cold pointer chase, not the accessor's code, and
there is no per-row lever — having gone to a synthetic micro instead of this file. Item 1774 records
the accounting. `prop-bag-regime-probe.mjs` above already closes the freeze and the bag shape, and
already prices the layout lever at **3.55x and flat in size**.

**`FANOUT` IS THE OTHER HALF, and the GQL bench did not have it until item 1401** — so every GQL
number before that item came from a fixture with out-degree exactly 1, one permutation cycle, no
self-loops and no parallel edges. That degeneracy hid a CORRECTNESS difference, not merely a cost
one: at item 1399 removing the depth-4 endpoint-mask gate measured "correct and 9.9x faster" on it and
answers **−3** on randomized multigraphs (item 1400), because the structures the trail correction
exists for were all absent. `FANOUT=1` reproduces the old fixture byte-for-byte (verified by digest),
so the knob costs nothing to leave alone — and anything about a hop, a dedupe or a path quantifier
should be read at `FANOUT=4` as well. Two things it has already settled: the equivalent-spelling
symmetry from items 1382-1388 HOLDS at degree 4 (1.01x and 1.02x), and the quantifier-vs-chain pair
stops being a spelling pair there (799,996 against 800,000 — trail semantics, legitimately).

**`MULTILABEL=-1` IS THE THIRD KNOB, and it is the COMMON case** (item 1405): `E` and `F` DISJOINT,
no edge carrying both, which is what a real schema has and what every multi-type row here lacked.
It matters because `typeEdgeCount` sums the named buckets, so overlapping types make the degree
estimate a 1.33x over-count at `MULTILABEL=3` and up to 2x — and that bias decides which side of
`FAR_DRIVEN_MIN_DEGREE` a given true degree lands on. On the disjoint fixture the estimate is exact
and the crossover is an integer: the far-driven walk **loses 16.9% at true degree 2 and wins 25.1% at
true degree 3** (144/144). At the SAME true degree 2 the overlapping fixture WINS 7.2% — opposite
sign — so the per-vertex bucket structure is a second factor the gate's one scalar cannot express.
Sweep `MULTILABEL=-1` alongside `3` for anything that reads a degree estimate or walks per-type
buckets. (`0` still means "no `F` at all", the control that separates a routing gap from a correct
decline.)

**THE GREMLIN BENCH NEEDED THE SAME KNOB AND DID NOT HAVE IT UNTIL ITEM 1413 — and its absence
cost a reading there too.** At `MULTILABEL=0` every edge is `['E']`, so a two-label hop walks an `E`
bucket and an EMPTY `F` bucket: nothing that happens in a SECOND bucket can be measured at all.
Item 1413 priced the multi-type walk's earlier-buckets dedupe against exactly that cell and got 5.5%
with a control moving 4.8%, because in both arms the scan never executed. Re-run on `-1` it was
**−0.5%** and the item was declined.

So the rule is now a rule about both benches: **a two-label row measured at `MULTILABEL=0` is
measuring one bucket.** Same missing shape, found twice, the second time after it had already cost a
reading — which is the argument for sweeping the knob rather than picking a value.

**AND THE KNOB CUTS BOTH WAYS: `MULTILABEL=-1` makes every MULTI-HOP chain row answer ZERO**
(item 1416). `-1` halves the `E` edges, so a 3-hop chain needs three consecutive ones and at
out-degree 1 there are none. A whole ranking of the non-hop GQL rows was taken that way and timed
dead paths — `chain3` read 21.5 ms with `c=0`, and 47.1 ms with `c=100000`. So: `-1` for a ONE-HOP
type question, never alone for a multi-hop count, and **read the `answer` field before the timing**.
A zero answer is the loudest form of "an answer invariant to what you varied cannot validate the
fixture" and it still took a second look to notice.

## HOW TO RUN ONE, which is not optional detail

**ASSERT THE ARM FROM THE FILE ON DISK, not from the variable you just built — and do it before you
measure anything.** Every A/B driver here checks the marker count after copying an arm into place,
and that rule has caught the mistake it exists for. The gap it did NOT cover, until item 1391, is the
in-place edit that PRECEDES the driver: a patch script that applies several replacements to a string
and writes once at the end discards all of them if any later assertion throws. At item 1391 a doc
anchor failed after the code replacement had already succeeded in memory, so nothing reached disk —
and the next twenty minutes were spent measuring HEAD against itself, reading a 1.10x asymmetry out
of it and drafting a refutation. Two things caught it and neither was attention: a `grep -c` of the
new symbol returned 0, and the DRIVER refused to start ("working tree is not the HAND arm"). So:
write, read the file back, count the marker, and only then build. A patch script should assert on
what it can re-read, not on what it computed.

**One shape per PROCESS, and repeat the PROCESS rather than adding rounds.** Four separate readings
in a single pass were inverted by ignoring this:

- rounds inside one process warm UNEQUALLY between arms and flipped a 2.5x comparison's SIGN
  (item 1320);
- a sweep running every case and size in one process produced a clean, monotonic, entirely false
  "superlinear" trend (item 1321);
- a probe warmed the memoizing adjacency field it was measuring, making a REJECTED lever look like
  a 5.2x win (item 1323, and item 355 documents the same defect in the same function);
- a ratio between TWO sizes read as superlinear where five sizes are flat (item 1325).

So: fresh process per arm, discard the first half of the reps, take the median, repeat the process,
and print the DISTRIBUTION rather than a summary. A result that is self-INCONSISTENT — two
different scalings for one plan — is the tell, not a noisy-looking number.

**And a verdict needs evidence of EXECUTION.** A summary that prints "the invariant holds" over an
empty table is worse than no probe. `index-never-hurts-probe.ts`'s caller exits non-zero with
`DID-NOT-RUN` when there are no result rows, after exactly that false pass (item 1324). Note also
that zsh does NOT word-split unquoted `$VAR`, so `for a in $ARMS` iterates ONCE over the whole
string; use `while IFS= read -r`.

### `hop-multi-agg-floor-probe.ts` — the single-aggregate FLOOR the bench does not carry

`ARM=pair-str|single-str|pair-num|single-num|pair-dict|single-dict|countkey|scan-str N= DEG=`

The three `hop min+max over a string / dict / number [wide multi-agg]` bench rows are **native
watchers** (item 1184) with no TS floor beside them, so their 37-49x is not readable as a TS target.
This probe supplies the floor and the null control. It established, at item 1343, that the TS
multi-aggregate ROUTE IS FINE (a pair costs 1.07-1.10x its single, so item 1184 must not be ported)
and that the real lever is a **per-vertex hop constant** of ~400-520 ns.

Two traps it exists to defuse, both of which caught me:

- **Sweep DEG, not just N.** A hop `min`/`max` is FLAT IN EDGE COUNT (far-driven: one visit per
  distinct far vertex). An N sweep at fixed degree moves vertices and edges together and cannot
  tell a per-edge cost from a per-node one. I recorded the wrong mechanism before the DEG sweep.
- **`count(*)` is not a floor here.** It is answered by a degree sum that never enumerates an edge
  (item 1183). The probe warns on any sub-millisecond median for that reason; a per-edge floor must
  read a property, which is what the `countkey` arm is for.

**`gremlin-hop-floor-probe.mjs` — the three-arm floor, and why the middle arm is the point.** An
`engine`-vs-`floor` probe tells you a traversal is 2.1x a hand-written loop and leaves you unable to
say what to fix. The third arm — the identical body as a GENERATOR, drained — splits that number in
two: `genfloor/floor` is the generator PROTOCOL and `engine/genfloor` is the pipeline on top of it.
At item 1411 those read **2.14x** and **1.00x**, which closed the pipeline as a target in one
reading. Build the middle arm whenever a profile blames a frame that is a generator body; without it
the share and the floor agree and still name nothing.

**And re-run a suspiciously exact tie as separate PROCESSES.** That run first reported engine and
genfloor at 35.73 against 35.73 — identical to 0.01 ms, which reads like the two arms being the same
code. Three independent processes gave 34.02/34.58, 33.91/33.39 and 36.00/34.77: the tie was p25
luck. Cheaper than reasoning about it, and the alternative is reporting an aliasing bug that is not
there — or missing one that is.

**`gql-undirected-floor-probe.mjs` — a five-arm ablation, and why the extra arms earn their keep.**
Two arms (engine, floor) tell you a row is 1.39x a hand walk and leave you unable to say what to
fix. Removing one thing per arm — the property read, then the row object, then the second pass —
splits that floor into its parts, and at item 1414 the split CONTRADICTED the profile: `propOf` +
`get properties` read 36.5% of engine time, but the property read is **25.2% of the floor** while
the bare adjacency walk is **59.8%** — work no projection change can touch. Build the extra arms
whenever a profile nominates a frame inside a loop you could also just write by hand.

**Check the arms that claim the same answer, and check the odd one against its own
expectation.** This probe's `onePass` arm deliberately returns half the rows, so it cannot join the
equality check — but "excluded from checking" is how an arm silently stops doing what it says. It is
asserted to be a strict, non-empty subset instead.

**THE FIXTURE'S SUCCESSOR FUNCTION IS WORTH ~2x, AT THE SAME DEGREE** (item 1426). Two instruments
in this directory disagreed **1.91x** on the identical 3-hop count with the identical answer, because
`isolated-row-bench.mjs` builds `to = (i * 7 + 3) % N` — a vertex points ~7 slots along, partly
cache-resident — while the cross-engine probe's default is `to = (k * 104729) % N`, effectively
random across the range. Both are permutations, so out-degree and in-degree are exactly 1 either way.
Measured: **1.93x (GQL), 2.06x (Gremlin)**.

Item 1066 priced this family at 9.3x over far-pool WIDTH; this is the same effect at fixed width and
varying STRIDE. So **the bench's chain rows are ~2x optimistic against a random graph**: A/B ratios
are safe (both arms share the fixture) and ABSOLUTE ns/row figures are not. Quote them as
"on this fixture", and sweep the stride before claiming a general result.

**THE TWO ISOLATED BENCHES HAVE OPPOSITE STRIDE DEFAULTS, AND THAT IS DELIBERATE** (item 1439).
`isolated-row-bench.mjs` defaults to `small`; `isolated-gremlin-bench.mjs` defaults to `random`,
because its edge builder was hardcoded to the random form before it had a knob at all. Each keeps the
default its own recorded figures were measured against — changing either silently invalidates its own
history — so **a cross-bench ratio taken from both defaults compares different graphs** by the ~2x
above. Pass `STRIDE` explicitly on BOTH when comparing engines, or use `cross-engine-chain3-probe.mjs`,
which holds one graph for both.

On the Gremlin bench the stride is worth more than the cross-engine probe's 2.06x suggested, now that
the main bench can vary it: `hopcount3` **90.65 → 41.84 ms (2.17x)** and `hopbare`
**21.60 → 4.05 (5.3x)** going from `random` to `small`, same answers.

**AND `STRIDE` ON THE GREMLIN BENCH WAS SILENTLY IGNORED BEFORE ITEM 1439.** It was not a knob, so
setting it measured the default while the driver believed otherwise — item 1431's trap, whose recorded
fix is to have the driver assert the value back. That was impossible here because the bench emitted
neither `stride` nor `rowCount`. Both are emitted now (along with `multilabel`/`vlabel`), so
**assert the fixture fields off every reading** rather than trusting the environment you set.

**WHEN A FILE PERTURBS MORE THAN THE EFFECT, MEASURE OUTSIDE THE FILE** (item 1441).
`packages/gremlin/src/executor/hop-values.ts` moves unrelated branches **~16%, in an arbitrary
direction**, on any edit: item 1413 saw two controls REGRESS 3.5% and 5.8%, item 1440 saw one
"improve" 16.3% at 4/4 while no target cleared 8%. That is not statistical noise — more rounds do not
average it out, because it is a repeatable consequence of the edit. `gremlin-multitype-floor-probe.mjs`
is the answer: hand floors price the SHAPE instead of the diff, need no edit, and additionally settle
whether a reverted change was right (item 1440's was — its lean arm measured IDENTICAL to the
array arm, 11.81 both). The same caution applies to `hop-projection.ts` on the GQL side, where item
1415 measured the toll at 3.4-5.8% and the standing rule is that a target there must be worth ~10%.

**A FORWARD-vs-`both` PER-ROW COMPARISON IS ONLY MEANINGFUL AT RANDOM STRIDE** (item 1443).
`small` stride privileges the SUCCESSOR direction (`to = (i * 7 + 3) % N`, a near neighbour), while
`both`'s second pass reads the PREDECESSOR — the inverse permutation, scattered. So `hopbothyield`
reads **3.35x `out('E')` per row at `small` and 0.98x at `random`**, with the engine at or below a
hand floor in both. Same-direction comparisons (`out` vs `out`) stay sound either way; it is only the
cross-DIRECTION ones the fixture biases. Item 1392 found the same locality effect over fan-in and
closed it as having no per-row lever.

**EVERY FIGURE IN THIS DIRECTORY'S RECORDS IS A 100k FIGURE UNLESS IT SAYS OTHERWISE** (item 1452).
A 10x size increase costs **9.6x to 31.3x** depending on the row, i.e. per-row cost rises **1.2-3.1x**
from 100k to 1M nodes:

| row                      | 100k  | 1M      | ratio     | per-row |
| ------------------------ | ----- | ------- | --------- | ------- |
| `hopfiltyield`           | 68.65 | 829.16  | 12.08x    | 1.21x   |
| `hopsingleyield`         | 26.69 | 472.66  | 17.71x    | 1.77x   |
| `chain3`                 | 90.40 | 1580.90 | 17.49x    | 1.75x   |
| `chain4`                 | 78.51 | 1590.86 | 20.26x    | 2.03x   |
| `quant44`                | 50.92 | 1590.98 | 31.25x    | 3.12x   |
| `grouped` / `sortedpage` |       |         | 9.6-10.5x | linear  |

A/B RATIOS are unaffected (both arms share the fixture), so conclusions hold; ABSOLUTE ns/row does
not. Two consequences worth knowing before quoting either: `chain3`/`chain4`/`quant44` all converge on
~1585 ms at 1M because they become footprint-bound, so **`quant44`'s 1.54x advantage over `chain4` at
100k does not survive the sweep** — a routing choice tuned at 100k is tuned on the wrong side of the
cache transition. And `quant44`'s growth is the outlier because its **GC goes 7.0 → 401.9 ms**, the one
superlinear term in the sweep that is allocation rather than cache.

**`gcMs` NEEDS REPETITION BEFORE IT NOMINATES ANYTHING; `gcCount` IS THE CHEAPER TELL** (item 1456).
Both isolated benches print one `gcMs` beside a `p25`, and the two are not equally trustworthy. On
`hopcount3` at 1,000,000 nodes, five runs of the same binary: `p25` 1313.8-1341.2 (stable to 2%),
`gcCount` 93-98 (5%), and **`gcMs` 252.4, 254.9, 259.0, 506.8, 705.0 — a 2.8x range**. The 705.0
reading made GC look like 53% of the query and nominated a target that does not exist; a profile of the
same row put GC at 9.71%.

The honest figure there is 24.8x growth from 100k to 1M (255 against a stable 10.3), which decomposes
into **8.6x more collections** (11 → 95, near-linear in N) and ~2.9x cost each over a bigger heap —
ordinary scaling. Compare `quant44`, where `gcMs` 7.0 → 401.9 (57x) was telling the truth because the
COLLECTION COUNT grew superlinearly: 1,000,000 boxed `Map` keys built per query, removed at item 1453
for 22-28%.

So: **when GC looks like a target, ask whether the collection count grows faster than N.** If it does
not, the extra milliseconds are heap size, not garbage the code can stop making.

**A WRITE PROBE IS NOT A READ PROBE, and both obvious windowings are wrong** (item 1457).
A write is not idempotent, so the fixture is rebuilt every rep and it dominates the process: profiled
UNWINDOWED, `write-floor-probe`'s top frames were `indexEdgeLabel` 11.71%, `build` 6.00%,
`insertEdge` 3.74%, `addVertex` 3.35% — all construction. Windowed around a SINGLE rep it is worse:
~11 samples (every share a multiple of 1/11) and `profileWindow` inflated the median from 14.70 ms to
**66.08, a 4.5x perturbation** on a 15 ms window. The shape that works is to build EVERY fixture
first, then put one window around all the mutations, timing each rep individually inside it — 117
samples, median 11.772 profiled against 11.79 not.

And that fixture change MOVED THE ANSWER: a build per rep gave engine/floor **2.96x**, nine
graphs resident gives **1.83x**. `REPS` is load-bearing on this probe in a way it is not on the read
probes, because nine 20,000-node graphs alive at once is a different memory regime. Quote the
non-perturbing instrument (1.83x) and state the reps.

**THE SPELLING PROBES' DEFAULT `SPELL_N` IS NOT THE ONE TO USE, AND A FLAG NEAR THE FLOOR IS NOT A
RATIO** (item 1461). `spelling-probe.ts` defaults to `SPELL_N = 20_000`, at which **both null controls
fall under the 1 ms comparison floor** — so its "N group(s) over 2x" line comes back marked UNGATED and
cannot be judged at all. At the documented `SPELL_N=200000 SPELL_REPS=9` the controls land at 6.3 ms
and the gate works; two of four groups flagged at the default simply vanish.

Of four flags raised across both probes after five route changes, **three were the instrument**:

| flag                                                | in-sweep | confirmed                       |
| --------------------------------------------------- | -------- | ------------------------------- |
| Gremlin `hasLabel(a,b)` vs `or(hasLabel, hasLabel)` | 4.22x    | **1.06x** (two sub-ms readings) |
| GQL `node count: inline vs clause WHERE`            | 2.73x    | **1.15x** isolated              |
| GQL `SEEK: a param equality alone`                  | 3.39x    | **1.14x** isolated              |
| Gremlin `union(out(T), out(U))` vs `out(T, U)`      | 172,061x | **real** — fixed at item 1460   |

The one real finding had absolutes of 0.001 ms against 251.210; the three artifacts were either two
numbers near the floor or in-sweep inflation (CLAUDE.md's item 737). So: **read the ABSOLUTE readings,
run at the documented N, and follow the probe's own "re-run the group ALONE, three times" instruction
before treating a flag as a finding.** It prints that line because its own sweep cannot be trusted at
these magnitudes.

**A GROUP WRITTEN WITH `count(*)` CANNOT SEE A ROUTE THAT ONLY PROJECTIONS REACH** (item 1490).
Every group in this probe up to that point used `RETURN count(*) AS c`, which is the right default —
it keeps the reading off row construction and the GC it causes (44.8% of a row-materializing hop,
item 1488). But a `count(*)` is claimed EARLIER in the shortcut ladder by the count family, whose
gate goes through `compilePredicate` rather than through `itemLocal` / `rowLocal`, so a group in that
spelling never reaches the walk that picks the projection and hop routes. Item 1490's first version
of its own guard was written that way and reported its five members within **1.27x on the build it
was meant to catch** (3.96 / 4.10 / 4.53 / 4.25 / 3.85 ms). Rewritten as `RETURN n.k AS v ORDER BY v
LIMIT 10` the same group reads 6.07x on that build and 1.46x once fixed.

So: **run a new group against the BROKEN build before committing it.** A spelling group is a
generative guard and CLAUDE.md's rule for those applies unchanged — one whose teeth were never
verified is worse than none, because it is believed. And when adding a group, ask which rung of the
ladder the spelling lands on, not just whether the two spellings mean the same thing.

The fixture gained a `d` DATE key for those groups (item 1490), derived from `k`'s own ordinal so a
temporal predicate and a numeric one select the identical set. `d` is new and every other key is
untouched — the same discipline as `ew` on the edges (item 1053), so every earlier group's figures
stay comparable.

## `algo-scaling-bench.mjs` — the TWELVE ALGORITHMS, which had no bench row at all

`packages/core/src/algorithms/` is ~2,200 lines of procedure reachable from **both** surfaces
(Gremlin's OLAP steps, GQL's `CALL`), dispatched through `runAlgorithmSync`, and nothing in this
corpus measured any of it. This bench measures each at two sizes a 4x step apart, so the **ratio** is
the reading: 4.0x is linear in V, and the two O(V·E) procedures carry `exp: 16`.

Why this ground: item 1466 declined a 3.3x win because any edit to `hop-values.ts` /
`hop-projection.ts` moves unrelated rows up to ~16% ([[executor-edits-perturb]]). The algorithms are
not those files and are not on any query's row path, so a change here cannot pay that toll.

**Each row has its own size scale (`div`), and it is a fixture requirement.** `betweenness` and
`closeness` are Brandes/BFS from every vertex, so at `div: 1` they would not finish. Both of a row's
points are divided equally so its ratio stays comparable; the **absolute ms are not comparable across
rows with different `div`**, and the output prints each row's actual V so that cannot be misread.

**One fixture per (div, size), shared by every algorithm at that scale — required, not tidiness.**
See `graph-retention-probe.mjs` below: a synchronous body cannot release a mutated graph, so the
first version (24 fixtures) died at 4,087 MB. The body **cannot** become async either, because
`profileWindow` does `result = body()` without awaiting — an async body stops the profiler
immediately and every `PROF_OUT` capture comes back empty.

First readings (NODES=40000, FANOUT=2, REPS=5): **nothing is algorithmically wrong.** Ratios run
4.08-7.48x against an expected 4x — the excess is the per-row cache term item 1452 measured at
1.2-3.1x over a 10x step, not an exponent — and `betweenness`/`closeness` land on 16.67x/16.52x
against their expected 16x. The signal is the **per-vertex spread**:

| ns/V at V=160,000 | row                            |
| ----------------- | ------------------------------ |
| 3342              | `labelPropagation`             |
| 2500              | `neighborAggregate`            |
| 1536              | `shortestPath`                 |
| 1401              | `peerPressure`                 |
| 231-601           | the other six whole-graph rows |

`labelPropagation` is **14x** `connectedComponents` per vertex on the identical fixture.

The bench prints its own `ABOVE` flag when a ratio exceeds `exp × 1.6`, and the flag tells you to
re-run at `SIZES=4` first, because item 1464 is explicit that a two-point ratio is a ratio and not a
trend. `stronglyConnectedComponents` (7.25x) and `onCycle` (7.48x) are flagged and **not yet
confirmed at four points.**

## `graph-retention-probe.mjs` — a discarded `Graph` is retained until the microtask queue drains

Found because the algorithm bench OOMed. The retaining path, from a heap snapshot BFS rather than by
guessing:

```text
(GC roots) -> (Micro tasks) -> system / CallableTask
  -> closure 'drainMutations' -> system / Context -> Context
  -> [object] Graph -> property 'verticesById' -> Map -> Vertex
```

`Graph` defers reactive bookkeeping to one microtask per burst of writes, and that queued closure
captures the graph. The deferral is fine; the consequence is that **`global.gc()` does not unwind the
stack**, so in a synchronous run the pending drain pins every graph.

**Bounded retention, not an unbounded leak** — and that distinction is the finding. `YIELD=1` (one
`await setTimeout(0)` per round) flattens it completely, so every async embedding releases on the
next tick. The exposure is synchronous batch work: a test suite, a bench sweep, a CLI that builds,
computes and discards inside one turn.

| arm             | per-round growth, N=20,000 |
| --------------- | -------------------------- |
| `empty`         | **0.00 MB** (the control)  |
| `verticesProps` | 11.45 MB                   |
| `full`          | 48.35 MB                   |
| `full YIELD=1`  | 0.00 MB                    |

`empty` landing at exactly 0.00 is what makes the rest trustworthy: retention tracks **mutation**,
not construction. Needs `--expose-gc`; the probe refuses to run without it rather than report V8's
incidental collection as an answer.

## `algo-surface-overhead-probe.mjs` — what REACHING an algorithm through a surface costs

Items 1467-1470 optimized the twelve procedures through `runAlgorithmSync`, which is the entry point
both engines dispatch through but **not how a user reaches them**. This prices the surface wrapper:

| arm       | what it runs                                      |
| --------- | ------------------------------------------------- |
| `direct`  | `runAlgorithmSync(name, cfg, graph)` — the floor  |
| `gql`     | `CALL <name>() YIELD node, <col> RETURN count(*)` |
| `gqlbare` | `CALL <name>() RETURN count(*)` (YIELD-less)      |
| `gremlin` | `V() -> step() -> count()`                        |

First readings (40,000 vertices, every arm returning 40,000): on `degree` the GQL wrapper costs
**2.5x the procedure** (4.06 → 10.12 ms); on `pagerank` only ~21% (21.09 → 25.46). **The overhead is
roughly fixed per row**, so the ratio only tells you how much algorithm it is divided by — quote
both or neither.

**`WRITE=1` IS THE CONTROL, and without it the `gremlin` arm is measured against the wrong
floor.** `CALL` YIELDs rows; a Gremlin OLAP step WRITES a property and passes traversers through, so
`direct` alone is not its floor. Item 1472: `direct` 122.32, `direct + writeProperty` 145.24,
`gremlin` 150.44 at 200,000 — so the **Gremlin OLAP wrapper is ~3.6%, within noise**, and the
apparent 46% was the write. Pass `WRITE=1` whenever comparing against a Gremlin OLAP arm.
`@lenke/gremlin` exports no `degree` step, and the probe asserts the step exists rather than
silently measuring something else.

**A PROFILED RUN IS ~15% SLOWER.** The same `gremlin` arm read 172.50 ms with `PROF_OUT` set and
150.44 without. Comparing a profiled number against an unprofiled one turned a 3.6% wrapper into a
spurious 19%. Profile to find frames; measure with the profiler detached.

**`count(*)` is deliberate**: every arm must consume the same rows without the comparison becoming
about how they are rendered. A `RETURN node.name` arm would add a property read per row and confound
the wrapper question with a projection question.

**Sample count gates the profile.** An early capture of `gql/degree` had **103 samples** (8.67 ms ×
9 reps at a 1 ms interval) and was nearly targeted off; the ranking is noise below a few hundred. Use
`NODES=200000 REPS=15`.

## `cross-surface-probe.mjs` — the SAME logical query in both surfaces, over ONE fixture

Every other instrument here measures one surface, and the two single-surface probes do not even share
a fixture (the GQL one builds one edge per vertex, the Gremlin one defaults to `FANOUT=5`). So "is one
surface paying more than the other for the same question?" was not askable until item 1481.

**`cross-engine` IN THIS REPO MEANS TS vs RUST.** This is cross-SURFACE: both arms are the pure-TS
engine, so a gap is between two front ends lowering to the same data.

**EVERY PAIR ASSERTS ITS TWO ANSWERS AGREE, and the probe throws rather than printing a ratio when
they do not.** A mistranslated query is the obvious failure of a cross-surface comparison, and a ratio
between two different questions looks exactly like a finding.

First readings at 200,000 vertices: `hopfiltered` 1.07x, `exists` 1.26x, `grouped` 1.32x, `project`
1.63x, all GQL-faster; `hopcount` is both-shortcut and below the floor. **Nothing above 1.63x — the
shared layers dominate and neither front end is dramatically behind.**

**RUN IT AT 200,000, NOT 20,000.** At 20,000 the same probe read `project` **4.41x**, `hopfiltered`
**0.74x** and `grouped` **0.86x** — two of five pairs pointed the OTHER WAY, and the headline was
4.41x rather than 1.63x. Four of five rows sit under 2 ms there and `hopcount` is 0.01 against 0.04,
two timer ticks. The size sweep did not merely change a magnitude here; it changed which surface was
winning.

The residual `project` gap is named: Gremlin builds a traverser per vertex and extends it per value
(`sourceFromIds` 17.3% + `extend` 9.1% + `startTraverser` 2.9% ≈ 29%) where GQL's node-projection walk
builds none. `hopValuesShortcut` already eliminates exactly that for `V().out(T).values(k)`; the
no-hop form has no shortcut. ~~**Priced, not taken** — it lands in `hop-values.ts`, whose ~16% per-edit perturbation the ~29%
ceiling clears only narrowly.~~ **TAKEN at item 1482, 2.39x**: that framing had a hole — the
perturbation is a consequence of editing the FILE, so a NEW module (`node-values.ts`) costs nothing
and only one `index.ts` call site changes. `hopbare` stayed flat across the A/B, confirming it.
`project` is now **0.77x — Gremlin ahead of GQL** where it was 1.63x behind.

## `fused-vs-general-probe.mjs` — how much faster IS the fused walk, for the same hop and row count?

Three items sized an opportunity against `V().out(T).values(k).count()` without noticing that the
plan rides `hopValuesShortcut`, which emits bare VALUES and never materializes a vertex traverser —
so the floor did strictly less work than the thing being floored. Item 1484 measures it directly.

**THE TRICK:** `hopValuesShortcut` accepts exactly `values(k)` (one key), `id()`, or nothing as the
third step and DECLINES anything else. So `label()` after the hop gives the general route over the
**identical hop and row count**, and `values(k)` gives the fused one.

```text
            200,000 vertices, FANOUT 5, 1,000,000 rows
fused values(k)   34.83 ms    35 ns/row
fused id()       117.23      117 ns/row
general label()  545.92      546 ns/row
                 general/fused(values) 15.68x    general/fused(id) 4.66x
```

**THERE IS NO SINGLE "FUSED VS GENERAL" NUMBER.** It is 4.66x-15.68x depending on what the
projection emits, and **the two FUSED arms differ 3.3x from each other** on the same walk (only the
`pick` closure differs). So price a sub-plan change against an arm that emits **what the sub-plan must
emit** — vertex traversers, i.e. the `id` arm at 4.66x — not against the cheapest fused arm.

**THAT 3.3x WAS A THIRD SHORTCUT, found at item 1485**: `count-shortcut.ts` treats a trailing
single-key `values(k)` under a `count()` as a **presence filter** (item 1141), so those values are
never materialized. The probe now runs TWO families — `rows` (no count tail, every arm must produce
its rows) and `count` (kept so the confound stays visible) — and **the ordering REVERSES between
them**: without a count tail `id()` is 2.8x cheaper than a property read, with one `values(k)` is 3.4x
cheaper than `id()`.

**Use the `rows` family to price anything** — AND set `STRIDE=scattered`. Item 1486: the two
instruments disagreed **3.4x** on `rows id()` and the fixture's edge stride was the entire reason. One
knob, one instrument, 200,000 vertices:

```text
                sequential   scattered
rows id()          51 ns/row   133 ns/row
rows values(k)    104          160
rows label()      595          423
label / id      11.57x        3.17x
id / values      0.50x         0.84x
```

**So fused-vs-general is ~3.2x on a realistic (scattered) fixture, not 4.2-11.9x** — and the
id-vs-values gap collapses from 2.2x to 1.1x, which is why item 1486 found there is NO property-read
target: when the walk is cache-bound the extra read hides behind the miss. A sequential fixture gives
every vertex exactly FANOUT out-edges in vertex order, so the walk reads adjacency in build order and
the per-row costs a real graph pays simply are not there.

**BUT `scattered` IS NOT "REALISTIC" EITHER — it is a DEGENERATE FUNCTIONAL GRAPH (item 1487).**
`from = 7919·e mod N`, `to = 104729·e mod N` means every edge is `x → c·x mod N` for one constant, so
each vertex has out-degree FANOUT but exactly **ONE distinct neighbour** (the rest are parallel
edges) — and `c·0 = 0`, so **`v0` is a fixed point**:

```text
             v0's distinct targets   2 edges hitting ONE target   self-loops
sequential   v3, v35764              0 / 40,000                   2
scattered    v0                      40,000 / 40,000              10
```

**Consequences.** A single-source algorithm seeded at `v0` measures NOTHING there — `shortestPath`
returned 1 row and the bench's one-row-per-vertex guard (item 1467) is what caught it. And the two
strides **bracket** a range rather than one being right: sequential is cache-friendly and
degree-diverse, scattered is cache-hostile and degree-degenerate. Quote a per-row hop cost from the
hostile one; do not measure dedupe, multiplicity or fan-out shapes on it at all.

This is the fixture **this probe has used all along**, which is sound for the per-edge costs its rows
quote and unsound for neighbour-diversity shapes. Not changed, because changing it would invalidate
the recorded history of every row here.

**The tell for a skipped materialization: the fast arm is faster than producing its own rows.**
`out(E).values(k).count()` measured 2.81 ms against 7.65 for the same rows without the count.

## `temporal-probe.mjs` — temporal values, which had NO bench row at all

`packages/core/src/temporal.ts` is 1,333 lines, reached from both engines' comparison paths, and had
**zero mentions** anywhere in this corpus until item 1489. It matters more here than that suggests:
the domain is a people-graph over TIME, so dates are the modelling primitive.

Each pair stores a `num` and a `d` encoding the same ordinal, so the numeric and temporal predicates
select the identical set. First readings at 200,000 vertices:

| pair      | numeric | temporal  | ratio     |
| --------- | ------- | --------- | --------- |
| filter    | 2.59    | 3.86      | 1.49x     |
| **order** | 5.53    | **15.14** | **2.74x** |
| project   | 11.01   | 9.78      | 0.89x     |
| grouped   | 4.38    | 4.85      | 1.11x     |

**`project` and `grouped` flat is what localizes it**: reading a temporal and keying one cost nothing
extra, so the gap is the ORDERING path. And profiling each arm alone (`ARM=`) shows they take
DIFFERENT ROUTES — numeric rides `topKNodeWalk` (`beatsRoot` in its profile), temporal runs the
general matcher. `isTemporal` is 4.97%, so the comparison is not the cost; the missed fast path is.

**COMPARE A WITNESS, NOT A ROW COUNT.** The first guard here compared row counts — useless, since
`count(*)` returns one row and `LIMIT 10` returns ten whatever was selected. It now compares the first
row's first column: the filter pair proves both arms select **19,950** rows, and the order pair's
witnesses are the same day by two spellings.

**`ARM=numeric|temporal` for profiling.** One window over both arms attributes their frames to the
same capture, which is how a 2.74x gap becomes unreadable.

### It has a GREMLIN half now (item 1491), and the two surfaces disagree

Item 1490 fixed the GQL `order` row above — **2.74x → 1.08x** — and the cause was the temporal
LITERAL in the predicate, not the sort key. The row's own "different routes" note is what led there;
its inference that the cost was the ordering path was wrong, because the pair it never ran was a
temporal predicate with a numeric projection.

The Gremlin half (`gfilter` / `gorder` / `gproject`, same fixture) was added to check whether item
1490's mechanism existed there. It does not — Gremlin dispatches a step list, not an expression tree
— but the surface measured 2.70x anyway, for an unrelated reason, fixed at item 1491.

**QUOTE THE GREMLIN HALF AT `REPS=200`, NOT THE DEFAULT 9.** The gap reads 2.01 / 2.13 / 2.76 /
2.82x at 9 / 20 / 60 / 200 reps: the numeric arm tiers up (2.57 → 1.85) and the temporal arm does not
(5.16 → 5.21), so a short run UNDERSTATES this one. The default stays 9 because the GQL half is
stable there.

**AND `GARM=` ISOLATION UNDERSTATES IT TOO — the opposite of item 762's rule.** One arm per
process: numeric 1.88/1.89, temporal 2.86/3.53. Paired: numeric 1.85, temporal 5.20. `cmpSameType` is
one module-level site, so a process comparing both types makes it polymorphic and ONLY the temporal
arm pays. Item 762's "one shape per process" exists because pairing FLATTERS a redistributing change;
here pairing is the honest case. **Isolate to measure a CHANGE; pair to measure what a mixed workload
costs** — and a graph filtering on dates and numbers alike is the paired case. Use `GARM` for
profiling (one window over both arms attributes their frames together) and the paired run for a
price.

`GPAIR=<name>` selects one Gremlin pair; `SKIP_GREMLIN=1` (any value, including empty) skips the half
entirely.

## `tally-floor-probe.mjs` — where `V().has(k, pred).count()` spends its time

Item 234 shipped `propertyCount` (the hand-written tally) at 11.5 ns a vertex against a 4.6 ns
"scan alone, touching no property" floor and left that **2.5x unexplained for 1,258 items**. This
probe decomposes it: seven arms, each adding exactly ONE thing to the one above, so a difference
names its own cause. Every answer-bearing arm must return the same count and the probe throws if
two disagree — an arm that answers a different question is the failure four separate items here have
hit (chain count 1479, values walk 1480/1483, presence count 1485, hop-count 1488).

**RUN IT ONE ARM PER PROCESS (`ARM=`).** In one process the arms disagreed with their own
ordering — `inline` read 12.35 ns against `dynkey`'s 7.79, which is impossible when each adds work
to the one before. Isolated:

```text
scan 1.31 · getter 2.94 · dynkey 5.17 · inline 4.94 · closure 4.38-5.05 · engine 14.20 (PRE 1492)
```

Two conclusions this instrument exists to supply, both of which cut off a guess:

- **a dynamic keyed read is free** — `properties[key]` is not the cost, so the megamorphic-access
  theory is out;
- **a closure costs the same as inline code**, so "a call per row" is not the cost either, which is
  what made specializing the predicate (item 1492) a derivation rather than a hope.

Post-1492 the engine arm reads 5.34-6.61, within 1.21x of the closure floor.

### A single frame over ~95% is evidence of INLINING, not of a hot spot (item 1493)

`runtime-profile-gremlin-probe.mjs`'s `hophas` shape reported **`degreeOfTypes` at 97.1%** with
`matches` at 0.5%. Both are impossible: `degreeOfTypes` for a single-type hop is one `Map.get`
(97.1% would make it 262 ns a call), and `matches` is called once per vertex in that same loop —
the cost item 1492 measured as dominant in a structurally identical one.

V8 inlined the loop's callees and the sampler attributes an inlined callee's samples to its own
frame, so one frame absorbed the loop body and the others lost their time to it. **Check the
arithmetic before chasing a frame: read its body and ask whether its share is possible at the call
count.** The analyzer's `mentions` column does not help here — `degreeOfTypes` had 65.

`hophas` was added at item 1493 for this: `filterchain` filters the VERTEX SET and `hopbare` walks
without filtering, so neither covers the common shape of walking and then filtering the FAR end,
where the test count scales with FANOUT rather than with |V|.

## `hop-rows-floor-probe.mjs` — what `V().out(T)` costs, step by step

`hopbare` was the largest row in the Gremlin corpus that nothing had decomposed. Nine arms, each
adding ONE thing, every one producing the same 400,000-element array the engine produces. One arm
per process (item 1492's rule).

**The headline is a negative: the engine is within 4.6% of the hand-written floor** (43.2 against
41.2 ms), so `drain` at 73.9% of its profile IS the walk and there is no pipeline overhead to
recover. The marginal shares (item 1494): 2% the vertex walk, **25% the per-vertex type `Map.get`
(54 ns a vertex)**, **38% iterating the edge `Set`s (41 ns an edge)**, 4% materializing, 26% reading
and pushing the endpoint, 4% the engine.

**The endpoint getter is NOT the lever**, twice over. A second warm `e.to` read costs only ~10 ns
an edge, so the read is ~9% of the row (a profile had suggested 24.6%, and my own first attribution
said 30% because it bundled the materialization). And `rowsplain`, which stashes the same string as
a PLAIN own property, is **1.19x WORSE** than the getter — adding an own property to 400,000 `Edge`
objects transitions their hidden class and slows every access on all of them. _You cannot buy your
way out of a getter by adding a field to a class with many live instances._

**`ARM=rowsplain` MUTATES THE FIXTURE and is gated to that arm alone.** The first version applied
the stash whenever `ARM` was unset, so a full-ladder run taxed every other arm by exactly the
mechanism that arm exists to demonstrate. A probe that mutates the fixture for one arm can
invalidate all the others.

What remains is the two structural shares (type lookup + `Set` iteration, 63% together), which mean a
flat per-vertex adjacency — NOT the global dense ordinal that was built and disqualified at items
1369-1372/1397.

### The flat-adjacency lever, MEASURED (item 1495) — and the obvious version is the one that loses

Item 1494 priced it at "~1.6x" from arithmetic. Measured, with three more arms:

```text
flatceiling  global packed CSR (off/nbr)                     1.82 ms   24x
arrayadj     per-vertex arrays, endpoints pre-resolved       2.11      20.6x
arrayedge    per-vertex Edge[], endpoint read live          10.50      4.1x   ← the honest number
engine       today                                          43.43      1.00x
flatchurn    global CSR + one edge per rep, rebuild         63.58      1.47x WORSE
```

Build cost of the flat structure: **93.4 ms**, more than two queries' worth.

**`flatchurn` is the arm that decides the design.** A global packed array cannot absorb an insert,
so the naive policy (drop on any adjacency write, rebuild on next read) makes one-write-per-read
**1.47x worse than today** — item 680's failure mode on the TS side. Break-even is ~1.5 queries
between writes.

**ALL OF THAT IS REFUTED BY ITEM 1498, WHICH BUILT IT: 1.58x SLOWER** (43.33 → 68.56 ms, three
rounds each, fuzzers green). ~~`arrayedge` is the figure to quote (4.1x)~~ — the array arms rebuild
the rows in ONE tight loop, so their buckets are contiguous and the walk has near-perfect locality,
which the engine's buckets never have (allocated interleaved across 400,000 `addEdge` calls).

The control that proves it is `setedge`, added at item 1498: the same nested rows rebuilt as `Set`s.

```text
setedge    (nested SETS,   built locally)   13.34  14.53  13.01 ms
arrayedge  (nested ARRAYS, built locally)   10.12  13.77  13.60 ms
engine                                      67.46  68.41  67.83 ms
```

**13.3 against 13.6 — the container is irrelevant.** Every "array adjacency" figure in items
1495-1497 was measuring allocation LOCALITY and attributing it to the container.

**So read any floor arm that REBUILDS a structure as a locality floor, not a design prediction.**
The arm was honest about skipping the endpoint read (item 1495 corrected 20.6x to 4.1x for that) and
silent about skipping the allocation history, which was the whole number. If a floor rebuilds what
the engine accumulates, add a control that rebuilds the ENGINE's own container the same way — the
two should then differ only by the thing under test.

The open risk is **removal**: `Set.delete` is O(1) and keeping insertion order in an array means
`splice`, so O(degree). Iteration order is unchanged (a `Set` and an appended array are both in
insertion order), which is what byte-identity turns on.

## `adjacency-removal-probe.mjs` — the gate on the array-adjacency design

Item 1495 selected `Map<string, Set<Edge>>` → `Map<string, Edge[]>` (4.1x on a bare hop) and left
removal unmeasured. `Set.delete` is O(1); order-preserving array removal is `indexOf` + `splice`,
both O(degree) — the axis that disqualified the global dense ordinal.

Two halves, because a micro on `Set.delete` alone is unbounded (items 1364, 1368, 1477):

```text
degree     set   splice     swap  indexed   splice/set        engine removeEdge
     4   220.0    142.5    137.5    290.0   0.6x  ← faster    degree    4: 1530 ns (unreliable)
    16    65.0     65.6     69.4    305.6   1.0x               degree   64: 1127
  1024    36.9    129.0     71.4   1408.9   3.5x               degree 1024:  717
  4096    41.6    266.5    202.0   5874.0   6.4x
```

**At degree 1024 the bucket operation is ~7% of a real removal** (37-46 of 529-717 ns), so `splice`
makes it **+12% to +17% on the whole removal** — bounded, and below degree 16 it is an improvement.
Gate passes against 4.1x on reads.

**A RANGE, not a point: the engine denominator moved 1.35x between runs** (717 then 529 ns) while
the bucket micro held steady. The engine half is the noisy side — it rebuilds a fresh graph per rep,
because removal is destructive and reusing one would measure a shrinking graph.

Two traps the arms exist to show:

- **`indexed` (array + a member→position `Map`) is the WORST arm at every degree**, by up to 22x:
  it removes the `indexOf` search, keeps the `splice` shift, and then pays to renumber every
  position after the hole. A plausible optimisation that is strictly worse than what it optimises.
- **`swap` is cheap and must not be used** — it reorders the bucket, and adjacency iteration
  order is observable in row order, which is what byte-identity turns on.

**Removal order is load-bearing in the arms themselves**: they remove in a SCATTERED order so the
expected shift is degree/2. Front-to-back makes `splice` look free and back-to-front maximally dear.
Members are objects, not integers, because the real buckets hold `Edge` references.

## `parse-plan-probe.mjs` — what parse+plan costs, and who pays it

`bench:usage` has encoded the answer since item 662 without anyone pricing it: `write: append node`
runs at 128.6k ops/s and `write: append node [params]` at 512.8k — **4x**, in the unindexed column
where no seek applies. The first row interpolates the loop counter into the text, so every call is a
distinct string and misses the parse+plan cache; the param row's text is constant and hits it.

**DEFEATING THE CACHE IS THE DESIGN.** Each `fresh` arm mints a unique text per rep by appending
a line comment carrying the rep number — the lexer discards it, so the string differs while the AST
does not. **The probe asserts that before printing anything**; without it the fresh arms could be
measuring a different query and every ratio would be void.

```text
shape    chars    parse    +plan   warm q  fresh q   fresh/warm
insert      46     2330     3232     2306     7248   3.1x
point       41     2741     8392     3900    13617   3.5x
hop         39     2737     5335     1110     7684   6.9x
agg         42     2603     5756     3140    10016   3.2x
longer     137     6956    14055    30805    50086   1.6x
```

Parse alone is **2.3-2.7 us for ~40 characters** (~60 ns a char, roughly linear — 7.0 us at 137);
planning adds 1-6 us more, exceeding parse on every read shape. **The cheaper the query, the more it
dominates**: `hop` executes in 1.1 us warm and costs 7.7 us fresh, so 86% of an uncached call is
parse+plan. The lever is auto-parameterization (canonicalize literals into params so interpolated
texts share a plan), priced at 3.1-6.9x for an interpolating caller — named at item 1499, not built.

**MATCH `ROUNDS` ON BOTH SIDES.** An earlier pass of the `checkKeyword` A/B read 7% because its
PRE arm ran at ROUNDS=5 (2533/2536 — tight enough to be convincing) and the same build reads
2257-2318 at ROUNDS=7. The tightness was within a round, not across configurations; the real answer
was flat.

Two frames checked and not taken: `tokenize` (11.4%, the largest non-GC frame) is owned by items
887/888, whose ceiling ablation measured 1.07x; and `checkKeyword`'s double `peek()` (3.2%, zero
mentions) measured flat at 1.5% and was reverted with the numbers recorded at the code.

### `PROF_ARM` — profile the planner alone (item 1500)

`PROF_ARM=plan` windows parse+compile with no execution, so the planner's frames are not diluted by
whatever the query does. The distribution it shows IS the result:

```text
21.1% tokenize (items 887/888, ablation 1.07x) · 7.6% parse · 6.6% hasSubquery · 4.4% check
4.4% checkKeyword (flat, item 1499) · 3.3% flattenConjuncts · 2.6% peek · 2.4% collectHints · …
```

**After the two frames item 1499 closed, the largest remaining is 6.6% and the tail is 1-3% each.**
No local change moves an uncached query much — which is the argument for item 1499's conclusion that
the lever is to SKIP parse+plan (auto-parameterization), not to speed it up. `hasSubquery`'s
allocation removal shipped at 1.03-1.13x on the plan arm and that is the size of win available here.

## `literal-param-gate-probe.mjs` — can a literal become a parameter?

The gate on item 1499's auto-parameterization lever (3.1-6.9x). The blocker was never performance:
**the planner reads literal VALUES**, so a literal lifted into a param is invisible to it at plan
time. This enumerates the positions a literal can occupy and compares the literal spelling against
the param spelling on ANSWERS and on ROUTE.

**The route axis is why this cannot be a unit test**, and the fixture is INDEXED by default for
the same reason (item 578: the spelling probe had no index and was blind to the whole seeding class).
Both spellings answering identically is necessary and not sufficient.

**Result (item 1501): GREEN with one hard exception.** Answers agree in every position. Routes hold
within 1.25x except **`LIMIT` at 5.3-6.1x** — `topKPlan` reads the limit value at plan time, so a
param limit loses the bounded top-K walk. Stable at 200k, 1M, and on a third run. `IS NULL` has no
parameterized spelling at all (`= $null` yields UNKNOWN), and `{k: null}` is a SEMANTIC exception
only (route 1.18x).

**THREE FLAGS, THREE INSTRUMENT FAILURES, ZERO FINDINGS** — all three now printed by the probe
with a confirm-alone command, so they are not re-derived:

- **the FLOOR**: `two conjuncts` read 0.54x at NODES=200000 with both arms sub-millisecond, and
  1.25x at 1,000,000. `FLOOR_MS` now separates sub-floor flags from results.
- **INSTABILITY**: `hop start` swung **3.03x / 0.73x / 0.32x** across isolated rounds.
- **BIMODALITY**: `inline`'s LITERAL arm reads **0.95 / 3.42 / 1.21 / 0.98 ms** at REPS=25, so its
  0.52-0.54x sweeps had caught the slow mode twice running; three of four rounds read ~1.0x.

The in-sweep run flags four cases including `inline` at 0.10x against its isolated ~1.0x — **the
sweep is not an instrument for these sub-5ms rows.** Confirm alone, at REPS=25, before believing any
flag but `LIMIT`.

### `fresh` vs `interp` — two uniquifiers, and only one can see auto-parameterization (item 1502)

`fresh` makes the text unique by appending a line COMMENT (item 1499, to defeat the parse cache).
That **also defeats auto-parameterization**, because the comment survives into the rewritten text —
so `fresh` cannot measure the feature at all. It is now the CONTROL for what a literal-free cache
miss pays for the normalization attempt (1.04x, with the regex pre-filter).

`interp` varies a LITERAL, which is what an interpolating application does, and is the arm the
feature is for: **insert 1.46x, point 1.82x, agg 2.02x, longer 1.83x**.

**AND THE FIRST `interp` USED `i % 7`, WHICH IS SEVEN TEXTS, NOT UNIQUE ONES.** The parse cache
holds all seven, so PRE measured FASTER than POST — a warm cache against a cache plus normalization.
Only `${i}` models the real caller. Third instance this session of match-the-fixture-to-the-claim,
and the first where the fixture flattered the status quo rather than the change.

## `gremlin-plan-overhead-probe.mjs` — what a traversal costs before it touches the graph

The Gremlin analogue of items 1499-1502. There is no text to parse, but `toArray` re-runs the whole
plan ANALYSIS per call — `effectivePlan`'s seven passes, `checkSteps`, `planReadsPath`,
`streamStaysElements` — with nothing cached between calls.

**THE FIXTURE IS DELIBERATELY TINY (200 vertices)**, the opposite of every other probe here.
200,000 elements is right for measuring a walk and wrong for a per-call constant: at bench scale the
graph work swamps it and the answer rounds to zero. `bench:usage`'s regime is this one.

```text
shape         floor     work  rebuilt  toArray/floor  rebuild cost
count             2      315      787         130.5x         473ns
filtered        587     1186     1870           2.0x         684ns
hop               5      456     1093          84.0x         637ns
vals              5     9205     9638        1688.8x         433ns
```

`work` reuses one plan; `rebuilt` constructs the traversal in the loop, as an app does in a request
handler. **~300-450 ns of per-call analysis on a trivial shape, plus ~450-680 ns to construct the
plan.**

Three hypotheses tested at item 1503, **all three refuted** — worth knowing before re-deriving them:

- **a `WeakMap` memo on `planReadsPath`**: 1.52-1.61x on a REUSED plan, **1.07-1.15x WORSE on a
  rebuilt one** (a fresh plan never hits and pays the set). Rejected on that asymmetry.
- **`subPlansOf`'s per-step allocation** (15.7%, the largest non-GC frame): removing it entirely
  measured FLAT. **An inlining artifact — the second this session after item 1493's 97.1%.** The
  cheap test is to delete the use and measure, not to reason about the share.
- **repeated calls, as item 919 found for `hasSubqueryExpr`**: instrumented, `planReadsPath` runs
  **exactly once per `toArray`**. No redundancy — which also leaves the memo's 1.52x unexplained.

The remaining overhead is ~8 pure passes with no hot spot (the shape item 1500 found in the GQL
planner). A design that wins both arms must make plan CONSTRUCTION carry the analysis, not cache it
on the execution path.

**DONE AT ITEM 1504 for `planReadsPath`**: `Plan.readsPath` is ORed in at `appendStep`, so the
walk is gone and a fresh plan arrives already analysed. **count 315 → 200 (1.57x), hop 456 → 265
(1.72x), filtered 1186 → 1031 (1.15x) on the reused arm; the rebuilt arm is FLAT** (769-788 vs 787),
where the memo was 1.07-1.15x worse. Wide controls at 200,000 vertices unmoved: hopbare 1.01x,
hopcount3 1.00x, grouped 1.01x.

**AND AGAIN AT ITEM 1505 for `effectivePlan`'s passes**, which the re-taken profile showed were
then the top group at **32.2%**. A `Plan.kinds` bitmask of the six kinds that GATE a pass lets five
of them return in one test. **count 200 → 162, hop 265 → 213, filtered 1031 → 966 on the reused arm,
and the REBUILT arm gains too this time** (778 → 729, 1117 → 1065) because a gate skips work however
the plan arrived. Cumulative since 1503: count 1.94x, hop 2.14x.

**`kinds` is TOP-LEVEL ONLY and `readsPath` PROPAGATES INWARD** — opposite rules on the same
object, each correct for its consumer: the gated passes never recurse, so a nested `union` is not
fusable and recording it would make the gate useless. And any pass that changes the steps must
RECOMPUTE `kinds`, because `fuseLocal` inlines sub-plan steps into the top level.

**AND THE LAST TWO AT ITEM 1506**: `dropVacuousLabels` ← the `hasLabel` bit, and
`flattenFilterWrappers` ← `not | filter | or | and | hasLabelAnd`. **count 162 → 124, hop 213 → 162
(1.31x both arms); cumulative since 1503, count 315 → 124 (2.54x) and hop 456 → 162 (2.81x).**

**The flatten gate FIRST LISTED FOUR KINDS AND WAS WRONG.** The function's explicit branches test
`filter`/`or`/`and` plus `presenceFoldOf` (`not`) — but `pushSplit` runs UNCONDITIONALLY at the
bottom of the loop and splits `hasLabelAnd` (item 1309). Two existing tests caught it. **Enumerate
the kinds a pass acts on from the CODE, including what runs outside the branch conditions.**

**AND THE VALIDATION WALK AT ITEM 1507** — it does not need to MOVE to construction (item 1503
was right that it cannot), only to be SKIPPED: `checkStep` is the only thing that raises, so a plan
with none of the 25 kinds it can raise for cannot fault. `Plan.mayFault` says which. **count 124 →
77 (1.61x), 4.09x cumulative since 1503** — plus `assertPlanIsSatisfiable` gated on a `path` bit
(~1.04x).

**The gate set is read off the SEVEN THROW SITES, not the kind sets.** The broad one
(`PATH_INCOMPATIBLE`: `out`, `has`, `values`…) also requires `f === 'path'`, and only a `path` step
produces that frontier — so one kind covers the whole site, where gating on the set would pass for
nearly every plan.

**`mayFault` PROPAGATES INTO SUB-PLANS** (unlike `kinds`), because `assertFrontierTypes` recurses
into branch arms — `V().union(inV())` must still be rejected. The first version was top-level only
and would have silently lost that fault.

**And the flag caused a REBUILT-arm regression that an early-out then over-paid back.** Two
sub-plan walks per append (one per flag) cost hop-rebuilt 1.07x; merging them helped, and skipping
the walk entirely for steps with NO sub-plan field — which is `out`, `has`, `count`, `values`, i.e.
almost everything — made the rebuilt arm **1.14-1.28x faster than item 1506**. That cost had been
paid silently since item 1504 introduced the walk.

`countShortcut` (12.9%), `newContext` (12.1%) and GC (12.9%) are now the top frames, and all three
are execution rather than analysis — the construction-time design does not reach them.

## `dedupe-twin-1899.mjs` — the distinct far values of a hop, asked three ways

`SHAPE=gql|gremlin|gremvals bun dedupe-twin-1899.mjs`, with `N` and `REPS`. One shape per process
(item 1871 retracted a flag measured in a shared one), 200,000 vertices / 1,000,000 edges, eight
distinct values so the answer is 8 rows and the whole cost is walk. Prints the per-rep series beside
the median — the POST arm here spreads 61-95 ms across processes while the PRE arm holds 0.3-2%, so
a single pair cannot settle anything under ~1.2x.

**ITS REASON FOR EXISTING IS THAT IT MEASURES BOTH GREMLIN SPELLINGS, AND THAT IS THE ONLY
THING THAT CAUGHT ITEM 1899'S BUG.** `values(k).dedupe()` and `dedupe().by(k).values(k)` are one
question, and the fused rung's gate matched only the first — because a `By` in this AST is
`{kind: 'key', key}`, never the bare string the caller writes. One spelling dropped to 65 ms and the
other stayed at 257 on the same build, both answering correctly, with the whole suite green. A
probe that measured either spelling ALONE would have reported a clean win.

The GQL arm is the control and the target at once: `MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.n AS n`
at ~21 ms is the fast side whose shortcut the Gremlin rung copies — dedupe INSIDE the walk, so eight
rows are ever built.

## `dedupe-mutants-1899.mjs` — does `hop-values-dedupe.test.ts` have teeth?

21 mutants over the gate and both walks (the lazy `[Symbol.iterator]` and the eager `drain` are the
same loop written twice, so `which`-occurrence selects one). The gate gets more mutants than the walk
because that is where the item's real bug was, and a gate that quietly admits nothing changes no
answer at all.

**TWO MUTANTS WERE DELETED RATHER THAN COVERED, which is the other thing a survivor can mean.**
They disabled the `adjacentEdges` fallback in `farValues`, and no test could reach it: `soleTypeBucket`
returns `undefined` only for `both` or a multi-label hop, both refused by the gate. The arm was dead
by construction and is gone. An untestable branch and a dead branch look identical from the test
side; the mutation run is what tells them apart.

## `neq-prof-1900.mjs` — the tagged shapes, and the control the workload screen never had

`SHAPE=neq|selectone|wherecmp|hop bun neq-prof-1900.mjs`, with `N` and `REPS`. One shape per
process, 200,000 vertices / 1,000,000 edges.

**THE `hop` ARM IS THE WHOLE POINT.** The workload screen reports `where: neq filter` at the top
of the Gremlin surface and gives nothing to compare it against, so item 1898 read its cost as path
bookkeeping. The identical walk WITHOUT a tag measures 42.5 ms against the tagged shape's 234 — so
the tag costs 5.5x, and that is the number any claim about `tracksPath` has to be judged against.
`selectone` (156 ms) splits it further: reading the tag back is most of it; comparing against it adds
the rest.

**PROFILE IT AT A HIGH `REPS` OR THE PROFILE IS THE FIXTURE.** At `REPS=3` the top five frames are
`indexEdgeLabel`, `getVertexById`, `insertEdge`, `#commitNormalized` and `addVertex` — building a
1,000,000-edge graph, not running the query. At `REPS=40` the query dominates and the frames are
`generatorResume` 26.5%, `whereCurrentStep` 22.8%, `iterLabeled` 13.2%, `asStep` 6.6%.

`wherecmp` (`as_(a).out(E).as_(b).where('b', neq('a'))`, 329 ms) exercises `whereCompareStep`, a
different function carrying the same per-row predicate clone item 1900 removed from its sibling. It
was added AFTER that change, so it is a standalone pricing of the follow-up and NOT a before/after
control — `hop` is the control.

## `where-mutants-1900.mjs` — does `where-current-specialized.test.ts` have teeth?

7 mutants over `whereCurrentStep`'s specialization, with `cf.test.ts` in the test set beside the new
file — that is where `where(neq(label))` was already covered, and running the new file alone would
credit this change with coverage that predates it.

**IT CAUGHT A VACUOUS TEST OF MINE, which is the kind of find that justifies the run.** The
ordering-op test asserted `where(gt('x'))` over a scalar tag returns `[]` — but each traverser's `n`
IS its own tagged `n`, so "not greater" and "not equal" agree and a mutant routing `gt` through the
equality branch answers `[]` either way. A far VERTEX ordered against a tagged VERTEX discriminates.

**THREE EXPECTED SURVIVORS, EACH WITH ITS REASON AT THE ENTRY** — a pure route change (answer-
equivalent by construction, gated by `neq-prof-1900.mjs` instead), `recallTag`'s pop (no shape here
binds one label twice), and the `isTemporal` guard, which is probably dead and is kept anyway because
only an argument says so, not the branch's own conditions. Item 1899 deleted a dead arm one item
earlier because its gate proved it; the pair is the rule.

## `gql-coverage-screen-1901.mjs` — what the GQL screen does NOT ask

`bun gql-coverage-screen-1901.mjs`, with `NODES` / `FANOUT` / `REPS`, or `SHAPE='<label>'` for one
shape in this process. One CHILD PROCESS per shape (item 1871 retracted a flag measured in a shared
one; item 737 refuted a 1.66x that only existed in-sweep).

**THIS IS ITEM 1898'S SWEEP ON THE OTHER SURFACE, and it found the same thing.** Items 1879/1880
split the existing seventeen families until "the addressable time is exhausted" — true only of the
shapes a screen HAS. At 200,000 vertices the biggest GQL shapes are all outside the corpus:
`any shortest` 2336 ms, the path accessors 741/738, `ORDER BY <expression>` 180, `CALL … YIELD` 173.

**THE `CONTROL` ROWS ARE THE COMPARISON, not the fastest row.** Three shapes from the existing
corpus are carried deliberately — the one-hop projection (26.2 ms for 800,000 rows, item 1895's
target), the deduped hop (24.7, item 1899's GQL fast side) and the `{2,3}` var-length bound (21,977,
which items 1879/1880 established as a documented CORRECTNESS refusal). A new shape above the first
two is a nomination; one merely above the third is not. Later rows added the ORDER BY floors, and one
of them dissolved a nomination: `top-k grouped` at 142 ms for 3 rows reads like a missing top-k until
the same grouped count without the `ORDER BY … LIMIT` measures 139.1.

## `gql-coverage-probe-1901.mjs` — can the screen even ask this shape?

The step BEFORE a screen row, and not a timing instrument. A candidate is worthless two ways: it may
not PARSE, and it may parse and match NOTHING, which `workload-perf-screen.mjs` warns is a broken row
rather than a fast family. ISO-GQL is NOT Cypher, so every candidate's syntax comes from the engine
here rather than from memory — all 23 of item 1901's did pass, which is the only reason the screen
above has no `ZERO ROWS` line in it.

## `rung-precedence-census.mjs` IS DARK AS OF ITEM 1901 — it refuses to report

Its load-bearing assertion fails: `compileLinear` returns **32** rung fields, the `fastPath` ladder in
`clauses.ts` consumes **22**, and the probe's transcribed `CHAIN` holds the **20** that existed at item 1775. The refusal is the probe working — it will not census the wrong order — but the instrument is
unusable until someone finds where the other ten compiled fields are consumed, which is a re-derivation
and not a patch. Nobody ran it between items ~1885 and 1901, so a "start here" instrument went dark
for fifteen items.

**Meanwhile, to ask the route question directly**, call `compileLinear(parse(text).parts[0])` and list
the non-null fields: no willing rung at all means the general path regardless of precedence, which is
how item 1901 established that `ORDER BY n.k + 1` reaches nothing while `ORDER BY n.k + 1 LIMIT 3`
reaches `nodeProjection`.

## `sort-gate-mutants-1902.mjs` — does the unwindowed expression-sort gate have teeth?

9 mutants over one gate in `deferredRoute`, with `page-fold-fault.test.ts` and two ordered-projection
suites in the test set beside the new file — that is where the refusal this change does NOT touch is
guarded, and running the new file alone would credit the change with coverage that predates it.

**THE MUTANT THAT MATTERS admits a `SKIP` WITH NO `LIMIT`**, because that is the case item 1062
refuses for a stated correctness reason: with no cap the general path projects every row and drops
the skipped ones afterwards, so a faulting item raises, while ranking-then-projecting emits fewer
rows than it projects and would silently not raise.

**AND THE HARNESS CONTRADICTED THE AUTHOR IN THE DIRECTION NOBODY CHECKS.** "The arm is never
taken unwindowed" was declared an expected survivor on `perf-gate-needs-its-own-test` grounds
(reverting the change is answer-equivalent) and is actually CAUGHT, by the ROUTE assertions in
`unwindowed-expr-sort.test.ts`. The harness reported "was expected to SURVIVE and did not — update
the entry", which is worth knowing a survivor list can do.

## WHAT `bun run fuzz` AND `bun run spelling` BOTH MISSED, AND WHY (item 1902)

Both instruments had the same blind spot, created the same way: item 1062 fixed the WINDOWED
alias-vs-expression sort and everything written afterwards asked the question with a `LIMIT`.

- the workload corpus's `withOrder` always ordered by the projection's **alias**, so no generated
  query ever spelled a sort key as an expression. `withOrder` now draws a monotone expression
  spelling where one exists, and the draw was **counted** (78 of ~2,350 `projection` draws) rather
  than assumed.
- every alias-vs-expression group in `spelling-probe.ts` carried `LIMIT 10`. Two unwindowed groups
  added. **They still flag at 3.1x / 2.7x isolated** (`SPELL_N=200000 SPELL_REPS=9`), which is the
  priced residual — per-row compiled-key evaluation plus a `KeyRow` allocation against the plain
  arm's direct column read — and NOT a new regression.
- `packages/native/src/unwindowed-expr-sort-parity.test.ts` is the direct cross-engine cover: 15
  shapes, TS against native, compared as ORDER rather than as a multiset, over a fixture with
  DUPLICATE keys because a distinct-key fixture cannot see a tiebreak change.

The HOP twin is still open: `deferredRoute` is node-scan only, so a hop's expression sort key
measures **1190.77 ms against 276.89 — 4.3x over 800,000 rows**. Item 1063 built the hop version of
item 1062's arm for windowed sorts, so the opening is in the same place.

## `hop-deferred-key-parity.test.ts` — the wrong answer a tie-heavy fixture hid (item 1903)

Not a probe but the regression cover for one, and it belongs here because of HOW it was nearly
missed. The deferred hop order arm ranked on NULL keys whenever a sort key read an end the
projection does not — so the rows came back in the walk's ARRIVAL order. Four of five end/key
combinations diverged from native, `ORDER BY e.w LIMIT 3` among them.

**ON THE PERF SCREEN'S OWN FIXTURE THE WRONG ANSWER MEASURED 7.6x FASTER AND LOOKED LIKE A
WIN.** Eight distinct `n` over 200,000 vertices means arrival order and the correct order share
their first ten rows, so the screen could not tell them apart — `RETURN a.n AS c ORDER BY b.n + 1
LIMIT 10` read **39.06 ms broken against 293.75 correct**. It took `reversingChain` — `n` distinct,
every edge pointing at the vertex that reverses it — to make the two orders exact opposites.

**So: a sort-order claim needs a fixture whose arrival order is NOT a plausible answer.** The same
rule as item 1899's unique-value fixture for a deduping rung, one axis over: ties do not just weaken
a fixture, they can make a wrong answer look fast.

And the reason nothing caught it for 840 items is the corpus blind spot item 1902 names: no
generated query had ever put a bare variable read in a sort key. The `neighbors` family now draws
`ORDER BY a.n, x` a quarter of the time (counted, 277 of ~2,350), and the spelling probe has the
unwindowed hop group.

## `sort-matrix-1904.ts` + `src/sort-matrix.test.ts` — every sort shape against native, in order

320 shapes (3x8x5 node, 4x10x5 hop) over one fixture built so that every order differs from every
other. `bun sort-matrix-1904.ts` for the matrix, `ROUTES=1` for the rung census; the TEST is the
guard that actually runs on every `bun run test`. The fixture and shape list live in
`src/sort-matrix.ts`, shared by both — item 606's reason.

**IT VARIES THE AXES EVERY OTHER STORE HOLDS FIXED**: which end the projection reads, which end
the KEY reads, how the key is spelled, and which window is on it. That is the combination item 1903's
wrong answer lived in, and all three existing stores were blind to it the same way (corpus orders by
alias; spelling groups all carried a `LIMIT`; the perf screen's ties made the wrong answer measure
7.6x faster).

**TEETH, VERIFIED**: the pre-item-1903 derivation makes 30 shapes diverge. Reverting only ONE
of the three flags does not — the fix is OVER-DETERMINED, so a later edit could drop two of three
and still look clean here.

**ROUTE CENSUS** — 131 `hopProjection`, 82 `nodeProjection`, 107 general path, and all 107 are one
of the two documented refusals (64 `LIMIT 0`, a speed guard; 43 `OFFSET` with no `LIMIT`, the
correctness one). No unwindowed shape falls through any more. The skip-only refusal is priced at
2.9x (1290.48 ms against 448.77 without the offset, 800,000 rows), and the design to take it is item
1903's: project EVERY row and slice after, which is fault-equal to the general path.

## `src/skip-only-fault-parity.test.ts` — the evidence that let a refusal be removed (item 1905)

Not cover added after the fact: this file IS the argument. `deferredHopOrder` and `deferredRoute`
refused a `SKIP` with no `LIMIT` because ranking-then-projecting emits fewer rows than it projects,
so an item faulting on a discarded row would silently not raise — `page-fold-fault.test.ts` caught
item 1062's first cut doing that. Item 1905 lifts the refusal by projecting EVERY ranked row and
slicing AFTER, and this asserts the resulting fault behaviour against native for BOTH arms.

**ITS CASES SPELL OUT THE VERDICT**, not just engine agreement: `OFFSET 1` / `SKIP 1` / no window
MUST RAISE (every row is projected); `DESC LIMIT 2` / `OFFSET 1 LIMIT 2` MUST RETURN ROWS (a true
top-k projects survivors only); `LIMIT 0` MUST RETURN `[]` (still refused, and for correctness —
`applyProjection` returns `[]` before projecting anything).

**TEETH VERIFIED PER ARM**, because "the hop is fault-equal" is not evidence about the node:
slicing before the projection fails the two skip-only hop cases, and the same mutation on the node
arm fails the node cases. A stored NaN is the only way to make a projection fault (ingest coerces
NaN to null), so it is computed with `SET`.

## A MUTATION BATTERY MUST REBUILD THE DIST PER MUTANT (item 1906)

`reach-gate-mutants-1906.mjs` mutates `packages/gql/src` and asserts against BOTH that package's
tests and the cross-engine ones in `packages/native`. **`@lenke/gql` resolves to `dist` inside
`packages/native`** ([[fuzzers-read-built-dists]]), so the first version ran the native suite against
an UNMUTATED build and **all three run-time mutants survived with that suite nominally in the test
set**. A battery that mutates source and asserts against a stale artifact is comparing the code to an
old copy of itself — the same trap `backend-parity-fuzz` has for the wasm artifact, one layer up.

And `restoreAll()` in the `finally` is not enough: restoring the SOURCE is not restoring the
ARTIFACT, so the rebuild belongs there too, or the last mutant stays in the dist that every TS
harness reads afterwards.

One reading note for any battery spanning two packages: the `N failing` count printed beside a
verdict is the FIRST result line in the concatenated output, so a mutant caught only by the second
suite prints `0 failing` beside its. The verdict comes from the exit code, which is the contract.

## `anyshortest-prof-1908.mjs` — the shortest-path shapes, and the floor they are read against

`SHAPE=anyshortest|allshortest|reach|hop bun anyshortest-prof-1908.mjs`, with `N` and `REPS`.
Its `reach` arm answers a DIFFERENT question (distinct reachable values, not one row per pair), so
it is a FLOOR rather than a control — the row counts differ by three orders of magnitude and that is
the point. `hop` is the per-row figure every other shape is read against (25 ns a row).

**AND IT IS THE INSTRUMENT THAT CAUGHT A 24.3% FRAME BEING WORTH 2.7%.** The profile named
`withBinding` — which clones the binding `Map` per matched node — at 24.3% on one run and 1.1% on the
next, with `matchNodeLabelled` taking its place (adjacent dist lines, an inlining boundary;
[[frame-attribution-trap]]). A direct micro settled it: 2.1M × (`new Map(src)` + one `set`) is
**64.2 ms**, i.e. ~2.7% of the shape, against mutate-only's 7.6.

**AN ABLATION COULD NOT PRICE IT**, which is worth knowing before reaching for one: mutating the
binding in place is unsound (the matcher backtracks) and returned **1 row instead of 2,099,864**, so
the timing meant nothing. When an ablation changes the answer, the only thing its run establishes is
whatever the CONTROLS did.

## `sideeffect-prof-1909.mjs` — the list-shaped Gremlin shapes, and the two floors they need

`SHAPE=aggcap|store|fold|valsfold|values|bare bun sideeffect-prof-1909.mjs`. It carries TWO
floors because one is not enough: `values` (800,000 bare values, 41 ms) is the WALK floor and `bare`
(`V().out(E)` with no projection, **4.48 ms** via the drain) is what the elements actually cost. The
gap between them is the whole diagnosis.

**ITS USEFUL READING WAS A SPELLING THAT IS SLOWER WITH FEWER GENERIC STEPS.** The route screen
says `V().out(E).fold()` runs TWO generic steps (the hop falls to the pipeline) and
`values(k).fold()` runs ONE — yet the second measured 137.77 against the first's 99.47. Both are
~95 ms above their own floor, which is what identified the cost as ITERATING a drainable walk rather
than accumulating a list (an array push is ~2 ns; 118 ns/element is sixty times that).

**PROFILE IT AT `N=50000 REPS=200`**, not at the screen's size: at `N=200000 REPS=25` a third of
the samples are still `indexEdgeLabel`/`getVertexById`/`commitNormalized` — the fixture. At the
smaller size the query is ~85% and the answer is unambiguous (40.4% `generatorResume` + 32.6% the
adjacency generator).

## THE WORKLOAD SCREEN'S ABSOLUTES DRIFT AS IT GROWS (item 1909)

`hop1: values` read **43.04 ms at item 1898 and 67.62 at item 1909** — while the isolated
measurement is **41.9-43.1**, unchanged. The screen has gained rows since (nine families at 1898,
more after), so its in-process dispatch pollution is worse. **It is a FINDER; a regression read off
it is not a regression** (items 737/1871), and this is that warning with a fresh number.

## A FUSED ROUTE IS NOT ONE ROUTE (item 1910)

`V().out(T).fold()` cost 99.53 ms. Admitting `fold` as a named residual in `hop-values.ts` took it to
**29.71** — a 3.35x, a clean win, and **still 7x the identical walk's 4.13**. The gap was a SECOND
gate: `hopValuesCsr` is consulted FIRST and its `pickFor` declined a `fold` projection, so the shape
fell past the CSR to the slower bucket walk. Admitting it there too closed the rest: **4.13 ms, 24.1x
in total, and now identical to the bare hop.**

**So "it is fused now" is not a finish line** — it was true at 29.71. What said otherwise was carrying
the bare walk as a FLOOR in the same instrument (`sideeffect-prof-1909.mjs`'s `bare` arm, 4.1-4.5 ms
across every run of this item), which is the only reason the remaining 7x was visible at all.

## THE BLOCKER YOU WROTE YOURSELF IS THE HARD ONE TO RE-CHECK (item 1911)

Item 1909 declined `aggregate(k).cap(k)` with a reason of its own making — "a side effect that also
PASSES THE STREAM THROUGH is a different emit contract from a barrier that replaces it, and
`aggregate` and `store` differ on eagerness in TinkerPop". Both clauses are TRUE IN GENERAL. Neither
binds with `cap` TERMINAL, which reading the two steps settles in a minute: `aggregateStep` pushes
into an array and returns the stream, `capStep` drains and yields that array, so the pair's answer IS
`fold`'s list — and with nothing downstream, neither the pass-through nor the buffering can be seen.
**26.0x and 24.5x**, two items later.

[[check-the-blocker-still-holds]] is written for inherited notes, and this is the harder case:
nothing about a note you wrote two items ago looks stale. The tell was the number sitting beside it —
1.09x of a shape that had just moved 24x.

## A WIN CAN MISS THE SHAPE THAT NOMINATED IT (item 1912)

The tagged-hop rung measured **17.6x** on `V().as_(a).out(E).select(a)` and left the workload
screen's rows at **406 and 196 ms**, unmoved. The screen's spellings carry a FIFTH step —
`values('n')` — which is what an application writes, and the four-step rung declined them.

**Read the screen's own definitions, not its labels.** `'select: as + select one'` is
`traversal(V(), as_('a'), out('E'), select('a'), values('n'))`, not the four-step shape the name
suggests. The isolated instrument was measuring a sibling of the flagged row, and only re-running the
screen after the win looked finished exposed it.

And the same reading gives the follow-up honestly: `select: as + select two` (273.93 ms) is
`select('a', 'b')` — a MAP of two tags, a different question from repeating one.

## A `drain()` THAT DELEGATES TO A GENERATOR PAYS THE GENERATOR FRAME (item 1913)

Every fused Gremlin walk is written twice on purpose — a lazy `[Symbol.iterator]` and an eager
`drain` — and `hop-values-csr.ts` writes the LOOP out in both. Writing `drain() { for (const v of
each(...)) out.push(v) }` instead is correct and costs **1.6-2.0x**: `where(neq(a)).values(n)` read
76.50 ms against the plain hop's 42.50 until the loop was written out, then 38.96 (below the hop,
which is what it should be — same properties, minus the self-loops).

**THE PROFILE NAMES THE FRAME, NOT THE RESUMES**: 44.7% in the generator body, 7.7% in `drain`,
`generatorResume` only 3.8%. A `function*` frame is optimized less well than a plain loop, so
delegating moves the whole body into one.

**ONE GREP FINDS THEM**: a `drain` whose body contains `for (const x of <helper>(`. It found the
second instance (item 1899's dedupe walk) immediately, written the same way by the same hand on the
same day.

## PER-ARM MUTANT LABELS GO BY FILE ORDER, NOT BY INTUITION (item 1913)

`dedupe-mutants-1899.mjs` labelled occurrence 0 "LAZY iterator" and occurrence 1 "EAGER drain" — and
they were **swapped**, because `walk` (which holds the drain) is defined before `farValues` (the
iterator). The mislabelling hid a real gap: the survivor was the ITERATOR's run-bound off-by-one, and
it survived because the lazy-iterator TEST used the duplicate-bearing fixture whose values absorb a
CSR over-read. Item 1899's unique-value `chain()` fixture had only ever reached the DRAIN, because
that is the path `toArray` takes.

**So: name per-arm mutants by where the anchor actually occurs, and make sure a discriminating
fixture reaches EACH copy.** The over-read is real — `flat` is over-allocated and zero-filled, so
reading past a run lands on slot 0, a real vertex with a real value.

## A WALK WRITTEN TWICE OVER TWO ARMS IS FOUR PATHS, AND THE OBVIOUS TESTS REACH TWO (item 1914)

Every fused Gremlin walk has a lazy `[Symbol.iterator]` and an eager `drain`, each with a CSR arm and
a bucket arm. **Three mutants survived in paths no test had entered:**

- **the ITERATOR'S BUCKET ARM.** Every `run` test was preceded by a `toArray`, which takes the DRAIN
  and warms item 1889's second-ask policy — so by the time the spread happened the walk was on the
  CSR. A FRESH graph per spread is the fix, since `seenBefore` records per (graph, topology, shape).
- **the ITERATOR'S CSR ARM with a missing key** — warm first, then spread. `twice()` covers the
  drain's CSR arm and a cold spread covers the iterator's bucket arm; neither reaches this one.
- **an anchor that had drifted silently**, because item 1913's duplication made one line appear
  twice and the mutant stopped running at all.

**So a mutant list for one of these walks needs: drain×CSR, drain×bucket, iterator×CSR,
iterator×bucket — and a test that actually enters each.**

## A BATTERY MUST REPORT EVERY ANCHOR DRIFT AT ONCE (item 1914)

`fold-mutants-1909.mjs` used to throw on the first mismatched anchor, which hides the rest — a
refactor that moves five of them then costs five runs to find. It now collects them all, prints them
together and still exits non-zero. Third harness-integrity fix in four items (item 1907's
templated config pointing at the previous subject, item 1913's swapped per-arm labels, this): **a
measuring instrument's own configuration is the first thing to verify, and it fails silently by
default.**

## `wheresub-prof-1915.mjs` — the sub-plan filters, against the floor that answers the same rows

`V().where(out(T)).values(k)` was the Gremlin workload screen's largest shape with neither a path
requirement nor a priced refusal: **90.01 ms for 200,000 rows that `V().values(k)` answers in 4.17**.
Seven arms, one shape per process: the target, the `scan` floor (the SAME 200,000 rows, no filter),
`filter`/`not`/`and`/`or` (the sibling spellings), the `count()` twin — which returns ONE row and so
prices the filter with nothing downstream — and the plain hop as a control the change cannot reach.

```
SHAPE=where|scan|filter|not|and|or|wherecnt|andcnt|orcnt|hop bun --cpu-prof wheresub-prof-1915.mjs
```

**THE `count()` TWIN IS THE ARM TO READ FIRST.** It isolates the filter from the projection, and
it is what turned "90 ms for a filtered scan" into "**404 ns per vertex to answer a yes/no**" against
a plain hop's 52 ns to visit an edge AND read a property off it.

**PROFILE AT `REPS=100`, NOT THE DEFAULT.** At REPS=25 the fixture build is still ~60% of the
profile (`indexEdgeLabel`, `getVertexById`, `#commitNormalized`) and the query's own frames are
buried — item 1900's lesson, hit again here. At REPS=100 the picture is unambiguous:
`generatorResume` 42.2%, `iterLabeled` 18.7%.

## AN EXISTENCE TEST CAN ADMIT WHAT A HOP RUNG MUST REFUSE (item 1915)

`soleTypeBucket` refuses `both`, a multi-type hop and an untyped one, and those refusals are
load-bearing **for an answer**: it must not double-count a `T|S` edge, must drop a self-loop's
duplicate under `both`, and must read the correct END off the edge. **None of the three is observable
in a yes/no**, so `sub-plan-existence.ts` admits all of them plus the edge-emitting spellings
(`outE`/`inE`/`bothE` walk the identical adjacency and differ only in what they yield).

So before reusing a hop helper for a filter, ask which of its refusals are about the ANSWER and which
are about the SHAPE. The equivalence the broader gate rests on: `traverseToVertex` and
`traverseToEdge` yield for EVERY adjacent edge unconditionally, so "the sub-plan emits something" and
"a bucket is non-empty" are the same question — and any step that can DROP a traverser (a `has`)
breaks it.

## `emptybucket-probe-1915.mjs` — ASK THE STRUCTURE, DON'T CITE A TEST THAT USES `?? 0`

`sub-plan-existence.ts` tests `set.size > 0` rather than `set !== undefined`, and the comment
justifying that originally cited `topology-version.test.ts`'s `a.adjFrom?.get('F')?.size ?? 0`.
**That `?? 0` is equally consistent with an ABSENT bucket, so the citation proved nothing.** This
probe asks the graph directly, by every route that can drop a vertex's last edge of a label:

```
bun emptybucket-probe-1915.mjs
```

The answer is that core **DELETES** a bucket as it empties — `removeEdge`, `removeLabelFromEdge`, the
last of several same-label edges, and removing the far vertex, all four. So a present-but-empty
bucket does not arise, `!== undefined` would be answer-equivalent, and **TWO mutants in
`wheresub-mutants-1915.mjs` are uncatchable by construction** (the `size > 0` guard and the untyped
loop, which the invariant makes redundant in the same way). Both are declared with that reason, and
the invariant is now pinned in `adjacency-box.test.ts` rather than assumed by the consumer.

The general form: **a `?? 0` or a `?.` in an assertion means the test passes under both of the
states you are trying to distinguish.** If a decision rests on which one holds, write the probe.

## PROVE THE CAP BINDS, NOT JUST THAT THE PROCESS DIED (item 1915)

`wheresub-mutants-1915.mjs --prove` runs the net before the mutants. Three things it got wrong first,
each worth avoiding:

- **The bomb was too slow to be run.** `1 << 24` chunks reached 4.8 GB in 265 seconds. A proof nobody
  runs is not a proof. 256 MiB chunks, each TOUCHED so the pages are really resident, cross a 16 GiB
  cap in seconds.
- **Its verdict lines were piped into `tail` and never appeared** — leaving `exit 0` standing in for
  the evidence it was supposed to summarize. The same mistake as reading a test runner's exit code
  without its result line, one layer up.
- **THE BOMB DIES EXIT 1, NOT 137.** Bun's allocator hits the failed mapping inside the cgroup and
  throws, rather than the kernel delivering SIGKILL. Non-zero either way, so a battery's verdict is
  unaffected — but **a non-zero exit alone does not show the CAP did it**, since a JS runtime has its
  own heap ceiling. The proof is that the death point SCALES with the cap:

```
2G cap    killed BY SIGNAL after   7,310 ms
16G cap   bun exit 1 after        49,145 ms     <- 6.7x longer for 8x the cap
bare spin loop                    exit 124      the timeout, which MemoryMax never trips
```

An UNCAPPED arm would compare more cleanly and is deliberately NOT run: CLAUDE.md records a
runaway filling a 192 GB swapfile and forcing a hard reboot, and this box has taken that four times.

## A NEW EXECUTOR MODULE IS A LEAF OR IT IS A CYCLE (item 1915)

`sub-plan-existence.ts` declares its own one-line `isVertex` instead of importing it, because
`runtime.ts` imports `applyPlanToStream` from `dispatch.ts` and `dispatch.ts` imports the new module
— so a VALUE import from `runtime` is a cycle and `import/no-cycle` is an error. A `type` import is
erased and is fine. The predicate is the identical `isVertexShaped` call `runtime.ts` itself exports,
not a second derivation of it. Third module in this package forced into that shape, after
`far-mask-drain.ts`'s locally-declared `Gate` and `csr-cache.ts` on the GQL side.

## AN INDEXED LOOP IS NOT THE FIX, TWICE (item 1915)

`and(out(E))` shipped at 36.61 ms against the identical `where(out(E))`'s 20.85 — 1.75x between two
spellings of one question. The guess was that `for…of` over the hops array allocated an iterator per
vertex; an indexed loop moved it 36.70 to 36.35, i.e. nothing. The same substitution in
`anyNonEmpty`'s loop over `labels` also measured neutral on all three arms.

**What fixed it was routing arity 1 to the straight-line step** (`and(p)` and `or(p)` over one plan
both mean exactly `p`), which took it to 20.85. So the cost is a LOOPING GENERATOR BODY with a
mutable accumulator against a straight-line `const hit = …`, not the iterator. Both rejected
substitutions are recorded in place with their numbers.

## `pathval-prof-1916.mjs` — the path accessors, against a floor that is the SAME match

**THE FLOOR A SHAPE IS READ AGAINST IS PART OF THE MEASUREMENT, and item 1901's two path rows
had the wrong one.** It priced `edges(p)` at 738.46 ms and `edges(p)[0]` at 741.10 against its
`CONTROL one-hop projection` (26.22 ms) — but a seeded `{1,2}` var-length match does far more work
than a one-hop projection whatever it returns, and `edges(p)` returns a LIST per row where the
control returns a scalar. The floor here is the **same pattern, same seed, same row count, scalar
return**, so the difference is the path machinery and nothing else:

```
FLOOR  same match, scalar       548.74 ms   500,000 rows   <- 71% of the "path" shape
path VARIABLE bound, unread     558.55       500,000       <- binding a path: +1.8%
path_length(p)                  763.81       500,000
edges(p)[0]                     772.22       500,000
edges(p)                        772.59       500,000
nodes(p)                        787.00       500,000
```

**ALL FOUR ACCESSORS COST THE SAME ~210 ms** — `path_length(p)` returns one integer and
`edges(p)[0]` one edge, yet both cost what the whole edge list costs, because ANY accessor sets
`wantPath` and routes the walk to `trailEndsViaUnit`, which reconstructs `verts`/`edges`/`steps` per
emitted path. Open, and narrow next to `edges(p)` itself.

The probe's extra arms split the floor further: `{1,1}` costs what the written one-hop costs (35.09
against 37.52) and `{1,2}` is almost exactly `{1,1}` + `{2,2}` (554.74 against 548.87), so **the
quantifier machinery adds no overhead of its own at these depths.**

## `{2,2}` vs A WRITTEN-OUT TWO-HOP IS NOT A SPELLING GAP (item 1916)

```
MATCH (a:T)-[:E]->{2,2}(b:T) WHERE a.n = $p0        513.78 ms   400,000 rows
MATCH (a:T)-[:E]->(m:T)-[:E]->(b:T) WHERE a.n=$p0   353.76      400,000 rows
```

Same row count on that fixture, 1.45x apart — and it would be this repo's named bug class if the two
were one question. **They are not.** `ast.ts` records that the repeated-element restrictor on a
var-length walk **defaults to `trail`**, so `{2,2}` excludes a path that reuses an edge and the
written form does not; they agree there only because the fixture has no 2-hop that can reuse one.

The general lesson: **equal row counts on one fixture are not evidence that two spellings are one
question.** ISO-GQL is not Cypher, and a quantified path's default path mode is exactly where that
assumption bites — check the restrictor before calling a quantified/unquantified pair equivalent.

## `flatadj-ceiling-1916.mjs` — A 13.1% FRAME WORTH 0.4%, PRICED BEFORE BUILDING

`flatAdj`'s fast arm does `Array.from(bucket)` for every vertex visited at every depth of a
var-length walk, because the DFS frame needs indexed access. The profile puts `Array.from` at
**13.1%**, and an older note in `var-length-count.ts` independently records `flatAdj` at **36.6%** on
a declined depth-4 shape — two hot-frame nominations on one line.

```
copy    Array.from(bucket) then index it     31.527 ms
iter    hold the Set iterator, call next()   29.428      <- 1.07x — the WHOLE win
forof   for…of over the Set                  22.418      <- NOT usable: the frame must resume
```

**2.099 ms of a 513.78 ms row. 0.4%.** Both arms pay the Set traversal; only the allocation goes.
[[frame-attribution-trap]] again, and the `forof` arm is the tempting one and is unreachable — a DFS
frame has to suspend and resume mid-bucket, which is exactly what `for…of` cannot do.

Two things made this cheap, and both are reusable: **the visit list is built FROM THE GRAPH**
(125,000 real visits, mean degree 4.00) rather than sampled uniformly, so it is a ceiling for the
real shape; and **the area had already warned** — the comment above `flatAdj` records a previous
change there at ~1.04x against a bimodal before-arm, withdrawn. Reading the warning first cost one
micro.

## A LADDER'S CROSS TERMS CAN BE INVALID WHILE ITS PAIRS ARE FINE (item 1917)

Item 735 left open which of three downstream consumers dominates a var-length walk, having ablated
all three at once. Item 1917 split them with LEGAL QUERIES rather than a patched build — each rung is
a query the engine must answer correctly, so no arm can secretly be the wrong build:

```
MATCH (a:T)-[:E]->{2,2}(b:T) WHERE a.n = $p0, 200,000 vertices, 3 rounds of median-of-7:

  two        RETURN b.n, end labelled     437.07 - 462.17 ms
  twonolab   RETURN b.n, end UNlabelled   392.91 - 402.33      <- ~11%, consistent 3/3
  constlab   RETURN 1,  end labelled      420.17 - 450.87      overlaps `two`
  bare       RETURN 1,  end UNlabelled    311.02
```

**DROPPING THE PROPERTY READ COSTS 2.7% WITH A LABEL AND 21% WITHOUT.** That is incoherent for
the same removal, and it is the tell that `RETURN 1` with no variable reference changes the ROUTE
rather than merely doing less work. So the tempting "both removed = 31%" is discarded, `constlab`'s
spread overlaps `two`'s (so the property read is not measurably distinguishable at this noise), and
only `two` vs `twonolab` is a clean pair.

**The reusable rule: in an N-way ablation, check that each single removal costs the same in every
context before trusting any combination of them.** A removal whose price depends on which other
removals are present is not an ablation — something is switching routes.

Row counts are printed for every rung, because `(b)` without `:T` is the same question ONLY on a
fixture where every vertex carries `T`. All four returned 400,000.

## `v.labels = [...]` IS A WRONG ANSWER AND A TRANSACTION VIOLATION (item 1917)

Three instruments, kept because the finding is behavioural rather than numeric:

- **`labelsetter-check-1917.mjs`** — does the setter maintain `verticesByLabel`? No: after
  `a.labels = ['U']`, `T` still reads as VACUOUS (`size === vertexCount`), while
  `removeLabelFromVertex` maintains it correctly.
- **`labelelision-wrongans-1917.mjs`** — the end-to-end consequence.
  `MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)` over a 6-chain answers **4 rows where `hasLabel` truth is
  1**, because `effectiveLabel` drops a label test the stale index calls vacuous. `v3.hasLabel(T)`
  is already false at that point — **the vertex is correct and only the index is not**, which is why
  this is easy to miss.
- **`labelsetter-extent-1917.mjs`** — how much the setter bypasses. The supported mutators call
  `indexVertexLabel`, `emit(...)`, the constraint checks and `recordUndo(...)` before
  `commitElementLabels`; the setter calls `commitElementLabels` alone. Three of the four diverge:
  the index, the EVENTS, and — worst — **a label written inside an ABORTED transaction survives**,
  because no undo entry is recorded.

All three are pinned as `test.failing` in `packages/core/src/core/label-setter-bypass.test.ts`.

**VERIFY A `test.failing`'s TEETH, because one that can never pass checks nothing.** Asserting
today's actual behaviour instead makes bun print `this test is marked as failing but it passed` and
exit **1** — so the pin fails the day the gap closes, which is the reason to pin rather than comment.

**AND READ [[label-index-vs-setter]] BEFORE INVESTIGATING `verticesByLabel` AGAIN.** The index
half was already priced and put to the owner at item 1553 and is still pending; this item
re-derived it from a profile without checking, the second time that same note has been bypassed.
Only the events and rollback halves were new.

## A FUZZER BLIND SPOT MADE OF TWO MUTUALLY EXCLUSIVE BRANCHES (item 1918)

`gremlin-fuzz.test.ts`'s terminal generator returned EITHER `[values(k)]` OR `[sum()]` — never both
— so **`values(k).sum()` had never been compared between the engines at all**, and its f64 result is
order-sensitive in the last ulp. The composed shape was unreachable not because anyone excluded it
but because the two arms were alternatives in one `if` chain.

```
values(k).sum()/.mean()=16 of 400 generated     <- now printed every run
```

**Three things make the widening trustworthy, and each is a rule worth reusing:**

- **It went in FIRST and was green BEFORE the engine change it guards**, so a later failure is
  attributable to the change and not to the widening.
- **Its weight comes entirely out of the bare-`sum` window** (0.60-0.70 split 0.05/0.025/0.025), so
  no other terminal's probability moves and the widening cannot be confused with a shift in the rest
  of the distribution.
- **It reports its own hit count**, because a generator branch that never fires is a guard that
  guards nothing — silently. Same reasoning as the `order(local)` counter beside it.

The general form: **when a generator picks one arm from a chain of alternatives, every PAIR of
arms is unreachable by construction.** Ask which compositions the chain cannot express, not just
which steps it can.

## `minmax-prof-1918.mjs` — the reducing terminals against the floor that materializes their input

```
bare hop (no projection)   4.31 ms   800,000 rows
values(k) — THE FLOOR     64.60      800,000
min                       86.44            1
max                       74.70            1
sum                      174.35            1     <- 2.7x the floor, to ADD what it already has
mean                     185.36            1
strmin (a STRING key)    233.05            1
```

**THE FLOOR IS THE POINT: a fold that builds no array should beat materializing every value it
folds.** `min`/`max` are fused (route screen: `SHORTCUT, 0 applyStep calls`) and still lose slightly;
`sum`/`mean` were NOT fused (`generic, 1 call [sum]`) and lose by 2.7x. Reading the fold against the
bare hop instead would have made all five look fine.

## MEASURE THE INVARIANT, NOT A PROXY FOR IT (item 1918)

Fusing `sum`/`mean` was refused because summing in a different order is a different f64 and
byte-identity with Rust is a hard invariant. Items 1830/1831 tested **TS-fused against TS-generic**
— 25 cases, identical sequences — and still declined, correctly: that comparison is a PROXY. Rust is
free to sum in a different internal order than it emits `values` in, and then matching the emission
order buys nothing.

- **`fusedorder-check-1918.mjs` / `fusedorder-matrix-1918.mjs`** do the proxy comparison properly
  (11 fused walk shapes, fused vs declined via a `limit` above the row count): 11/11 identical order
  and bit-identical sums.
- **`sumorder-native-1918.ts`** does the real one: each shape on the TS engine and on the RUST
  engine over the FFI, f64 compared bit for bit. **12/12 bit-identical.**

**THE NATIVE TEXT IS DERIVED FROM THE TS PLAN** by `planToGremlin`, never written out beside it:
two hand-maintained spellings can drift into two different questions, and then a disagreement means
nothing. (The differential fuzzer does the same.)

**AND EVERY ARM CARRIES AN ORDER CONTROL — the first fixture FAILED IT.** `i % 7 === 0 ? 1e16 : 1`
looks order-sensitive and is not: the big term recurs ~N/7 times, dominates, and the sum came out
bit-identical forward and reversed, so the whole probe was vacuous and said so. A reciprocal ramp
`1/(i+1)` spans magnitudes without one term dominating. **An f64 agreement over associative input
proves nothing about summation order.**

## A MUTATION BATTERY'S BASELINE CHECK IS A FINDING IN ITS OWN RIGHT (item 1918)

`numfold-mutants-1918.mjs` never reached its first mutant: the BASELINE run failed, on an existing
test named `sum and mean are NOT folded` in `projected-aggregate.test.ts`. That is how the item
learned the refusal it was overturning is **locked in by a test**, not merely described in a comment
— which changed the decision from "fill a gap" to "overturn a deliberate lock", and the change was
reverted to the owner.

So: **assert the baseline passes before mutating.** It costs one run and it catches the case where
the thing you are "fixing" was decided on purpose.

## A FOLD'S COST CAN TRACK THE VALUE TYPE, NOT THE COMPARISON (item 1919)

`V().out(E).values(s).min()` measured **199.92 ms** against the numeric twin's 78.50, and against
its OWN floor — `values(s)`, which materializes all 800,000 strings — at **76.74**. So a fold that
builds no array cost **2.6x the arm that builds an 800,000-element one**, where the numeric fold was
1.26x its floor. Two hypotheses, both refuted before building:

- **THE STRING COMPARATOR.** `strcmp-ceiling-1919.mjs` prices the classify-as-you-fold reduction
  (`sort-key-specialize.ts`'s trick, which a fold can do with no O(n) pre-scan) at **4.98 ms** on
  ASCII — and at **nothing at all** once 1 string in 1000 carries a surrogate. `compareCodePoints`
  is 13.5 ns a call; all 800,000 comparisons are ~11 ms against a 123 ms gap.
- **A ROUTE DIFFERENCE.** "Same code" is not "same route", so the route screen gained
  `hop1: min STRING` / `hop1: values STRING` rather than the assumption being made. Both read
  `SHORTCUT, 0 applyStep calls`, identical to their numeric twins.

**IT WAS A GENERATOR BOUNDARY.** The fold iterated lazily where a `drain` exists (`toArray`
prefers one since item 1412; `foldProjectedList` takes it since 1909). **2.00x / 1.93x.**

**AND THE PROFILE NAMES THE SAME FRAME FOR BOTH ARMS, WHICH IS THE REUSABLE PART.** Both put

> 52% in `walk$3`'s lazy iterator — but it costs **~105 ns an element for numbers and ~210 for
> strings**, because the fixture's integers yield as SMIs where a string yields a HEAP POINTER. Same
> frame, same code, same route, 2x by value type.

**So read a fold against a floor of its OWN value type.** Comparing the string row to the NUMERIC
floor makes the gap look like the comparator, and it points there forever.

## AN ORACLE THAT CANNOT READ ITS FIXTURE'S TYPE IS NOT AN ORACLE (item 1919)

`projected-aggregate.test.ts` had no all-string column — only a MIXED one, which it excludes on good
grounds (replicating `compareTotal`'s cross-type ranks would make the oracle a second copy of the
engine). Adding `['pear','apple','fig','apple','quince']` failed TWO existing tests, and **the
engine was right**: the oracle reduced with `Number(b) < Number(a)`, `Number('apple')` is `NaN`, so
every comparison was false and the reduce returned the **FIRST** element — calling `fig` the minimum
where the engine correctly said `apple`.

The comparison is now chosen from the COLUMN'S TYPE: numeric columns keep the numeric reduce,
string columns get `<` (code-point order for ASCII), mixed stays excluded. A single-type column needs
no type ranks, so this is not re-implementing the subject. It had been passing for ~60 items purely
because no fixture exercised it.

## HOW TO MAKE A `drain` CHOICE NON-ROUTE-ONLY (item 1909, applied at 1919)

Taking a walk's `drain` yields the same elements in the same order, so no answer test can see it —
the textbook route-only mutant. Item 1909 declared exactly that an expected survivor, then REMOVED
the entry after driving the helper with a walk whose `drain` and iterator **disagree**:

```js
const walk = {
  *[Symbol.iterator]() {
    yield 999;
  },
  drain: () => [5, 3, 7],
};
expect(foldProjectedMinMax(walk, 'min')).toStrictEqual([3]); // 3, not 999
```

Plus the twin that the fallback still works (a walk with no `drain`, and a plain array). With both,
item 1919's battery is **6 mutants, 6 caught, 0 survivors** — a perf change gated by a test rather
than by an instrument. Prefer this to declaring the survivor whenever the choice is reachable through
an exported helper.

## A HAND CEILING MUST USE THE DATA STRUCTURE THE ENGINE WILL USE (item 1920)

`pathfuse-ceiling-1920.mjs` priced the `V().out(T).path()` fusion before it was built — the right
instinct, and it understated the available win by **3x**:

```
hand walk, no row built      15.78 ms
hand walk, far vertex only   19.35
hand walk, [near, far]       26.11      <- "the ceiling"; the allocation is only 6.75 ms
the engine, before          124.55      <- so 4.77x looked available
the engine, after             8.40      <- THREE TIMES FASTER THAN ITS OWN CEILING
```

The probe walked the adjacency `Set`s (`v.adjFrom.get(type)`) — the BUCKET arm — while the engine
takes the **CSR arm** on the second ask, a dense `Int32Array` walk instead of iterating 200,000
`Set`s. **A ceiling measured on the slower arm is a floor for the faster one**, and had the numbers
fallen the other way it would have justified declining a 14.8x.

Item 1893's `handCsr` arm got this right and is NAMED for the structure; this probe quietly was
not. The arm it did price is still the thing it was built for — the array allocation is 6.75 ms
either way, so "does the row allocation eat the win?" was answered correctly. It is the SCALE of the
headroom it got wrong.

## A 14.8x IS A REASON TO DISTRUST THE MEASUREMENT (item 1920)

The fused `path: hop path` row (8.40 ms) came out FASTER than `hop1: values` (50.21) — reading one
property per row costs more than building a 2-element array — and faster than the hand walk. A row
COUNT cannot tell a correct fusion from one building 600,000 cheap WRONG arrays.

`pathfuse-parity-1920.mjs` compares CONTENTS against the declining spelling (a `limit` above the row
count makes the plan four steps, so the gate refuses), element by element, asking each shape **COLD
(bucket arm) and WARM (CSR arm)** — 6/6 identical. And it checks the path holds the graph's OWN
vertices by **IDENTITY rather than by id**: a fusion that rebuilt them would compare equal by id
while being different objects, which a downstream `select`/`where(neq)` would see. A self-loop's two
slots must be the SAME object.

## `pathshape-probe-1920.mjs` — READ A LAYOUT OFF THE ENGINE BEFORE FUSING IT

```
V().out(E).path()            [V:a V:b] [V:b V:c] [V:d V:d]   [near, far]; self-loop [d,d]
V().in(E).path()             [V:b V:a] [V:c V:b] [V:d V:d]   near is STILL the scan vertex
V().outE(E).path()           [V:a E:e1]                      an EDGE in the path
V().out(E).values(n).path()  [V:a V:b "b"]                   a SCALAR in the path
V().out(E).out(E).path()     [V:a V:b V:c]                   three deep
V().out(E).path().by(n)      ["a" "b"]                       EVERY element projected
```

Only the first two share a row shape, which is what the gate admits. The `by` row was added AFTER
a mutant letting the gate admit `path().by(k)` survived — a shape with no test is a shape the gate
can quietly claim.

## THE FOURTH PATH IS THE DIRECTION THAT DISCRIMINATES (item 1920)

Item 1914 established that a walk written twice (lazy iterator, eager drain) over two arms (CSR,
bucket) is FOUR paths and the obvious tests reach two. Item 1920 reached all four and a mutant
still survived: the bucket arm reads `direct.forward ? e.to : e.from`, and **for `out` that IS
`e.to`** — so replacing the whole expression with `e.to` is invisible unless a cold-iterator test
uses `in`.

**So the fourth path is not just (arm x laziness) — it is (arm x laziness x the input that can tell
the two branches apart).** Enumerating the arms is not enough if every test feeds them the case
where both branches agree.

## THE PATH-DEPENDENT FAMILY WAS NINE-TENTHS UNMEASURED (item 1921)

`ast.ts`'s `PATH_DEPENDENT_KINDS` lists TEN step kinds that make `planReadsPath` true, and every
fused walk in the package is gated on `!tracksPath` — so each of them reaches no rung at all. The
workload screen carried exactly ONE (`path()`, added at item 1898, taken at 1920). Adding the rest:

```
pathdep: tree                  1294.12 ms        1 row    <- 16x the previous top row
pathdep: outE.otherV            328.12      600,000
pathdep: simplePath             318.82      599,998
pathdep: path().by(k)           314.43      600,000
pathdep: cyclicPath             162.00            2
pathdep: outE.inV (the twin)     46.21      600,000      <- the IDENTICAL answer
-----------------------------------------------------
edge: outE.has(w).inV            77.84      342,856      <- the screen's previous TOP row
```

**Five of six are above the entire rest of the screen.** The general form, and this is the second
time it has paid: when a gate excludes a whole FAMILY from every optimisation, measure the family —
not the one member that happened to get a screen row.

## A FALSE PATH DEPENDENCE COSTS MORE THAN THE STEP IT SITS ON (item 1921)

`outE(T).otherV()` is exactly `outE(T).inV()` — after a DIRECTED edge step the far end is fixed by
the direction, so nothing needs the path. But `otherV` is path-dependent BY KIND, and:

**SETTING `tracksPath` MAKES `effectivePlan` SKIPPED WHOLESALE** — and that chain holds item
1307's `outE(T).inV()` -> `out(T)`. So the long spelling disabled the very rewrite that would have
fixed it: **328.12 ms against the twin's 46.21.** The cost was the guard cascade, not the step.

So the fix is a path-dependence REMOVAL ahead of the path decision, not a new rung — after which
every existing fusion applies. And `readsPath` must be RECOMPUTED there, which `rewritten`
deliberately does not do: its note says a carried-over `true` is "at worst stale and only declines an
optimisation", and this is the one pass where that staleness would decline the optimisation it just
enabled.

**THE SUCCESS CRITERION FOR A SPELLING GAP IS EQUALITY WITH THE TWIN, not "faster"**: 48.71
against 47.72. `gremlin-spelling-probe.ts` now carries all three spellings (and the incoming mirror)
at a 1.17x / 1.14x spread — the groups that would have caught this and did not exist.

## "PROVE IT IS DEAD BEFORE DELETING IT" CUT THE OTHER WAY (item 1921)

A mutant dropping the `i === 0` guard in `normalizeDirectedOtherV` SURVIVED, which looked like dead
code. `otherv-index0-probe-1921.mjs` asked instead of assuming: `traversal()` always puts a source
first, **but `toArray` accepts a PLAN OBJECT**, so a plan whose steps begin with `otherV` is
reachable through the public API. With the guard the executor raises its own
`otherV() requires an edge`; without it, `steps[-1]` is `undefined` and `undefined.kind` throws a raw
`TypeError`.

So the guard was kept and given a test. Items 1899 and 1903 answered this same question oppositely on
one guard each — **the probe is what distinguishes them, and a surviving mutant is the prompt to
write it, not the verdict.**

Its sibling survivor is worth the same note: the `if (!changed) return plan` identity guarantee was
untested because the only identity assertion used a plan with NO `otherV` — which takes an EARLIER
early-out. **Two early-outs need two tests**, and `bothE` is the input that reaches the second.

## A TEST FOR "THIS CACHE MUST NOT BE USED HERE" NEEDS A FIXTURE WHERE THE CACHED VALUE DIFFERS (item 1922)

`tree()` keys every path position by `JSON.stringify(node.toJSON())` — the byte-identity contract —
which is **744 ms of a 1013 ms shape**, because a 600,000-row two-element path calls it 1,200,000
times over only 200,000 distinct vertices. A per-element memo is the obvious fix and is **gated on a
correctness condition**: the stream is pulled lazily, so a mutation step upstream of `tree()` runs
interleaved with the tree insertion, and an element keyed on both sides of its own mutation has two
legitimately different keys.

**THE FIRST MUTATION RUN LEFT FIVE SURVIVORS, FOUR OF THEM THE GATE MUTANTS** — memo on
unconditionally, `keysStable` forced true, gate inverted, `keysStable` defaulting true. The gate was
right; **the test could not have caught any of them.**

```
asserted: "1 of 2 top-level keys mentions z" on an acyclic a->b, b->c
reality:  the property step reaches the FAR end BEFORE tree keys it, so every element is
          mutated before its FIRST keying — a memo stores the already-mutated key and answers
          IDENTICALLY. The "1 of 2" was only "a was never mutated at all".
```

**TWO THINGS THE DISCRIMINATING FIXTURE NEEDS:**

- **A CYCLE**, so an element is keyed CLEAN, mutated, then keyed AGAIN. With `a->b, b->c, c->a` the
  traverser order is `[a,b] [b,c] [c,a]`: `a` is keyed at the top in the first and, after `property`
  mutates it in the third, keyed again under `c`.
- **A NESTED position, not the top level.** Every vertex there has one out-edge, so the top level is
  always three keys whatever happens. `treememo-stale-probe-1922.mjs` had to print the WHOLE tree:
  top-level `a` carries no `z`, nested `c > a` does — the same element with two different keys in one
  tree, which is exactly what a memo collapses.

**THE GENERAL FORM**: an acyclic graph cannot produce a stale read however the mutation is placed,
so the test was asserting something true for the wrong reason — the same class as CLAUDE.md's "an
answer that is INVARIANT to the property you varied cannot validate the fixture". **Before trusting a
"must not cache" test, construct the case where caching would give a different answer, and check the
test fails without the gate.**

## `tree-prof-1922.mjs` — `by(k)` IS THE INSTRUMENT THAT ISOLATES THE KEY

```
tree()           1013.61 -> 547.01 ms   <- 1.85x
tree().by(k)      269.67     267.90      flat: the SAME shape with treeKey SKIPPED
path()              8.66                 the same 600,000 paths, no keys at all
out(E).values(n)   30.32                 the walk alone
```

A `by` modulator replaces `treeKey` with the stringified modulator value and changes nothing else, so
`tree - treeby` is the key cost and nothing else: **73%.** Reading `tree()` against the hop or the
path floor instead would have mixed the key, the traversers and the nested insert together.

**AND IT PRICES WHAT IS LEFT**: the residual key cost is ~279 ms for the 200,000 genuinely
DISTINCT serializations (~1.4 µs each), reachable only by caching the canonical rendering ON THE
ELEMENT — a core change with the invalidation problem [[graph-counters-are-async]] describes. And
`tree().by(k)` at 267.90 is **31x `path()`'s 8.66** for the same paths: that is the tree MACHINERY,
and item 1920 showed this shape of cost falling to a whole-plan claim.

## `RunContext`'s CONSERVATIVE-DEFAULT CONVENTION, and why it needs its own assertion

`tracksPath` defaults to `true` so a context built without it is "always correct, just unoptimized".
`keysStable` (item 1922) follows it and defaults to **`false`** for the same reason — the dangerous
default is the other one. A mutant flipping that default SURVIVED until a test looked at it
directly (`expect(newContext().keysStable).toBe(false)`): the production call site always passes an
explicit value, so nothing else exercises it. **A safe default that nothing asserts is a comment.**

## A LENGTH GATE'S TEST IS THE SHAPE ONE TOO LONG _THAT NOTHING ELSE REFUSES_ (item 1923)

`normalizeDepth1SimplePath` gates on `steps.length !== 3 && steps.length !== 4`. Loosening it to
`steps.length < 3` SURVIVED every assertion — including the one written specifically for it.

```
the depth-TWO case it looks like it admits:  V().out(E).out(E).simplePath()
                                             -> the 4th step is the second `out`, so the
                                                `tail.kind !== 'simplePath'` check refuses it and
                                                the length gate never fires at all
what the length gate ACTUALLY protects:      [V, out, simplePath, values, count]
                                             -> destructures to the first four, the FIFTH step is
                                                silently DROPPED: 599,998 rows for a query that
                                                asked for ONE
```

**Item 1912 recorded the identical hole** ("nothing reached the case where the fifth step IS a
values and a SIXTH is silently dropped — 800,000 rows where the query asked for two"), in the same
module family. **When several checks overlap, a mutant on one of them is only caught by an input the
OTHERS let through** — so enumerate which check each test actually exercises.

## `as_`/`select` ARE NOT PATH-DEPENDENT — a stale claim that steered two items (item 1923)

Items 1900 and 1912 both state "`as_`/`select`/`path` make `planReadsPath` true, and every fused walk
is gated on `!tracksPath`". Measured:

```
V().out(E).simplePath()               readsPath = true
V().out(E).path()                     readsPath = true
V().as_(x).out(E).where(neq(x))       readsPath = FALSE
V().as_(x).out(E).select(x)           readsPath = FALSE
V().as_(x).out(E)                     readsPath = FALSE
```

`PATH_DEPENDENT_KINDS` contains neither `as` nor `select`. Those shapes were slow because **no rung
MATCHED them** — a different diagnosis with a different fix, and the one items 1912/1914 actually
applied. Both CLOSED.md lines are struck. The correction is load-bearing for item 1923: it is what
makes `V().as_(t).out(T).where(neq(t))` a legal rewrite TARGET, since that shape is path-free.

**So: check `readsPath` on the actual plan rather than inheriting a claim about which steps set it.**
One `console.log` settles it.

## `pathfam-shape-1923.mjs` + `simplepath-parity-1923.mjs` — the family's remaining shapes

What `simplePath`/`cyclicPath`/`path().by(k)` actually yield at depth one, read off the engine:

```
V().out(E)                       b  c  d        <- d is the self-loop
V().out(E).simplePath()          b  c           <- the FAR VERTEX, self-loop dropped: a pure FILTER
V().out(E).cyclicPath()          d              <- the complement
V().out(E).path().by(n)          [a b] [b c] [d d]
V().out(E).out(E).simplePath()   c              <- depth 2 needs all THREE distinct: different test
```

**THE PARITY PROBE ASSERTS ITS FIXTURE CONTAINS SELF-LOOPS BEFORE COMPARING ANYTHING.** Without
them `simplePath` and the plain hop agree and all ten comparisons pass for the wrong reason — the
"answer INVARIANT to the property you varied" trap. It also checks the PARTITION
(`out(E) 60000 = simplePath 59998 + cyclicPath 2`), because a wrong filter returns a plausible count.

## `JSON.stringify` RENDERS `undefined` INSIDE AN ARRAY AS `null` — a probe that hid the one thing that mattered (item 1924)

`pathby-shape-1924.mjs`'s first version printed rows with `JSON.stringify` and reported
`path().by(opt)` as `[[1,null],[1,null]]` for a graph where one far vertex is MISSING `opt` and the
other holds a stored `null`. The two looked identical, and the obvious implementation (`?? null`)
looked correct. **They are not identical:**

```
path().by(opt)      [1, undefined]   <- the far vertex has NO `opt`
                    [1, null]        <- the far vertex has a STORED null
values(opt)         null             <- ONE row: `values` DROPS the absent key, keeps the null
path().by(toString) [undefined, undefined]   <- Object.hasOwn, not `in`
```

So `path()`'s `by` and `values()` disagree on an absent key **by design** — one yields `undefined`
in place, the other drops the row — and a fusion building `null` would have been **a wrong answer no
JSON comparison could ever see**.

**THE RULE: if a probe's output passes through `JSON.stringify`, it cannot distinguish `undefined`
from `null`, a sparse hole from a filled one, or a `Map` from `{}`** (the last one is a bug this repo
already shipped — `treeStep`'s note records a nested `Map` stringifying to `{}` as "the silent
empty-tree bug this replaces"). Render the values yourself when the distinction is the point.

And mirror the real projection rather than re-deriving it: `evalBy`'s `'key'` arm is
`Object.hasOwn(bag, key) ? bag[key] : NO_VALUE` and `byOr` maps NO_VALUE to `undefined`.
`Object.hasOwn` rather than `in` is load-bearing — with `in`, `path().by(toString)` would put
`function toString()` in the row. [[prototype-key-class-not-a-bug]]

## EXTENDING A FUSED RUNG INVALIDATES THE PREVIOUS ITEM'S MUTANT ANCHORS BY CONSTRUCTION (item 1924)

Adding the `by(k)` mode to item 1920's rung rewrote every row site and the gate, so **NINE of that
item's mutants matched zero occurrences and did not run**. The battery reported all nine in ONE run
rather than throwing on the first — item 1914's harness fix earning itself in exactly the situation
it was built for ("a refactor that moves five of them costs five runs to discover").

Each was **re-anchored onto the new text, keeping its original name and intent**. A dead mutant
silently loses the coverage the earlier item built, and a battery reporting "20 caught" while nine
entries never executed is worse than no battery at all.

**So re-running the previous item's battery is part of the change, not a formality** — and the
thing to read is the ANCHOR-DRIFT list, not just the survivor count. A drifted anchor reports as
neither caught nor survived.

**AND A MODE MULTIPLIES THE PATHS AGAIN**: a walk written twice (lazy, eager) over two arms (CSR,
bucket) is four paths; a mode makes eight. Item 1920's battery found three of its four untested, so
each new arm gets its own per-arm mutant and the tests drive the iterator's CSR _and_ cold-BUCKET
arms for the new mode specifically — not just the drain that `toArray` happens to take.

## `tree()` FUSION DECLINED AT 1.55x — and the ceiling arm is where item 1920's mistake was NOT repeated (item 1925)

```
tree-ceiling-1925.mjs, 200,000 vertices / 600,000 E-edges, median of 7:

walk    the CSR traversal, no tree, no keys        0.36 ms   <- the walk is FREE
keys    + the canonical key, memoized            149.65      the CONTRACTUAL floor
tree    + the nested insert — the WHOLE tree      350.23      <- the ceiling
the engine today                                  542.94      so 1.55x, ~193 ms available
```

**THE HAND ARM WALKS THE CSR, NOT THE BUCKETS.** Item 1920 priced its fusion against a hand walk
over the adjacency `Set`s while the engine takes the CSR arm on the second ask — its "ceiling" came
out **3x BELOW** what the engine then achieved. Here the same size reads **0.36 ms on the CSR against
15.78 on the buckets**, which is the whole difference between a useful ceiling and a misleading one.

**WHY 350 ms IS A FLOOR AND NOT A RESIDUAL**: 149 ms is the canonical `toJSON()` key (contractual
byte-identity, already memoized to the 200,000 distinct serializations) and 200 ms is 600,000
two-level inserts into plain objects (~334 ns each). **The plain object is contractual too** —
`treeKey`'s note records that "a nested `Map` would stringify to `{}` — the silent-empty-tree bug
this replaces", so the faster structure is the one already removed for being wrong. A whole-plan
claim removes only the pipeline between them.

## AND `forEach`'s PER-ROW CLOSURE IS NOT THE COST (item 1925)

`treeStep`'s `t.path.forEach(callback)` allocates a closure per ROW (it captures `cursor`) and is
invoked 1,200,000 times, and the profile puts **27%** in that frame. Replacing it with an indexed
loop: **535-538 ms against 546, ~2%, inside the spread.**

V8 inlines the callback, so the frame's 27% is the WORK inside it — the `bys` test, the key
dispatch, the nested lookup and insert — not the dispatch. **A `forEach` frame high in a profile is
not evidence that `forEach` is the problem**, which is [[frame-attribution-trap]] in its third form
this session (after a getter frame at item 1916 and a lazy-iterator frame at item 1919).

## MEMORY IS FOUR DIFFERENT QUANTITIES, and this index was 500 items behind (item 2458)

This file's allocation section stops at item 1925 and predates EVERY memory instrument built since.
That is not a cosmetic gap: item 2457 wrote a second peak-live probe because this index did not
mention the first one. It mentioned `peakmem` once in 3,000 lines and `alloc:peak` not at all.

**Match the quantity to the question before picking a probe — three of these four are routinely
quoted for each other, and only one of them bounds what the engine can answer at all.**

| quantity      | what it is                           | instrument                      | what it CANNOT tell you                                                                                                                                              |
| ------------- | ------------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHURN         | total bytes allocated over a window  | `bun run alloc` (item 2416)     | nothing about simultaneity; a nursery recycles it. `hop2generic` churns 218 MiB at 5.7% GC and is fine                                                               |
| RETAINED      | what SURVIVES the window             | `bun run alloc` (2416)          | nothing about the middle of the walk                                                                                                                                 |
| COUNT / SITE  | how many allocations, and where      | `bun run alloc:count` (2418)    | nothing about how many are alive AT ONCE                                                                                                                             |
| **PEAK LIVE** | the high-water mark DURING the query | **`bun run alloc:peak`** (2419) | — this is the OOM bound. A shape whose peak is CONSTANT in the walk answers any size; one whose peak GROWS has an OOM size, and that size is a property of the SHAPE |

Also here: `alloc:gcobs` (GC observation), `alloc:write` (the write path, item 2432 — five probes
preceded it and all five were reads), `alloc:rust` / `alloc:wasm`, `alloc:gremlin` (2449, the Gremlin
surface's first memory numbers), `alloc:askpolicy`, `alloc:labeltest`, and `alloc:retained` (2457,
which DUPLICATES `alloc:peak` and should be folded into it or dropped).

### `alloc:peak`: USE `MECH=cap`, NOT `MECH=highwater` — measured at item 2458

`alloc:peak` has three mechanisms and they are not interchangeable:

- `MECH=highwater` samples `GCProfiler`'s per-collection `usedHeapSize`, so it only ever reads when
  **V8 chooses to collect**. At item 2458 it FAILED ITS OWN CONTROL CHECK: the probe states that
  `hop1` (returns every row) must grow as ~n^1 and `hop1count` must be ~n^0, and highwater reported
  `hop1` as **n^0.05, "CONSTANT - no OOM size"**. It also had a full 200,000-row sort peaking at
  **0.09 MiB**, which is impossible. Fewer collections at larger heaps means fewer samples.
- `MECH=cap` **takes a `CAP_STEP` (default 8 MiB, item 2475)** and bisects the smallest
  `--max-old-space-size` at which the shape completes, in child
  processes, differenced against a graph-only arm. It asks the OOM question directly instead of
  inferring it from sampling, and at 2458 its controls PASSED: `hop1count` needed 0 MiB at both
  sizes, `hop1` needed 8 MiB at 50k and 16 at 200k.

  ⚠️ **THE DEFAULT STEP HIDES ANY EFFECT UNDER 8 MiB, and item 2474 mistook that for the mechanism
  being unfit.** Sweeping fanout gave exactly 8 MiB in every cell INCLUDING the linear control, which
  made the rows unreadable rather than flat. At `CAP_STEP=1` the same cells read 0 (constant control)
  and 3 -> 4 (linear control). **When a known-exponent control does not move, check whether the
  resolution is a CONSTANT you can change before declaring the mechanism unfit.** A finer step costs
  `log2(8 / step)` extra child processes per arm.

- `MECH=rss` is **refuted by its own controls** (see the probe header) and kept only to answer "did
  the query exceed what building the graph already needed".

**READ THE CONTROL LINE THE PROBE PRINTS.** It names the two arms whose exponents are known a
priori; when one of them is wrong, every other row in that run is unusable, however plausible it
looks. This is the same discipline as [[frame-attribution-trap]], applied to a growth exponent
rather than a profile frame.

### `frontier-mech-2476.mjs` — BFS-by-levels against DFS, with no engine in the way

`bun --expose-gc packages/native/frontier-mech-2476.mjs` (knobs `MECH_N`, `MECH_DEG`, `MECH_DEPTH`,
`MECH_STEP`, `MECH_REPS`). Prices the mechanism behind `repeatStep`'s frontier over a plain adjacency
array: a level-materializing walk against a stack-based one, asserted to emit the SAME multiset, with
a streaming control, a holding control and the holding/streaming ratio as a GATE (exit 1 under 10x).
At N=20,000 DEG=3 DEPTH=3 it reads 29.76 MiB for BFS-by-levels, **0.00 for DFS**, and 29.60 for the
holding control — so the level frontier costs what holding every row costs. The fixture guards the
`(k * DEG + d) % N` generator trap by counting distinct endpoints.

### `unwrap-probe-2483.ts` — the local-scope conformance map against TinkerPop

`cd packages/gremlin && bun unwrap-probe-2483.ts`. 21 local-scope cases with the TinkerPop 3.7.3
value beside each, printing `agree`/`DIFFER` and a total. Currently 14 agree, 7 differ, and the
differences have THREE causes, not one: the n=1 unwrapping (5 cases — the trigger is the REQUESTED
WINDOW SIZE, not the result's size, which `limit(local,2)` over a one-element list proves by staying
wrapped), `sample` having no local-scope overload (1), and an empty window dropping the ROW in
TinkerPop where lenke keeps it (1). `dedupe` also has no local overload, so that case is not askable
at all — and asking it anyway is what produced two FALSE `agree` rows in the first draft, since a
fixture of distinct values cannot tell a dedupe from a non-dedupe.

### `by-forms-probe-2485.ts` — the `by()` modulator family against TinkerPop

`cd packages/gremlin && bun by-forms-probe-2485.ts`. 15 `by()` forms with the TinkerPop 3.7.3 value
beside each: `by()`, `by(Order.desc)`, `by(key)`, `by(key, comparator)`, `by(traversal)`,
`by(traversal, comparator)`, `by(T.label)`, and the modulator on `groupCount`/`dedupe`/`path`/`tree`/
`project`/`select`/`sample`. Currently **15 expressed, 0 inexpressible, 0 disagreements** — the family
is complete and conformant.

⚠️ It serializes Maps by hand, and must: `group`/`groupCount` return a real `Map` and
`JSON.stringify(new Map([['java', 2]]))` is `{}`, which made the first run report
`groupCount().by('lang')` as a wrong answer when the Map held exactly the right entries. **Any probe
that `JSON.stringify`s a step's output reads every Map-returning step as empty.**

The fixture is the modern graph because each form's presence CHANGES the answer on it (two labels,
`java` twice, four vertices missing `age`/`lang`). It also pins two TinkerPop semantics in passing,
both agreeing: `group().by(trav).by(trav)` reduces to a SINGLE value where `by(key)` collects a LIST,
and `dedup().by(key)` DROPS vertices missing the key rather than grouping them under null.
