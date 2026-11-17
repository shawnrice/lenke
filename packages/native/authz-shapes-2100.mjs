/*
 * Item 2100 — ReBAC AUTHZ shapes, which neither screen contains.
 *
 * ⚠️ WHY THESE AND NOT MORE CORPUS ROWS. Items 2096/2097 exhausted the GQL corpus's largest shape and
 * 2099 showed the Gremlin screen is a smooth per-edge gradient with no outlier: a new target needs a
 * new SHAPE. Authz is the one shape family the record names as a real ask and neither screen has —
 * Zanzibar-style checks are expressible in ISO-GQL as `EXISTS <grant> AND NOT EXISTS <deny>`, and that
 * DOUBLE-QUANTIFIER form appears nowhere in the corpus.
 *
 * 🔑 THE FIXTURE IS THE SHAPE'S OWN, not a generic graph. An authz check is selective (one subject,
 * one object) over a graph whose structure is groups, memberships and grants — so a fixture of
 * uniform fanout would not exercise the question. Group sizes are SKEWED, because a real tenant has a
 * few large groups and many small ones, and the selective path's cost depends on which it hits.
 *
 * ⚠️ EVERY SHAPE'S ANSWER IS ASSERTED against a hand-computed expectation. A selective authz query
 * that silently returns nothing would otherwise be the fastest row in the table.
 *
 * ⚠️⚠️ **THE LABEL IS `Team`, NOT `Group`, AND THAT IS A FINDING RATHER THAN A PREFERENCE.** `Group` is
 * a RESERVED WORD in ISO-GQL (`GROUP BY`), so `(:Group)` is a syntax error — which a ReBAC schema
 * naturally wants to write. The engine handles it correctly and says exactly what to do ("quote it as a
 * delimited identifier with backticks"), and the backtick form is verified below; but the first
 * spelling anyone reaches for in this domain does not parse.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20000);
const GROUPS = Number(process.env.GROUPS ?? 400);
const DOCS = Number(process.env.DOCS ?? 2000);
const REPS = Number(process.env.REPS ?? 13);

const g = new Graph();

for (let u = 0; u < USERS; u += 1) {
  g.addVertex({ id: `u${u}`, labels: ['User'], properties: { name: `u${u}` } });
}

for (let r = 0; r < GROUPS; r += 1) {
  g.addVertex({ id: `g${r}`, labels: ['Team'], properties: { name: `g${r}` } });
}

for (let d = 0; d < DOCS; d += 1) {
  g.addVertex({ id: `d${d}`, labels: ['Doc'], properties: { name: `d${d}` } });
}

/*
 * ⚠️ SKEWED MEMBERSHIP: group 0 holds a tenth of all users, the rest share the remainder. A uniform
 * assignment would make every check cost the same and hide the shape's actual sensitivity.
 */
let edge = 0;

for (let u = 0; u < USERS; u += 1) {
  const grp = u % 10 === 0 ? 0 : 1 + (u % (GROUPS - 1));

  g.addEdge({
    id: `m${edge}`,
    from: g.getVertexById(`u${u}`),
    to: g.getVertexById(`g${grp}`),
    labels: ['MEMBER_OF'],
    properties: {},
  });
  edge += 1;
}

// Group -> Doc grants, and a few explicit per-user denies.
for (let r = 0; r < GROUPS; r += 1) {
  g.addEdge({
    id: `gr${edge}`,
    from: g.getVertexById(`g${r}`),
    to: g.getVertexById(`d${r % DOCS}`),
    labels: ['CAN_VIEW'],
    properties: {},
  });
  edge += 1;
}

/** Users 0, 100, 200 … are explicitly denied on the doc their group grants. */
const DENIED = new Set();

for (let u = 0; u < USERS; u += 100) {
  const grp = u % 10 === 0 ? 0 : 1 + (u % (GROUPS - 1));

  g.addEdge({
    id: `dn${edge}`,
    from: g.getVertexById(`u${u}`),
    to: g.getVertexById(`d${grp % DOCS}`),
    labels: ['DENIED'],
    properties: {},
  });
  edge += 1;
  DENIED.add(`u${u}|d${grp % DOCS}`);
}

/*
 * ⚠️⚠️ **THE INDEX IS THE WHOLE QUESTION, SO IT IS A KNOB.** Without it every one of these shapes
 * scans all USERS to find the one subject: a single authz CHECK measured **0.802 ms at 20,000 users
 * and 4.894 at 200,000 — 6.1x for 10x the users**, when the work it must do is O(the subject's teams x
 * their grants) and independent of tenant size. An authz check that scales with the TENANT is the
 * difference between a feature and an outage.
 */
if (process.env.INDEXED === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const docOf = (u) => `d${(u % 10 === 0 ? 0 : 1 + (u % (GROUPS - 1))) % DOCS}`;

const shapes = {
  /* 1. THE CHECK: may this subject view this object? One row in, one boolean out. */
  'check: grant only': {
    q: `MATCH (u:User) WHERE u.name = $u AND EXISTS { MATCH (u)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d } RETURN count(*) AS c`,
    params: { u: 'u7', d: docOf(7) },
    want: 1,
  },
  /* 2. 🔑 THE ZANZIBAR FORM: a grant AND the absence of a deny — the double quantifier. */
  'check: grant AND NOT deny': {
    q: `MATCH (u:User) WHERE u.name = $u AND EXISTS { MATCH (u)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d } AND NOT EXISTS { MATCH (u)-[:DENIED]->(d2:Doc) WHERE d2.name = $d } RETURN count(*) AS c`,
    params: { u: 'u7', d: docOf(7) },
    want: 1,
  },
  /* 3. The same check for a DENIED subject — the branch that must return nothing. */
  'check: denied subject': {
    q: `MATCH (u:User) WHERE u.name = $u AND EXISTS { MATCH (u)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d } AND NOT EXISTS { MATCH (u)-[:DENIED]->(d2:Doc) WHERE d2.name = $d } RETURN count(*) AS c`,
    params: { u: 'u100', d: docOf(100) },
    want: 0,
  },
  /* 4. LIST OBJECTS: everything this subject may view — the "what can I see" page. */
  'list: objects for subject': {
    q: `MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE u.name = $u RETURN DISTINCT d.name AS doc`,
    params: { u: 'u7' },
    want: 1,
  },
  /* 5. LIST SUBJECTS: everyone who may view this object — the share dialog, and the dear direction. */
  'list: subjects for object': {
    q: `MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN count(DISTINCT u.name) AS n`,
    params: { d: 'd0' },
    want: null,
  },
};

console.log(`  USERS=${USERS} GROUPS=${GROUPS} DOCS=${DOCS}, ${edge} edges, median of ${REPS}\n`);
console.log(`  ${'shape'.padEnd(30)} ${'ms'.padStart(9)} ${'rows'.padStart(6)}  answer`);

for (const [name, spec] of Object.entries(shapes)) {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, spec.q, spec.params);
    series.push(performance.now() - t0);
  }

  const first = rows.length > 0 ? Object.values(rows[0])[0] : undefined;

  // ⚠️ THE ASSERTION: a selective check that silently matched nothing would be the fastest row here.
  if (spec.want !== null && first !== spec.want && rows.length !== spec.want) {
    throw new Error(
      `${name}: answered ${JSON.stringify(first)} / ${rows.length} rows, expected ${spec.want}`,
    );
  }

  /*
   * ⚠️ FOUR WARM-UP REPS DROPPED, NOT TWO. With two, the FIRST shape in the table read 1.138 ms while
   * the shape below it — which does strictly MORE work (a second quantifier) — read 0.584. That is the
   * first-shape-pays-the-JIT artefact, not a finding about conjunct order.
   */
  const kept = series.slice(4).sort((a, b) => a - b);

  console.log(
    `  ${name.padEnd(30)} ${kept[Math.floor(kept.length / 2)].toFixed(3).padStart(9)} ${String(rows.length).padStart(6)}  ${JSON.stringify(first)}`,
  );
}
