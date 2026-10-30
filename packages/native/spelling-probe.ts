/**
 * Equivalent spellings must cost the same — the TypeScript half.
 *
 * `crates/lenke-engine/examples/spelling_probe.rs` does this for the Rust engine:
 * for each group of queries that should be equivalent it prints the canonicalized
 * optimized plan and the measured time, and flags any group whose members
 * disagree. The TS engine has no plan to canonicalize, so time is the only signal
 * here — which makes this a PROBE, run deliberately, not a test with a timing
 * assertion in CI.
 *
 * It exists because this class keeps recurring and keeps being found by accident:
 * audit item 125 found an inline endpoint constraint costing 4x the equivalent
 * clause `WHERE`, and item 121 found a multi-pattern spelling costing 160x. Every
 * historical instance in CLAUDE.md returned the CORRECT answer, so no correctness
 * test could catch it.
 *
 *   cd packages/native && bun spelling-probe.ts
 *   SPELL_N=50000 bun spelling-probe.ts
 *
 * A group is flagged when its slowest member is more than SPELL_TOL (default 2x)
 * the fastest. Answers are compared too: a group whose members disagree on the
 * ANSWER is a correctness bug and is reported first.
 *
 * DO NOT READ AN UNFLAGGED GROUP'S TIMES AS A FINDING. Every group here runs in ONE
 * process, so a member is warmed by the members before it (item 274's contamination,
 * the same reason `route-cost-probe` takes one case per process). The 2x threshold is
 * set where the signal survives that; below it the printed numbers are not comparable.
 *
 * Measured, because this was learned the expensive way (item 491): the group
 * `three hops, THIRD position filtered` printed 541.30 / 386.79 / 385.02 ms — a 1.4x
 * spread that is NOT flagged — and the three spellings were priced as a target. One
 * case per process, three rounds, two selectivities (1.1% and 14%): **307.8-341.4
 * against 308.5-319.6 against 310.2-351.0**, i.e. identical within noise. The 1.4x was
 * the instrument, not the engine.
 *
 * So: a flagged group is a finding; an unflagged group is a question for
 * `route-cost-probe`, which isolates.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 20_000);
const TOL = Number(process.env.SPELL_TOL ?? 2);
const REPS = Number(process.env.SPELL_REPS ?? 5);
/**
 * A group whose SLOWEST member is under this many milliseconds is not compared.
 *
 * A ratio between two sub-millisecond timings is the clock's resolution, not a
 * measurement — the mistake item 124 made against the native engine, which this
 * probe then reproduced against its own O(1) groups: `label on start: redundant
 * vs absent` flagged at 1.5-1.6x on members reading 0.02 and 0.03ms. Both are
 * answered by a bucket-size read; neither is slow; the ratio means nothing.
 */
const FLOOR_MS = Number(process.env.SPELL_FLOOR ?? 1);

const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["P","Q","Univ"]' : '["P","Univ"]'},"properties":{"k":${i % 50},"s":"s${i % 7}","flag":${i % 5 !== 0},"meta":{"s":"s${i % 7}"}}}`,
);

// BOTH ENDPOINT KEYS ARE SCATTERED, by different multipliers, and that is load-bearing.
//
// `from` used to be `v${e % N}` — inserted in VERTEX CREATION ORDER, while `to` was a
// pseudorandom permutation. The degree-sum walks iterate vertices in creation order and probe
// `index.get(v.id)`, so `edgesFromByLabel` was walked sequentially and `edgesToByLabel` was
// jumped around: item 164's mechanism (29ns a vertex against 135ns). That made every
// from-driven spelling look ~2x faster than its to-driven twin, in a probe whose entire job is
// to compare spellings of one question.
//
// Item 286 recorded the resulting 1.9x as an open target — "`edgesToByLabel` costs ~1.9x
// `edgesFromByLabel`" — and item 287 REFUTED it by swapping the construction, which flipped
// which spelling was slow (FROM 15.3/19.1 and TO 31.6/34.2 one way; FROM 31.7/31.7 and TO
// 15.6/14.3 the other). With both scattered, all four spellings land within 1.10x. The index
// was never the variable; the fixture was.
for (let e = 0; e < N * 3; e++) {
  lines.push(
    // `ew` IS NEW AND `w` IS UNTOUCHED (item 1053). Every existing group keys on `w = e % 5` — a
    // fifth of the edges, which `edgeSeek`'s margin correctly refuses — so those groups keep
    // scanning exactly as they did and every figure recorded against them stays comparable. `ew`
    // is 1 in 1,000, selective enough for the seed to be admitted, and it is the key the new
    // groups below use.
    `{"type":"edge","id":"e${e}","labels":${e % 11 === 0 ? '["E","F"]' : '["E"]'},"from":"v${(e * 104729) % N}","to":"v${(e * 7919) % N}","properties":{"w":${e % 5},"ew":${e % 1000}}}`,
  );
}

// FOUR nodes under a label nothing else here uses, so the multi-pattern group below has a
// TINY left side: a comma product needs one, because the two spellings it compares differ by
// |left| x |right| binding `Map`s and N x N is not a measurement, it is a hang. They carry no
// edges, so the two groups that start an UNTYPED hop scan (`MATCH (a)-[:E]->(b)` and the
// three-hop one) see no extra rows, and every other group is label-anchored on `P` (item 285).
for (let i = 0; i < 4; i++) {
  lines.push(
    `{"type":"node","id":"s${i}","labels":["S","Univ"],"properties":{"k":${i},"s":"t${i}"}}`,
  );
}

const g = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

/** Groups of spellings of ONE question. Every member must answer identically. */
const GROUPS: [string, readonly string[]][] = [
  [
    // Item 984. `NOT n.flag` IS `n.flag = false`. `directEqProps` admits a bare `prop` or a
    // `compare` and nothing else, so a `NOT` conjunct declined the WHOLE chain and the
    // predicate ran through the generic evaluator — 2.20x the equality spelling (item 983)
    // until `notTruthProps` lifted it. Both polarities, because they reach the lift by
    // different arms.
    'a NEGATED boolean vs the equality spelling',
    [
      'MATCH (n:P) WHERE NOT n.flag RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.flag = false RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.flag <> true RETURN count(*) AS c',
    ],
  ],
  [
    'a boolean compared against a literal vs the bare predicate',
    [
      'MATCH (n:P) WHERE n.flag RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.flag = true RETURN count(*) AS c',
      'MATCH (n:P) WHERE true = n.flag RETURN count(*) AS c',
    ],
  ],
  [
    // Items 954-959. A constant STRING subscript IS a field access, so these are one question.
    // They were not: `fieldChain` matched only `kind: 'field'`, so the bracket spelling could
    // not lift into `pathProps` (1.18x on a filtered count), and `compileExpr`'s `case 'index'`
    // arm ran for a projection that never lifts (1.27x). The parser now CANONICALIZES the
    // bracket form to a field, so all four below build one AST — this group is the guard that
    // they stay one.
    'a dotted path vs a constant string subscript',
    [
      "MATCH (n:P) WHERE n.meta.s = 's3' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.meta['s'] = 's3' RETURN count(*) AS c",
      "MATCH (n:P) WHERE 's3' = n.meta['s'] RETURN count(*) AS c",
    ],
  ],
  [
    // Item 549: ISO's `<order by and page statement>` standing in FRONT of the projection. An
    // `OFFSET 0` keeps every row and an `ORDER BY` cannot move a one-row order-free aggregate, so
    // all three below are one question — and the two with the clause cost 83.00 and 126.60ms
    // against 0.00. `dropVacuousPage` drops them; this group is what would have caught it.
    'a vacuous ORDER BY / OFFSET statement vs none',
    [
      'MATCH (n:P) RETURN count(*) AS c',
      'MATCH (n:P) OFFSET 0 RETURN count(*) AS c',
      'MATCH (n:P) ORDER BY n.k RETURN count(*) AS c',
    ],
  ],
  [
    'a vacuous ORDER BY statement in front of an aggregate',
    ['MATCH (n:P) RETURN max(n.k) AS m', 'MATCH (n:P) ORDER BY n.k RETURN max(n.k) AS m'],
  ],
  [
    // Item 683: a VACUOUS QUANTIFIER. `->{1,1}` is one repetition, so with no edge variable and
    // the default `trail` mode it asks exactly what a plain hop asks — and both answer the same
    // number. But the quantifier puts the segment past every gate that bails on
    // `segments.some((s) => s.rel.quantifier)`, so the plain spelling takes the O(1)
    // `edgesByLabel` bucket size while `{1,1}` enumerates: 1.600us against 3580.920 at 50,000
    // vertices / 50,000 E edges, a 2238x spread for an identical answer.
    //
    // The native engine normalizes this away in the OPTIMIZER (`opt.rs`, a one-hop `VarLength`
    // with no `until`/`body_filter` under WALK/TRAIL becomes an `Expand`), which is why the same
    // two spellings sit within 3.3% there. TS has no `ir::Plan` to canonicalize, so it needs the
    // equivalent normalization in its planner — this group is what will show it landing.
    //
    // The gate set is NOT cosmetic, and each half is measured: with an edge variable the
    // quantified form binds a LIST (`e: [{...}]`) where the plain form binds a scalar
    // (`e: {...}`), so a normalization must require no edge variable; and `acyclic` forbids any
    // repeated node, so at one hop it DROPS a self-loop the plain spelling keeps.
    // BOTH ENDS UNLABELLED is load-bearing in this group. With `(a:P)` the plain spelling
    // cannot use the bucket size either — it takes the degree-sum walk — so both members walk
    // and the spread is only 2.18x (24.93ms vs 54.25 at 200k/600k). The O(1) rung needs both
    // ends unconstrained, and that is where the real gap is.
    'a vacuous {1,1} quantifier vs a plain hop',
    ['MATCH (a)-[:E]->(b) RETURN count(*) AS c', 'MATCH (a)-[:E]->{1,1}(b) RETURN count(*) AS c'],
  ],
  [
    // The LABELLED twin, kept because it isolates a different rung: both members walk, so this
    // one measures the enumeration overhead alone (2.18x) rather than the lost O(1) bucket.
    'a vacuous {1,1} quantifier vs a plain hop, labelled start',
    [
      'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,1}(b) RETURN count(*) AS c',
    ],
  ],
  [
    // Item 548: `FILTER <pred>` is ISO's own clause-level predicate statement (§14.6) and asks
    // exactly what a clause `WHERE` on the MATCH before it asks — but the FILTER spelling put one
    // extra clause in front of every detector, so the whole query fell to the general pipeline.
    // It read 41.72ms against 10.73 for the node count and 278.94 against 33.63 for the hop.
    // `inlineTrailingFilter` folds it; these groups are what would have caught it.
    'a trailing FILTER vs a clause WHERE: node count',
    [
      'MATCH (n:P) WHERE n.k > 1 RETURN count(*) AS c',
      'MATCH (n:P) FILTER n.k > 1 RETURN count(*) AS c',
    ],
  ],
  [
    'a trailing FILTER vs a clause WHERE: hop count',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k > 1 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b) FILTER b.k > 1 RETURN count(*) AS c',
    ],
  ],
  [
    'a trailing FILTER vs a clause WHERE: node aggregate',
    [
      'MATCH (n:P) WHERE n.k > 1 RETURN max(n.k) AS m',
      'MATCH (n:P) FILTER n.k > 1 RETURN max(n.k) AS m',
    ],
  ],
  [
    // Item 505: the anchor-then-traverse spelling. Two MATCH clauses sharing a variable join
    // on it, so this is one question written two ways — and the split form missed EVERY fast
    // path, at 747.9ms against 0.0 for the count.
    'anchor then traverse: one clause vs two',
    [
      'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    // Item 499: two ISO spellings of ONE degree. The native engine has lowered both to a single
    // node since it was written; TypeScript did not, so the VALUE spelling missed the degree
    // ladder entirely and cost 8.3x. This group is what would have caught it.
    'degree subquery: COUNT { … } vs VALUE { … RETURN count(*) }',
    [
      'MATCH (n:P) RETURN COUNT { MATCH (n)-[:E]->(x) } AS c',
      'MATCH (n:P) RETURN VALUE { MATCH (n)-[:E]->(x) RETURN count(*) } AS c',
    ],
  ],
  [
    'node count: inline vs clause WHERE',
    [
      'MATCH (n:P {k: 2}) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, FAR endpoint filtered (item 125)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, START endpoint filtered',
    [
      'MATCH (a:P)-[:E]->(b) WHERE a.k = 2 RETURN count(*) AS c',
      'MATCH (a:P {k: 2})-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P WHERE a.k = 2)-[:E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    // Item 444. `-[e:E]->` and `-[:E]->` ask the same question when `e` is never mentioned, and
    // they cost 3.7x apart until the hop fast path stopped refusing a named rel outright. This
    // group is why that hid: the probe had no anon-vs-named edge spelling at all.
    'edge variable named but unread (item 444)',
    [
      'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS c',
      'MATCH (a:P)-[e:E]->(b) RETURN count(b.k) AS c',
    ],
  ],
  [
    // The projection twin of the group above — `detectHopAggregate` delegates to
    // `detectHopProjection`, so a gate change reaches both, and a probe that only covered the
    // aggregate would miss half of it.
    'edge named but unread, filtered projection (item 444)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN b.k AS k',
      'MATCH (a:P)-[e:E]->(b) WHERE b.k = 2 RETURN b.k AS k',
    ],
  ],
  [
    // Items 446 and 447. Reading the rel variable in the RETURN is served by the hop fast path,
    // which BINDS the edge (446); reading it in a clause `WHERE` is served too, by the filtered
    // rel-bound walk (447). `w` is always >= 0 in this fixture, so the two spell one question.
    //
    // This group was added by 446 LABELLED as expected-over-threshold at 2.7x, because the
    // clause-`WHERE` half was not built yet. 447 built it and the group should now agree — which
    // is the point of having added it before the fix rather than after.
    'edge property: bare vs behind a vacuous rel filter (items 446, 447)',
    [
      'MATCH (a:P)-[r:E]->(b) RETURN r.w AS w',
      'MATCH (a:P)-[r:E]->(b) WHERE r.w >= 0 RETURN r.w AS w',
    ],
  ],
  [
    'operand order: $x = n.k vs n.k = $x',
    [
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 2 = n.k RETURN count(*) AS c',
    ],
  ],
  [
    // FLAGS ~3 RUNS IN 5 AT 2.4x AND THE GAP IS NOT REAL (item 455). Isolated one case per
    // process, three rounds of min-of-9, the two spellings measure 4.4-4.6 ms either way; the
    // equality pair `n.k = 5` / `5 = n.k` likewise at 3.8-4.1. In-process this group reads
    // 5.40/13.19, 5.28/5.33, 5.38/13.11, 5.58/13.54, 5.40/5.35 — two distinct modes 2.5x apart
    // for the SAME query, not a spread. Confirm with `SPELL_ONLY='range operand order'` before
    // believing it, or with `PCASE=opprop|oplit bun run probe:route`.
    'range operand order: 5 <= n.k vs n.k >= 5',
    [
      'MATCH (n:P) WHERE n.k >= 5 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 5 <= n.k RETURN count(*) AS c',
    ],
  ],
  [
    'OR vs IN',
    [
      'MATCH (n:P) WHERE n.k = 2 OR n.k = 7 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k IN [2, 7] RETURN count(*) AS c',
    ],
  ],
  [
    'NOT (=) vs <>',
    [
      'MATCH (n:P) WHERE NOT (n.k = 2) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k <> 2 RETURN count(*) AS c',
    ],
  ],
  [
    'edge type disjunction order',
    [
      'MATCH (a:P)-[:E|F]->(b) RETURN count(*) AS c',
      'MATCH (a:P)-[:F|E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    'direction: -> vs reversed <-',
    [
      'MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c',
      'MATCH (b:Q)<-[:E]-(a:P) RETURN count(*) AS c',
    ],
  ],
  [
    'two patterns vs two clauses (items 122/123)',
    [
      'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P {k: 1}) MATCH (b:P {k: 2}) RETURN count(*) AS c',
    ],
  ],
  [
    // These three ask for the distinct values of one property and must answer the same ROWS in
    // the same order, which is why the `count(*)` spelling is not among them — it carries an
    // extra column and the probe compares answers. The LET spellings were 9.1x off the bare
    // one: `GROUP BY` takes a BOUND NAME, so a LET is the only way ISO lets you name a
    // grouping key, and the DISTINCT spelling gets written the same way. Item 187 routed
    // DISTINCT-via-LET to the walk and item 188 did the same for a `GROUP BY` with no
    // aggregate, which closed the group — 1.36 / 1.37 / 1.44ms, within 6%.
    'the distinct values of one property',
    [
      'MATCH (n:P) RETURN DISTINCT n.k AS a',
      'MATCH (n:P) LET a = n.k RETURN DISTINCT a',
      'MATCH (n:P) LET a = n.k RETURN a GROUP BY a',
    ],
  ],
  [
    // One grouped count, written the two ways ISO lets you write it. `GROUP BY` takes a BOUND
    // NAME, so the `RETURN` form needs a `LET` to name the key; the `SELECT` form names the
    // PROPERTY and has no `LET` at all. The tally accepted only the first, so the standard's own
    // spelling went down the general grouping path: 69.5ms against 4.1 (audit item 199). The
    // third member adds the `HAVING` the SELECT form exists to carry — it has no `RETURN`
    // counterpart, since `HAVING` is SELECT-statement-only in ISO, so it is here as a member
    // whose cost must stay beside the others rather than as a second spelling of them.
    // The same inline-vs-clause question as the node-count group below, but for a PROJECTION
    // rather than a count — a different path (`detectNodeProjection`, item 204) and so a
    // separate group. Measured in isolation at 20,000 vertices the two read 24.3ns and 34.8ns a
    // vertex, so the inline spelling is ~1.4x ahead: `inlineHolds` -> `satisfies` against a
    // compiled predicate over the same property.
    'a filtered node projection: inline vs clause WHERE (item 204)',
    ['MATCH (n:P) WHERE n.k = 2 RETURN n.s AS s', 'MATCH (n:P {k: 2}) RETURN n.s AS s'],
  ],
  [
    'a grouped count: the LET form vs ISO SELECT (item 199)',
    [
      'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a',
      'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k',
      'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 0',
    ],
  ],
  [
    // `ORDER BY <alias>` IS `ORDER BY <the expression the alias names>`. `aliasDefinition`
    // substitutes it so the top-k keeps INPUT bindings and projects only the rows it emits.
    //
    // Item 144 found the COMPUTED case declining that substitution, measured the alias
    // spelling at 154.8ms against the expression's 89.3 (191.8 for an alias of a function),
    // and concluded it could not be fixed in one engine because the two spellings differ in
    // WHICH QUERIES RAISE. That conclusion was WRONG, and the correction is the thing worth
    // keeping: native projects only the emitted rows (`try_late_materialize`), so TS was the
    // inconsistent engine and the difference was a LIVE cross-engine divergence, not a shared
    // design. Item 145 fixed it in TS alone — 150.6 -> 86.1ms against the expression's 86.3.
    //
    // The pair stays as the regression guard. Note what it still PRINTS, though: ~1.9x, where
    // an isolated harness at the same `SPELL_N` reads 6.66ms against 5.64 (1.18x) and 200,000
    // rows read 86.1 against 86.3. This probe runs twenty-odd queries in one process, so each
    // row's cache state depends on its predecessors and its absolute spread is inflated — the
    // third time that has been confirmed (TS audit items 141, 143, 145). It is a FINDER: a
    // group it flags is worth isolating, and a spread it prints is not a settled delta.
    'ORDER BY alias vs its expression (items 144/145)',
    [
      'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 10',
      'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.k + 1 LIMIT 10',
    ],
  ],
  // Item 1063's HOP twin of the group above. The hop rung refused a windowed sort whose
  // projection could fault, so these two cost 48-50 ms apiece against 11 for the plain spelling;
  // deferring the projection brought both to ~12.5. They are in here because item 1062's first
  // cut made the single-node pair diverge 3.8x and THIS probe is what caught it.
  [
    'hop ORDER BY alias vs its expression, windowed (item 1063)',
    [
      'MATCH (a:P)-[:E]->(b) RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
      'MATCH (a:P)-[:E]->(b) RETURN b.k + 1 AS c ORDER BY b.k + 1 LIMIT 10',
    ],
  ],
  // The WALK VARIANTS of the same refusal cannot be a spelling group — a filtered hop and an
  // unfiltered one answer different questions, and this probe compares answers as well as times.
  // They are covered by `defer-hop-probe.ts`, one shape per process, where the comparison is
  // against each variant's OWN plain twin rather than against each other.
  [
    'hop windowed sort, FILTERED: alias vs expression (item 1063)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k > 1 RETURN b.k + 1 AS c ORDER BY c LIMIT 10',
      'MATCH (a:P)-[:E]->(b) WHERE b.k > 1 RETURN b.k + 1 AS c ORDER BY b.k + 1 LIMIT 10',
    ],
  ],
  [
    'ORDER BY plain-column alias vs its expression',
    [
      'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10',
      'MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10',
    ],
  ],
  [
    // ADDED AT ITEM 868, because the NATIVE engine had a >=1785x gap on exactly this axis. A
    // sorted LIMIT can be written with the ORDER BY in STATEMENT position (before RETURN) or in
    // CLAUSE position (after it). They mean the same thing, but natively they lowered to
    // different plans — `OrderPage{Scan}` vs `OrderPage{Project{Scan}}` — and only the first
    // reached the streaming top-K, so item 866 had to lift the second onto the same path. The TS
    // engine is a separate implementation and item 843's rule applies: whether the same asymmetry
    // is here is a measurement, not an inference either way.
    'sorted LIMIT: ORDER BY in STATEMENT vs CLAUSE position (item 868)',
    [
      'MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c',
      'MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10',
    ],
  ],
  [
    // ADDED AT ITEM 869, which found the worst spelling gap in this file after the label one:
    // a KEYLESS `LIMIT` in statement position forced the whole working table and sliced, where
    // the clause position took lazily — 36.68 ms against 0.04 at 200,000 rows, the same query
    // written two ways. Both now stop pulling at the window's end.
    'keyless LIMIT: statement vs clause position (item 869)',
    ['MATCH (n:P) LIMIT 10 RETURN n.k AS c', 'MATCH (n:P) RETURN n.k AS c LIMIT 10'],
  ],
  [
    // ADDED AT ITEM 870. Item 869 fixed the BARE keyless page by taking the window lazily, and
    // only measured that shape. A FILTER or a hop ahead of the page is a different question: the
    // lazy `slice` has to pull THROUGH them, and natively these are the shapes where
    // `pull_capped` declines and `pull_capped_stream` takes over instead. Native measured all
    // four pairs within 1.5% (item 870's probe); this asks the same of TS.
    'keyless LIMIT after a WHERE: statement vs clause',
    [
      'MATCH (n:P) WHERE n.k > 25 LIMIT 10 RETURN n.k AS c',
      'MATCH (n:P) WHERE n.k > 25 RETURN n.k AS c LIMIT 10',
    ],
  ],
  [
    'keyless LIMIT after a hop: statement vs clause',
    [
      'MATCH (a:P)-[:E]->(b) LIMIT 10 RETURN b.k AS c',
      'MATCH (a:P)-[:E]->(b) RETURN b.k AS c LIMIT 10',
    ],
  ],
  [
    'keyless OFFSET + LIMIT: statement vs clause position',
    [
      'MATCH (n:P) OFFSET 5 LIMIT 10 RETURN n.k AS c',
      'MATCH (n:P) RETURN n.k AS c SKIP 5 LIMIT 10',
    ],
  ],
  [
    'sorted LIMIT DESC: statement vs clause position',
    [
      'MATCH (n:P) ORDER BY n.k DESC LIMIT 10 RETURN n.k AS c',
      'MATCH (n:P) RETURN n.k AS c ORDER BY n.k DESC LIMIT 10',
    ],
  ],
  [
    // A LOW-CARDINALITY key is where the native win came from: the dictionary's smallest value
    // bounds the column, so a rank-bounded scan can STOP. The TS engine stores properties per
    // element with no dictionary, so it has no such bound — this group asks whether the spread
    // between the two spellings is nonetheless different for a low-cardinality key. Uses the
    // fixture's existing 7-way `s` rather than adding a property: this fixture is SHARED, and
    // the comment above records how four added nodes silently changed an unrelated group.
    'sorted LIMIT on a LOW-CARDINALITY key: statement vs clause',
    [
      'MATCH (n:P) ORDER BY n.s LIMIT 10 RETURN n.s AS c',
      'MATCH (n:P) RETURN n.s AS c ORDER BY n.s LIMIT 10',
    ],
  ],
  // THIS GROUP FOUND A 5400x CLIFF AND IS WHY ITEM 286 EXISTS — keep both members.
  //
  // It used to read 0.00ms on both and be skipped under `FLOOR_MS`, because every node in the
  // fixture was a `P`: `vacuousLabel` elided `:P` and the O(1) edge-bucket count answered both
  // spellings. Item 285 added four `S` nodes for the multi-pattern group below, which makes
  // `:P` genuinely SELECTIVE — and the labelled spelling fell to a full per-edge traversal,
  // 0.00ms against 54.06ms for the same answer. Four nodes out of 200,000 were enough.
  //
  // The cause was a missing rung, not a tuning question: the unfiltered branch of
  // `buildOneHopCount` went from the O(1) bucket size straight to a per-edge walk, while the
  // degree-sum walk that answers "one end labelled, the other free" in O(|label|) existed and
  // was reachable only WITH a predicate. Item 286 gave that branch the rung: 54.06 -> 21.38ms.
  //
  // IT STILL FLAGS, AT ~2100x, AND THAT IS CORRECT RATHER THAN OUTSTANDING. These two members
  // are NOT equivalent work: the untyped spelling needs no vertex visits at all (one bucket
  // size), while the labelled one must visit every `P` to sum its degree. O(|label|) against
  // O(1) cannot converge, so no amount of further work closes this pair — it is here as a
  // REGRESSION guard on the 54ms, not as a target. Read the four-spelling group below for the
  // comparison that IS between equivalent plans.
  // ⚠️ THE PREDICATE FORMS ITEMS 1286-1298 LIFTED, which should have been added with each one.
  // CLAUDE.md is explicit — "When adding a predicate form to the planner, add its spellings there"
  // — and six forms shipped (items 1284, 1286, 1288, 1289, 1290, 1298) before item 1300 noticed
  // none of them had. Each pair below is LOGICALLY IDENTICAL regardless of null or type, so a
  // disagreement is a real defect and not a semantics question:
  //
  //   `NOT IN` is `not3` of `IN`, so the two spellings are one question by definition (item 1288).
  //   `IS LABELED` is total, so the doubly-negated form is the same test (item 1289).
  //   `IS TYPED` is total, so the doubly-negated form is the same test (item 1298).
  //
  // They are also the pairs a future change to those families would split FIRST, which is the
  // point of having them here rather than only in the unit tests: those assert the answer, and this
  // asserts the COST.
  [
    'NOT IN vs NOT (IN) — the negated membership (item 1288)',
    [
      'MATCH (n:P) WHERE n.k NOT IN [1, 2] RETURN count(*) AS c',
      'MATCH (n:P) WHERE NOT (n.k IN [1, 2]) RETURN count(*) AS c',
    ],
  ],
  [
    'IS LABELED vs the doubly-negated form (item 1289)',
    [
      'MATCH (n:P) WHERE n IS LABELED P RETURN count(*) AS c',
      'MATCH (n:P) WHERE NOT (n IS NOT LABELED P) RETURN count(*) AS c',
    ],
  ],
  [
    'IS TYPED vs the doubly-negated form (item 1298)',
    [
      'MATCH (n:P) WHERE n.k IS TYPED INTEGER RETURN count(*) AS c',
      'MATCH (n:P) WHERE NOT (n.k IS NOT TYPED INTEGER) RETURN count(*) AS c',
    ],
  ],
  [
    'label on start: redundant vs absent',
    ['MATCH (a:P)-[:E]->(b) RETURN count(*) AS c', 'MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  ],
  // An ANONYMOUS end node against a NAMED one, when the projection reads neither (item 775).
  // `->()` and `->(b)` ask the same question here — one row per edge, 200,000 either way,
  // measured — and they cost 83.51 ms against 19.03, a **4.4x** gap found by this probe's own
  // method applied by hand.
  //
  // The cause is located: `hopEnds` in `hop-projection.ts` returns `null` when
  // `node.variable === undefined`, so an anonymous end refuses the whole hop-projection fast
  // path and falls to the general row pipeline. It is the THIRD instance of this shape in that
  // file — item 444 found `-[e:E]->` against `-[:E]->` at 3.7x from a guard its own comment
  // called "defensive, not load-bearing", and item 505 found split `MATCH` clauses at 747.9 ms
  // against 0.0.
  //
  // FIXED at item 776: an anonymous end now gets a SYNTHESIZED binding name the parser cannot
  // produce, rather than a refusal — 4.60-4.88x, and the two spellings converge (16.48 against
  // the named spelling's 17.40). This group stopped flagging in the same run that measured it,
  // which is the cycle it was added for. It stays as the REGRESSION guard.
  //
  // The sentinel's uniqueness is load-bearing: with a plausible name like `b`,
  // `MATCH (b:P)-[r:E]->() RETURN b.age` would bind the FAR node to `b` and read its age. The
  // whole suite passed that mutant before item 776 added tests for it.
  // An INLINE property on the START against the same predicate in a clause `WHERE` (item 777).
  // Equivalent spellings, asserted-equal row counts (2,065 each on the probe's own fixture
  // shape), and **8.4x apart** — 8.69 / 8.34 / 8.42 ms against 1.00 / 1.00 / 0.99 over three
  // reads of `MATCH (a:P {k: 5})-[:E]->(b) RETURN b.k` and its clause twin.
  //
  // Cause located: `plainNode` is `(n.properties?.length ?? 0) === 0 && n.where === undefined`,
  // so an inline property on the start refuses `detectHopProjection` outright, while the clause
  // form is admitted. The FAR node does not have this problem — `closedFarPred` pushes an inline
  // predicate there into the walk, which is why the mirror pair runs the other way (inline on the
  // END is 1.7x FASTER than its clause twin, 8.34 against 14.36). So inline predicates are
  // pushed down at one end of the same hop and fatal at the other.
  //
  // FOURTH instance in `hop-projection.ts` of a gate on whether something is PRESENT rather than
  // whether it is USED (items 444, 505, 776, this).
  //
  // FIXED at item 778 by `liftStartProps`, item 505's shape: a REWRITE lifting the inline property
  // into the `WHERE` the fast path already handles. 5.31x, and the two spellings converge (0.95
  // against 0.95). This group stopped flagging in the same run that measured the fix. It stays as
  // the REGRESSION guard.
  //
  // THREE refusals carry its correctness, and mutation found all three untested: a NULL literal
  // (inline `{k: null}` is IS NULL per item 260, where `k = null` is UNKNOWN), a PARAM (which
  // cannot be shown non-null at compile time), and a QUANTIFIED segment — that last one found by
  // the suite rather than by reasoning, because a clause `WHERE` DISQUALIFIES the unbounded
  // var-length BFS rung and `->+` then faults on the trail budget.
  [
    'an INLINE start property vs a clause WHERE (item 777)',
    [
      'MATCH (a:P {k: 5})-[:E]->(b) RETURN b.k AS v',
      'MATCH (a:P)-[:E]->(b) WHERE a.k = 5 RETURN b.k AS v',
    ],
  ],
  // THREE spellings of a predicate on the hop's FAR node, which is the MIRROR of the group above
  // and where the gap turned out to be between the two forms that both already took the fast
  // path. Item 777 recorded inline-vs-clause here and left it as the open asymmetry; item 780
  // found the real outlier was the INLINE NODE `WHERE` — admitted by `closedFarPred`, which had
  // already proved it reads nothing but the far variable, and then compiled WITHOUT that proof,
  // so `directEqProps` declined and it ran on the generic evaluator:
  //
  //   `->(b {k: 5})`          13.83 ms    `->(b WHERE b.k = 5)`   20.55 -> 14.14 (1.45x)
  //   `->(b) WHERE b.k = 5`   19.31
  //
  // Passing the proof closed it. Item 781 then closed the clause form the same way — a clause
  // `WHERE` reading nothing but the far variable satisfies `ownVar`'s proof too, so it compiles
  // to a far PREDICATE and drops the gate: 21.07 -> 13.90 (1.52x), and an AND of two far-local
  // conjuncts 22.49 -> 14.93 (1.51x). All three spellings now land together, which is what this
  // group is here to keep true.
  //
  // What it canNOT reach, deliberately: a clause that also reads the START or the REL (those
  // belong to `carried`, which has the walks that bind them), and a clause combined with an
  // inline far constraint that does not lift — merging would drop the inline one, so the lift
  // refuses. Both are pinned as tests rather than as probe rows, because they are correctness.
  [
    'a predicate on the FAR node: three spellings (item 780)',
    [
      'MATCH (a:P)-[:E]->(b {k: 5}) RETURN b.k AS v',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 5) RETURN b.k AS v',
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 5 RETURN b.k AS v',
    ],
  ],
  // A MIXED clause written both ways round. These are one question — `AND` in FILTER position,
  // where `filterPredicate`'s contract makes conjunct order unobservable — and they cost
  // differently, because `filterPredicate` DECLINES when no conjunct can raise and the written
  // order then survives. Item 782 measured 22.00 far-first against 24.18 start-first and closed
  // it by hoisting the far-local conjunct, which always goes first whichever way it is written:
  // 14.93 and 14.61 after, a 1.02x spread against 1.10x.
  //
  // Worth keeping because the residual is what makes it fast rather than the hoist alone — what
  // is left after the far conjuncts leave is START-ONLY, so the walk that gates a vertex before
  // touching its adjacency takes over. A change that stopped the residual being recognised that
  // way would show up here as the spread returning, with both answers still correct.
  [
    'a MIXED clause, far-first vs start-first (item 782)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 5 AND a.k >= 0 RETURN b.k AS v',
      'MATCH (a:P)-[:E]->(b) WHERE a.k >= 0 AND b.k = 5 RETURN b.k AS v',
    ],
  ],
  [
    'an ANONYMOUS end node vs a named one (item 775)',
    ['MATCH (:P)-[r:E]->() RETURN r.k AS v', 'MATCH (:P)-[r:E]->(b) RETURN r.k AS v'],
  ],
  // FOUR spellings of one question that ARE equivalent work — one end labelled, the other
  // free, every arrow direction and every side. All four now take a degree sum over the same
  // 200,000-vertex bucket, so unlike the pair above they SHOULD converge.
  //
  // They now do, and the story of why is worth more than the group. Under the OLD fixture this
  // flagged at 3.3x and item 286 recorded the cause as an index asymmetry — "`edgesToByLabel`
  // costs ~1.9x `edgesFromByLabel`" — on the strength of the split lining up exactly with which
  // index each walk reads (17.800 ms on FROM against 33.414 and 33.984 on TO).
  //
  // ITEM 287 REFUTED THAT. Both indexes are the same structure, so a 1.9x cannot be structural;
  // the fixture was the variable. `from` was `v${e % N}` — inserted in VERTEX CREATION ORDER,
  // which is the order these walks iterate — while `to` was a pseudorandom permutation, so one
  // index was walked sequentially and the other jumped around. Swapping the construction FLIPPED
  // which spelling was slow, and scattering both made all four converge. The fixture above is
  // now symmetric for that reason.
  //
  // A fix applied to one side only would also have left these behind, which is exactly how the
  // far endpoint sat on the per-edge tally for eight items — so the group stays.
  [
    'one end labelled, the other free: four spellings (item 286)',
    [
      'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
      'MATCH (b)<-[:E]-(a:P) RETURN count(*) AS c',
      'MATCH (a)-[:E]->(b:P) RETURN count(*) AS c',
      'MATCH (b:P)<-[:E]-(a) RETURN count(*) AS c',
    ],
  ],
  [
    'AND order',
    [
      "MATCH (n:P) WHERE n.k = 2 AND n.s = 's1' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.s = 's1' AND n.k = 2 RETURN count(*) AS c",
    ],
  ],
  // A product's ONE-SIDED predicate, spelled as one clause of two patterns and as two clauses
  // of one. `pushWhereIntoNode` declined on `patterns.length !== 1`, so the comma spelling kept
  // the predicate as a CLAUSE FILTER — evaluated once per surviving binding, and a binding over
  // a product is a `Map` materialized per product row before anything filters it — while the
  // two-clause spelling pushed it into the node, evaluated once per SCANNED vertex. 15.6x at
  // 4 x 100,000, both answering the same rows. This is item 121's shape (a multi-pattern
  // spelling at 160x) recurring in the other direction, which is why it gets a permanent group.
  //
  // `RETURN b.k` and not `count(*)`: the product-of-counts shortcut answers the count form
  // without building the product at all, so a count group would be O(1) on both members and
  // measure nothing. The projection is what forces the bindings the two spellings disagree on.
  //
  // The CORRELATED pair (`WHERE b.k = a.k`) is deliberately NOT a member. It cannot be pushed
  // onto either pattern — `visitRemaining` chooses the intra-clause visit order at runtime, so
  // the other pattern's variable may be unbound — and it keeps a real ~3.4x against its
  // two-clause twin. Putting a known-divergent pair in a probe that flags divergence makes the
  // probe lie; it is recorded in CLOSED.md instead.
  //
  // 🛑 THIS GROUP FLAGS AT ~2.3x AND THE OUTLIER IS THE INLINE `{k: 7}` MEMBER, WHICH IS
  // **CLOSED AT ITEM 644** — not outstanding, and not what the paragraphs above describe (they
  // explain the comma-vs-`MATCH MATCH` cause item 285 fixed, and predate this member). Only
  // `eqProps`/`cmpProps` reach `rejectedByElementDirect`, so the inline-props spelling evaluates
  // its predicate once per VERTEX while the other three evaluate once per SURVIVOR — 20,004
  // evaluations against 404 at 20,000 vertices, worth 1.89x at a million.
  //
  // Extending the pre-filter to inline `props` was BUILT AND REVERTED there, because the
  // pre-filter runs BEFORE the binding and so skips a binding that would RAISE:
  // `MATCH p = (a:P {k: 1}), (p:P {k: 2}) RETURN count(*)` raises on the general path and
  // answered 0 with the change. `product-count.test.ts`'s "a PATH variable colliding with a node
  // variable declines, preserving the raise" pins it, and WHICH queries raise is part of the
  // cross-engine invariant.
  //
  // Item 713 re-derived all of this — the diagnosis, the 2.8x, and the same reverted candidate,
  // which failed that same test — because the reason lived only in a code comment in
  // `executor.ts` and this group, the thing that PRINTS the flag, did not name it. That is what
  // this note is for: a flag is only readable where it is printed.
  [
    "a product's one-sided predicate: comma vs MATCH MATCH (item 285)",
    [
      'MATCH (a:S), (b:P) WHERE b.k = 7 RETURN b.k AS x',
      'MATCH (a:S) MATCH (b:P) WHERE b.k = 7 RETURN b.k AS x',
      'MATCH (a:S), (b:P WHERE b.k = 7) RETURN b.k AS x',
      'MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x',
    ],
  ],
  // An AND of two equalities against the SAME question written inline, and the two half-and-half
  // spellings between them. Added in audit item 230, which closed it: the clause chain cost
  // 47.4 ns a vertex against the inline form's 21.1 for an identical answer, because the chain
  // went to the general evaluator — which reads its element back out of the BINDING — while the
  // inline form compared the element directly. `directEqProps` now lifts the literal-valued
  // conjuncts of an all-`=` chain, which is sound precisely because a closed `=` cannot raise and
  // so a reordering has nothing to swallow.
  //
  // The REVERSED-operand member is here because `asPropCompare` is what reads each conjunct, and a
  // flip it mishandled would show up as one member of this group drifting rather than as a wrong
  // answer. (A param conjunct is the other member worth having — a param does NOT lift, since its
  // value is unknown at compile time — but this probe runs every query without parameters, so it
  // has no place to bind one. It is covered by `bench:usage`'s `read: keyed dedup lookup`, which
  // is exactly that mixed shape.)
  [
    'an AND of two equalities: clause vs inline vs mixed (item 230)',
    [
      "MATCH (n:P) WHERE n.k = 2 AND n.s = 's1' RETURN count(*) AS c",
      "MATCH (n:P {k: 2, s: 's1'}) RETURN count(*) AS c",
      "MATCH (n:P {k: 2}) WHERE n.s = 's1' RETURN count(*) AS c",
      "MATCH (n:P WHERE n.k = 2 AND n.s = 's1') RETURN count(*) AS c",
      "MATCH (n:P) WHERE 2 = n.k AND 's1' = n.s RETURN count(*) AS c",
    ],
  ],
  // The multi-segment count families, added in audit item 225 because items 219-222 each closed a
  // spelling gap that this standing instrument did not guard. Every one of them was found by a
  // throwaway probe at the time, and every one was ALREADY OPEN before the item that fixed it:
  //
  //   219  2-hop middle   WHERE 2331.7ms / inline WHERE 1183.1 / inline prop 482.3   (2.4x, 13.3x)
  //   220  2-hop end      forward 2363.5 against the hand-reversed spelling's 118.1  (20.0x)
  //   222  3-hop interior WHERE 9360.5 / inline WHERE 3945.9 / inline prop 560.7      (2.4x, 13.3x)
  //
  // So these are regression guards for four fixes, not speculative coverage.
  //
  // What is deliberately NOT here: the 3-hop END-filtered question. Item 223 established that it
  // stays on the row pipeline ON PURPOSE in both engines — reversing it is a selectivity gamble
  // native priced and declined — so it is ~9s on this fixture, and a group whose slowest member
  // takes seconds would make a probe nobody can afford to run.
  [
    'hop, MIDDLE filtered (item 219)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c) RETURN count(*) AS c',
    ],
  ],
  [
    // The reversed-arrow member is the one that matters most: item 220's whole finding was that
    // the forward spelling and the same question written backwards were 20x apart, and the fix
    // was a planner reversal rather than a new walk. If that reversal ever stops firing, THIS
    // member is what notices.
    'hop, END filtered, including the reversed arrows (item 220)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE c.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2}) RETURN count(*) AS c',
      'MATCH (c)<-[:E]-(b)<-[:E]-(a:P) WHERE c.k = 2 RETURN count(*) AS c',
    ],
  ],
  [
    'three hops, SECOND position filtered (item 222)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
  [
    // The third position is gated once per MIDDLE EDGE where the second is gated once per vertex,
    // so these two groups are different questions with different costs — which is why they are two
    // groups and not one. Within each, the three spellings must agree.
    'three hops, THIRD position filtered (item 222)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
  [
    // `P` is carried by every vertex in this fixture, so the label constrains nothing and the two
    // are one question. Item 221's three-hop tally reads a VACUOUS end label as absent, decided
    // per execution; if that collapse regresses, the labelled member pays an endpoint resolve per
    // edge and this group spreads.
    'three hops: a vacuous start label vs none (item 221)',
    [
      // `:Univ` and NOT `:P`, which is the whole point of this group and what it was failing to
      // test. `vacuousLabel` is an EXACT equality — the label's bucket against `vertexCount` — so
      // the four `:S` nodes below made `:P` non-vacuous, `effectiveLabel` could not elide it, and
      // this group compared a real label constraint against none. It read 1.87x and item 324
      // widened it to 2.6x by speeding up the unlabelled member alone.
      //
      // With a label every vertex carries, the labelled member goes **537.92ms -> 190.91** and the
      // two land within **1.03x** (item 325). FOUR vertices out of 200,004 were costing it 2.8x,
      // which is the cliff worth knowing about: vacuity is all-or-nothing, so one unlabelled node
      // in a real graph defeats the elision for every query anchored on that label.
      //
      // `:P` stays non-vacuous on purpose. The `label on start` group below is a deliberate
      // guard on exactly that asymmetry (CLOSED.md: "do not quiet it by reverting the fixture"),
      // and giving the `:S` nodes a `:P` instead of an `:Univ` would have silenced it — it went
      // sub-millisecond when that was tried.
      'MATCH (a:Univ)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
  // FOUR hops, forward against the REVERSED arrows — one question, and the shape item 290 added
  // the count family's fourth arm for. Before that arm the forward spelling fell to the general
  // matcher at 1154ns a path against the three-hop shortcut's 13.7ns: 36,082ms at 50,000 nodes of
  // degree 5, a x420 step where the degree predicts x6, and 3457x off native.
  //
  // The REVERSED member is the one that earns its place. Item 220's finding was a 20x gap between
  // a question and the same question written backwards, and the walk hoists the `a` side from
  // `b`'s reverse index while taking `x` from `d`'s forward one — four independent direction
  // flags, so a walk that handles one end only would pass the forward spelling and fail this.
  [
    'four hops: forward vs the reversed arrows (item 290)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (x)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:P) RETURN count(*) AS c',
    ],
  ],
  // FIVE hops, which is `longChainCount` rather than a degree product (item 298). The sweep
  // takes one pass per segment and reads a per-leg direction flag, so a reversal is five
  // independent flips — and the START label moves to the other end of the written pattern,
  // which is the position the sweep SEEDS. Getting that wrong does not change the answer when
  // the graph makes both ends symmetric, so the TIME is the signal here, as it is above.
  [
    'five hops: forward vs the reversed arrows (item 298)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(x) RETURN count(*) AS c',
      'MATCH (x)<-[:E]-(e)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:P) RETURN count(*) AS c',
    ],
  ],
  // A quantified hop spelled as a parenthesized GROUP against the abbreviated form — one
  // question, and the group spelling cost 1.87x until `dropUnreadGroupBinds` (item 569). The
  // group compiles to a repetition UNIT that materializes a per-rep LIST for every inner
  // variable; when nothing downstream reads them, that work is the whole difference.
  //
  // The third member names NO inner variables at all, which is the same plan arrived at by a
  // different route — a regression that reaches only the elision shows as the first member
  // drifting away from the other two rather than as all three moving.
  [
    'a quantified hop: group vs abbreviated spelling (item 569)',
    [
      'MATCH (a:P)((x)-[e:E]->(y)){1,2} RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,2}(y) RETURN count(*) AS c',
      'MATCH (a:P)(()-[:E]->()){1,2} RETURN count(*) AS c',
    ],
  ],
  // The ENDPOINT PREDICATE on that same quantified hop, in every spelling it has (item 583).
  // Before 583 the inline and clause forms both DECLINED the degree rung and enumerated, so they
  // agreed with each other at ~7x the cost — which is the failure mode this probe cannot see:
  // equally slow is not a flag. They are here because carrying only ONE spelling is the thing
  // that would create a flag, and that is exactly what items 303/304 measured at 139x on the
  // one-hop version of this question.
  //
  // There is deliberately NO group-spelling member: outside a quantified group, `y` is the LIST
  // of per-rep bindings rather than a node, so `WHERE y.k > 25` there is a different question (or
  // not one at all), and the group's own `WHERE` is a PER-REP predicate testing every landing
  // rather than the endpoint. The equivalence class is the two endpoint spellings, and the
  // equality group below is the same class for `=`.
  [
    'a quantified hop with an ENDPOINT PREDICATE: inline vs clause (item 583)',
    [
      'MATCH (a:P)-[:E]->{1,2}(y WHERE y.k > 25) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,2}(y) WHERE y.k > 25 RETURN count(*) AS c',
    ],
  ],
  // DEPTH 3 (item 588), where a WALK now takes the level recurrence in BOTH engines. The three
  // members are one question: the abbreviated hop, the parenthesized GROUP, and the group with no
  // inner variables at all. They reach the same rung — the group spellings through item 569's
  // `dropUnreadGroupBinds` — so a regression that reaches only one of them shows as a spread here
  // rather than as a slow query nobody is watching. Before 588 all three ENUMERATED and agreed
  // with each other at ~20x the cost, which is the failure this probe structurally cannot see:
  // equally slow is not a flag. That is what the bench pair is for.
  [
    'a DEEP walk: abbreviated vs group spelling (item 588)',
    [
      'MATCH WALK (a:P)-[:E]->{1,3}(y) RETURN count(*) AS c',
      'MATCH WALK (a:P)((x)-[e:E]->(y)){1,3} RETURN count(*) AS c',
      'MATCH WALK (a:P)(()-[:E]->()){1,3} RETURN count(*) AS c',
    ],
  ],
  [
    'a quantified hop with an ENDPOINT EQUALITY: three spellings (item 583)',
    [
      'MATCH (a:P)-[:E]->{1,2}(y {k: 7}) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,2}(y WHERE y.k = 7) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,2}(y) WHERE y.k = 7 RETURN count(*) AS c',
    ],
  ],
];

const timed = (q: string, params?: Record<string, unknown>): { ms: number; answer: string } => {
  let best = Infinity;
  let answer = '';

  for (let i = 0; i < REPS; i++) {
    const t = performance.now();
    const rows = params === undefined ? tsQuery(g, q) : tsQuery(g, q, params);

    best = Math.min(best, performance.now() - t);
    answer = JSON.stringify(rows);
  }

  return { ms: best, answer };
};

console.log(`${N} vertices / ${N * 3} edges, min of ${REPS}, flagging spread > ${TOL}x\n`);

const wrong: string[] = [];
const slow: { name: string; spread: number; ms: number }[] = [];
const fast: string[] = [];

/**
 * The spread the NULL CONTROL group measured — one query against itself, so whatever it reads
 * is this run's own variance and nothing else.
 *
 * It gates the summary rather than only printing in place, because item 635 proves printing is
 * not enough: that item chased a 1.40x for three ticks with the refuting number already in its
 * own output (the control spelling's rounds were 1.86 / 4.35 / 1.76ms, a 2.47x SELF-ratio,
 * larger than the gap it was the control for). A reader reaches the summary with the per-group
 * tables already scrolled away, so the summary is where the comparison has to happen.
 *
 * `undefined` when the control did not run — `SPELL_ONLY` filtered it out, or it fell under
 * `FLOOR_MS` — and the summary then says so rather than silently dropping the gate.
 */
const nullSpreads: { ms: number; spread: number }[] = [];
const NULL_CONTROL = 'NULL CONTROL';

/**
 * The null control nearest `ms` in COST, or `undefined` when none ran.
 *
 * One control cannot price a whole page. Item 636 added a single one at the numeric group's
 * ~2 ms and its own record said so — *"a null control at a different cost measures a different
 * noise floor"* — and then item 643 found both ways that bites:
 *
 *   - At the DOCUMENTED `SPELL_N=200000` the control fell under `FLOOR_MS` entirely, so the page
 *     printed UNGATED and nothing was gated at the size people actually run.
 *   - At `SPELL_N=1000000` it ran at ~2 ms and was used to gate a 10 ms group, which read 2.14x
 *     against it and was FLAT when measured directly. That cost two ticks of chasing.
 *
 * So there are now several, spanning the page's range, and a group is judged against the one
 * closest to its own duration — compared in LOG space, because noise is multiplicative here and
 * 1 ms is as far from 10 as 10 is from 100.
 */
const nullNear = (ms: number): { ms: number; spread: number } | undefined => {
  let best: { ms: number; spread: number } | undefined;
  let bestGap = Infinity;

  for (const c of nullSpreads) {
    const gap = Math.abs(Math.log(c.ms) - Math.log(ms));

    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }

  return best;
};

// `SPELL_ONLY=<substring>` runs just the matching groups, which is how a flag gets CONFIRMED
// (item 455). The two-pass min below removes the POSITION bias and nothing else: a whole process
// can enter a slow mode for one spelling and keep it across both passes, so "slower from either
// position" is necessary and NOT sufficient. The only sufficient check is a separate process, and
// before this flag there was no short way to run one.
const ONLY = process.env.SPELL_ONLY;

const runGroup = (
  name: string,
  spellings: readonly string[],
  params?: Record<string, unknown>,
): void => {
  // TWO passes, the second in reverse order, keeping the min per spelling.
  //
  // Whichever member runs FIRST in a group pays a large position penalty, and it is the
  // harness's, not the query's. On the `direction` group at N=200,000 the first member read
  // 234.4 / 233.6 / 236.3ms and the second 152.1 / 142.9 / 154.0 — and SWAPPING the two made the
  // penalty follow the POSITION, not the spelling (reversed-first 237.8 / 238.7 / 235.3, with
  // forward then at 148.6 / 158.8 / 146.7). In a process running only that group both read
  // 141.7 / 142.6. So the group had been reported at 1.5-2.1x across audit items 180 and 181
  // with no engine cause at all; the two spellings compile to the same predicate, which is why
  // item 181's fix could not move the number.
  //
  // Timing every spelling in both positions and taking its better reading removes the bias: a
  // spelling that is genuinely slower is slower from either position. It doubles the probe's
  // runtime, which is the right trade for an instrument whose whole output is a ratio.
  const firstPass = spellings.map((q) => timed(q, params));
  const secondPass: { ms: number; answer: string }[] = [];

  for (let i = spellings.length - 1; i >= 0; i -= 1) {
    secondPass[i] = timed(spellings[i], params);
  }

  const runs = spellings.map((q, i) => ({
    q,
    ms: Math.min(firstPass[i].ms, secondPass[i].ms),
    answer: firstPass[i].answer,
  }));
  // Both passes' answers, so a spelling that answers inconsistently is still caught.
  const answers = new Set([...firstPass, ...secondPass].map((r) => r.answer));
  const fastest = Math.min(...runs.map((r) => r.ms));
  const slowest = Math.max(...runs.map((r) => r.ms));
  const spread = slowest / Math.max(fastest, 0.01);
  const tooFast = slowest < FLOOR_MS;

  // Recorded even when it is `too fast` to flag, because a control under the floor still says
  // something — it says this run is too small for ANY ratio on it to be read.
  if (name.startsWith(NULL_CONTROL) && !tooFast) {
    nullSpreads.push({ ms: slowest, spread });
  }

  let flag = '';

  if (answers.size > 1) {
    flag = 'ANSWERS DIFFER';
  } else if (tooFast) {
    flag = 'too fast';
  } else if (spread > TOL) {
    flag = `${spread.toFixed(1)}x`;
  }

  console.log(`${flag.padStart(15)}  ${name}`);

  for (const r of runs) {
    console.log(`                   ${r.ms.toFixed(2).padStart(9)}ms  ${r.q}`);
  }

  if (answers.size > 1) {
    wrong.push(name);

    for (const r of runs) {
      console.log(`                   -> ${r.answer.slice(0, 80)}`);
    }
  } else if (spread > TOL && !tooFast) {
    slow.push({ name, spread, ms: slowest });
  } else if (tooFast) {
    fast.push(name);
  }
};

const wanted = (n: string): boolean => ONLY === undefined || n.includes(ONLY);

for (const [name, spellings] of GROUPS.filter(([n]) => wanted(n))) {
  runGroup(name, spellings);
}

// --- THE SEEK PASS (item 579) ------------------------------------------------------------
//
// Everything above runs UNINDEXED and WITHOUT PARAMETERS, and item 578 found what that costs:
// this probe already held the pair
//
//   MATCH (n:P) WHERE n.k = 2 AND n.s = 's1'     against     MATCH (n:P {k: 2}) WHERE n.s = 's1'
//
// in item 230's group and could not flag a confirmed 1.41x gap between their PARAMETERIZED,
// INDEXED forms — because with no index there is no seek, so no seek-versus-recheck asymmetry
// exists to find. Its own comment delegated the param case to `bench:usage`'s
// `read: keyed dedup lookup`, which was a single row and therefore never a comparison.
//
// That matters more than one gap: **every index-seeding bug this engine has had was one spelling
// seeding where another did not** (the equivalent-spelling note lists four), and the instrument
// built to catch that class was blind to all of it.
//
// The indexes are created HERE, after the unindexed groups, so their numbers are untouched and
// stay comparable with every figure recorded against them. No second fixture, no extra memory.
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });
// THE EDGE INDEX, which this probe never had (item 1053). Item 1035 recorded that the probe
// "CANNOT SEE the edge-seed route" and deferred it because adding a selective key to a SHARED
// fixture risked every group's numbers. It does not, done this way: the index is on `ew` ALONE, so
// the groups keyed on `w` cannot seed and are unchanged.
//
// WHY IT MATTERS NOW. Items 1035, 1038, 1044, 1046 and 1049 all made an edge index reachable from a
// route that previously scanned — the GQL count, the GQL projection, the Gremlin edge hop, the
// start-filtered Gremlin hop, and `count(DISTINCT)`. FIVE shipped routes with no spelling-probe
// coverage at all, in the instrument whose entire purpose is to catch one spelling reaching an
// index while its twin does not.
g.createIndex({ on: 'edge', kind: 'hash', keys: ['ew'] });

// PRINTED, because a seek group that silently measures a SCAN is worthless and looks fine. Item
// 576 is the precedent: `createIndex` took the edge arm for any unrecognized target and built an
// index on the wrong element, costing 500x with no error. One line here makes the premise of
// every group below visible in the output.
console.log(
  `\nindexed vertex keys: ${g.vertexPropertyIndex.indexedKeys().join(', ') || 'NONE — the seek groups below measure SCANS'}` +
    `\nindexed EDGE keys:   ${g.edgePropertyIndex.indexedKeys().join(', ') || 'NONE — the edge-seed groups below measure SCANS'}\n`,
);

/**
 * Spellings of one question, run WITH an index and WITH parameters.
 *
 * THE SEEKED KEY IS `s`, NOT `k`, and the choice is the floor. `k` is `i % 50`, so a seek on it
 * returns 4,000 of 200,000 and a count over them takes 0.32ms — under `FLOOR_MS`, which means
 * "too fast, not compared" and no ratio at all. `s` is `i % 7` (28,571 rows), which lands the
 * same shapes above 1ms. Item 578's gap is a PER-ROW cost, so the row count is not incidental to
 * seeing it: at 20 matches a seek it was unresolvable and at 1000 it was 1.41x.
 */
const SEEK_GROUPS: [string, readonly string[], Record<string, unknown>][] = [
  [
    // THE EDGE-SEED ROUTES (item 1053), the five this session made reachable and none of which had
    // spelling coverage. `ew` is 1 in 1,000, so the seed is admitted; every member must land on the
    // seeded route, and a member that falls back to a scan is 100x+ away — exactly the cliff this
    // probe exists to catch, and all five routes were verified by hand one at a time instead.
    //
    //   item 1035  the GQL COUNT, via `tallyEdges`
    //   item 1038  the GQL PROJECTION, via `relSeekedHopWalk`
    //   item 1049  `count(DISTINCT …)`, via `foldFor` gaining a fold
    //
    // The clause and inline spellings of each are both here, because "one spelling seeds and its
    // twin scans" is the precise defect, and items 1031/1038 are where that gap was 100-190x.
    'EDGE SEED: the count, projection and DISTINCT routes — clause vs inline',
    [
      'MATCH ()-[r:E]->() WHERE r.ew = $ew RETURN count(*) AS c',
      'MATCH ()-[r:E {ew: $ew}]->() RETURN count(*) AS c',
      'MATCH (a)-[r:E]->(b) WHERE r.ew = $ew RETURN count(*) AS c',
    ],
    { ew: 7 },
  ],
  [
    // The PROJECTION and the AGGREGATES over the same seeded key, which reach it through a
    // different route (`relSeekedHopWalk`, and `detectHopAggregate`'s delegation to it).
    'EDGE SEED: projection and aggregates over a seeded edge key',
    [
      'MATCH ()-[r:E]->() WHERE r.ew = $ew RETURN r.ew AS v',
      'MATCH ()-[r:E {ew: $ew}]->() RETURN r.ew AS v',
    ],
    { ew: 7 },
  ],
  [
    // THE EDGE TWIN OF THE CLAUSE-VS-INLINE QUESTION, which this probe had no group for at all.
    // Item 125 found a 4x gap between a clause `WHERE` and an inline `{k: v}` on a NODE
    // predicate and every group here inherited that framing, so the same question about a
    // RELATIONSHIP went unasked. Measured ad hoc first at 5.2x — `WHERE r.w = $v` 22.43 ns an
    // edge against inline `{w: $v}` 118.71, both returning the identical 100 rows — which is
    // this engine's named bug class and was invisible to its own instrument.
    //
    // `w` is `e % 5`, so an equality keeps a fifth of the edges: selective enough to measure a
    // per-edge filter, far enough above `FLOOR_MS` to be compared at all.
    'EDGE predicate: a param equality — clause vs inline vs inline-WHERE',
    [
      'MATCH (a:P)-[r:E]->(b) WHERE r.w = $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E {w: $w}]->(b) RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w = $w]->(b) RETURN count(*) AS c',
    ],
    { w: 2 },
  ],
  [
    // The ORDERING twin: `cmpProps` carries these where `eqProps` cannot, so they can diverge
    // from the equality group above independently.
    'EDGE predicate: an ordering comparison — clause vs inline-WHERE',
    [
      'MATCH (a:P)-[r:E]->(b) WHERE r.w >= $w RETURN count(*) AS c',
      'MATCH (a:P)-[r:E WHERE r.w >= $w]->(b) RETURN count(*) AS c',
    ],
    { w: 2 },
  ],
  [
    // And the PROJECTED form, because item 125's gap was on a count and a count can take a
    // shortcut no projection can.
    'EDGE predicate: a param equality, projected — clause vs inline',
    [
      'MATCH (a:P)-[r:E]->(b) WHERE r.w = $w RETURN r.w AS w',
      'MATCH (a:P)-[r:E {w: $w}]->(b) RETURN r.w AS w',
    ],
    { w: 2 },
  ],
  [
    // The pair item 578 measured at 1.41x on the COUNT form (clause 21.3/20.8/21.8k ops/s
    // against inline 11.5/14.4/14.7k, three interleaved rounds at 1000 matches a seek). Native
    // showed no gap. Every member must SEEK; one that scans instead is the bug this exists for.
    // The second conjunct is `n.k >= 0`, which EVERY row satisfies, and that is deliberate: with
    // `n.k = 2` the four members returned 571 rows instead of 28,571 and the whole group fell
    // under `FLOOR_MS` at 0.29-0.52ms — "too fast, not compared". A selective second conjunct
    // measures the filter; a vacuous one leaves the SEEK's row count intact, which is what a
    // per-row gap needs to be visible. It also matches item 578's shape, whose `u.active = true`
    // kept a third of the rows rather than a fiftieth.
    'SEEK: a param equality AND a second conjunct — clause vs inline (item 578)',
    [
      'MATCH (n:P) WHERE n.s = $s AND n.k >= 0 RETURN count(*) AS c',
      'MATCH (n:P {s: $s}) WHERE n.k >= 0 RETURN count(*) AS c',
      'MATCH (n:P WHERE n.s = $s) WHERE n.k >= 0 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k >= 0 AND n.s = $s RETURN count(*) AS c',
    ],
    { s: 's1' },
  ],
  [
    // THE NUMERIC twin of the group above. Item 578's 1.41x was measured seeking a NUMERIC key
    // (`score`) at ~1000 matches; the group above seeks a STRING key (`s`) at 28,571 and
    // CONVERGES within 1.07x. This is the group that separates the two variables, and it needs a
    // raised `SPELL_N` to clear the floor: `k` is `i % 50`, so 200,000 vertices give only 4,000
    // matches and ~0.5ms. At SPELL_N=1000000 it is 20,000 matches.
    'SEEK: a param equality on a NUMERIC key AND a second conjunct (item 578)',
    [
      "MATCH (n:P) WHERE n.k = $k AND n.s >= '' RETURN count(*) AS c",
      "MATCH (n:P {k: $k}) WHERE n.s >= '' RETURN count(*) AS c",
      "MATCH (n:P WHERE n.k = $k) WHERE n.s >= '' RETURN count(*) AS c",
    ],
    { k: 2 },
  ],
  [
    // THE NULL CONTROL: one query, listed twice. Its spread is instrument noise BY
    // CONSTRUCTION — there is no spelling difference for it to measure — so it prices every
    // other flag on this page. Read it first. If it reads 1.3x, a group flagged at 1.3x has
    // measured nothing.
    //
    // It exists because the group ABOVE sent item 635 chasing a 1.30-1.33x that reproduced
    // across three separate processes and still was not real. At SPELL_N=1000000 those members
    // run 1.7-2.4ms, which clears `FLOOR_MS` and is still deep in the noise: the same script
    // re-run gave 1.40x then 1.19x, and the same question at 100,000 matches on 5,000,000
    // vertices — where the harness is quiet to 0.3% and the seek is 9x better than the scan —
    // converged at 0.96x. `FLOOR_MS` at 1ms is NOT high enough to make a ratio mean something,
    // and this control is the cheapest way to say so on every run rather than in a comment.
    //
    // It deliberately shares the numeric group's shape and params so it sits at the same
    // duration: a null control at a different cost measures a different noise floor.
    'NULL CONTROL (seek): one query twice — this is the instrument, not a result',
    [
      "MATCH (n:P) WHERE n.k = $k AND n.s >= '' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.k = $k AND n.s >= '' RETURN count(*) AS c",
    ],
    { k: 2 },
  ],
  [
    // THE SECOND CONTROL, and it is a SCAN so it clears `FLOOR_MS` at the DOCUMENTED
    // `SPELL_N=200000` — the one above only does at 1,000,000, so item 643 found the page
    // printing UNGATED at the size the memory note actually tells you to run.
    //
    // Two controls at different costs also fix the deeper problem: `nullNear` judges each group
    // against whichever is closest to ITS duration, instead of pricing a 10 ms group against a
    // 2 ms control. That mistake read 2.14x on a group that measured FLAT directly.
    'NULL CONTROL (scan): one query twice, at scan cost',
    [
      "MATCH (n:P) WHERE n.s >= '' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.s >= '' RETURN count(*) AS c",
    ],
    {},
  ],
  [
    // FOUR spellings of a two-equality question where one key is SEEKED and the other filtered,
    // all returning the same rows — which is what lets `{k, s}` sit in a group at all (a member
    // with a different answer is reported as ANSWERS DIFFER, so the vacuous-conjunct group above
    // cannot hold it).
    //
    // Item 580 narrowed the gap with this shape and REFUTED the obvious cause. Nothing here
    // loses the seek: the scan reference (`MATCH (n:P) WHERE n.s >= ''`, no seekable conjunct) is
    // 7.09ms at 200,000 vertices where every spelling below is 1.0-3.5ms. "One spelling lost the
    // seek" is the hypothesis this engine's history makes most tempting — every historical index
    // bug was exactly that — and it is not what this is.
    //
    // What DID narrow: both conjuncts written INLINE is as fast as the best clause form, and
    // without a second conjunct the spellings converge. So the slow corner needs the MIX of an
    // inline seed and a clause conjunct. The mechanism is still open.
    'SEEK: two equalities, one seeked — all four spellings (item 580)',
    [
      'MATCH (n:P) WHERE n.k = $k AND n.s = $s RETURN count(*) AS c',
      'MATCH (n:P {k: $k}) WHERE n.s = $s RETURN count(*) AS c',
      'MATCH (n:P {s: $s}) WHERE n.k = $k RETURN count(*) AS c',
      'MATCH (n:P {k: $k, s: $s}) RETURN count(*) AS c',
    ],
    { k: 2, s: 's1' },
  ],
  [
    // The seekable conjunct ALONE, so the group above has a floor to read against: if both its
    // members regress together, this says whether the seek itself moved.
    'SEEK: a param equality alone — clause vs inline vs inline-WHERE',
    [
      'MATCH (n:P) WHERE n.s = $s RETURN count(*) AS c',
      'MATCH (n:P {s: $s}) RETURN count(*) AS c',
      'MATCH (n:P WHERE n.s = $s) RETURN count(*) AS c',
    ],
    { s: 's1' },
  ],
  [
    // A PARAM against the same question written with a LITERAL. A literal lifts at compile time
    // and a param cannot (item 230's group says so), so this is the one group EXPECTED to
    // spread — it is here to measure how much, not to stay quiet.
    'SEEK: param vs literal on the seeked key',
    [
      'MATCH (n:P) WHERE n.s = $s RETURN count(*) AS c',
      "MATCH (n:P) WHERE n.s = 's1' RETURN count(*) AS c",
    ],
    { s: 's1' },
  ],
  [
    // A PROJECTION rather than a count, so the seek is measured with rows flowing out of it.
    'SEEK: a param equality, projected — clause vs inline',
    [
      'MATCH (n:P) WHERE n.s = $s RETURN n.k AS k ORDER BY k LIMIT 5',
      'MATCH (n:P {s: $s}) RETURN n.k AS k ORDER BY k LIMIT 5',
    ],
    { s: 's1' },
  ],
  [
    // The hop forms, where item 125's 4x lived. An anchored hop whose START is seekable.
    'SEEK: an anchored hop — clause vs inline on the start',
    [
      'MATCH (a:P)-[:E]->(b) WHERE a.s = $s RETURN count(*) AS c',
      'MATCH (a:P {s: $s})-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P WHERE a.s = $s)-[:E]->(b) RETURN count(*) AS c',
    ],
    { s: 's1' },
  ],
];

for (const [name, spellings, params] of SEEK_GROUPS.filter(([n]) => wanted(n))) {
  runGroup(name, spellings, params);
}

console.log(
  `\n${wrong.length} group(s) disagree on the ANSWER${wrong.length > 0 ? `: ${wrong.join('; ')}` : ''}`,
);
// 🛑 AND THE NULL CONTROL MEASURES A DIFFERENT VARIANCE FROM THE ONE A FLAG NEEDS (item 1073).
// It runs one query REPS times in THIS process and keeps the min, so it reports within-run jitter
// — 1.01x at 12.8ms on a typical run. The variance that matters for a flag is BETWEEN runs, and it
// is far larger at the same cost: item 1073 measured one member of the product group at
// 6.50 / 10.66 / 10.01 ms across three isolated runs, a 1.64x spread for the SAME code, wider than
// the differences between the four spellings it was being compared with. So a group that clears
// the control is not thereby confirmed — it has cleared a ruler shorter than the thing being
// measured, which is what the three-run instruction below is for.
//
// A flagged group is only a result if it beat the instrument NEAR ITS OWN COST — one query against
// itself, so a group at or under it has measured the harness, not the engine.
const clears = (s: { spread: number; ms: number }): boolean => {
  const n = nullNear(s.ms);

  return n === undefined || s.spread > n.spread;
};
// The control is the ruler, not a thing being measured, so it is never listed as a finding —
// it reported itself as a group "NOT clear of the null control" at `SPELL_REPS=1`, which is
// true, circular, and exactly the sort of line that gets quoted back as a result.
const judged = slow.filter((s) => !s.name.startsWith(NULL_CONTROL));
const real = judged.filter(clears);
const noise = judged.filter((s) => !clears(s));
// TWO decimals, and the NET ratio beside the raw one. At one decimal a group at 1.04x and a
// control at 1.02x both render `1.0x`, so the list reads as self-contradicting — "clear of the
// null control" over an entry that appears equal to it. Reachable with the documented
// `SPELL_TOL=1.5` hunt, not just in theory. The net is what the reader actually wants: the
// spread with the instrument's own variance divided out.
const show = (s: { name: string; spread: number; ms: number }): string =>
  ((): string => {
    const n = nullNear(s.ms);

    return n === undefined
      ? `${s.name} (${s.spread.toFixed(2)}x)`
      : `${s.name} (${s.spread.toFixed(2)}x, net ${(s.spread / n.spread).toFixed(2)}x vs the ${n.ms.toFixed(1)}ms control)`;
  })();

if (nullSpreads.length === 0) {
  console.log(
    '\nNULL CONTROLS: none ran (filtered out, or under the floor) — NOTHING BELOW IS GATED.',
  );
  console.log('  Every ratio here may be instrument noise. Raise SPELL_N and run it again.');
} else {
  console.log("\nNULL CONTROLS — one query against itself, so each is this run's own variance");
  console.log('  at that cost. A group is judged against the one NEAREST its own duration.');

  for (const c of nullSpreads) {
    console.log(`    ${c.spread.toFixed(2)}x at ${c.ms.toFixed(1)}ms`);
  }
}

// The heading must not claim a gate that did not run: an UNGATED list quoted later as "clear
// of the null control" would be this probe asserting the opposite of what it measured.
const heading =
  nullSpreads.length === 0
    ? `${real.length} group(s) over ${TOL}x (UNGATED — no null control in this run)`
    : `${real.length} group(s) over ${TOL}x AND clear of the nearest null control`;

console.log(`${heading}${real.length > 0 ? `:\n  - ${real.map(show).join('\n  - ')}` : ''}`);

// A FLAG IS NOT YET A FINDING, and item 1072 is why this line exists rather than only the note
// in the header. `runGroup` times every member in BOTH positions and keeps its better reading,
// which removes WITHIN-group position bias (items 180/181) — but not the state the ~40 groups
// before it have left behind. The `SEEK: a param equality AND a second conjunct` group had been
// recorded as a real 2.4x gap since item 578 on the strength of being over the threshold:
//
//   in the full run   8.74 / 7.91 / 8.72 / 18.83 ms      2.4x
//   SPELL_ONLY alone  4.01 / 3.90 / 4.10 /  3.96         1.05x
//
// Its compiled hints are the same SET in both conjunct orders and the chooser takes the narrowest
// (28,572 against 200,000), so there was nothing to fix. The other two flagged groups SURVIVE the
// same check — `label on start` at 1545x and item 285's product at 2.30x — so the confirmation
// step separates them, which is exactly what makes it worth printing.
if (real.length > 0) {
  console.log('\n  CONFIRM EACH BEFORE TREATING IT AS A FINDING — a flag can still be this');
  console.log('  harness. Re-run the group ALONE, where no earlier group has polluted dispatch,');
  console.log('  THREE TIMES: one isolated run is still one reading (item 1073).');

  for (const s of real) {
    // The name is single-quoted for the shell, so an apostrophe in it (`a product's …`) has to
    // be escaped or the command it prints does not run — which would defeat the whole point of
    // printing a command.
    const only = s.name.slice(0, 44).replaceAll("'", String.raw`'\''`);

    console.log(`    SPELL_N=${N} SPELL_REPS=${REPS} SPELL_ONLY='${only}' bun run spelling`);
  }
}

if (noise.length > 0) {
  console.log(
    `${noise.length} group(s) over ${TOL}x but NOT clear of the null control — not results:\n  - ${noise
      .map(show)
      .join('\n  - ')}`,
  );
}

// `SPELL_FLOOR` as well as `SPELL_N`, because for a SEEDED group the old advice is wrong (item
// 1053). Raising `SPELL_N` raises the match count proportionally and the seeded route stays fast —
// the edge-seed groups read 0.08-0.11 ms at `SPELL_N=200000` and would at any size — so the knob
// that makes them comparable is the FLOOR. Telling a reader to raise the fixture instead sends
// them to the one thing that cannot work, which item 1051 established on the Rust twin by raising
// its fixture 10x and watching all eight blind groups stay blind.
const fastTail =
  fast.length > 0
    ? ` (raise SPELL_N, or SPELL_FLOOR for a group that is fast because it SEEKS): ${fast.join('; ')}`
    : '';

console.log(`${fast.length} group(s) under ${FLOOR_MS}ms, not compared${fastTail}`);
