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

| probe                        | the property                                            | last run                                                                               |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `spelling-probe.ts`          | equivalent GQL spellings of one predicate cost the same | clean; its one flag is item 644's BUILT-AND-REVERTED product lever                     |
| `gremlin-spelling-probe.ts`  | the same for Gremlin (item 1305)                        | zero flagged AT `SPELL_N=200000`; **1M flagged a new 2.00x group** (item 1332)         |
| `surface-parity-probe.ts`    | GQL and Gremlin cost the same for ONE question          | **FOUND item 1322's 5.78x pathology**; leaves `two-hop-count` open at GQL 1.84x slower |
| `index-never-hurts-probe.ts` | adding an index never makes a query slower (item 1324)  | holds on 17 shapes, both surfaces                                                      |
| `id-lookup-is-o1-probe.ts`   | lookup by id is FLAT in graph size (item 1326)          | holds on 8 arms over a 16x range                                                       |

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

`notfold-soundness-check.ts` is not a timing probe — it answers whether a rewrite is ALLOWED. Item
1331 folds `not(hasNot(k))` into `hasKey(k)` for 16.9x, and the two are exact duals on elements but
NOT on anything else: after `properties()` they give 1 and 3, after `values()` 0 and 2, because
`hasNot` returns false for a non-element. Run it before widening that fold's allow-list, and in
general whenever a rewrite's soundness depends on what the stream carries.

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

## HOW TO RUN ONE, which is not optional detail

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
