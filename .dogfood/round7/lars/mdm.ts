// Entity-resolution / MDM pipeline on @lenke. Ingest messy multi-source records,
// block+match, cluster, merge into golden records via _MERGE, measure quality
// against the planted ground truth.
import { writeFileSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { generate, type SrcRec } from './gen';

const OUT = new URL('.', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// 0. Generate + persist source files (exercise real file ingest)
// ---------------------------------------------------------------------------
const { records, clusters } = generate(1200, 42);
const crm = records.filter((r) => r.source === 'crm');
const erp = records.filter((r) => r.source === 'erp');

// CRM as a PLAIN business CSV (id,name,email,phone,city,updated) — the exact
// untyped shape the charter cares about.
const csvEsc = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const csvLines = ['id,name,email,phone,city,updated'];
for (const r of crm)
  csvLines.push([r.id, r.name, r.email, r.phone, r.city, r.updated].map(csvEsc).join(','));
writeFileSync(OUT + 'crm.csv', csvLines.join('\n'));
// ERP as NDJSON
writeFileSync(OUT + 'erp.ndjson', erp.map((r) => JSON.stringify(r)).join('\n'));
// keep a truth key alongside (hidden from matching)
const truthOf = new Map(records.map((r) => [r.id, r.truth]));

// ---------------------------------------------------------------------------
// 1. Ingest -> :Source vertices
// ---------------------------------------------------------------------------
const g = new Graph();

// Minimal RFC-ish CSV line splitter (handles quotes) — needed because
// serialization.decodeNodes treats column 2 as :LABEL (see findings).
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '',
    row: string[] = [],
    inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inq = false;
      } else field += c;
    } else if (c === '"') inq = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      /* skip */
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

import { readFileSync } from 'node:fs';
for (const rec of parseCsv(readFileSync(OUT + 'crm.csv', 'utf8'))) {
  g.addVertex({ id: rec.id, labels: ['Source'], properties: { ...rec, src: 'crm' } });
}
for (const line of readFileSync(OUT + 'erp.ndjson', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as SrcRec;
  g.addVertex({
    id: rec.id,
    labels: ['Source'],
    properties: {
      id: rec.id,
      name: rec.name,
      email: rec.email,
      phone: rec.phone,
      city: rec.city,
      updated: rec.updated,
      src: 'erp',
    },
  });
}
console.log(
  `ingested ${g.vertexCount} source records (${crm.length} crm csv + ${erp.length} erp ndjson)`,
);

// ---------------------------------------------------------------------------
// 2. Normalize blocking keys IN GQL (probe the string toolkit)
// ---------------------------------------------------------------------------
// name key: lower(trim(name)); email key: lower(trim(email));
// phone digits: replace-chain (no regexp_replace/translate available);
// email domain: last(split(...)) — because list[i] indexing is not parsed.
query(
  g,
  `
  MATCH (s:Source)
  SET s.nname  = lower(trim(s.name)),
      s.nemail = lower(trim(s.email)),
      s.nphone = replace(replace(replace(replace(replace(replace(replace(s.phone,'(',''),')',''),' ',''),'-',''),'.',''),'+',''),'1',''),
      s.edom   = last(split(lower(trim(s.email)),'@'))
`,
);
// note: the '1' strip above also nukes legit digit 1s — see findings (no digit-class strip).

// ---------------------------------------------------------------------------
// 3. Blocking: group by each key, emit clusters (avoids O(n^2) self-join)
// ---------------------------------------------------------------------------
type Group = { k: string; ids: string[] };
function groupsBy(prop: string, minLen = 1): Group[] {
  const rows = query(
    g,
    `MATCH (s:Source) WHERE s.${prop} IS NOT NULL AND char_length(s.${prop}) >= ${minLen} RETURN s.${prop} AS k, collect_list(s.id) AS ids`,
  ) as { k: string; ids: string[] }[];
  return rows.filter((r) => r.ids.length > 1);
}
const emailGroups = groupsBy('nemail', 3);
const phoneGroups = groupsBy('nphone', 7);
const nameGroups = groupsBy('nname', 3);

// ---------------------------------------------------------------------------
// 4. Union-find over candidate links  (resolve for a chosen set of blockers)
// ---------------------------------------------------------------------------
const allIds = [...g.vertices].map((v) => v.id as string);
function resolve(groupSets: Group[][]): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const id of allIds) parent.set(id, id);
  for (const gr of groupSets)
    for (const { ids } of gr) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  const out = new Map<string, string[]>();
  for (const id of allIds) {
    const root = find(id);
    (out.get(root) ?? out.set(root, []).get(root)!).push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Quality metrics vs planted ground truth (pairwise precision/recall)
// ---------------------------------------------------------------------------
function pairsOf(memberMap: Iterable<string[]>): Set<string> {
  const s = new Set<string>();
  for (const members of memberMap) {
    const m = [...members].sort();
    for (let i = 0; i < m.length; i++)
      for (let j = i + 1; j < m.length; j++) s.add(`${m[i]}|${m[j]}`);
  }
  return s;
}
const truthClusters = new Map<number, string[]>();
for (const [id, t] of truthOf) (truthClusters.get(t) ?? truthClusters.set(t, []).get(t)!).push(id);
const truthPairs = pairsOf(truthClusters.values());

function score(label: string, resolved: Map<string, string[]>) {
  const predPairs = pairsOf(resolved.values());
  let tp = 0;
  for (const p of predPairs) if (truthPairs.has(p)) tp++;
  const fp = predPairs.size - tp,
    fn = truthPairs.size - tp;
  const precision = tp / (tp + fp || 1),
    recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const multi = [...resolved.values()].filter((m) => m.length > 1);
  console.log(`\n[${label}]`);
  console.log(`  predicted pairs ${predPairs.size}  TP=${tp} FP=${fp} FN=${fn}`);
  console.log(
    `  precision=${precision.toFixed(4)} recall=${recall.toFixed(4)} f1=${f1.toFixed(4)}`,
  );
  console.log(
    `  clusters ${resolved.size} (${multi.length} multi, ${resolved.size - multi.length} singleton)`,
  );
  return { precision, recall, f1 };
}

console.log('\n=== MATCH QUALITY (pairwise vs ground truth) ===');
console.log(`ground-truth dup pairs: ${truthPairs.size}`);
score('email+phone (strong identifiers)', resolve([emailGroups, phoneGroups]));
score(
  'email+phone+name (adds weak name-only blocker)',
  resolve([emailGroups, phoneGroups, nameGroups]),
);
score('name only (weak, collision-prone)', resolve([nameGroups]));

// canonical resolution used downstream = the strong blockers
const resolved = resolve([emailGroups, phoneGroups]);

export { g, resolved, records, clusters, truthOf, query };
