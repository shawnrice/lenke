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

const MEMBERS = Math.floor(USERS / 10);

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

const ARMS = {
  gqlList: () => query(g, GQL_LIST, { doc: 'doc1' }).length,
  gqlCount: () => query(g, GQL_COUNT, { doc: 'doc1' })[0].c,
  gremList: () => toArray(gremList, g).length,
  handList: () => handList().length,
  handRows: () => handRows().length,
  gqlDocFirst: () => query(g, GQL_LIST_DOCFIRST, { doc: 'doc1' }).length,
};

const fn = ARMS[SHAPE];

for (let w = 0; w < 3; w += 1) {
  fn();
}

const ts = [];
let answer = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  answer = fn();
  ts.push(performance.now() - t);
}

console.log(
  `  USERS=${USERS} SHAPE=${SHAPE.padEnd(9)} median ${med(ts).toFixed(2).padStart(8)} ms   answer=${answer}   ${((med(ts) * 1e6) / Math.max(answer, 1)).toFixed(0)} ns/result`,
);
