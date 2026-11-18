/**
 * ⚠️⚠️ **IS `list: subjects for object` AT ITS FLOOR? (item 2288)** Item 2100 opened ReBAC authz, found the
 * CHECK flat when the subject key is indexed (144x at 200,000 users), and recorded that this second
 * operation *"CORRECTLY DOES NOT BENEFIT"* from an index — 30.5 ms, marginally worse with one — because it
 * must enumerate every subject who can see the object.
 *
 * 🔑 **That is a claim about the INDEX, not about the FLOOR.** `check-the-blocker-still-holds`: a "not
 * built because X" note is a claim about X. 30.5 ms for ~20,000 results is ~1.5 µs per result, where a
 * one-hop enumeration should be nearer 100 ns — so the question item 2100 did not ask is what the same
 * answer costs when computed by hand.
 *
 * ✅ `SHAPE` selects ONE arm per process (items 2285/2286: extra arms in one process both erase and
 * manufacture gaps). Every arm prints its answer, because a cost comparison between arms that return
 * different things is not a comparison.
 *
 *   gqlList     the GQL query an app would write
 *   gremList    the Gremlin spelling of the same question
 *   handList    a hand-rolled adjacency walk — the floor
 *   gqlCount    the same traversal, counted not materialized — isolates enumeration from projection
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, has, hasLabel, in_, toArray, traversal, values } from '@lenke/gremlin';

const USERS = Number(process.env.USERS ?? 20_000);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'gqlList';

const g = new Graph();

/* One doc, one team holding a tenth of all users (item 2100's skew), and that team granted on the doc. */
g.addVertex({ id: 'doc1', labels: ['Doc'], properties: { name: 'doc1' } });
g.addVertex({ id: 'teamBig', labels: ['Team'], properties: { name: 'teamBig' } });
g.addEdge({
  id: 'grant1',
  from: g.getVertexById('teamBig'),
  to: g.getVertexById('doc1'),
  labels: ['CAN_VIEW'],
  properties: {},
});

/*
 * ⚠⚠ **DECOY EDGES OF ANOTHER TYPE, TO ABLATE THE ADJACENCY HYPOTHESIS (item 2289).** Item 2288 left the
 * ~30x with its mechanism UNVERIFIED and one obvious story: the hop scans a vertex's WHOLE adjacency and
 * filters by label, where the floor's `edgesToByLabel` is a direct indexed lookup.
 *
 * 🔑 That story makes a sharp PREDICTION, testable with no engine edit: adding edges of an UNWANTED type
 * to the same vertices must slow the engine and leave the floor flat. If both stay flat, the cost is the
 * per-row machinery and the adjacency frame in the profile is attribution, not cause
 * (`frame-attribution-trap`). This is `expand_bench`'s question, which `CLAUDE.md` says scales with degree
 * AND with how many types the degree spans.
 */
const DECOYS = Number(process.env.DECOYS ?? 0);

/*
 * ⚠⚠ **THE CONTROL MY FIRST SWEEP LACKED (item 2289).** Item 2288 varied USERS and read ns/result flat —
 * but the member count was `USERS / 10`, so the RESULTS grew with the users and "flat per result" cannot
 * tell a per-USER cost from a per-RESULT one. 🔑 `MEMBERS` pins the result count, so raising USERS alone
 * adds non-member users the walk must either skip or never touch. If the cost grows, the walk visits every
 * user; if it is flat, it reaches the members directly. `vary-only-the-projection` is the same technique.
 */
const MEMBERS = Number(process.env.MEMBERS ?? Math.floor(USERS / 10));

for (let i = 0; i < USERS; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}` } });
}

for (let i = 0; i < MEMBERS; i += 1) {
  g.addEdge({
    id: `m${i}`,
    from: g.getVertexById(`u${i}`),
    to: g.getVertexById('teamBig'),
    labels: ['MEMBER_OF'],
    properties: {},
  });
}

/*
 * The decoys hang off the TEAM, which is the vertex the walk expands to reach the members — so they inflate
 * exactly the adjacency the hypothesis says is scanned, and they cannot change the answer because no query
 * here mentions `DECOY`.
 */
for (let i = 0; i < DECOYS; i += 1) {
  g.addVertex({ id: `d${i}`, labels: ['Decoy'], properties: { name: `decoy${i}` } });
  g.addEdge({
    id: `dk${i}`,
    from: g.getVertexById(`d${i}`),
    to: g.getVertexById('teamBig'),
    labels: ['DECOY_OF'],
    properties: {},
  });
}

/*
 * ⚠⚠ **AN INDEX ON THE *OBJECT* KEY, WHICH IS THE ONE THE GATE ASKS ABOUT (item 2291).**
 *
 * 🔑 `hop2-projection.ts`'s own header says the rung hands a query to the orienting matcher only when
 * `farEndSeeksNarrower` — *"Only a genuine SEEK on the far node justifies handing the query back"* —
 * because reversing on label-bucket size alone would give up a fused walk worth 13.8x (items 1821/1822).
 * With no index on `Doc.name` there is no seek, so the rung keeps its walk and visits every user.
 *
 * ⚠️ Item 2100 indexed the SUBJECT key (`User.name`) and concluded this operation *"correctly does not
 * benefit"*. That is true of the subject key and does not generalize: the gate reads the FAR node.
 */
const INDEX = process.env.INDEX ?? 'none';

if (INDEX === 'doc' || INDEX === 'both') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const GQL_LIST =
  'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $doc RETURN u.name AS n';
const GQL_COUNT =
  'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $doc RETURN count(*) AS c';

const gremList = traversal(
  V(),
  hasLabel('Doc'),
  has('name', 'doc1'),
  in_('CAN_VIEW'),
  in_('MEMBER_OF'),
  values('name'),
);

/* The floor: resolve the doc, walk in twice, collect names. Nothing an engine could skip. */
const handList = () => {
  const doc = g.getVertexById('doc1');
  const names = [];

  /*
   * ⚠️ Uses `edgesToByLabel`, the LABEL-INDEXED accessor, so the floor does not get an unfair advantage
   * from scanning less than the engine does — and no advantage from scanning MORE, either. A floor that
   * walks all adjacency and filters would overstate what the engine pays (`floor-arm-must-take-same-route`).
   */
  for (const e1 of doc.edgesToByLabel('CAN_VIEW')) {
    for (const e2 of e1.from.edgesToByLabel('MEMBER_OF')) {
      names.push(e2.from.properties.name);
    }
  }

  return names;
};

/*
 * ⚠⚠ **THE SAME WALK, BUILDING THE ENGINE'S OUTPUT CONTRACT.** `gqlList` returns 2,000 ROW OBJECTS
 * (`{n: name}`); `handList` pushes 2,000 strings into an array. That is not the same work, and the
 * difference is exactly what item 2256 priced as the cost of a projection. 🔑 This arm closes that hole, so
 * the remaining gap is the engine's overhead rather than its output shape.
 */
const handRows = () => {
  const doc = g.getVertexById('doc1');
  const rows = [];

  for (const e1 of doc.edgesToByLabel('CAN_VIEW')) {
    for (const e2 of e1.from.edgesToByLabel('MEMBER_OF')) {
      rows.push({ n: e2.from.properties.name });
    }
  }

  return rows;
};

/*
 * ⚠⚠ **THE SAME QUESTION WRITTEN FROM THE SELECTIVE END.** `GQL_LIST` starts at `(u:User)` — 20,000
 * candidates — while `handRows` resolves the ONE doc and walks inward. 🔑 If the engine does not orient the
 * walk, my floor was unfair (`floor-arm-must-take-same-route`) AND the orientation is itself the finding.
 * This arm asks the identical question with the doc written first, so the two spellings should cost the
 * same if the planner orients — this repo's equivalent-spelling property.
 */
const GQL_LIST_DOCFIRST =
  'MATCH (d:Doc)<-[:CAN_VIEW]-(t:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $doc RETURN u.name AS n';

/*
 * ⚠⚠ **TWO ARMS THAT CLOSE THE LAST GAP IN WORK (item 2289).** The decoy ablation refuted the
 * scan-and-filter story, but it also exposed that `matchesLabel` is 9% of the profile because the engine
 * verifies `:User`, `:Team` and `:Doc` on every row — and my floor checks NO labels, trusting the edge
 * types instead. 🔑 So:
 *
 *   gqlUnlabelled   the same question with the labels dropped  — how much of the gap IS label verification
 *   handLabels      the floor, now verifying the same labels    — the floor doing the engine's work
 *
 * In this fixture the labels are implied by the edge types, so dropping them cannot change the answer —
 * asserted by the printed count, as every arm here is.
 */
const GQL_UNLABELLED =
  'MATCH (u)-[:MEMBER_OF]->(t)-[:CAN_VIEW]->(d) WHERE d.name = $doc RETURN u.name AS n';

const handLabels = () => {
  const doc = g.getVertexById('doc1');
  const rows = [];

  if (!doc.hasLabel('Doc')) {
    return rows;
  }

  for (const e1 of doc.edgesToByLabel('CAN_VIEW')) {
    const team = e1.from;

    if (!team.hasLabel('Team')) {
      continue;
    }

    for (const e2 of team.edgesToByLabel('MEMBER_OF')) {
      const user = e2.from;

      if (user.hasLabel('User')) {
        rows.push({ n: user.properties.name });
      }
    }
  }

  return rows;
};

const ARMS = {
  gqlList: () => query(g, GQL_LIST, { doc: 'doc1' }).length,
  gqlCount: () => query(g, GQL_COUNT, { doc: 'doc1' })[0].c,
  gremList: () => toArray(gremList, g).length,
  handList: () => handList().length,
  handRows: () => handRows().length,
  handLabels: () => handLabels().length,
  gqlUnlabelled: () => query(g, GQL_UNLABELLED, { doc: 'doc1' }).length,
  gqlDocFirst: () => query(g, GQL_LIST_DOCFIRST, { doc: 'doc1' }).length,
  /*
   * ⚠⚠ **PROVE THE INDEX FUNCTIONS BEFORE BELIEVING A NULL FROM IT.** This file is `.mjs`, so there is
   * NO typecheck — and item 2275's index arm silently created nothing because `kind` was invalid, with
   * bun erasing the type. A 400,000-user name lookup is a scan without an index and a seek with one, so
   * this arm's own ratio between `INDEX=none` and `INDEX=doc` is the proof.
   */
  /*
   * ⚠⚠ **INLINE vs CLAUSE `WHERE`, ON THE FAR NODE (item 2291).** `farEndSeeksNarrower` asks
   * `mightSeek(endNode)` and `estimateSeedFrom(graph, endNode, ...)` — both about the NODE. My predicate
   * is a clause `WHERE`, and *"a clause `WHERE` vs an inline `{k: $x}`"* is one of the four
   * equivalent-spelling shapes `CLAUDE.md` names as having cost 100-300x historically. There IS a
   * `pushWhereIntoNode` rewrite, so this measures whether it reaches this gate.
   */
  gqlInlineFar: () =>
    query(
      g,
      'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc {name: $doc}) RETURN u.name AS n',
      { doc: 'doc1' },
    ).length,
  seekProof: () =>
    query(g, 'MATCH (u:User) WHERE u.name = $u RETURN u.name AS n', { u: 'user7' }).length,
};

const fn = ARMS[SHAPE];

/*
 * ⚠⚠ **INNER-ITERATION CALIBRATION (item 2304).** Several arms here are sub-millisecond — `handLabels`
 * read 0.05 ms and `gqlDocFirst` 0.69 — and items 2302/2303 showed that a single call in one
 * `performance.now()` pair UNDERSTATES a fast arm: the clock and the JIT dominate. (The unfiltered hop
 * count in `farfilter-2286` moved from "0.01 ms" to ~24 ns once calibrated.) 🔑 So warm properly, then
 * double an inner count until one sample fills `SAMPLE_MS`, and report per call — the pattern
 * `gremlin-spelling-probe` has used since item 1644.
 */
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 25);

for (let w = 0; w < 200; w += 1) {
  fn();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    fn();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 1_000_000) {
    break;
  }

  inner *= 2;
}

const ts = [];
let answer = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  for (let i = 0; i < inner; i += 1) {
    answer = fn();
  }

  ts.push((performance.now() - t) / inner);
}

console.log(
  `  USERS=${USERS} DECOYS=${String(DECOYS).padEnd(5)} SHAPE=${SHAPE.padEnd(9)} median ${med(ts).toFixed(4).padStart(9)} ms   inner=${String(inner).padStart(7)}   answer=${answer}   ${((med(ts) * 1e6) / Math.max(answer, 1)).toFixed(0)} ns/result`,
);
