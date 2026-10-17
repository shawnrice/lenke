// Item 445: what does DECLINING the hop fast path cost, and is any of it about edges?
//
// The question started as "projecting an edge costs 100x projecting a node", from the
// cross-engine bench: `project the edge` 607.1 ms lazy against `project the element` 5.7. That
// framing was wrong twice over, and both corrections are the reason this probe exists.
//
//   - WRONG FIXTURE. Those two bench rows use DIFFERENT documents — `nodesDoc` is 200,000 nodes
//     and `graphDoc` is 1,000,000 edges — so the per-row figures are 28.5 ns and 607 ns, about
//     21x rather than 100x. Matching the fixture to the claim is the standing rule and the 100x
//     was 5x of fixture.
//   - WRONG ATTRIBUTION, which is the real finding. `MATCH (:Person)-[r:KNOWS]->(b) RETURN b`
//     measured 104 ns/row and `RETURN r` 595 — but those are not the same ROUTE: item 444 admits
//     a named-but-unmentioned rel to `detectHopProjection`, and `RETURN r` mentions it, so that
//     6x was fast-path-versus-general-path wearing an edge costume. Comparing two projections
//     that BOTH decline settles it: `RETURN b, r.w` is 727 ns/row and `RETURN r, r.w` is 722.
//     Identical. Rendering an edge costs nothing measurable.
//
// So the real quantity is the ROUTE, and it is worth about 6.9x: ~105 ns/row on the fast path
// against ~720 off it, over an identical traversal with identical row counts. Every case below
// is one process (item 423), min of 9, and the fixture is the bench's own 5-edges-per-node shape.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.PN ?? 40_000);
const DEG = 5;
const REPS = Number(process.env.PR ?? 9);

const fresh = (): Graph => {
  const g = new Graph();
  const ids = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      // `Half` is on half the vertices, so it is NOT vacuous and the walk cannot use the
      // far-driven variant — which is how the START-driven cost gets priced separately. Every
      // label in a fixture must exclude something (item 435).
      id: `v${i}`,
      labels: i % 2 === 0 ? ['Person', 'Half'] : ['Person'],
      // `PCOL2` adds a SECOND numeric column, for the two-column aggregate question (item 471).
      // Off by default, because widening every node changes the scan for every other case here
      // and the numbers in the audit are against the one-column fixture.
      properties: nodeProps(i),
    }),
  );

  for (let k = 0; k < N * DEG; k++) {
    const from = (k * 7919) % N;
    // `PNOLOOP` shifts a self-loop to the next vertex. The default fixture HAS 50 of them at
    // N = 200,000 (`k * 96810 ≡ 0 mod N` every 20,000 edges), which is enough to disarm any
    // optimization gated on `selfLoopCount === 0` — item 478 measured the DECLINE before
    // noticing. Off by default: the other cases' numbers are against the original fixture.
    const to = (k * 104_729) % N;

    g.addEdge({
      id: `e${k}`,
      from: ids[from],
      to: ids[process.env.PNOLOOP !== undefined && to === from ? (to + 1) % N : to],
      labels: ['KNOWS'],
      properties: { w: k % 7 },
    });
  }

  return g;
};

const queries: Record<string, string> = {
  // The pair that isolates the question: identical traversal, identical row count, and the only
  // difference is whether the projected element is the far NODE or the EDGE.
  node: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b',
  edge: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r',
  // One PROPERTY off each, to separate binding and traversal from rendering the whole element.
  nodeprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age',
  edgeprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r.w',
  // The bench's own spelling, with both endpoints anonymous.
  benchedge: 'MATCH (:Person)-[r:KNOWS]->() RETURN r',
  // CONTROL: the same row count with NO element projected at all, so whatever this costs is the
  // traversal that both sides pay and neither change can remove.
  control: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN 1 AS one',
  // The ANONYMOUS spelling of `node`, which cannot be anything but the fast path.
  anonnode: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b',
  // A node projection that DECLINES the fast path, because the item it projects mentions the
  // rel. This is the apples-to-apples partner for `edge`: same traversal, same rows, same
  // route, and the only difference is which element is rendered.
  gennode: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b, r.w AS w',
  // And its edge twin, so the pair differs only in the SECOND projected item.
  genedge: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r, r.w AS w',
  // A node-only projection forced off the fast path by a second segment, which declines for a
  // reason that has nothing to do with edges at all.
  twohopnode: 'MATCH (:Person)-[r:KNOWS]->(b) WHERE r.w < 100 RETURN b',
  // The START-DRIVEN fast path, isolated. A non-vacuous start label refuses the far-driven
  // walk, whose 2.3x comes from hoisting `projectRow` to once per far VERTEX (item 167) — a
  // hoist that is invalid the moment a projected item reads the EDGE, since each edge differs.
  // So this, not the far-driven 105 ns/row, is the honest ceiling for any rel-binding walk.
  startdriven: 'MATCH (a:Half)-[:KNOWS]->(b) RETURN b',
  // Its general-path twin: same start label, same traversal, but mentioning the rel declines.
  startdrivengen: 'MATCH (a:Half)-[r:KNOWS]->(b) RETURN r',
  // Element projection against property projection, and then the same pair CONSUMED by an
  // aggregate so no element crosses the egress boundary at all. Item 289 settled that the
  // ts-vs-ffi gap on a row-returning query is the JSON CARRIER, so an element row (a map of id,
  // labels and properties) and a property row (one scalar) are not comparable on egress alone —
  // these four separate rendering from carrying.
  cntelem: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN count(b) AS c',
  cntprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN count(b.age) AS c',
  cntedge: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN count(r) AS c',
  cntedgeprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN count(r.w) AS c',
  // One row out, all the traversal in: whatever this costs is NOT per-row egress.
  onerow: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b LIMIT 1',
  oneprop: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age LIMIT 1',
  // Items 446 and 447 asked of the NATIVE engine, with egress held equal: every case projects
  // ONE scalar, so the row payload is identical and item 289's carrier cancels. If native shared
  // the TS gap, naming or reading the rel would show here.
  natanon: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age',
  natnamed: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age',
  natrelread: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN r.w',
  natrelwhere: 'MATCH (:Person)-[r:KNOWS]->(b) WHERE r.w < 100 RETURN b.age',
  natfarwhere: 'MATCH (:Person)-[r:KNOWS]->(b) WHERE b.age < 100 RETURN b.age',
  // Items 451 and 453 found native's filtered-count arms — a single numeric bound at 3.7x and a
  // two-bound RANGE at 3.9x. Item 448's rule says a gap found in one engine is a QUESTION about
  // the other, never a finding, so these ask TS the same ladder. Same selectivity across the
  // three (`age` is 0..89, so `< 1000` and `>= 0` are both vacuous), so only the predicate shape
  // differs.
  cnt0: 'MATCH (n:Person) RETURN count(*) AS c',
  cnt1: 'MATCH (n:Person) WHERE n.age > 5 RETURN count(*) AS c',
  cnt2: 'MATCH (n:Person) WHERE n.age > 5 AND n.age < 1000 RETURN count(*) AS c',
  cnt2rev: 'MATCH (n:Person) WHERE n.age < 1000 AND n.age > 5 RETURN count(*) AS c',
  cnt3: 'MATCH (n:Person) WHERE n.age > 5 AND n.age < 1000 AND n.age >= 0 RETURN count(*) AS c',
  // Item 455: the operand-order spelling the probe has reported at 2.4-2.5x every run and that
  // nothing has an item number for. `n.age >= 5` and `5 <= n.age` are the same question, and
  // CLAUDE.md names that exact pair among the 100-300x gaps this engine exists not to have.
  // Isolated here because `spelling-probe` runs its whole group in ONE process (item 274).
  // Item 465: item 464's CASE question, asked of TS. Item 448's rule — a gap found in one
  // engine is a QUESTION about the other, never a finding. The property-armed row is the
  // control: same machinery, structurally unable to take a literal-arm fast path.
  casefloor: 'MATCH (n:Person) RETURN count(n.age) AS c',
  caselit: 'MATCH (n:Person) RETURN count(CASE WHEN n.age > 3 THEN 1 ELSE 0 END) AS c',
  casenull: 'MATCH (n:Person) RETURN count(CASE WHEN n.age > 3 THEN 1 ELSE null END) AS c',
  casesum: 'MATCH (n:Person) RETURN sum(CASE WHEN n.age > 3 THEN 1 ELSE 0 END) AS c',
  caseprop: 'MATCH (n:Person) RETURN count(CASE WHEN n.age > 3 THEN n.age ELSE 0 END) AS c',
  // Is `sum(CASE …)` the CASE or the SUM? These two separate them.
  sumfloor: 'MATCH (n:Person) RETURN sum(n.age) AS c',
  sumprop: 'MATCH (n:Person) RETURN sum(n.age + 0) AS c',
  opprop: 'MATCH (n:Person) WHERE n.age >= 5 RETURN count(*) AS c',
  oplit: 'MATCH (n:Person) WHERE 5 <= n.age RETURN count(*) AS c',
  opprop2: 'MATCH (n:Person) WHERE n.age = 5 RETURN count(*) AS c',
  oplit2: 'MATCH (n:Person) WHERE 5 = n.age RETURN count(*) AS c',
  // Item 469: the collecting route item 468 added takes a SINGLE sum/avg. A projection with two
  // aggregates has no fold for the pair, so it falls to the general path whole. The all-foldable
  // pairs are the control: same arity, same egress, already fast.
  aggsumcnt: 'MATCH (n:Person) RETURN sum(n.age) AS s, count(*) AS c',
  aggsumavg: 'MATCH (n:Person) RETURN sum(n.age) AS s, avg(n.age) AS a',
  aggcntcnt: 'MATCH (n:Person) RETURN count(n.age) AS a, count(*) AS c',
  aggminmax: 'MATCH (n:Person) RETURN min(n.age) AS a, max(n.age) AS b',
  aggdistinct: 'MATCH (n:Person) RETURN count(DISTINCT n.age) AS c',
  minfloor: 'MATCH (n:Person) RETURN min(n.age) AS c',
  // Item 471, run with PCOL2=1: two aggregates over DIFFERENT columns, which native's
  // `try_scan_multi_agg` one-pass arm cannot take (it requires every value-aggregate to read
  // the same `Num` column). `twocol1` is the SAME-column control on the identical fixture.
  twocol1: 'MATCH (n:Person) RETURN sum(n.age) AS s, max(n.age) AS m',
  twocol2: 'MATCH (n:Person) RETURN sum(n.age) AS s, max(n.w2) AS m',
  twocolcnt: 'MATCH (n:Person) RETURN count(n.age) AS a, count(n.w2) AS b',
  twocolone: 'MATCH (n:Person) RETURN sum(n.w2) AS s',
  // Item 472: the same ARITY question on a HOP. `detectHopAggregate` takes ONE aggregate, so
  // the pair should fall off the ladder the way item 469's scan pair did — asked, not assumed.
  hopagg1: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(*) AS c',
  hopagg1b: 'MATCH (:Person)-[:KNOWS]->(b) RETURN max(b.age) AS m',
  hopagg2: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(*) AS c, max(b.age) AS m',
  hopagg2b: 'MATCH (:Person)-[:KNOWS]->(b) RETURN min(b.age) AS lo, max(b.age) AS hi',
  // Item 474: the GROUPED twin of the arity question. `detectGroupedNodeCount` takes a key and
  // ONE `count(*)`; a key with two aggregates, or with one that is not `count(*)`, may fall off.
  // Implicit grouping: GROUP BY takes a BOUND name, and a RETURN alias is not one.
  grp1: 'MATCH (n:Person) RETURN n.age AS k, count(*) AS c',
  grp1b: 'MATCH (n:Person) RETURN n.age AS k, max(n.age) AS m',
  grp2: 'MATCH (n:Person) RETURN n.age AS k, count(*) AS c, max(n.age) AS m',
  // Item 475: the last cell of the arity matrix — a GROUPED aggregate over a HOP.
  // `detectGroupedHopCount` is a `count(*)` tally like the node one; anything else may fall off.
  grph1: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age AS k, count(*) AS c',
  // The NAMED spelling of grph1 — same question, and the tally requires `start.variable`.
  grph1n: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age AS k, count(*) AS c',
  grph1nb: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age AS k, max(b.age) AS m',
  grph1b: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age AS k, max(b.age) AS m',
  grph2: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age AS k, count(*) AS c, max(b.age) AS m',
  // Item 477: the UNDIRECTED twin. Item 476 left `direction === 'both'` refused (a guard
  // inherited from the tally, where a bucket SUM would double-count) with its mutant surviving.
  grphboth: 'MATCH (:Person)-[:KNOWS]-(b) RETURN b.age AS k, count(*) AS c, max(b.age) AS m',
  grphbothc: 'MATCH (:Person)-[:KNOWS]-(b) RETURN b.age AS k, count(*) AS c',
  // Item 478's control pair: is native's undirected cost a MISSING PATH or simply twice the
  // edge steps? The ungrouped counts answer that without any grouping machinery in the way.
  cntdir: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(b.age) AS c',
  cntboth: 'MATCH (:Person)-[:KNOWS]-(b) RETURN count(b.age) AS c',
  hopbothmulti: 'MATCH (:Person)-[:KNOWS]-(b) RETURN count(*) AS c, max(b.age) AS m',
  // Item 479: min/max are IDEMPOTENT, so a duplicated row cannot change them — these two
  // should be servable by the two-walk scheme even on a graph WITH self-loops.
  hopbothmax: 'MATCH (:Person)-[:KNOWS]-(b) RETURN max(b.age) AS m',
  hopbothminmax: 'MATCH (:Person)-[:KNOWS]-(b) RETURN min(b.age) AS lo, max(b.age) AS hi',
  hopdirmax: 'MATCH (:Person)-[:KNOWS]->(b) RETURN max(b.age) AS m',
  // Item 480: the PROJECTION twin of the undirected question. Row order is observable here, so
  // two passes are not available — this prices what a per-vertex out-then-in walk would win.
  projdir: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age AS k',
  projboth: 'MATCH (:Person)-[:KNOWS]-(b) RETURN b.age AS k',
  // `Half` is on half the vertices, so it is NOT vacuous and the directed walk must be
  // START-driven — the fair control for an undirected walk, which cannot be far-driven.
  projdirhalf: 'MATCH (:Half)-[:KNOWS]->(b) RETURN b.age AS k',
  projbothhalf: 'MATCH (:Half)-[:KNOWS]-(b) RETURN b.age AS k',
  // Item 482: what else does a `both` guard still refuse? The plain count, the DISTINCT
  // projection, and the two-hop shapes.
  cntstarboth: 'MATCH (:Person)-[:KNOWS]-(b) RETURN count(*) AS c',
  cntstardir: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(*) AS c',
  distboth: 'MATCH (:Person)-[:KNOWS]-(b) RETURN DISTINCT b.age AS k',
  distdir: 'MATCH (:Person)-[:KNOWS]->(b) RETURN DISTINCT b.age AS k',
  // Item 485: TS reads 964 ms where native reads 7.2 — the widest cross-engine gap yet. Is it
  // the anonymous start (item 475's bug class) or the DISTINCT walk itself?
  distdirnamed: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN DISTINCT b.age AS k',
  distnode: 'MATCH (n:Person) RETURN DISTINCT n.age AS k',
  distcount: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(DISTINCT b.age) AS c',
  // Item 486: a rel VARIABLE nothing reads. Item 485's mutation run showed the DISTINCT walk's
  // refusal of it is EQUIVALENT — admitting it answers the same — so this prices the widening.
  distrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN DISTINCT b.age AS k',
  distrelread: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN DISTINCT r.w AS k',
  projrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age AS k',
  // Item 487: the same unread-rel-variable question asked of every OTHER rung.
  cntrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN count(*) AS c',
  grphrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age AS k, count(*) AS c',
  grphaggrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN b.age AS k, max(b.age) AS m',
  // Item 491: the three spellings of a THIRD-position filter on a 3-hop count, which the TS
  // spelling probe reported 1.4x apart — in ONE process, which item 274 warns contaminates.
  h3clause:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE c.age = 2 RETURN count(*) AS n',
  h3nodewhere:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c WHERE c.age = 2)-[:KNOWS]->(d) RETURN count(*) AS n',
  h3inline:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c {age: 2})-[:KNOWS]->(d) RETURN count(*) AS n',
  // The same trio at the probe's own SELECTIVITY (~14% with PCOL2's `w2 = i % 7`, against 1.1%
  // for `age = 2`), in case the asymmetry is selectivity-dependent rather than in-process noise.
  h3clauseW:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE c.w2 = 2 RETURN count(*) AS n',
  h3inlineW:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c {w2: 2})-[:KNOWS]->(d) RETURN count(*) AS n',
  // Item 492: the SUBQUERY family, priced in isolation. `bun run bench` reads 6.9x on both of
  // its subquery rows, and the probe that reported it shares one process per group.
  subcount: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x) } AS c',
  subexists: 'MATCH (n:Person) WHERE EXISTS { MATCH (n)-[:KNOWS]->(x) } RETURN count(*) AS c',
  sub2hop: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x)-[:KNOWS]->(y) } AS c',
  // Item 495: the same two-hop degree with a MIDDLE LABEL, which is the other branch — a label
  // has to resolve the middle vertex, so there the saving is the box rather than the skipped
  // resolve. `Half` is on half the vertices, so it is not vacuous.
  sub2hoplabel: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x:Half)-[:KNOWS]->(y) } AS c',
  // Item 496: a THREE-hop degree subquery. Native materializes every sub-row and tallies by
  // provenance, so its cost should be LINEAR in sub-rows (~25M here against the two-hop's 5M).
  // A falsifiable prediction, measured before anything is built on the diagnosis.
  sub3hop:
    'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x)-[:KNOWS]->(y)-[:KNOWS]->(z) } AS c',
  // Item 498: the rest of the subquery enum, priced against the two forms items 496/497 now
  // answer by degree. A far LABEL and a sub-WHERE are the two positions a degree chain refuses;
  // the VALUE spelling is the EQUIVALENT-SPELLING question (both should lower to one count).
  sublabel: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x:Half) } AS c',
  sub2hoplab2: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x)-[:KNOWS]->(y:Half) } AS c',
  subwhere: 'MATCH (n:Person) RETURN COUNT { MATCH (n)-[:KNOWS]->(x) WHERE x.age > 50 } AS c',
  subvalue: 'MATCH (n:Person) RETURN VALUE { MATCH (n)-[:KNOWS]->(x) RETURN count(*) } AS c',
  submax: 'MATCH (n:Person) RETURN VALUE { MATCH (n)-[:KNOWS]->(x) RETURN max(x.age) } AS c',
  // ⚠️ ENGINE=ts WILL NOT FINISH these at PN=200000 (item 502): the TS engine re-runs an
  // uncorrelated subquery body ONCE PER OUTER ROW, so the cost is quadratic in the fixture —
  // 4.1 SECONDS at PN=2000 and 18.6 at PN=4000, against native's 21ms at PN=200000. Price the
  // TS side at PN<=4000 until that is fixed.
  //
  // Item 501: UNCORRELATED subquery bodies, which run ONCE in native. `opt` never descends into a
  // subquery body (item 500), so these are the shapes where that costs the most: a body that
  // would have been a degree product, an indexed seek or a merged filter at the top level.
  uncorr2hop:
    'MATCH (n:Person) RETURN n.age AS a, COUNT { MATCH (:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) } AS c',
  uncorr1hop: 'MATCH (n:Person) RETURN n.age AS a, COUNT { MATCH (:Person)-[:KNOWS]->(b) } AS c',
  uncorrlabel: 'MATCH (n:Person) RETURN n.age AS a, COUNT { MATCH (b:Half) } AS c',
  uncorreq: 'MATCH (n:Person) RETURN n.age AS a, COUNT { MATCH (b:Person) WHERE b.age = 42 } AS c',
  // The same questions asked at the TOP level, which IS optimized — the control pair.
  toplevel2hop: 'MATCH (:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c',
  topleveleq: 'MATCH (b:Person) WHERE b.age = 42 RETURN count(*) AS c',
  subcontrol: 'MATCH (n:Person)-[:KNOWS]->(x) RETURN count(*) AS c',
  // Item 505: two plan-level enums nothing has priced — the SET operators and the left-outer
  // hop. Both engines, against the ordinary hop as the control.
  unionall: 'MATCH (n:Person) RETURN n.age AS a UNION ALL MATCH (n:Half) RETURN n.age AS a',
  uniondist: 'MATCH (n:Person) RETURN n.age AS a UNION MATCH (n:Half) RETURN n.age AS a',
  exceptop: 'MATCH (n:Person) RETURN n.age AS a EXCEPT MATCH (n:Half) RETURN n.age AS a',
  intersectop: 'MATCH (n:Person) RETURN n.age AS a INTERSECT MATCH (n:Half) RETURN n.age AS a',
  optcount: 'MATCH (n:Person) OPTIONAL MATCH (n)-[:KNOWS]->(x) RETURN count(*) AS c',
  optproj: 'MATCH (n:Person) OPTIONAL MATCH (n)-[:KNOWS]->(x) RETURN x.age AS a',
  plainproj: 'MATCH (n:Person)-[:KNOWS]->(x) RETURN x.age AS a',
  // The FAIR control for `optproj`: the same TWO clauses without OPTIONAL. A ratio between two
  // queries is a ratio between two ROUTES until they are shown to take the same one (item 445).
  twoclauseproj: 'MATCH (n:Person) MATCH (n)-[:KNOWS]->(x) RETURN x.age AS a',
  twoclausecount: 'MATCH (n:Person) MATCH (n)-[:KNOWS]->(x) RETURN count(*) AS c',
  // Item 506: the widening item 505 left open — a THIRD clause, which does not chain onto the
  // fused pair because the fused clause is no longer a bare node.
  threeclausecount:
    'MATCH (n:Person) MATCH (n)-[:KNOWS]->(x) MATCH (x)-[:KNOWS]->(y) RETURN count(*) AS c',
  twohopcount: 'MATCH (n:Person)-[:KNOWS]->(x)-[:KNOWS]->(y) RETURN count(*) AS c',
  splittwohopcount: 'MATCH (n:Person)-[:KNOWS]->(x) MATCH (x)-[:KNOWS]->(y) RETURN count(*) AS c',
  plaincount: 'MATCH (n:Person)-[:KNOWS]->(x) RETURN count(*) AS c',
  // Item 512: four plan-level enums nothing has priced — the list unwind, top-k, the WITH
  // pipeline and the inline CALL. Both engines, against the plain scan/hop as controls.
  topk: 'MATCH (n:Person) RETURN n.age AS a ORDER BY a DESC LIMIT 10',
  topkhop: 'MATCH (:Person)-[:KNOWS]->(b) RETURN b.age AS a ORDER BY a DESC LIMIT 10',
  orderall: 'MATCH (n:Person) RETURN n.age AS a ORDER BY a',
  withpipe: 'MATCH (n:Person) LET a = n.age RETURN count(*) AS c',
  // Item 516: the WITH pipeline and the ISO SELECT spelling, neither priced.
  withcount: 'MATCH (n:Person) WITH n.age AS a RETURN count(*) AS c',
  withproj: 'MATCH (n:Person) WITH n.age AS a RETURN a AS k',
  withnode: 'MATCH (n:Person) WITH n AS m RETURN count(*) AS c',
  selcount: 'SELECT count(*) AS c FROM MATCH (n:Person)',
  selhop: 'SELECT count(*) AS c FROM MATCH (n:Person)-[:KNOWS]->(x)',
  letgroup: 'MATCH (n:Person) LET a = n.age RETURN a AS k, count(*) AS c GROUP BY a',
  plaingroup: 'MATCH (n:Person) RETURN n.age AS k, count(*) AS c',
  letproj: 'MATCH (n:Person) LET a = n.age RETURN a AS k',
  plainnodeproj: 'MATCH (n:Person) RETURN n.age AS k',
  forunwind: 'MATCH (n:Person) FOR x IN [1, 2, 3] RETURN count(*) AS c',
  forprop: 'MATCH (n:Person) FOR t IN n.tags RETURN count(*) AS c',
  forpropproj: 'MATCH (n:Person) FOR t IN n.tags RETURN t AS t',
  forconstproj: 'MATCH (n:Person) FOR x IN [1, 2, 3] RETURN x AS x',
  callinline: 'MATCH (n:Person) CALL (n) { MATCH (n)-[:KNOWS]->(x) RETURN x } RETURN count(*) AS c',
  hopaggrelvar: 'MATCH (:Person)-[r:KNOWS]->(b) RETURN max(b.age) AS m',
  twohoprelvar: 'MATCH (:Person)-[r:KNOWS]->(b)-[s:KNOWS]->(c) RETURN count(*) AS c',
  threehoprelvar:
    'MATCH (:Person)-[r:KNOWS]->(b)-[s:KNOWS]->(c)-[t:KNOWS]->(d) RETURN count(*) AS c',
  twohopboth: 'MATCH (:Person)-[:KNOWS]-(b)-[:KNOWS]-(c) RETURN count(*) AS c',
  twohopdir: 'MATCH (:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c',
  // Item 484: the THREE-hop twin of item 483. Run at a smaller PN — the undirected row count
  // is ~16x the directed one, and the general path enumerates all of it.
  threehopdir: 'MATCH (:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c',
  threehopboth: 'MATCH (:Person)-[:KNOWS]-(b)-[:KNOWS]-(c)-[:KNOWS]-(d) RETURN count(*) AS c',
  hopdirmulti: 'MATCH (:Person)-[:KNOWS]->(b) RETURN count(*) AS c, max(b.age) AS m',
  // Item 521: a CORRELATED subquery body is the one `opt` still never touches (item 501 took the
  // uncorrelated case). `corrdeg` is the shape the degree fast path already intercepts — a
  // control; the others leave it and run the raw Expand/Filter chain the parser emitted.
  corrdeg: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) } AS c',
  corrfilt: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE b.age > 50 } AS c',
  corrlblfilt: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b:Half) WHERE b.age > 50 } AS c',
  correxists:
    'MATCH (x:Person) WHERE EXISTS { (x)-[:KNOWS]->(b) WHERE b.age > 50 } RETURN count(*) AS c',
  corrvalue: 'MATCH (x:Person) RETURN VALUE { MATCH (x)-[:KNOWS]->(b) RETURN max(b.age) } AS m',
  // The TOP-LEVEL twin of `corrfilt`, which `opt` does optimize: the gap between the two is the
  // price of the body being nested inside an `Expr`.
  tlfilt: 'MATCH (:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN count(*) AS c',
  tllblfilt: 'MATCH (:Person)-[:KNOWS]->(b:Half) WHERE b.age > 50 RETURN count(*) AS c',
  // Isolating WHICH filter costs: the label alone (item 500's degree path reads both label
  // spellings, so this one is intercepted), and two PROPERTY filters stacked the same way.
  corrlblonly: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b:Half) } AS c',
  corr2filt:
    'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE b.age > 50 AND b.age < 80 } AS c',
  // Item 522: the same question asked of the OTHER correlated body — a `CALL (x) { … }` inline
  // body, which item 521 did not reach (it patched `correlated_subquery_body` only).
  callinlinelbl:
    'MATCH (x:Person) CALL (x) { MATCH (x)-[:KNOWS]->(b:Half) WHERE b.age > 50 RETURN b } RETURN count(*) AS c',
  callinlinefilt:
    'MATCH (x:Person) CALL (x) { MATCH (x)-[:KNOWS]->(b) WHERE b.age > 50 RETURN b } RETURN count(*) AS c',
  // Item 523: the OTHER rewrites `normalize_pred` does that a correlated body never reaches —
  // `IN [literals]` to an OR chain, a negated equality, and the reversed operand order. Each is
  // paired with the spelling `opt` would have produced, so the pair IS the question.
  corrin: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE b.age IN [11, 22, 33] } AS c',
  corror:
    'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE b.age = 11 OR b.age = 22 OR b.age = 33 } AS c',
  corrnoteq: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE NOT b.age = 11 } AS c',
  corrne: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE b.age <> 11 } AS c',
  corrrev: 'MATCH (x:Person) RETURN COUNT { (x)-[:KNOWS]->(b) WHERE 50 < b.age } AS c',
  // Item 525: the EXISTS twin of item 524's question. `oneHopExists` has a FREE-endpoint arm
  // (a bucket size read) and a general arm that calls `matchNode` per edge — so a LABEL alone
  // is enough to leave the cheap arm, and a predicate that never matches walks the whole
  // adjacency allocating a binding an edge.
  existsfree: 'MATCH (x:Person) WHERE EXISTS { (x)-[:KNOWS]->(b) } RETURN count(*) AS c',
  existslbl: 'MATCH (x:Person) WHERE EXISTS { (x)-[:KNOWS]->(b:Half) } RETURN count(*) AS c',
  existsmiss:
    'MATCH (x:Person) WHERE EXISTS { (x)-[:KNOWS]->(b) WHERE b.age > 1000 } RETURN count(*) AS c',
};
// One node's properties, shared by the TWO fixture builders below — a `Graph` for the TS engine
// and NDJSON for the native one. Patching only one of them is item 471's trap: it reads as a
// 13x "column gap" that is really a missing property.
//
//   `PCOL2` adds a SECOND numeric column (the two-column aggregate question, item 471).
//   `PLIST` adds a three-element LIST column (the `FOR … IN` question, item 515).
//
// Both are off by default, because widening every node changes the scan for every other case
// here and the numbers in the audit are against the one-column fixture.
const nodeProps = (i: number): Record<string, unknown> => {
  if (process.env.PLIST !== undefined) {
    return { age: i % 90, tags: [i % 3, (i + 1) % 3, (i + 2) % 3] };
  }

  return process.env.PCOL2 === undefined ? { age: i % 90 } : { age: i % 90, w2: i % 7 };
};

const key = process.env.PCASE ?? 'node';
const q = queries[key];

if (q === undefined) {
  throw new Error(`no such case: ${key}`);
}

// ENGINE=native asks the same ladder of the Rust engine, which is a separate implementation with
// its own hop fast paths — so whether a gap transfers is a question to measure, not to infer from
// the TS planner. Native row egress is 58-94 ns a row (items 428, 434), which is why only
// native-against-native ratios are read here, never native against ts.
const engine = process.env.ENGINE ?? 'ts';
const times: number[] = [];
let rows = 0;

if (engine === 'native') {
  const lines: string[] = [];

  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({
        type: 'vertex',
        id: `v${i}`,
        labels: i % 2 === 0 ? ['Person', 'Half'] : ['Person'],
        // Mirrors the TS fixture's `PCOL2` arm — the NATIVE fixture is a separate builder a
        // few lines down, and patching only the first one left `w2` absent entirely, which
        // reads as a 13x "column gap" that is really a missing property (item 471).
        properties: nodeProps(i),
      }),
    );
  }

  for (let k = 0; k < N * DEG; k++) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${k}`,
        from: `v${(k * 7919) % N}`,
        to: `v${
          process.env.PNOLOOP !== undefined && (k * 104_729) % N === (k * 7919) % N
            ? ((k * 104_729) % N) + 1
            : (k * 104_729) % N
        }`,
        labels: ['KNOWS'],
        properties: { w: k % 7 },
      }),
    );
  }

  const nat = graphFromNdjson(nativeBackend(), `${lines.join('\n')}\n`);

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const out = nat.query(q);

    rows = (out as unknown[]).length;
    times.push(performance.now() - t0);
  }
} else {
  const g = fresh();

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    // Materialized with a length read: these queries are LAZY in the TS engine, and timing a
    // generator that is never drained measures building the generator.
    const out = tsQuery(g, q);

    rows = Array.isArray(out) ? out.length : [...(out as Iterable<unknown>)].length;
    times.push(performance.now() - t0);
  }
}

times.sort((p, n) => p - n);
console.log(
  `${engine.padEnd(7)}${key.padEnd(10)}min ${times[0].toFixed(1).padStart(8)}  p25 ${times[Math.floor(times.length / 4)].toFixed(1).padStart(8)}  med ${times[Math.floor(times.length / 2)].toFixed(1).padStart(8)}  rows ${rows}  ns/row ${((times[0] * 1e6) / Math.max(rows, 1)).toFixed(0)}`,
);
