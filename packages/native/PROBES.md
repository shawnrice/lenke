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

| probe                             | the property                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | last run                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spelling-probe.ts`               | equivalent GQL spellings of one predicate cost the same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | clean; one flag is item 644's reverted product lever. **Gained TEMPORAL groups at 1490 (2.29x)**                                                                                                                                                                                                                                                                                                        |
| `gremlin-spelling-probe.ts`       | the same for Gremlin (item 1305)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | zero flagged AT `SPELL_N=200000`; **1M flagged a new 2.00x group** (item 1332)                                                                                                                                                                                                                                                                                                                          |
| `surface-parity-probe.ts`         | GQL and Gremlin cost the same for ONE question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | found 1322's 5.78x and 1334's 1.92x; `two-hop-count` now GQL 1.35x FASTER, gap reversed                                                                                                                                                                                                                                                                                                                 |
| `index-never-hurts-probe.ts`      | adding an index never makes a query slower (item 1324)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | holds on 17 shapes, both surfaces                                                                                                                                                                                                                                                                                                                                                                       |
| `id-lookup-is-o1-probe.ts`        | lookup by id is FLAT in graph size (item 1326)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | holds on 8 arms over a 16x range                                                                                                                                                                                                                                                                                                                                                                        |
| `id-lookup-hotset-probe.mjs`      | whether that probe's residual drift is CACHE or COMPLEXITY (item 1395)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | CACHE: flat in N at a fixed hot set, rising in hot set at fixed N — O(1) confirmed at **~5 ns hot / ~18 ns cold**                                                                                                                                                                                                                                                                                       |
| `order-probe-1389.mjs`            | a rewritten adjacency walk yields the SAME SEQUENCE, not just the same multiset (item 1389)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | BASE vs HAND identical for both `out('E','F')` and `out('F','E')`                                                                                                                                                                                                                                                                                                                                       |
| `rung-precedence-census.mjs`      | **WHICH of the 20 rungs answers each shape, and which willing rungs are STARVED** (item 1775) — ⚠️ its 10 GENERAL-PATH shapes now have bench rows (item 1785), 2 of them CORRECT declines — ⚠️ **RUN IT WITH `bun`, NOT `node`**: it imports `rewrites.ts`, so node dies on `auto-param.js` resolution (item 1785 hit this; a dead oracle is what item 1775 itself was built after)                                                                                                                                                                                                                                | 79 shapes: only 5 contested, 3 pairs, all 3 correctly ordered. 10 shapes on the GENERAL PATH — that list is the open surface                                                                                                                                                                                                                                                                            |
| `executor-duplication-census.mjs` | **WHICH executor functions are NEAR-DUPLICATES, and which pair was MEASURED on only ONE side** (item 1787) — the companion to the rung census: that one asks which rung answers a shape, this one asks whether the same walk was written twice. ⚠️ A HIGH SCORE IS A CANDIDATE, NOT A FINDING: its top row (`stackedWalk`/`pairSlotWalk`, 122L byte-identical) is duplicated ON PURPOSE at item 1681, and collapsing it cost the depth-3 row 1.26x. ⚠️ Its ASYMMETRIC-CITATION screen reads COMMENTS, so it must scan the RAW body — the first cut scanned the comment-STRIPPED body and reported a pair BACKWARDS | 611 functions, 28 pairs >= 0.80. Found the subquery TRIPLET where item 1500's `for...in` fix reached 1 of 3 copies                                                                                                                                                                                                                                                                                      |
| `page-rung-probe.mjs`             | what LOSING a projection rung to a page costs (1775); its `*param` arms were the BEFORE route at 1776/1777 and are SPELLING TWINS since 1778                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | page taken: node **7.27x**, hop START **8.14x**, hop FAR **4.87x**, parameterized **7.14x/7.98x/4.81x** (1776-1778); every spelling pair now flat. ⚠️ `hopoffset` is **1.28x FASTER than `hoplist`**, which item 1777 read as a suspect walk choice — ~~suspect~~ **it is this probe's own degenerate fixture: items 1438 and 1779 both decline the gate, 7 of 8 cells say the shipped route is right** |
| `offset-order-equiv.mjs`          | SPELLING (literal vs `$s`) and SELF (paged vs unpaged-sliced) for the paged rungs; ⚠️ it was the cross-ROUTE oracle until 1778 removed the last general-path spelling                                                                                                                                                                                                                                                                                                                                                                                                                                              | SPELLING identical on all 16 rows; SELF differs for the far-read hop, which is 1777's forced start-driven walk and expected                                                                                                                                                                                                                                                                             |
| `offset-rung-profile.mjs`         | the two profiles behind that 7.9x, windowed past the fixture build (item 1775)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | general path 3424 ms engine vs the rung's 426; **`internalSkip` is 3.7% — losing the rung is the other 96%**                                                                                                                                                                                                                                                                                            |
| `skip-only-page-parity.ts`        | do TS and NATIVE agree POSITIONALLY on an UNORDERED skip-only page — the shape every fuzzer is blind to (item 1776)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | node proj / 2col / `WHERE` IDENTICAL paged AND unpaged; **hop FAR's UNPAGED order already differs between the engines**                                                                                                                                                                                                                                                                                 |
| `hop-walk-fanin-ab.sh`            | FAR-driven against START-driven on the SINGLE-type hop, the walk choice NO gate guards, swept over `FANIN` × `FANOUT` × `STRIDE` (item 1779)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | far-driven wins **7 of 8 cells, 1.91x-8.26x**, and its margin GROWS as fan-in concentrates; the sole dissenter is `small`/fanout 1. Reproduces item 1438's cells to **0.01x** on a harness sharing no code with it                                                                                                                                                                                      |
| `far-driven-predicated-parity.ts` | do TS and NATIVE still agree as MULTISETS on a filtered hop projection now that TS far-drives it (item 1781) — ⚠️ the shape `bun run fuzz` does NOT cover                                                                                                                                                                                                                                                                                                                                                                                                                                                          | all 7 admitted shapes **SAME SET, DIFFERENT ORDER** against native, every DECLINED control **IDENTICAL** — so the order difference is attributable to the new route and the multiset never moves                                                                                                                                                                                                        |
| `order-residual-ab.sh`            | does admitting `order` as a residual over the bare hop pay, and what does it cost the rows it cannot reach (item 1783)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | target **1.536x** (79.4 -> 51.7 ms), 5/5 rounds below the base median, 11/11 arm assertions; ⚠️ a control read **0.95x at three rounds and 1.081x at five** — the 5% was never there                                                                                                                                                                                                                    |
| `gremlin-order-by-key-parity.ts`  | do TS and NATIVE agree POSITIONALLY on `V().out(T).order().by(k)` (item 1783) — ⚠️ the Gremlin fuzzer generates ZERO property-key `by()` modulators                                                                                                                                                                                                                                                                                                                                                                                                                                                                | all 5 cases IDENTICAL incl. a TIED key; ⚠️ **it was VACUOUS on its first run** (key derived from the edge permutation, so walk order == sorted order) and now carries a can-fail GUARD                                                                                                                                                                                                                  |
| `walk-ab-aggregate.mjs`           | reduces that driver's log to one row per cell — `p25` per process, median across rounds — and REFUSES a table whose arms stopped answering the same question                                                                                                                                                                                                                                                                                                                                                                                                                                                       | guard mutated (one arm's `rowCount` rewritten): **3 cells flagged, exit 1**                                                                                                                                                                                                                                                                                                                             |

⚠️ **A PROBE CAN GO TAUTOLOGICAL WHEN THE CHANGE IT INFORMED SHIPS, and that is the dead oracle's
quieter sibling.** `offset-order-equiv.mjs` compares the UNPAGED query's rows, sliced, against the
PAGED query's. Before item 1776 those were two different ROUTES for the node shapes — the rung and
the general path — which is what made its `IDENTICAL` verdict evidence. Item 1776 gave the paged
shape to the same rung, so for the node rows it now compares the rung against itself and cannot fail.
Item 1775's rule was "run a probe before citing it"; this is the other half: **check that the probe
can still FAIL.** ⚠️ **AND IT HAPPENED TWICE MORE, TWO ITEMS APART**: item 1778 closed
the literal-vs-parameterized gap and so removed the last GENERAL-PATH spelling of a skip-only page
from the engine — which is what the cross-route oracle was made of. **A fix that closes a gap can
delete the instrument that proved the previous fix correct.** The answer is not to keep a slow route
alive as a test fixture: `skip-only-page.test.ts` now expects an ABSOLUTE enumerated row list, which
no route change can erode, and `skip-only-page-parity.ts` holds the cross-engine half. ⚠️ **AND IT WAS REPAIRED AT ITEM 1777 RATHER THAN LEFT WITH A NOTE**, once item
1777 gave the hop page to the same rung and the last falsifiable rows went with it. It now reports
two comparisons per case and labels them: **ROUTE**, the literal `OFFSET k` against the
parameterized `OFFSET $s` — which declines the rung on purpose, so this is the real cross-route claim
and the only one that decides the exit code — and **SELF**, the paged query against the unpaged query
sliced, which legitimately DIFFERS for a shape whose rung changes its walk when paged. The
cross-ENGINE half is `skip-only-page-parity.ts`, and the per-shape assertions are in
`skip-only-page.test.ts`.

⚠️ **AND THE FUZZERS WERE BLIND TO THE WHOLE SHAPE** (item 1776). Every page the differential fuzzer
generates rides an `ORDER BY` — `… ORDER BY t SKIP n LIMIT m`, and `ORDER BY … OFFSET 1` in statement
position — so an UNORDERED `RETURN n.k OFFSET k` is outside its corpus, and `bun run fuzz` green said
nothing at all about the route item 1776 changed. Found by reading the generator, not by trusting the
suite; the same failure mode as `fuzzer-blind-to-one-column-group`. `skip-only-page-parity.ts` is the
oracle that covers it, and it reads each paged shape against its own UNPAGED control, because a page
cannot be expected to agree where the unpaged orders already do not.

⚠️ **NEVER LABEL A BENCH ROW A "TWIN" FROM EXPECTATION — ASK `compileLinear` WHICH RUNG FIRES**
(item 1785). I added `hop2groupstart` as a rung-taking control for `hop2groupend` and wrote that it
"reaches a rung"; both are GENERAL PATH, so the 1.09x between them is two general-path shapes
differing by one property read, not a route gap. The real twin in that batch —
`hopgroupsumcrossend` (general) against `hopgroupsumsameend` (`groupedHopAggregate`) — prices losing
the rung at **2.38x**. Item 1775's own lesson from the other side: a corpus gap reads like a
starvation, and an assumed twin reads like a route gap.

⚠️ **AND A SMALL FIXTURE OVERSTATED THAT GAP BY 2x.** The same pair read **5.04x** at 20,000 nodes
from one process per arm, and **2.38x** at 200,000 over three interleaved rounds. The direction held
and the magnitude did not — which is how a smoke-test number usually fails, and why a smoke test is
for liveness (is the answer non-vacuous?) rather than for a ratio.

⚠️ **NORMALIZE BY THE QUANTITY THE LOOP IS OVER, NOT BY THE QUANTITY IT EMITS** (item 1784). A
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

⚠️ **READ THE GENERATOR'S SHAPE SPACE ON THE AXIS THE CHANGE MOVES** (item 1783). The Gremlin fuzzer
calls `order(` 59 times, so it looks like coverage for any order-step change. Every `by()` modulator
it generates is a COMPARATOR TOKEN — 8 × `.by(desc)`, 3 × `.by(Order.desc)`, **zero with a property
key** — so `order().by('s')` is outside its corpus entirely. The step is generated; the MODULATOR
KIND is not. Third blindness finding in one arc and all three are different: item 1776's page was
ABSENT, item 1781's shape was PRESENT UNDER A COUNTER THAT NAMED IT, this one's step is present with
the wrong argument.

⚠️ **AND A PARITY PROBE CAN BE VACUOUS ON ITS FIRST RUN — ASK IT TO PROVE IT CAN FAIL.**
`gremlin-order-by-key-parity.ts` derived its sort key from the same permutation as its edge targets,
so the walk order already EQUALED the sorted order: sorted and unsorted output were byte-identical
and all five `IDENTICAL` verdicts held for a reason unrelated to sorting. A route that dropped the
sort entirely would have passed it. It now carries a GUARD rather than a comment — it exits 1 if
sorted ever equals the walk order. Items 1064, 1777 and 1781 each paid for this same fixture defect;
this is the fourth and the first to leave an automated check behind.

⚠️ **RE-RANK A BENCH AFTER FUSION WORK, BECAUSE A FUSION PROMOTES THE SPELLING IT DID NOT REACH**
(item 1782). Item 1439 ranked the Gremlin bench with `hoporder` on top at 89.48 ms; items 1586, 1630
and 1713 fused and specialized the projected-order path and it now reads **24.07**, which puts
`hoporderbystr` — `order().by(k)`, the one sort spelling the fusion never reached — at the top at
**1537.5 ns/row**. Route markers confirm it takes NO shortcut at all (`projected=UNDEFINED`), because
`hopValuesShortcut` needs a `values()` step. **The new peak was created by the previous wins, and
only a re-rank shows it.**

⚠️ **AND A HOT FRAME CAN BE HOT BECAUSE OF THE ROUTE THAT REACHES IT.** That row's profile puts
`iterLabeled` at 32.7% and the whole traversal cluster at 70%, which invites optimizing the adjacency
iterator. It is not slow: `hopbare` runs the IDENTICAL `V().out('E')` walk in 8.5 ms against this
row's ~43, because the fused route does not go through the generic traverser pipeline.
`frame-attribution-trap` in a new form — and the control that separates the two readings is the same
walk on the other route, not a deletion test.

⚠️ **AND A COVERAGE COUNTER CAN NAME A SHAPE IT DOES NOT COUNT — `hopFilter` IS THE COUNT LADDER**
(item 1781). The differential fuzzer prints `hopFilter=172/156`, which reads as coverage of the
filtered one-hop family. Its test is

    /^MATCH \([ab]?[^()]*\)[-<]/.test(q) && q.includes(' WHERE ') && q.includes('count(*)')

so it tallies only the filtered **`count(*)`** ladder; `groupHopPred` is the GROUPED form. A plain
`MATCH (a:L)-[:E]->(b:L) WHERE <far pred> RETURN b.k` — a yielding projection — is tallied by
neither, so `bun run fuzz` green said nothing about the route item 1781 changed.
`far-driven-predicated-parity.ts` is the oracle that covers it.

⚠️ **THAT IS THE THIRD TIME IN SIX ITEMS, AND THE FIRST TWO WERE DIFFERENT FAILURES.** Item 1776's
page was absent from the corpus entirely; this one is PRESENT UNDER A NAME THAT MATCHES, which is
worse, because the counter is non-zero and reading it is what convinces you not to look. The rule
is unchanged and now has a second form: **read the generator's PREDICATE, not its counter's name.**

⚠️ **THE FILTERED-HOP ROWS WERE ALL ONE PREDICATE CLASS, AND IT IS THE CLASS THAT CANNOT TAKE THE
ROUTE** (item 1780). Every filtered row in `isolated-row-bench.mjs` was an ORDERING comparison
(`b.n > 5`, `b.n > -1`, `b.k > -1`), which can raise on a cross-type pair — so the whole family
declined item 936's candidate design (gate a far-driven filter on a raise-free predicate) for a
reason that is a property of the FIXTURE's predicates, not of the engine. `=`, `<>`, `IS [NOT] NULL`
and label tests cannot raise (`cross-type-comparison-no-error`), and the equality form is also the
only SELECTIVE one — every `>` row here passes ~100%. `hopfiltfareq` and `hopfiltneq` are those two
rows; the pair separates raise-freedom from selectivity, which one row would conflate. **A filter
family measured only with `>` is measuring neither property.**

~~⚠️ **AND `truthCannotRaise` IS NOT THE KEY FOR SUCH A GATE**~~ ✅ **IT IS THE KEY, AND ITEM 1780 GOT
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

✅ **AND THAT SAME COUPLING IS NOW A TOOL: `OFFSET 1` IS A START-DRIVEN FORCER** (item 1779). Item
1777 gave `hopOrderPlan` a `pageSkip !== 0` arm of its `startDriven` flag, so adding `OFFSET 1` to a
hop flips the walk while changing nothing else — same detector, same exit, one fewer row. **That
makes a route A/B two QUERIES IN ONE BUILD**, with no source patch and no rebuild between arms, so
item 737's cross-build trap cannot apply. It is how `hop-walk-fanin-ab.sh` swept a walk choice that
item 1438 could only reach by hand-patching `hop-projection.ts` — and the two agree to **0.01x** on
the cells they share, which is the check that says the forcer measures the route and not itself.

⚠️ **AND IT INHERITS THE RISK ABOVE: this probe is DOWNSTREAM OF A SHIPPED BEHAVIOUR.** If item
1777's forced walk were removed, both arms would be far-driven and the sweep would compare a route
against itself — tautological, in the same way and for the same reason as the oracles above. The
guard is not in the probe: `skip-only-page.test.ts` pins the paged far-read hop's rows in
START-DRIVEN order and item 1777's mutant confirms dropping the force fails 3 of them. **When a probe
is built on a shipped route choice, say which test holds that choice up**, or the probe's silence
later looks like evidence.

⚠️ **`rung-precedence-census.mjs` ASSERTS THE ASSUMPTION IT RESTS ON, and a reader changing either
file must know why.** It reads `compileLinear`'s non-null fields to name the rung that fires, which is
only sound because `compileLinear`'s returned field order is kept IDENTICAL to `runLinear`'s lazy
`if (linear.<rung>)` chain in `executor/clauses.ts` — deliberately, and `rewrites.ts` records that the
two once DRIFTED in their first five entries while matching in the last fourteen. The census
transcribes the chain and refuses to report if the orders disagree, rather than producing a confident
census of the wrong precedence. ⚠️ **AND A STARVED RUNG IS A CANDIDATE, NOT A FINDING** — item 418
measured a branch moved ahead of a hot dispatch costing the shape it does not claim 1.12x, so a
broader rung firing first is often right. All three contested pairs the census found were correct.

⚠️ **`hop-distinct-route-probe.mjs` WAS DEAD FOR AN UNKNOWN NUMBER OF ITEMS** and item 1775 found it
by accident, copying its import. It read `../gql/src/executor.ts`, which stopped existing when the
executor was split into modules — so item 1583's own oracle, the instrument that found a 6.00x rung
starvation, had been silently unrunnable while `CLOSED.md` went on citing it. Nothing noticed, because
a probe has no gate. **A probe that imports engine internals is a probe that a refactor can kill
without failing anything**, so run the ones you cite before citing them, and prefer the import path a
TEST uses (`routes-fired.test.ts` names `./executor/rewrites.ts`) since a test's path is maintained.

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

**⚠️ `runtime-profile-probe.mjs` CANNOT RESOLVE A SUB-15% QUESTION (item 1477).** At 60 reps its
intra-arm spread on the projection shapes is **27-31%** — `proj1` PRE alone read 245.7, 300.8 and
322.0 — so more rounds do not help: the spread is WITHIN an arm, not between them. Fine for the 2-5x
findings it was built for; for anything smaller use the isolated row benches and their
median-of-medians-across-alternated-rounds protocol.

**⚠️ A SHARE IS A NOMINATION; AN ABLATION IS THE PRICE.** Four instances now: `edgesOfTypes` read
37.9% self for a path that is a single `Map.get` (1104); a clean 3.8x micro landed at **1.11x** in the
engine (1364); `bucketsOf` profiled at 9.2% and ablated at **3.7%** (1368); and a pre-shaped row
template measured **1.52x in a 300,000-row micro and NOTHING in the engine** (1477). Expect the share
to overstate by ~2.5x and price in the engine, or say plainly that you have not.

**The micro case deserves its own statement**, because it is the seductive one: a micro that isolates
one operation measures that operation's share of ITSELF, which is 100%. In the engine it is whatever
the profile says — so **the profile's share is the CEILING on what a micro's ratio can become, not a
prediction of it.**

**⚠️ WINDOW THE PROFILE ABOVE ~20k ELEMENTS.** `--cpu-prof` covers the whole process, so at 200,000
the fixture build INVERTS the ranking — `getVertexById`, `indexEdgeLabel` and `commitElementLabels`
at the top of every shape, all load, no query (item 1362). Raising reps is not the fix; it shrinks the
build's fraction while costing time in the dimension being swept.

**⚠️ THE GQL PROBE RAN AT FANOUT=1 UNTIL ITEM 1488**, which CLAUDE.md itself calls sparse ("per-edge
costs scale with the edge:node ratio"). It now has `STRIDE` and `FANOUT` knobs — and two new shapes,
because the ones it had could not show per-edge cost at all: `hopfilter`'s `WHERE a.k = 5` leaves
~2,062 of 200,000 sources so it is SCAN-dominated (FANOUT 1→5 moved it 113.5→127.6 ms), and `hopall`
(a one-hop `count()`) is a **degree sum** at 2-8 ns/edge. `hoprows` materializes a row per edge and
cannot shortcut.

On `hoprows`, stride matters: **1.84x at FANOUT=1, 1.25x at FANOUT=5** (higher fan-out amortizes the
scattered bucket lookup over more edges). Its screen verdict: `farDrivenHopWalk` 51.6% (priced),
**`(garbage collector)` 44.8%**, and row construction **1.4% in total** — which is why item 1477's
row-template change measured a null. **That shape is GC-bound on the size of its own result.**

**⚠️ WRITING AN ITEM ABOUT A FRAME RETIRES IT FROM THE SCREEN.** `topKNodeWalk` had ZERO mentions when
1358 flagged it and one afterwards — 1358's own entry. The ZERO signal is ONE-SHOT, so a flagged frame
must be taken or explicitly priced in the same pass, or the next run reads clean with the work open.

### What the screen found, so it is not re-run for the same answer

⚠️ **ITS SURFACE WAS FIVE SINGLE-PATTERN GQL SHAPES, and that was the limit of "no unpriced frame
survives" (item 1473).** A real query joins two patterns, keeps an optional side, de-duplicates or
asks a subquery, and none of that machinery had ever been profiled. Six shapes added — `join`,
`optional`, `distinct`, `existssub`, `wideproj`, `unioned` (+ `unioneddistinct`, `excepted`,
`unionedbig`, `unionedbigdistinct`) — and they turned up **one ZERO-mention frame, `combineRows`,
which became a 4.63x fix**. Five of the six came back clean, so those five are now covered too.

⚠️ **The Gremlin screen had the same gap (item 1474).** Its eight shapes covered hops, order,
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

⚠️ **`localized` and `localvalues` measure DIFFERENT things and the probe keeps both.** A bare
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
⚠️ `hopbare` first read 13% worse there and was FLAT (3/5, nominally better) when isolated over five
alternated rounds — its own spread across those was 23%.

⚠️ **But re-profiling `folded` at 400 reps instead of 20 roughly DOUBLED both shares** (`projectValues`
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

| file                                | surface                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isolated-row-bench.mjs`            | one GQL row (`SHAPE=hopfilter NODES= REPS= DROP=`)                                                                                                                                         |
| `isolated-gremlin-bench.mjs`        | one Gremlin row (item 1368)                                                                                                                                                                |
| `hop-proj-isolated-probe.mjs`       | one hop PROJECTION row, `SHAPE=hop1id                                                                                                                                                      | hop2id | hop1values        | hop2values`, rows asserted and the fixture's DISTINCT out-targets checked (item 1769). ⚠️ Overlaps `isolated-gremlin-bench.mjs`; prefer that one unless you need the row-count assertion |
| `properties-getter-probe.mjs`       | `v.properties` / `v.labels` / `v.id` on REAL vertices, random order, boxes pre-warmed, `NODES=` sweepable — the instrument that found items 1770-1772's cost to be scale (items 1772/1773) |
| `far-identity-probe.mjs`            | does a fused hop yield the CANONICAL `Vertex` per id, or fresh instances? (item 1770)                                                                                                      |
| `gremlin-hop-floor-probe.mjs`       | the Gremlin hop FLOOR, three arms (item 1411)                                                                                                                                              |
| `gremlin-multitype-floor-probe.mjs` | why `out('E','F')` costs 1.86x `out('E')` — six arms, `ARM=` (item 1441)                                                                                                                   |
| `gql-filtered-hop-floor-probe.mjs`  | how far the FILTERED GQL hop is above a hand floor — seven arms, `ARM=` (item 1444)                                                                                                        |
| `id-lookup-scaling-probe.mjs`       | is get-by-id O(1)? engine vs a raw `Map`, `MODE=hit                                                                                                                                        | seq    | miss` (item 1451) |
| `write-floor-probe.mjs`             | is a TS write's cost the QUERY LAYER or the CORE? three arms, `ARM=`/`OP=` (item 1457)                                                                                                     |

⚠️ **A HAND FLOOR BRACKETS; IT DOES NOT ATTRIBUTE** (item 1448). `gql-filtered-hop-floor-probe.mjs`
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

⚠️ **`hop-projection.ts` CHARGES A TOLL, so price a target against ~10% before attempting it**
(items 1413 and 1415). Two independent changes there — a dedupe skip and a per-row `EvalEnv` hoist —
had flat-to-small targets (−0.5%, +2.3% at degree 1) and each made rows on walks they CANNOT REACH
**3.4-5.8% slower**, with concordance against them (28/81, 12/81). The controls moved against the
change, so this is not a control flattering a target; it is the file. Every item that succeeded here
clears 10% easily (1408 at 26.8/42.1%, 1409 at 55.7/79.8%, 1410 at 31.2/49.1%) and both that failed
are under it. Put two per-edge walks the change cannot reach in every A/B on this file, and treat a
sub-10% nomination as already declined.

Per-rep timing, `p25` headline, full distribution, GC accounted, answer in the output so a driver can
assert the arms agree.

⚠️ **`gcMs` IS 2-3x NOISIER THAN `p25`, so never read it as a share from one run** (item 1421). And when it DOES
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

| probe                        | question                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prop-bag-regime-probe.mjs`  | WHY the property read grows with size — and three refutations (item 1363/1364)                                                                                                                       |
| `engine-bag-shape-probe.mjs` | does bag SHAPE reach the engine? **1.11x — no** (item 1364)                                                                                                                                          |
| `token-drain-probe.mjs`      | `drainMutations`' duplicate-token array vs a count map (item 1360)                                                                                                                                   |
| `ordinal-churn-probe.mjs`    | what DELETES cost a never-reused dense ordinal (item 1372)                                                                                                                                           |
| `keyed-load-micro.mjs`       | freeze x key-constancy x access ORDER x bag COUNT on synthetic bags (item 1770/1771). ⚠️ A MICRO: items 1770-1773 showed it cannot reach the engine's regime — see `prop-bag-regime-probe.mjs` first |
| `chase-depth-micro.mjs`      | does dependent-load DEPTH explain the per-row read? **No — saturates at 18-20 ns at depth 4, in BOTH `ALLOC=interleaved` and `ALLOC=scattered`** (items 1771/1773)                                   |

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

**⚠️ AND READ ITEM 1392 BEFORE PRICING A PER-ROW PROPERTY READ AT ALL.** Items 1770-1773 spent four
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
true degree 3** (144/144). ⚠️ At the SAME true degree 2 the overlapping fixture WINS 7.2% — opposite
sign — so the per-vertex bucket structure is a second factor the gate's one scalar cannot express.
Sweep `MULTILABEL=-1` alongside `3` for anything that reads a degree estimate or walks per-type
buckets. (`0` still means "no `F` at all", the control that separates a routing gap from a correct
decline.)

⚠️ **THE GREMLIN BENCH NEEDED THE SAME KNOB AND DID NOT HAVE IT UNTIL ITEM 1413 — and its absence
cost a reading there too.** At `MULTILABEL=0` every edge is `['E']`, so a two-label hop walks an `E`
bucket and an EMPTY `F` bucket: nothing that happens in a SECOND bucket can be measured at all.
Item 1413 priced the multi-type walk's earlier-buckets dedupe against exactly that cell and got 5.5%
with a control moving 4.8%, because in both arms the scan never executed. Re-run on `-1` it was
**−0.5%** and the item was declined.

So the rule is now a rule about both benches: **a two-label row measured at `MULTILABEL=0` is
measuring one bucket.** Same missing shape, found twice, the second time after it had already cost a
reading — which is the argument for sweeping the knob rather than picking a value.

⚠️ **AND THE KNOB CUTS BOTH WAYS: `MULTILABEL=-1` makes every MULTI-HOP chain row answer ZERO**
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

⚠️ **And re-run a suspiciously exact tie as separate PROCESSES.** That run first reported engine and
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

⚠️ **Check the arms that claim the same answer, and check the odd one against its own
expectation.** This probe's `onePass` arm deliberately returns half the rows, so it cannot join the
equality check — but "excluded from checking" is how an arm silently stops doing what it says. It is
asserted to be a strict, non-empty subset instead.

⚠️ **THE FIXTURE'S SUCCESSOR FUNCTION IS WORTH ~2x, AT THE SAME DEGREE** (item 1426). Two instruments
in this directory disagreed **1.91x** on the identical 3-hop count with the identical answer, because
`isolated-row-bench.mjs` builds `to = (i * 7 + 3) % N` — a vertex points ~7 slots along, partly
cache-resident — while the cross-engine probe's default is `to = (k * 104729) % N`, effectively
random across the range. Both are permutations, so out-degree and in-degree are exactly 1 either way.
Measured: **1.93x (GQL), 2.06x (Gremlin)**.

Item 1066 priced this family at 9.3x over far-pool WIDTH; this is the same effect at fixed width and
varying STRIDE. So **the bench's chain rows are ~2x optimistic against a random graph**: A/B ratios
are safe (both arms share the fixture) and ABSOLUTE ns/row figures are not. Quote them as
"on this fixture", and sweep the stride before claiming a general result.

⚠️ **THE TWO ISOLATED BENCHES HAVE OPPOSITE STRIDE DEFAULTS, AND THAT IS DELIBERATE** (item 1439).
`isolated-row-bench.mjs` defaults to `small`; `isolated-gremlin-bench.mjs` defaults to `random`,
because its edge builder was hardcoded to the random form before it had a knob at all. Each keeps the
default its own recorded figures were measured against — changing either silently invalidates its own
history — so **a cross-bench ratio taken from both defaults compares different graphs** by the ~2x
above. Pass `STRIDE` explicitly on BOTH when comparing engines, or use `cross-engine-chain3-probe.mjs`,
which holds one graph for both.

On the Gremlin bench the stride is worth more than the cross-engine probe's 2.06x suggested, now that
the main bench can vary it: `hopcount3` **90.65 → 41.84 ms (2.17x)** and `hopbare`
**21.60 → 4.05 (5.3x)** going from `random` to `small`, same answers.

⚠️ **AND `STRIDE` ON THE GREMLIN BENCH WAS SILENTLY IGNORED BEFORE ITEM 1439.** It was not a knob, so
setting it measured the default while the driver believed otherwise — item 1431's trap, whose recorded
fix is to have the driver assert the value back. That was impossible here because the bench emitted
neither `stride` nor `rowCount`. Both are emitted now (along with `multilabel`/`vlabel`), so
**assert the fixture fields off every reading** rather than trusting the environment you set.

⚠️ **WHEN A FILE PERTURBS MORE THAN THE EFFECT, MEASURE OUTSIDE THE FILE** (item 1441).
`packages/gremlin/src/executor/hop-values.ts` moves unrelated branches **~16%, in an arbitrary
direction**, on any edit: item 1413 saw two controls REGRESS 3.5% and 5.8%, item 1440 saw one
"improve" 16.3% at 4/4 while no target cleared 8%. That is not statistical noise — more rounds do not
average it out, because it is a repeatable consequence of the edit. `gremlin-multitype-floor-probe.mjs`
is the answer: hand floors price the SHAPE instead of the diff, need no edit, and additionally settle
whether a reverted change was right (item 1440's was — its lean arm measured IDENTICAL to the
array arm, 11.81 both). The same caution applies to `hop-projection.ts` on the GQL side, where item
1415 measured the toll at 3.4-5.8% and the standing rule is that a target there must be worth ~10%.

⚠️ **A FORWARD-vs-`both` PER-ROW COMPARISON IS ONLY MEANINGFUL AT RANDOM STRIDE** (item 1443).
`small` stride privileges the SUCCESSOR direction (`to = (i * 7 + 3) % N`, a near neighbour), while
`both`'s second pass reads the PREDECESSOR — the inverse permutation, scattered. So `hopbothyield`
reads **3.35x `out('E')` per row at `small` and 0.98x at `random`**, with the engine at or below a
hand floor in both. Same-direction comparisons (`out` vs `out`) stay sound either way; it is only the
cross-DIRECTION ones the fixture biases. Item 1392 found the same locality effect over fan-in and
closed it as having no per-row lever.

⚠️ **EVERY FIGURE IN THIS DIRECTORY'S RECORDS IS A 100k FIGURE UNLESS IT SAYS OTHERWISE** (item 1452).
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

⚠️ **`gcMs` NEEDS REPETITION BEFORE IT NOMINATES ANYTHING; `gcCount` IS THE CHEAPER TELL** (item 1456).
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

⚠️ **A WRITE PROBE IS NOT A READ PROBE, and both obvious windowings are wrong** (item 1457).
A write is not idempotent, so the fixture is rebuilt every rep and it dominates the process: profiled
UNWINDOWED, `write-floor-probe`'s top frames were `indexEdgeLabel` 11.71%, `build` 6.00%,
`insertEdge` 3.74%, `addVertex` 3.35% — all construction. Windowed around a SINGLE rep it is worse:
~11 samples (every share a multiple of 1/11) and `profileWindow` inflated the median from 14.70 ms to
**66.08, a 4.5x perturbation** on a 15 ms window. The shape that works is to build EVERY fixture
first, then put one window around all the mutations, timing each rep individually inside it — 117
samples, median 11.772 profiled against 11.79 not.

⚠️ And that fixture change MOVED THE ANSWER: a build per rep gave engine/floor **2.96x**, nine
graphs resident gives **1.83x**. `REPS` is load-bearing on this probe in a way it is not on the read
probes, because nine 20,000-node graphs alive at once is a different memory regime. Quote the
non-perturbing instrument (1.83x) and state the reps.

⚠️ **THE SPELLING PROBES' DEFAULT `SPELL_N` IS NOT THE ONE TO USE, AND A FLAG NEAR THE FLOOR IS NOT A
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

⚠️ **A GROUP WRITTEN WITH `count(*)` CANNOT SEE A ROUTE THAT ONLY PROJECTIONS REACH** (item 1490).
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

⚠️ **Each row has its own size scale (`div`), and it is a fixture requirement.** `betweenness` and
`closeness` are Brandes/BFS from every vertex, so at `div: 1` they would not finish. Both of a row's
points are divided equally so its ratio stays comparable; the **absolute ms are not comparable across
rows with different `div`**, and the output prints each row's actual V so that cannot be misread.

⚠️ **One fixture per (div, size), shared by every algorithm at that scale — required, not tidiness.**
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

⚠️ **Bounded retention, not an unbounded leak** — and that distinction is the finding. `YIELD=1` (one
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

⚠️ **`WRITE=1` IS THE CONTROL, and without it the `gremlin` arm is measured against the wrong
floor.** `CALL` YIELDs rows; a Gremlin OLAP step WRITES a property and passes traversers through, so
`direct` alone is not its floor. Item 1472: `direct` 122.32, `direct + writeProperty` 145.24,
`gremlin` 150.44 at 200,000 — so the **Gremlin OLAP wrapper is ~3.6%, within noise**, and the
apparent 46% was the write. Pass `WRITE=1` whenever comparing against a Gremlin OLAP arm.
`@lenke/gremlin` exports no `degree` step, and the probe asserts the step exists rather than
silently measuring something else.

⚠️ **A PROFILED RUN IS ~15% SLOWER.** The same `gremlin` arm read 172.50 ms with `PROF_OUT` set and
150.44 without. Comparing a profiled number against an unprofiled one turned a 3.6% wrapper into a
spurious 19%. Profile to find frames; measure with the profiler detached.

⚠️ **`count(*)` is deliberate**: every arm must consume the same rows without the comparison becoming
about how they are rendered. A `RETURN node.name` arm would add a property read per row and confound
the wrapper question with a projection question.

⚠️ **Sample count gates the profile.** An early capture of `gql/degree` had **103 samples** (8.67 ms ×
9 reps at a 1 ms interval) and was nearly targeted off; the ranking is noise below a few hundred. Use
`NODES=200000 REPS=15`.

## `cross-surface-probe.mjs` — the SAME logical query in both surfaces, over ONE fixture

Every other instrument here measures one surface, and the two single-surface probes do not even share
a fixture (the GQL one builds one edge per vertex, the Gremlin one defaults to `FANOUT=5`). So "is one
surface paying more than the other for the same question?" was not askable until item 1481.

⚠️ **`cross-engine` IN THIS REPO MEANS TS vs RUST.** This is cross-SURFACE: both arms are the pure-TS
engine, so a gap is between two front ends lowering to the same data.

⚠️ **EVERY PAIR ASSERTS ITS TWO ANSWERS AGREE, and the probe throws rather than printing a ratio when
they do not.** A mistranslated query is the obvious failure of a cross-surface comparison, and a ratio
between two different questions looks exactly like a finding.

First readings at 200,000 vertices: `hopfiltered` 1.07x, `exists` 1.26x, `grouped` 1.32x, `project`
1.63x, all GQL-faster; `hopcount` is both-shortcut and below the floor. **Nothing above 1.63x — the
shared layers dominate and neither front end is dramatically behind.**

⚠️ **RUN IT AT 200,000, NOT 20,000.** At 20,000 the same probe read `project` **4.41x**, `hopfiltered`
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

⚠️ **THE TRICK:** `hopValuesShortcut` accepts exactly `values(k)` (one key), `id()`, or nothing as the
third step and DECLINES anything else. So `label()` after the hop gives the general route over the
**identical hop and row count**, and `values(k)` gives the fused one.

```text
            200,000 vertices, FANOUT 5, 1,000,000 rows
fused values(k)   34.83 ms    35 ns/row
fused id()       117.23      117 ns/row
general label()  545.92      546 ns/row
                 general/fused(values) 15.68x    general/fused(id) 4.66x
```

⚠️ **THERE IS NO SINGLE "FUSED VS GENERAL" NUMBER.** It is 4.66x-15.68x depending on what the
projection emits, and **the two FUSED arms differ 3.3x from each other** on the same walk (only the
`pick` closure differs). So price a sub-plan change against an arm that emits **what the sub-plan must
emit** — vertex traversers, i.e. the `id` arm at 4.66x — not against the cheapest fused arm.

⚠️ **THAT 3.3x WAS A THIRD SHORTCUT, found at item 1485**: `count-shortcut.ts` treats a trailing
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

⚠️ **So fused-vs-general is ~3.2x on a realistic (scattered) fixture, not 4.2-11.9x** — and the
id-vs-values gap collapses from 2.2x to 1.1x, which is why item 1486 found there is NO property-read
target: when the walk is cache-bound the extra read hides behind the miss. A sequential fixture gives
every vertex exactly FANOUT out-edges in vertex order, so the walk reads adjacency in build order and
the per-row costs a real graph pays simply are not there.

⚠️ **BUT `scattered` IS NOT "REALISTIC" EITHER — it is a DEGENERATE FUNCTIONAL GRAPH (item 1487).**
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

⚠️ **The tell for a skipped materialization: the fast arm is faster than producing its own rows.**
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

⚠️ **COMPARE A WITNESS, NOT A ROW COUNT.** The first guard here compared row counts — useless, since
`count(*)` returns one row and `LIMIT 10` returns ten whatever was selected. It now compares the first
row's first column: the filter pair proves both arms select **19,950** rows, and the order pair's
witnesses are the same day by two spellings.

⚠️ **`ARM=numeric|temporal` for profiling.** One window over both arms attributes their frames to the
same capture, which is how a 2.74x gap becomes unreadable.

### It has a GREMLIN half now (item 1491), and the two surfaces disagree

Item 1490 fixed the GQL `order` row above — **2.74x → 1.08x** — and the cause was the temporal
LITERAL in the predicate, not the sort key. The row's own "different routes" note is what led there;
its inference that the cost was the ordering path was wrong, because the pair it never ran was a
temporal predicate with a numeric projection.

The Gremlin half (`gfilter` / `gorder` / `gproject`, same fixture) was added to check whether item
1490's mechanism existed there. It does not — Gremlin dispatches a step list, not an expression tree
— but the surface measured 2.70x anyway, for an unrelated reason, fixed at item 1491.

⚠️ **QUOTE THE GREMLIN HALF AT `REPS=200`, NOT THE DEFAULT 9.** The gap reads 2.01 / 2.13 / 2.76 /
2.82x at 9 / 20 / 60 / 200 reps: the numeric arm tiers up (2.57 → 1.85) and the temporal arm does not
(5.16 → 5.21), so a short run UNDERSTATES this one. The default stays 9 because the GQL half is
stable there.

⚠️ **AND `GARM=` ISOLATION UNDERSTATES IT TOO — the opposite of item 762's rule.** One arm per
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

⚠️ **RUN IT ONE ARM PER PROCESS (`ARM=`).** In one process the arms disagreed with their own
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

### ⚠️ A single frame over ~95% is evidence of INLINING, not of a hot spot (item 1493)

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

⚠️ **The endpoint getter is NOT the lever**, twice over. A second warm `e.to` read costs only ~10 ns
an edge, so the read is ~9% of the row (a profile had suggested 24.6%, and my own first attribution
said 30% because it bundled the materialization). And `rowsplain`, which stashes the same string as
a PLAIN own property, is **1.19x WORSE** than the getter — adding an own property to 400,000 `Edge`
objects transitions their hidden class and slows every access on all of them. _You cannot buy your
way out of a getter by adding a field to a class with many live instances._

⚠️ **`ARM=rowsplain` MUTATES THE FIXTURE and is gated to that arm alone.** The first version applied
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

⚠️ **`flatchurn` is the arm that decides the design.** A global packed array cannot absorb an insert,
so the naive policy (drop on any adjacency write, rebuild on next read) makes one-write-per-read
**1.47x worse than today** — item 680's failure mode on the TS side. Break-even is ~1.5 queries
between writes.

⚠️ **ALL OF THAT IS REFUTED BY ITEM 1498, WHICH BUILT IT: 1.58x SLOWER** (43.33 → 68.56 ms, three
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

⚠️ **So read any floor arm that REBUILDS a structure as a locality floor, not a design prediction.**
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

⚠️ **A RANGE, not a point: the engine denominator moved 1.35x between runs** (717 then 529 ns) while
the bucket micro held steady. The engine half is the noisy side — it rebuilds a fresh graph per rep,
because removal is destructive and reusing one would measure a shrinking graph.

Two traps the arms exist to show:

- ⚠️ **`indexed` (array + a member→position `Map`) is the WORST arm at every degree**, by up to 22x:
  it removes the `indexOf` search, keeps the `splice` shift, and then pays to renumber every
  position after the hole. A plausible optimisation that is strictly worse than what it optimises.
- ⚠️ **`swap` is cheap and must not be used** — it reorders the bucket, and adjacency iteration
  order is observable in row order, which is what byte-identity turns on.

**Removal order is load-bearing in the arms themselves**: they remove in a SCATTERED order so the
expected shift is degree/2. Front-to-back makes `splice` look free and back-to-front maximally dear.
Members are objects, not integers, because the real buckets hold `Edge` references.

## `parse-plan-probe.mjs` — what parse+plan costs, and who pays it

`bench:usage` has encoded the answer since item 662 without anyone pricing it: `write: append node`
runs at 128.6k ops/s and `write: append node [params]` at 512.8k — **4x**, in the unindexed column
where no seek applies. The first row interpolates the loop counter into the text, so every call is a
distinct string and misses the parse+plan cache; the param row's text is constant and hits it.

⚠️ **DEFEATING THE CACHE IS THE DESIGN.** Each `fresh` arm mints a unique text per rep by appending
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

⚠️ **MATCH `ROUNDS` ON BOTH SIDES.** An earlier pass of the `checkKeyword` A/B read 7% because its
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

⚠️ **The route axis is why this cannot be a unit test**, and the fixture is INDEXED by default for
the same reason (item 578: the spelling probe had no index and was blind to the whole seeding class).
Both spellings answering identically is necessary and not sufficient.

**Result (item 1501): GREEN with one hard exception.** Answers agree in every position. Routes hold
within 1.25x except **`LIMIT` at 5.3-6.1x** — `topKPlan` reads the limit value at plan time, so a
param limit loses the bounded top-K walk. Stable at 200k, 1M, and on a third run. `IS NULL` has no
parameterized spelling at all (`= $null` yields UNKNOWN), and `{k: null}` is a SEMANTIC exception
only (route 1.18x).

⚠️ **THREE FLAGS, THREE INSTRUMENT FAILURES, ZERO FINDINGS** — all three now printed by the probe
with a confirm-alone command, so they are not re-derived:

- **the FLOOR**: `two conjuncts` read 0.54x at NODES=200000 with both arms sub-millisecond, and
  1.25x at 1,000,000. `FLOOR_MS` now separates sub-floor flags from results.
- **INSTABILITY**: `hop start` swung **3.03x / 0.73x / 0.32x** across isolated rounds.
- **BIMODALITY**: `inline`'s LITERAL arm reads **0.95 / 3.42 / 1.21 / 0.98 ms** at REPS=25, so its
  0.52-0.54x sweeps had caught the slow mode twice running; three of four rounds read ~1.0x.

The in-sweep run flags four cases including `inline` at 0.10x against its isolated ~1.0x — **the
sweep is not an instrument for these sub-5ms rows.** Confirm alone, at REPS=25, before believing any
flag but `LIMIT`.

### ⚠️ `fresh` vs `interp` — two uniquifiers, and only one can see auto-parameterization (item 1502)

`fresh` makes the text unique by appending a line COMMENT (item 1499, to defeat the parse cache).
That **also defeats auto-parameterization**, because the comment survives into the rewritten text —
so `fresh` cannot measure the feature at all. It is now the CONTROL for what a literal-free cache
miss pays for the normalization attempt (1.04x, with the regex pre-filter).

`interp` varies a LITERAL, which is what an interpolating application does, and is the arm the
feature is for: **insert 1.46x, point 1.82x, agg 2.02x, longer 1.83x**.

⚠️ **AND THE FIRST `interp` USED `i % 7`, WHICH IS SEVEN TEXTS, NOT UNIQUE ONES.** The parse cache
holds all seven, so PRE measured FASTER than POST — a warm cache against a cache plus normalization.
Only `${i}` models the real caller. Third instance this session of match-the-fixture-to-the-claim,
and the first where the fixture flattered the status quo rather than the change.

## `gremlin-plan-overhead-probe.mjs` — what a traversal costs before it touches the graph

The Gremlin analogue of items 1499-1502. There is no text to parse, but `toArray` re-runs the whole
plan ANALYSIS per call — `effectivePlan`'s seven passes, `checkSteps`, `planReadsPath`,
`streamStaysElements` — with nothing cached between calls.

⚠️ **THE FIXTURE IS DELIBERATELY TINY (200 vertices)**, the opposite of every other probe here.
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

✅ **DONE AT ITEM 1504 for `planReadsPath`**: `Plan.readsPath` is ORed in at `appendStep`, so the
walk is gone and a fresh plan arrives already analysed. **count 315 → 200 (1.57x), hop 456 → 265
(1.72x), filtered 1186 → 1031 (1.15x) on the reused arm; the rebuilt arm is FLAT** (769-788 vs 787),
where the memo was 1.07-1.15x worse. Wide controls at 200,000 vertices unmoved: hopbare 1.01x,
hopcount3 1.00x, grouped 1.01x.

✅ **AND AGAIN AT ITEM 1505 for `effectivePlan`'s passes**, which the re-taken profile showed were
then the top group at **32.2%**. A `Plan.kinds` bitmask of the six kinds that GATE a pass lets five
of them return in one test. **count 200 → 162, hop 265 → 213, filtered 1031 → 966 on the reused arm,
and the REBUILT arm gains too this time** (778 → 729, 1117 → 1065) because a gate skips work however
the plan arrived. Cumulative since 1503: count 1.94x, hop 2.14x.

⚠️ **`kinds` is TOP-LEVEL ONLY and `readsPath` PROPAGATES INWARD** — opposite rules on the same
object, each correct for its consumer: the gated passes never recurse, so a nested `union` is not
fusable and recording it would make the gate useless. And any pass that changes the steps must
RECOMPUTE `kinds`, because `fuseLocal` inlines sub-plan steps into the top level.

✅ **AND THE LAST TWO AT ITEM 1506**: `dropVacuousLabels` ← the `hasLabel` bit, and
`flattenFilterWrappers` ← `not | filter | or | and | hasLabelAnd`. **count 162 → 124, hop 213 → 162
(1.31x both arms); cumulative since 1503, count 315 → 124 (2.54x) and hop 456 → 162 (2.81x).**

⚠️ **The flatten gate FIRST LISTED FOUR KINDS AND WAS WRONG.** The function's explicit branches test
`filter`/`or`/`and` plus `presenceFoldOf` (`not`) — but `pushSplit` runs UNCONDITIONALLY at the
bottom of the loop and splits `hasLabelAnd` (item 1309). Two existing tests caught it. **Enumerate
the kinds a pass acts on from the CODE, including what runs outside the branch conditions.**

✅ **AND THE VALIDATION WALK AT ITEM 1507** — it does not need to MOVE to construction (item 1503
was right that it cannot), only to be SKIPPED: `checkStep` is the only thing that raises, so a plan
with none of the 25 kinds it can raise for cannot fault. `Plan.mayFault` says which. **count 124 →
77 (1.61x), 4.09x cumulative since 1503** — plus `assertPlanIsSatisfiable` gated on a `path` bit
(~1.04x).

⚠️ **The gate set is read off the SEVEN THROW SITES, not the kind sets.** The broad one
(`PATH_INCOMPATIBLE`: `out`, `has`, `values`…) also requires `f === 'path'`, and only a `path` step
produces that frontier — so one kind covers the whole site, where gating on the set would pass for
nearly every plan.

⚠️ **`mayFault` PROPAGATES INTO SUB-PLANS** (unlike `kinds`), because `assertFrontierTypes` recurses
into branch arms — `V().union(inV())` must still be rejected. The first version was top-level only
and would have silently lost that fault.

⚠️ **And the flag caused a REBUILT-arm regression that an early-out then over-paid back.** Two
sub-plan walks per append (one per flag) cost hop-rebuilt 1.07x; merging them helped, and skipping
the walk entirely for steps with NO sub-plan field — which is `out`, `has`, `count`, `values`, i.e.
almost everything — made the rebuilt arm **1.14-1.28x faster than item 1506**. That cost had been
paid silently since item 1504 introduced the walk.

`countShortcut` (12.9%), `newContext` (12.1%) and GC (12.9%) are now the top frames, and all three
are execution rather than analysis — the construction-time design does not reach them.
