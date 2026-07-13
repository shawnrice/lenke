// Dogfood round 6 — Gustavo. An event-sourced HR audit / versioning layer.
// Builds a realistic HR graph over "time", then: shows entity history,
// reconstructs "as of seq N", verifies against ground truth, diffs versions,
// answers a bitemporal question, and stress-tests the README's undo/redo claim.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { AuditLedger, graphContentEqual, graphContentEqualIgnoringIds } from './audit.ts';

const h1 = (s: string) => console.log(`\n########## ${s} ##########`);
const ok = (b: boolean, s: string) => console.log(`  [${b ? 'PASS' : 'FAIL'}] ${s}`);

const graph = new Graph();
const ledger = new AuditLedger(graph);

// Ground-truth id-stable snapshots (clone) taken at each commit — the honest
// reference we verify reconstruction against.
const truth: { seq: number; g: Graph; note: string }[] = [];
function commit(
  meta: { validTime?: string; actor?: string; note: string },
  stmts: { text: string; params?: any }[],
) {
  const { seq } = ledger.commit(meta, stmts);
  truth.push({ seq, g: graph.clone(), note: meta.note });
  return seq;
}

// ---------------------------------------------------------------------------
h1('BUILD: HR history over "time" (valid-time = effective date)');

commit({ validTime: '2021-01-04', actor: 'hr:onboarding', note: 'found company + first hires' }, [
  { text: `INSERT (:Department {name: $n, code: $c})`, params: { n: 'Engineering', c: 'ENG' } },
  { text: `INSERT (:Department {name: $n, code: $c})`, params: { n: 'Sales', c: 'SAL' } },
]);

commit({ validTime: '2021-02-01', actor: 'hr:onboarding', note: 'hire Alice into ENG' }, [
  {
    text: `INSERT (:Employee {name: $n, title: $t, salary: $s, ssn: $ssn})`,
    params: { n: 'Alice', t: 'Engineer', s: 120000, ssn: '111-22-3333' },
  },
  {
    text: `MATCH (e:Employee {name:'Alice'}), (d:Department {code:'ENG'}) INSERT (e)-[:WORKS_IN {since: $since}]->(d)`,
    params: { since: '2021-02-01' },
  },
]);

commit(
  { validTime: '2021-03-15', actor: 'hr:onboarding', note: 'hire Bob into SAL, reports to Alice' },
  [
    {
      text: `INSERT (:Employee {name: $n, title: $t, salary: $s, ssn: $ssn})`,
      params: { n: 'Bob', t: 'Sales Rep', s: 90000, ssn: '444-55-6666' },
    },
    {
      text: `MATCH (e:Employee {name:'Bob'}), (d:Department {code:'SAL'}) INSERT (e)-[:WORKS_IN {since: $since}]->(d)`,
      params: { since: '2021-03-15' },
    },
    {
      text: `MATCH (b:Employee {name:'Bob'}), (a:Employee {name:'Alice'}) INSERT (b)-[:REPORTS_TO {since: $since}]->(a)`,
      params: { since: '2021-03-15' },
    },
  ],
);

commit({ validTime: '2022-01-01', actor: 'mgr:alice', note: 'Alice raise' }, [
  { text: `MATCH (e:Employee {name:'Alice'}) SET e.salary = $s`, params: { s: 135000 } },
]);

commit(
  {
    validTime: '2022-04-01',
    actor: 'mgr:alice',
    note: 'Bob promotion (bulk update: title+salary+level)',
  },
  [
    // Represent a promotion as a multi-field change. Two ways below; we use SET x3
    // (which emits singular PropertyChanged events, each with `previous`).
    { text: `MATCH (e:Employee {name:'Bob'}) SET e.title = $t`, params: { t: 'Senior Sales Rep' } },
    { text: `MATCH (e:Employee {name:'Bob'}) SET e.salary = $s`, params: { s: 110000 } },
    { text: `MATCH (e:Employee {name:'Bob'}) SET e.level = $l`, params: { l: 3 } },
  ],
);

const seqBeforeTransfer = ledger.records.at(-1)!.seq;

commit(
  {
    validTime: '2022-09-01',
    actor: 'hr:mobility',
    note: 'Bob transfers ENG (drop old WORKS_IN, add new)',
  },
  [
    { text: `MATCH (:Employee {name:'Bob'})-[w:WORKS_IN]->(:Department {code:'SAL'}) DELETE w` },
    {
      text: `MATCH (e:Employee {name:'Bob'}), (d:Department {code:'ENG'}) INSERT (e)-[:WORKS_IN {since: $since}]->(d)`,
      params: { since: '2022-09-01' },
    },
  ],
);

commit({ validTime: '2023-01-01', actor: 'compliance', note: 'purge SSNs (right-to-erasure)' }, [
  { text: `MATCH (e:Employee {name:'Alice'}) REMOVE e.ssn` },
  { text: `MATCH (e:Employee {name:'Bob'}) REMOVE e.ssn` },
]);

commit(
  {
    validTime: '2023-06-30',
    actor: 'hr:offboarding',
    note: 'Alice leaves (terminate → detach delete)',
  },
  [{ text: `MATCH (e:Employee {name:'Alice'}) DETACH DELETE e` }],
);

console.log(`total events journaled: ${ledger.records.length}`);
console.log(`total statements in WriteLog: ${ledger.writeLog.head()}`);
console.log(`ground-truth snapshots: ${truth.length}`);

// ---------------------------------------------------------------------------
h1('QUERY 1: full audit history of one entity (Bob)');
const bobId = [...graph.vertices].find((v) => v.getProperty('name') === 'Bob')!.id;
for (const r of ledger.history(bobId)) {
  const detail = r.key
    ? `${r.key}: ${JSON.stringify(r.previous)} -> ${JSON.stringify(r.value)}`
    : r.keys
      ? `remove ${r.keys.join(',')} (was ${JSON.stringify(r.previous)})`
      : r.snapshot
        ? JSON.stringify(r.snapshot.properties)
        : (r.label ?? '');
  console.log(
    `  seq ${String(r.seq).padStart(2)} | vt=${r.validTime} | ${r.actor.padEnd(14)} | ${r.type.replace('@graph/', '')} ${detail}`,
  );
}

// ---------------------------------------------------------------------------
h1('QUERY 2: reconstruct "as of" past points + verify against ground truth');
for (const t of truth) {
  const recon = ledger.reconstructFromSnapshot(t.seq)!;
  const idEqual = graphContentEqual(recon, t.g);
  ok(idEqual, `snapshot reconstruction @seq ${t.seq} (${t.note}) is BYTE/ID-equal to ground truth`);
}

// ---------------------------------------------------------------------------
h1('QUERY 3: statement-replay reconstruction (the @lenke/sync WriteLog model)');
{
  const finalTruth = truth.at(-1)!.g;
  const replay = ledger.reconstructFromStatements(ledger.writeLog.head());
  const idEqual = graphContentEqual(replay, finalTruth);
  const contentEqual = graphContentEqualIgnoringIds(replay, finalTruth);
  ok(
    idEqual === false,
    `graphContentEqual(replay, truth) is FALSE — statement replay mints fresh UUIDs`,
  );
  ok(
    contentEqual === true,
    `...but id-ignoring content comparison is TRUE (structurally identical)`,
  );
  console.log(
    '  => the stock graphContentEqual (the documented round-trip verifier) CANNOT verify a statement replay.',
  );
}

// ---------------------------------------------------------------------------
h1('QUERY 4: diff two versions (before vs after Bob transfer)');
{
  const before = ledger.reconstructFromSnapshot(seqBeforeTransfer)!;
  const after = truth.at(-3)!.g; // after transfer, before ssn purge... find transfer snapshot
  // find the transfer snapshot explicitly
  const transferSnap = truth.find((t) => t.note.startsWith('Bob transfers'))!.g;
  console.log(diffEmployeeDepts(before, transferSnap));
}

// ---------------------------------------------------------------------------
h1('QUERY 5: bitemporal — Bob salary as-of valid-time, as-known-at seq');
// valid-time series built from the audit records (transaction-time = seq).
function salaryAsOf(entityId: string, validAsOf: string, knownAsOfSeq: number): unknown {
  let val: unknown = undefined;
  for (const r of ledger.records) {
    if (r.seq > knownAsOfSeq) break;
    if (r.entityId !== entityId) continue;
    // an INSERT snapshot establishes the initial salary
    if (r.type === '@graph/VertexAdded' && r.snapshot) {
      if ((r.validTime ?? '') <= validAsOf) val = r.snapshot.properties.salary;
    }
    if (r.key === 'salary' && (r.validTime ?? '') <= validAsOf) val = r.value;
  }
  return val;
}
console.log(
  `  Bob salary effective 2022-03-01, as known today (seq ${ledger.records.length}): ${salaryAsOf(bobId, '2022-03-01', ledger.records.length)}`,
);
console.log(
  `  Bob salary effective 2022-06-01, as known today: ${salaryAsOf(bobId, '2022-06-01', ledger.records.length)}`,
);
console.log(
  `  Bob salary effective 2022-06-01, as known BEFORE promotion (seq ${seqBeforeTransfer - 3}): ${salaryAsOf(bobId, '2022-06-01', seqBeforeTransfer - 3)}`,
);

// ---------------------------------------------------------------------------
h1(
  'CROWN JEWEL: README claims events are "enough to build an undo/redo stack purely from events". Test it.',
);
purelyEventDrivenUndoTest();

function purelyEventDrivenUndoTest() {
  // Build a fresh graph; capture ONLY event payloads (as a purely-event undo
  // stack would — no pre-commit reads, no ground-truth snapshots).
  const g = new Graph();
  const undoStack: any[] = [];
  const record = (e: any) => undoStack.push({ type: e.type, ...structuredCloneSafe(e.value) });
  for (const t of [
    '@graph/VertexPropertyChanged',
    '@graph/VertexPropertiesChanged',
    '@graph/VertexPropertyRemoved',
    '@graph/VertexPropertiesRemoved',
  ]) {
    g.on(t as any, record as any);
  }
  const v = g.addVertex({
    labels: ['Employee'],
    properties: { name: 'Zoe', salary: 100000, title: 'Engineer', ssn: '999-00-1111' },
  });

  const original = { ...v.properties };

  // (a) singular SET — README says this is undoable. It is.
  v.setProperty('salary', 130000);
  // (b) BULK setProperties — promotion in one call.
  v.setProperties({ title: 'Staff Engineer', salary: 160000, level: 6 });
  // (c) removeProperty — compliance erasure.
  v.removeProperty('ssn');

  // Now undo purely from the captured EVENT payloads, newest first.
  const g2reconstructed: Record<string, unknown> = { ...v.properties };
  for (const rec of [...undoStack].reverse()) {
    if (rec.type === '@graph/VertexPropertyChanged') {
      // previous present → correct
      g2reconstructed[rec.key] = rec.previous;
    } else if (rec.type === '@graph/VertexPropertiesChanged') {
      // NO previous in payload → best a pure-event undo can do is delete the keys
      for (const k of Object.keys(rec.next)) delete g2reconstructed[k];
    } else if (rec.type === '@graph/VertexPropertyRemoved') {
      // NO removed value in payload → cannot restore; leave absent
    }
  }

  console.log('  original state :', JSON.stringify(original));
  console.log('  event-undo gave:', JSON.stringify(g2reconstructed));
  const equal = JSON.stringify(sortKeys(original)) === JSON.stringify(sortKeys(g2reconstructed));
  ok(equal, 'purely-event-driven undo restored the ORIGINAL state');
  if (!equal) {
    console.log('  >>> SILENTLY WRONG reconstruction. Lost/incorrect keys:');
    for (const k of new Set([...Object.keys(original), ...Object.keys(g2reconstructed)])) {
      if (JSON.stringify((original as any)[k]) !== JSON.stringify(g2reconstructed[k])) {
        console.log(
          `        ${k}: original=${JSON.stringify((original as any)[k])} vs undo=${JSON.stringify(g2reconstructed[k])}`,
        );
      }
    }
    console.log(
      '  Cause: VertexPropertiesChanged carries `next` but NO `previous`; VertexPropertyRemoved carries `key` but NOT the removed value.',
    );
  }
}

// helpers -------------------------------------------------------------------
function diffEmployeeDepts(a: Graph, b: Graph): string {
  const deptOf = (g: Graph, name: string) => {
    const e = [...g.vertices].find((v) => v.getProperty('name') === name);
    if (!e) return '(gone)';
    for (const edge of g.edges)
      if (edge.from.id === e.id && edge.labels.has('WORKS_IN')) return edge.to.getProperty('code');
    return '(none)';
  };
  const lines: string[] = [];
  for (const name of ['Alice', 'Bob']) {
    const x = deptOf(a, name),
      y = deptOf(b, name);
    lines.push(`  ${name}: ${x} ${x === y ? '==' : '->'} ${y}${x === y ? '' : '  [CHANGED]'}`);
  }
  return lines.join('\n');
}
function structuredCloneSafe(v: any) {
  const o: any = {};
  for (const k of ['key', 'value', 'previous', 'keys', 'next']) if (k in v) o[k] = v[k];
  return o;
}
function sortKeys(o: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}
