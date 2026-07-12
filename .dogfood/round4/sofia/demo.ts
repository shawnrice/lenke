// demo.ts — a bitemporal org-chart on lenke: ingest 18mo of history, run as-of
// queries, reconstruct a past state, diff it, and print an audit trail.
//
//   run:  bun demo.ts

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { TemporalEngine } from './temporal.ts';

const g = new Graph();
// Valid-time lives on REPORTS_TO edges; index validFrom so GQL as-of range
// predicates plan as index seeks rather than scans.
g.createVertexIndex('empId');
g.createEdgeIndex('validFrom');
const engine = new TemporalEngine(g);

// -- helpers ----------------------------------------------------------------
const P: Record<string, string> = {}; // name -> vertex id
function hire(name: string, title: string) {
  const v = g.addVertex({
    id: `emp-${name.toLowerCase()}`,
    labels: ['Person'],
    properties: { empId: `emp-${name.toLowerCase()}`, name, title },
  });
  P[name] = v.id;
  return v.id;
}
function reportTo(person: string, manager: string, validFrom: string) {
  g.addEdge({
    from: g.getVertexById(P[person])!,
    to: g.getVertexById(P[manager])!,
    labels: ['REPORTS_TO'],
    properties: { validFrom, validTo: null },
  });
}
// close the currently-open REPORTS_TO edge out of `person`
function endReport(person: string, validTo: string) {
  for (const e of g.getVertexById(P[person])!.edgesFromByLabel('REPORTS_TO')) {
    if (e.getProperty('validTo') === null) e.setProperty('validTo', validTo);
  }
}
function retitle(person: string, title: string) {
  g.getVertexById(P[person])!.setProperty('title', title);
}

// -- ingest business history (each engine.tx = one audited commit) ----------
engine.tx({ validAt: '2023-01-01', actor: 'founders', reason: 'company founded' }, () => {
  hire('Alice', 'CEO');
  hire('Bob', 'Engineer');
  hire('Carol', 'Engineer');
  reportTo('Bob', 'Alice', '2023-01-01');
  reportTo('Carol', 'Alice', '2023-01-01');
});

engine.tx(
  { validAt: '2023-06-01', actor: 'alice', reason: 'Q2 growth: hire Dave, promote Bob to manage' },
  () => {
    hire('Dave', 'Engineer');
    retitle('Bob', 'Engineering Manager');
    reportTo('Dave', 'Bob', '2023-06-01');
  },
);

engine.checkpoint(); // <-- snapshot checkpoint after year-one hiring

engine.tx(
  { validAt: '2024-01-01', actor: 'alice', reason: 'reorg: Carol moves under Bob; hire Eve' },
  () => {
    endReport('Carol', '2024-01-01');
    reportTo('Carol', 'Bob', '2024-01-01');
    hire('Eve', 'Engineer');
    reportTo('Eve', 'Bob', '2024-01-01');
  },
);

engine.tx(
  {
    validAt: '2024-03-01',
    actor: 'alice',
    reason: 'Bob departs; Dave promoted, inherits Bob’s reports',
  },
  () => {
    retitle('Dave', 'Engineering Manager');
    endReport('Bob', '2024-03-01'); // Bob no longer reports to Alice
    endReport('Dave', '2024-03-01');
    reportTo('Dave', 'Alice', '2024-03-01');
    endReport('Carol', '2024-03-01');
    reportTo('Carol', 'Dave', '2024-03-01');
    endReport('Eve', '2024-03-01');
    reportTo('Eve', 'Dave', '2024-03-01');
  },
);

engine.tx({ validAt: '2024-07-01', actor: 'dave', reason: 'Carol promoted to Senior' }, () => {
  retitle('Carol', 'Senior Engineer');
});

// ===========================================================================
console.log('═'.repeat(70));
console.log(
  'INGESTED',
  engine.log.length,
  'events across',
  engine.currentSeq(),
  'transaction seqs',
);
console.log('snapshot checkpoints at seqs:', engine.snapshotSeqs());

// --- 1. VALID-TIME "as-of" org chart (pure GQL range predicates) -----------
const ORG_ASOF = `
  MATCH (p:Person)-[r:REPORTS_TO]->(m:Person)
  WHERE r.validFrom <= $d AND (r.validTo IS NULL OR r.validTo > $d)
  RETURN p.name AS report, m.name AS manager
  ORDER BY manager, report`;

function orgChartAsOf(graph: Graph, d: string) {
  return query(graph, ORG_ASOF, { d }).map((r) => `${r.report} → ${r.manager}`);
}

for (const d of ['2023-03-01', '2023-09-01', '2024-02-01', '2024-06-01']) {
  console.log(`\n── org chart as-of VALID date ${d} ──`);
  for (const line of orgChartAsOf(g, d)) console.log('   ', line);
}

// --- 2. point-in-time relationship query -----------------------------------
console.log('\n── who reported to Bob as-of 2024-02-01? ──');
const bobReports = query(
  g,
  `MATCH (p:Person)-[r:REPORTS_TO]->(m:Person {name:$mgr})
   WHERE r.validFrom <= $d AND (r.validTo IS NULL OR r.validTo > $d)
   RETURN p.name AS report ORDER BY report`,
  { mgr: 'Bob', d: '2024-02-01' },
);
console.log('   ', bobReports.map((r) => r.report).join(', '));

// --- 3. AUDIT TRAIL for one entity (Carol) ---------------------------------
console.log('\n── audit trail for Carol (', P.Carol, ') ──');
for (const rec of engine.auditFor(P.Carol)) {
  const o: any = rec.op;
  let what = o.kind;
  if (o.kind === 'setVertexProp')
    what = `${o.key}: ${JSON.stringify(o.previous)} → ${JSON.stringify(o.value)}`;
  else if (o.kind === 'addVertex') what = `hired as "${o.properties.title}"`;
  else if (o.kind === 'addEdge')
    what = `start REPORTS_TO ${o.to} (validFrom ${o.properties.validFrom})`;
  else if (o.kind === 'setEdgeProp')
    what = `close REPORTS_TO ${o.to} (${o.key}=${JSON.stringify(o.value)})`;
  console.log(`   seq=${rec.seq} tx#${rec.txId} valid=${rec.validAt} by=${rec.actor}: ${what}`);
}

// --- 4. RECONSTRUCT a past transaction-state + DIFF vs now ------------------
// Reconstruct just after the 2024-01-01 reorg commit (tx#3). This lands PAST
// the checkpoint (seq 8), so it exercises snapshot-load + tail-replay.
const reorgSeq = Math.max(...engine.log.filter((r) => r.txId === 3).map((r) => r.seq));
const past = engine.reconstructAt(reorgSeq);
console.log(
  `\n── reconstruct transaction-state @ seq ${reorgSeq} (just after the 2024-01 reorg) ` +
    `(from snapshot seq ${past.fromSnapshot} + ${past.replayed} replayed events) ──`,
);

function titleMap(graph: Graph): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of query(graph, `MATCH (p:Person) RETURN p.name AS n, p.title AS t`))
    out[r.n as string] = r.t as string;
  return out;
}
// "open" reporting lines = validTo IS NULL, at the transaction-state's latest belief
function openLines(graph: Graph): Set<string> {
  const rows = query(
    graph,
    `MATCH (p:Person)-[r:REPORTS_TO]->(m:Person) WHERE r.validTo IS NULL RETURN p.name AS a, m.name AS b`,
  );
  return new Set(rows.map((r) => `${r.a} → ${r.b}`));
}

const pastTitles = titleMap(past.graph);
const nowTitles = titleMap(g);
console.log('   titles then:', JSON.stringify(pastTitles));
console.log('   titles now :', JSON.stringify(nowTitles));
console.log('   title diffs:');
const allNames = new Set([...Object.keys(pastTitles), ...Object.keys(nowTitles)]);
for (const n of [...allNames].sort()) {
  if (pastTitles[n] !== nowTitles[n])
    console.log(`     ${n}: ${pastTitles[n] ?? '(absent)'} → ${nowTitles[n] ?? '(absent)'}`);
}

const pastLines = openLines(past.graph);
const nowLines = openLines(g);
console.log(
  '   reporting lines added since the reorg state:',
  [...nowLines].filter((l) => !pastLines.has(l)),
);
console.log(
  '   reporting lines removed since the reorg state:',
  [...pastLines].filter((l) => !nowLines.has(l)),
);

// --- 5. BITEMPORAL: reconstruct tx-state, THEN valid-time as-of on it -------
// "As of what we recorded through seq 9, what did the org chart look like on
// valid date 2024-02-01?" — replay to a tx-state, then run the valid-time query.
const asOfTx = engine.reconstructAt(9);
console.log(`\n── bitemporal: tx-state @ seq 9, valid-date as-of 2024-02-01 ──`);
for (const line of orgChartAsOf(asOfTx.graph, '2024-02-01')) console.log('   ', line);
console.log('   (compare: same valid-date on the FULL/current log:)');
for (const line of orgChartAsOf(g, '2024-02-01')) console.log('   ', line);

// --- persist the log + checkpoints -----------------------------------------
const paths = engine.persist(import.meta.dir);
console.log('\npersisted event log →', paths.logPath);
console.log('persisted checkpoints →', paths.snapPath);
console.log('═'.repeat(70));
