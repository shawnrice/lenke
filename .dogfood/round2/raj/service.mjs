import { createEmptyGraph, graphFromNdjson } from '@lenke/native';
// who-to-follow + fraud-signal API slice over a social graph, on the napi
// backend. Follows the @lenke/node + backend-embedded guides.
//
// Run: bun service.mjs
import { createNodeBackend } from '@lenke/node/backend';

import { buildNdjson } from './seed.mjs';

const line = (s = '') => console.log(s);
const h = (s) => line(`\n=== ${s} ===`);

const backend = createNodeBackend();

// ---------------------------------------------------------------------------
// 1. Bulk load. Cold path is graphFromNdjson; but the task wants a live-graph
//    COPY FROM, so cold-boot an empty graph then mergeNdjson into it and read
//    the report (as backend-embedded.md documents).
// ---------------------------------------------------------------------------
h('bulk load via mergeNdjson (COPY FROM into a live graph)');
const ndjson = buildNdjson({ users: 300, seed: 42 });
line(`seed NDJSON: ${(ndjson.byteLength / 1024).toFixed(1)} KiB`);

const graph = createEmptyGraph(backend);
const t0 = performance.now();
const report = graph.mergeNdjson(ndjson);
const loadMs = performance.now() - t0;

line(`merge report: ${JSON.stringify(report)}`);
line(`loaded ${graph.vertexCount} vertices, ${graph.edgeCount} edges in ${loadMs.toFixed(1)}ms`);
line(
  `nodesAdded=${report.nodesAdded} edgesAdded=${report.edgesAdded} ` +
    `nodesSkipped=${report.nodesSkipped.length} edgesSkipped=${report.edgesSkipped.length} ` +
    `phantomVertices=${report.phantomVertices.length}`,
);

// ---------------------------------------------------------------------------
// 2. Indexes for fast point lookups. We look users up by `uid` constantly.
// ---------------------------------------------------------------------------
h('property indexes');
graph.createVertexIndex('uid');
graph.createEdgeIndex('since');
line(`vertexIndexes(): ${JSON.stringify(graph.vertexIndexes())}`);
line(`edgeIndexes():   ${JSON.stringify(graph.edgeIndexes())}`);

// ---------------------------------------------------------------------------
// 3. Typed one-shot query — a single user's profile card by uid.
// ---------------------------------------------------------------------------
h('typed point lookup by indexed uid');
const [me] = graph.query`
  MATCH (p:Person {uid: ${'u5'}})
  RETURN p.uid AS uid, p.name AS name, p.accountAgeDays AS ageDays`;
line(`me = ${JSON.stringify(me)}`);

// ---------------------------------------------------------------------------
// 4. Friend-of-friend "who to follow" — prepared statement, run in a hot loop.
//    People that the people I follow follow, that I don't already follow,
//    ranked by how many mutuals suggest them.
// ---------------------------------------------------------------------------
h('prepare() who-to-follow + hot loop');
// (In a .ts file this is `graph.prepare<{ uid: string; name: string; mutuals: number }>(...)`;
//  this file is plain .mjs so the type arg is omitted at runtime.)
const wtf = graph.prepare(`
  MATCH (me:Person {uid: $uid})-[:FOLLOWS]->(:Person)-[:FOLLOWS]->(cand:Person)
  WHERE cand.uid <> $uid
    AND NOT EXISTS { MATCH (me)-[:FOLLOWS]->(cand) }
  RETURN cand.uid AS uid, cand.name AS name, count(*) AS mutuals
  ORDER BY mutuals DESC, uid ASC
  LIMIT 5`);

const sample = ['u5', 'u5', 'u12', 'u99', 'u200'];
line('recommendations by user:');
for (const uid of sample) {
  const recs = wtf.query({ uid });
  line(`  ${uid} -> ${recs.map((r) => `${r.uid}(${r.mutuals})`).join(', ') || '(none)'}`);
}

// Real hot loop: same prepared query, many iterations, to time the parse-once win.
const ITER = 5000;
const users = Array.from({ length: 300 }, (_, i) => `u${i}`);
const tp0 = performance.now();
let checksum = 0;
for (let i = 0; i < ITER; i += 1) {
  const recs = wtf.query({ uid: users[i % users.length] });
  checksum += recs.length;
}
const prepMs = performance.now() - tp0;
line(
  `prepared hot loop: ${ITER} runs in ${prepMs.toFixed(0)}ms ` +
    `(${(prepMs / ITER).toFixed(3)}ms/query), checksum=${checksum}`,
);

// Compare against re-parsing each call (plain query with the same text/params).
const wtfText = `
  MATCH (me:Person {uid: $uid})-[:FOLLOWS]->(:Person)-[:FOLLOWS]->(cand:Person)
  WHERE cand.uid <> $uid
    AND NOT EXISTS { MATCH (me)-[:FOLLOWS]->(cand) }
  RETURN cand.uid AS uid, cand.name AS name, count(*) AS mutuals
  ORDER BY mutuals DESC, uid ASC
  LIMIT 5`;
const tq0 = performance.now();
for (let i = 0; i < ITER; i += 1) {
  graph.query(wtfText, { uid: users[i % users.length] });
}
const reparseMs = performance.now() - tq0;
line(
  `re-parse each call: ${ITER} runs in ${reparseMs.toFixed(0)}ms ` +
    `(${(reparseMs / ITER).toFixed(3)}ms/query)`,
);
wtf.free();

// ---------------------------------------------------------------------------
// 5. Mutual-connection count between two users (typed).
// ---------------------------------------------------------------------------
h('mutual connections between two users');
const mutual = graph.query`
  MATCH (a:Person {uid: ${'u5'}})-[:FOLLOWS]->(m:Person)<-[:FOLLOWS]-(b:Person {uid: ${'u12'}})
  RETURN count(*) AS mutuals`;
line(`u5 <-> u12 mutuals: ${JSON.stringify(mutual)}`);

// ---------------------------------------------------------------------------
// 6. Fraud signal — young accounts with many outbound follows but few inbound.
// ---------------------------------------------------------------------------
h('fraud signal: spray-follow young accounts');
const suspicious = graph.query(
  `
  MATCH (p:Person)-[:FOLLOWS]->(:Person)
  WITH p, count(*) AS outDeg
  WHERE p.accountAgeDays < $maxAge AND outDeg > $minOut
  RETURN p.uid AS uid, p.name AS name, p.accountAgeDays AS ageDays, outDeg
  ORDER BY outDeg DESC
  LIMIT 8`,
  { maxAge: 30, minOut: 20 },
);
for (const r of suspicious) {
  line(`  ${r.uid} ${r.name} age=${r.ageDays}d out=${r.outDeg}`);
}
if (suspicious.length === 0) line('  (none flagged)');

// ---------------------------------------------------------------------------
// 7. Deliberate errors — how do they surface?
// ---------------------------------------------------------------------------
h('error surfaces');
try {
  graph.query(`MATCH (p:Person) RETURN bogus_fn(p.name)`);
  line('unknown function: NO ERROR (unexpected)');
} catch (e) {
  line(
    `unknown function -> ${e.constructor.name}: ${e.message}` +
      (e.code !== undefined ? ` [code=${e.code}]` : ''),
  );
}

try {
  // References $uid but supplies nothing.
  graph.query(`MATCH (p:Person {uid: $uid}) RETURN p.name`);
  line('missing param: NO ERROR (unexpected)');
} catch (e) {
  line(
    `missing param -> ${e.constructor.name}: ${e.message}` +
      (e.code !== undefined ? ` [code=${e.code}]` : ''),
  );
}

try {
  graph.query(`MATCH (p:Person RETURN p.name`); // syntax error
  line('syntax error: NO ERROR (unexpected)');
} catch (e) {
  line(
    `syntax error -> ${e.constructor.name}: ${e.message}` +
      (e.pos !== undefined ? ` [pos=${e.pos}]` : ''),
  );
}

graph.free();
h('done');
