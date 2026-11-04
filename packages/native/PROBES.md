# The TS-side probes, indexed by question

`packages/native` holds dozens of `*-probe.ts` files. Most answer one historical question and are
kept for the numbers in their header, which is where a rejected lever's evidence lives. This file
indexes only the **cross-cutting** ones — the instruments a new measuring pass should run BEFORE
hunting, because each checks a property of the whole engine rather than one shape.

CLAUDE.md states the rule for the Rust corpus: _"Writing a new benchmark feels like progress and
reading three file headers feels like overhead. It is the other way round."_ The same applies
here, and more so — the Rust side is indexed by question in `crates/lenke-engine/examples/README.md`
and this side was not indexed at all.

## Invariant probes — a property that must hold, not a number to beat

Each of these was built because a violation was FOUND. A violation is a planner choosing a route
for a reason other than cost, and it is invisible to every correctness test, because both routes
return the same rows.

| probe                        | the property                                                                                | last run                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `spelling-probe.ts`          | equivalent GQL spellings of one predicate cost the same                                     | clean; its one flag is item 644's BUILT-AND-REVERTED product lever                                                |
| `gremlin-spelling-probe.ts`  | the same for Gremlin (item 1305)                                                            | zero flagged AT `SPELL_N=200000`; **1M flagged a new 2.00x group** (item 1332)                                    |
| `surface-parity-probe.ts`    | GQL and Gremlin cost the same for ONE question                                              | found 1322's 5.78x and 1334's 1.92x; `two-hop-count` now GQL 1.35x FASTER, gap reversed                           |
| `index-never-hurts-probe.ts` | adding an index never makes a query slower (item 1324)                                      | holds on 17 shapes, both surfaces                                                                                 |
| `id-lookup-is-o1-probe.ts`   | lookup by id is FLAT in graph size (item 1326)                                              | holds on 8 arms over a 16x range                                                                                  |
| `id-lookup-hotset-probe.mjs` | whether that probe's residual drift is CACHE or COMPLEXITY (item 1395)                      | CACHE: flat in N at a fixed hot set, rising in hot set at fixed N — O(1) confirmed at **~5 ns hot / ~18 ns cold** |
| `order-probe-1389.mjs`       | a rewritten adjacency walk yields the SAME SEQUENCE, not just the same multiset (item 1389) | BASE vs HAND identical for both `out('E','F')` and `out('F','E')`                                                 |

⚠️ `order-probe-1389.mjs` CARRIES ITS OWN VACUITY CHECK, and it needs one. Gremlin stream order is a
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
| `product-inline-seed-probe.ts` | ⚠️ NEVER reproduced the gap it was built for — see item 1333 before trusting it              |

`notfold-soundness-check.ts` is not a timing probe — it answers whether a rewrite is ALLOWED. Item
1331 folds `not(hasNot(k))` into `hasKey(k)` for 16.9x, and the two are exact duals on elements but
NOT on anything else: after `properties()` they give 1 and 3, after `values()` 0 and 2, because
`hasNot` returns false for a non-element. Run it before widening that fold's allow-list, and in
general whenever a rewrite's soundness depends on what the stream carries.

**⚠️ A BESPOKE PROBE CAN FAIL TO REPRODUCE WHAT A SHARED ONE SHOWS.**
`product-inline-seed-probe.ts` was built to bisect item 1333's 2x and matched the spelling probe's
fixture on TEN dimensions — N, edge count, labels, property richness, the NDJSON load path,
index-build order, the second index, one-process multi-shape timing, two-pass min, the per-rep
`JSON.stringify` — and never showed the gap, before OR after the fix. So its flatness is not
evidence a change does nothing, and the cause is still open (`ts-closure-size-is-load-bearing` is
the standing suspect: that probe is ~1,500 lines, this one ~250). Item 1334 is the contrast worth
copying: when a gap shows on one instrument and not another, READ THE DECLINE in the planner rather
than bisecting the fixture further — the guard answered in one look what ten measured arms could not.

**⚠️ AND SWEEP THE DEGREE, NOT JUST THE SIZE.** `two-hop-surface-probe.ts` exists because the parity
probe's fixture is a degree-1 CHAIN, where a two-hop degree product has nothing to multiply. The gap
held at degree 2 and 3 so the target was real — but the RATIO is locality-sensitive (1.81x on the
sequential chain, 1.42x on scattered targets, absolute costs 2.7x apart), so quote the fixture with
the number.

**⚠️ RUN THE SPELLING PROBES AT MORE THAN ONE `SPELL_N`.** Item 1331 closed the last flagged group
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
NODES=200000 PROF_OUT=$D/hopfilter.cpuprofile node runtime-profile-probe.mjs hopfilter 120
node runtime-profile-analyze.mjs $D
```

**⚠️ ITS VERDICT HAS LIED IN SIX DISTINCT WAYS, each found by pointing it at a new surface or by two
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

**⚠️ "HAS MENTIONS" IS NOT "IS OPTIMIZED".** The signal is binary, so a frame can be 41.9% of its
shape and three passing references retire it. Chase the nominations by hand.

**⚠️ A SHARE IS A NOMINATION; AN ABLATION IS THE PRICE.** Three instances now: `edgesOfTypes` read
37.9% self for a path that is a single `Map.get` (1104); a clean 3.8x micro landed at **1.11x** in the
engine (1364); `bucketsOf` profiled at 9.2% and ablated at **3.7%** (1368). Expect the share to
overstate by ~2.5x and price in the engine, or say plainly that you have not.

**⚠️ WINDOW THE PROFILE ABOVE ~20k ELEMENTS.** `--cpu-prof` covers the whole process, so at 200,000
the fixture build INVERTS the ranking — `getVertexById`, `indexEdgeLabel` and `commitElementLabels`
at the top of every shape, all load, no query (item 1362). Raising reps is not the fix; it shrinks the
build's fraction while costing time in the dimension being swept.

**⚠️ WRITING AN ITEM ABOUT A FRAME RETIRES IT FROM THE SCREEN.** `topKNodeWalk` had ZERO mentions when
1358 flagged it and one afterwards — 1358's own entry. The ZERO signal is ONE-SHOT, so a flagged frame
must be taken or explicitly priced in the same pass, or the next run reads clean with the work open.

### What the screen found, so it is not re-run for the same answer

Both query surfaces at 20k AND 200k, plus the write path: **no unpriced frame survives**. Every
nomination resolved to work already measured — `topKNodeWalk` to item 1064, `compareCodePoints` to
921's declined hoist, `expandSlot`/`slotChainCount`/`bucketsOf` to 1104/1105/1108/1152, and
`drainMutations` priced at 1.7% and declined (1360). **The size sweep is the part worth repeating**:
`propOf` grows 1.4-3.5x and `degreeOfTypes` **7.2x** from 20k to 200k (item 1365), so a
cache-resident measurement understates anything on those paths.

## The ALLOCATION screen — `--heap-prof` is UNFIT, calibrate before believing it

| file                       | what it does                                                             |
| -------------------------- | ------------------------------------------------------------------------ |
| `heap-prof-calibrate.mjs`  | allocates 128 MiB through ONE named function, in retained + garbage arms |
| `runtime-heap-analyze.mjs` | reads `.heapprofile`, same cross-check as the CPU analyzer               |
| `gc-cost-probe.mjs`        | GC pauses with duration and KIND, via `PerformanceObserver`              |

**⚠️ `node --heap-prof` REPORTED 0.7 MiB FOR 128 MiB ALLOCATED** and never named the allocating
function, identically in both arms (item 1361). The analyzer is kept because its format reading is
correct and the defect is upstream — but conclude NOTHING from it until `heap-prof-calibrate.mjs`
passes. This is the only instrument in this directory found wholly unfit rather than subtly biased.

`gc-cost-probe.mjs` is the one that works: it put the write path at **17.6% GC** against the CPU
profile's 18.6% for the same shape — two instruments agreeing within a point, which is what makes
either trustworthy. It also found the split that changes the reading: **93% is MINOR scavenge**, and
minor cost scales with what SURVIVES the nursery, so when the thing being built is a graph the caller
keeps, this is promotion of the data structure and not eliminable churn.

**⚠️ DRAIN A `PerformanceObserver` BEFORE READING IT.** Entries arrive in a queued callback, so a
fully synchronous rep loop buffers every one and `disconnect()` fires first — the probe's first
version reported **0 pauses and 0.0% GC** for a run profiling at 18.6% (item 1361).

**⚠️ A `Graph` KEEPS ITSELF ALIVE UNTIL THE HOST YIELDS.** Its first write schedules
`setTimeout(this.notify, 1)`, and a pending timer holds `this.notify`, which holds the Graph. A
synchronous loop building many graphs retains all of them: heap 148 / 614 / 1242 MiB at 10 / 45 / 90
reps, and a 256 MiB cap OOM-crashes. Not a leak — one macrotask drains it — but a benchmark that
builds graphs in a tight loop is measuring a different heap than it thinks.

## The ISOLATED ROW BENCHES — for a sub-10% question on ONE row

| file                         | surface                                            |
| ---------------------------- | -------------------------------------------------- |
| `isolated-row-bench.mjs`     | one GQL row (`SHAPE=hopfilter NODES= REPS= DROP=`) |
| `isolated-gremlin-bench.mjs` | one Gremlin row (item 1368)                        |

Per-rep timing, `p25` headline, full distribution, GC accounted, answer in the output so a driver can
assert the arms agree.

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

**⚠️ THE NOISE IS PROCESS-LEVEL, SO NO ESTIMATOR FIXES IT.** Replacing the loop-total with CLAUDE.md's
own median-of-14 moved the floor from 12% to 13.2% — no better (item 1367). Each process builds its
own fixture and gets its own heap layout, and that offset applies to every rep in it. **The unit of
sampling is the PROCESS**: `p25` within one, many processes per arm, arms interleaved.

**⚠️ A LONG ROW MEASURES 4-5x BETTER THAN A SHORT ONE.** The Gremlin 3-hop row is ~300 ms a rep and
has a 2.9% floor; the GQL hop-filter row is ~3.5 ms and has 13.2% (item 1368). **Pick a fixture size
that makes the row long before adding reps.**

**⚠️ RECORD THE CONCORDANCE, NOT JUST THE RATIO — n=8 WOULD HAVE SHIPPED A NO-OP.** An
answer-preserving four-line fast path read **+2.6% faster at n=8** and **−0.3% at n=24** (item 1367).
What stopped it was counting pairs: 43 of 64 favoured it, where 32 is chance. "Two medians 2.6% apart
with overlapping distributions" invites shipping; "43 of 64 pairs" does not.

**⚠️ AND n=8 IS SIGN-UNSTABLE BELOW ~3% ON A ~300 ms ROW — three independent demonstrations, in both
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

**⚠️ QUOTE p OR THE PAIR COUNT, NOT A RATIO ALONE.** Item 1380's +0.96% at n=24 looks like a small
win and is not one: U = 351 against an expected 288 with SD 48.5 gives z = 1.30, p ≈ 0.19. "No
detectable difference" is a result and should be written as one.

**⚠️ `p25` PER PROCESS, MEDIAN ACROSS PROCESSES — a MEAN inverts verdicts.** Item 1380's faster arm
carried outliers at 350.31 and 324.15 where the slower arm's largest was 320.17, so a mean reads the
faster arm as a regression. Print the distribution beside the summary; a bimodal series summarised is
a lie, and this is the shape it takes.

**⚠️ WITHIN one interleaved run, n=24 resolves ~1%; ACROSS runs the absolute level drifts ~3%.**
Compare arms inside a run; never against another run's number.

**⚠️ EXTRACT THE BASELINE WITH `git show <ref>:<path>`, DO NOT RECONSTRUCT IT.** Item 1380's BASE came
from `git show HEAD~1:…`, which is the pre-change engine verbatim; a patch-reconstructed arm can drift
from the committed diff. Assert that both arms share every OTHER change you are not measuring — 1380
checked `walkBucket` appeared 4 times in both, without which it would have measured two items at
once.

## More bespoke probes

| probe                        | question                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `prop-bag-regime-probe.mjs`  | WHY the property read grows with size — and three refutations (item 1363/1364) |
| `engine-bag-shape-probe.mjs` | does bag SHAPE reach the engine? **1.11x — no** (item 1364)                    |
| `token-drain-probe.mjs`      | `drainMutations`' duplicate-token array vs a count map (item 1360)             |
| `ordinal-churn-probe.mjs`    | what DELETES cost a never-reused dense ordinal (item 1372)                     |

`prop-bag-regime-probe.mjs` closes three levers with numbers, so they are not re-attempted:
megamorphic bag shapes cost **nothing at 200k** relative to one hidden class, `Object.freeze` is
**free at every size**, and a `Map` per element is **3.18x WORSE**. The one thing that wins is a
`Float64Array` column — **3.55x and FLAT in size** — which is the layout lever, i.e. a data-model
change, not a local one.

**⚠️ IT ALSO VIOLATED ONE-SHAPE-PER-PROCESS AND INVERTED ITS OWN TABLE** (item 1364). Its five arms
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
