// Round-6 Gustavo probes: does the event/replay machinery carry enough to
// reconstruct historical state? Each probe prints PASS/FAIL-ish observations.
import { Graph } from '@lenke/core';
import type { GraphEvent } from '@lenke/core';
import { query } from '@lenke/gql';
import { serialize, deserialize, graphContentEqual } from '@lenke/serialization';

const line = (s: string) => console.log(s);
const hr = (s: string) => console.log(`\n=== ${s} ===`);

// A tiny "capture everything" journal.
const EVENT_TYPES = [
  '@graph/VertexAdded',
  '@graph/VertexRemoved',
  '@graph/EdgeAdded',
  '@graph/EdgeRemoved',
  '@graph/LabelAddedToVertex',
  '@graph/LabelRemovedFromVertex',
  '@graph/LabelAddedToEdge',
  '@graph/LabelRemovedFromEdge',
  '@graph/VertexPropertyChanged',
  '@graph/VertexPropertiesChanged',
  '@graph/VertexPropertyRemoved',
  '@graph/VertexPropertiesRemoved',
  '@graph/EdgePropertyChanged',
  '@graph/EdgePropertiesChanged',
  '@graph/EdgePropertyRemoved',
  '@graph/EdgePropertiesRemoved',
] as const;

function attachJournal(g: Graph) {
  const log: { type: string; value: any }[] = [];
  const offs = EVENT_TYPES.map((t) =>
    g.on(t as any, (e: GraphEvent) => log.push({ type: (e as any).type, value: (e as any).value })),
  );
  return { log, detach: () => offs.forEach((o) => o()) };
}

// ---------------------------------------------------------------------------
// PROBE A: do GQL writes (INSERT/SET/REMOVE/DELETE) emit graph events?
hr('PROBE A: GQL mutations emit graph events?');
{
  const g = new Graph();
  const { log } = attachJournal(g);
  query(g, `INSERT (:Person {name: 'Alice', salary: 100})`);
  query(g, `MATCH (p:Person {name:'Alice'}) SET p.salary = 120`);
  query(g, `MATCH (p:Person {name:'Alice'}) SET p.tenure = 3`); // new key
  query(g, `MATCH (p:Person {name:'Alice'}) REMOVE p.tenure`);
  query(g, `MATCH (p:Person {name:'Alice'}) DETACH DELETE p`);
  line(`events captured from 5 GQL statements: ${log.length}`);
  for (const e of log) line(`  ${e.type} :: ${JSON.stringify(pick(e.value))}`);
}

// PROBE A2: does the SET-existing-key event carry `previous`?
hr('PROBE A2: GQL SET carries previous?');
{
  const g = new Graph();
  query(g, `INSERT (:Person {name: 'Bob', salary: 50})`);
  const seen: any[] = [];
  const off = g.on('@graph/VertexPropertyChanged', (e: any) => seen.push(e.value));
  query(g, `MATCH (p:Person {name:'Bob'}) SET p.salary = 75`);
  off();
  line(`VertexPropertyChanged events: ${seen.length}`);
  for (const v of seen)
    line(`  key=${v.key} value=${v.value} previous=${JSON.stringify(v.previous)}`);
}

// ---------------------------------------------------------------------------
// PROBE B: bulk setProperties event — does it carry previous per key?
hr('PROBE B: bulk setProperties previous coverage');
{
  const g = new Graph();
  const v = g.addVertex({
    labels: ['Person'],
    properties: { name: 'Cara', salary: 60, title: 'Eng' },
  });
  const seen: any[] = [];
  const off = g.on('@graph/VertexPropertiesChanged', (e: any) => seen.push(e.value));
  v.setProperties({ salary: 90, title: 'Senior Eng', level: 5 });
  off();
  line(`VertexPropertiesChanged events: ${seen.length}`);
  for (const s of seen)
    line(
      `  next=${JSON.stringify(s.next)} previous=${'previous' in s ? JSON.stringify(s.previous) : '<<ABSENT>>'}`,
    );
  line(
    `=> reversing this bulk write needs the OLD {salary:60,title:'Eng',level:absent}; is it in the event? ${'previous' in seen[0] ? 'yes' : 'NO'}`,
  );
}

// ---------------------------------------------------------------------------
// PROBE C: removeProperty / removeProperties event — does it carry the removed value?
hr('PROBE C: property-removal previous coverage');
{
  const g = new Graph();
  const v = g.addVertex({
    labels: ['Person'],
    properties: { name: 'Dan', ssn: '123-45-6789', bonus: 5000 },
  });
  const single: any[] = [];
  const bulk: any[] = [];
  const o1 = g.on('@graph/VertexPropertyRemoved', (e: any) => single.push(e.value));
  const o2 = g.on('@graph/VertexPropertiesRemoved', (e: any) => bulk.push(e.value));
  v.removeProperty('ssn');
  v.removeProperties(['bonus']);
  o1();
  o2();
  line(`VertexPropertyRemoved: ${JSON.stringify(single.map(pick))}`);
  line(`VertexPropertiesRemoved: ${JSON.stringify(bulk.map(pick))}`);
  line(
    `=> to undo a removal you need the removed VALUE; present in event? ${single[0] && 'previous' in single[0] ? 'yes' : 'NO'}`,
  );
}

// ---------------------------------------------------------------------------
// PROBE D: cascade edge removal on removeVertex — are EdgeRemoved events fired, and in what order?
hr('PROBE D: cascade edge-removal events + ordering');
{
  const g = new Graph();
  const a = g.addVertex({ labels: ['Person'], properties: { name: 'A' } });
  const b = g.addVertex({ labels: ['Person'], properties: { name: 'B' } });
  g.addEdge({ from: a, to: b, labels: ['REPORTS_TO'], properties: { since: 2020 } });
  const order: string[] = [];
  const offs = ['@graph/VertexRemoved', '@graph/EdgeRemoved'].map((t) =>
    g.on(t as any, (e: any) =>
      order.push(
        `${e.type}(${e.value.getProperty?.('name') ?? e.value.getProperty?.('since') ?? '?'})`,
      ),
    ),
  );
  g.removeVertex(a);
  offs.forEach((o) => o());
  line(`emit order: ${order.join(' -> ')}`);
  line(
    `=> forward-replay of these events would remove the VERTEX before its EDGE; edge event carries pre-commit endpoints? ${'checked below'}`,
  );
}

// ---------------------------------------------------------------------------
// PROBE E: statement-replay id divergence vs clone/ndjson id stability
hr('PROBE E: reconstruction identity — statement replay vs clone/ndjson');
{
  const g = new Graph();
  query(g, `INSERT (:Person {name: 'Eve', salary: 100})`);
  query(g, `INSERT (:Person {name: 'Frank', salary: 100})`);
  const origId = [...g.vertices][0].id;

  // (1) clone snapshot
  const cloned = g.clone();
  line(
    `clone(): graphContentEqual? ${graphContentEqual(cloned, g)} (clone id == orig id? ${[...cloned.vertices][0].id === origId})`,
  );

  // (2) ndjson round-trip
  const nd = serialize(g, 'ndjson');
  const back = deserialize(nd, 'ndjson');
  line(`ndjson round-trip: graphContentEqual? ${graphContentEqual(back, g)}`);

  // (3) statement replay (re-run the same INSERT statements into a fresh graph)
  const replay = new Graph();
  query(replay, `INSERT (:Person {name: 'Eve', salary: 100})`);
  query(replay, `INSERT (:Person {name: 'Frank', salary: 100})`);
  line(
    `statement replay: graphContentEqual? ${graphContentEqual(replay, g)} <== structurally identical, but ids are fresh UUIDs`,
  );
  line(`   orig first id:   ${origId}`);
  line(`   replay first id: ${[...replay.vertices][0].id}`);
}

// ---------------------------------------------------------------------------
// PROBE F: is the veto observable to the caller / other listeners?
hr('PROBE F: veto observability');
{
  const g = new Graph();
  const v = g.addVertex({ labels: ['Person'], properties: { name: 'Gwen', salary: 100 } });
  let later = 'never-ran';
  g.on('@graph/VertexPropertyChanged', (e: any) => {
    if (e.value.key === 'salary') e.preventDefault();
  });
  g.on('@graph/VertexPropertyChanged', (e: any) => {
    later = `ran; defaultPrevented=${e.defaultPrevented}`;
  });
  const before = v.getProperty('salary');
  v.setProperty('salary', 999); // vetoed
  const after = v.getProperty('salary');
  line(`salary before=${before} after=${after} (veto ${before === after ? 'HELD' : 'FAILED'})`);
  line(`later listener: ${later}`);
  line(
    `=> does setProperty return / throw anything to signal veto to the writer? setProperty returns: ${JSON.stringify(v.setProperty('salary', 999) as any)}`,
  );
  line(`   (writer cannot tell the write was silently dropped)`);
}

// ---------------------------------------------------------------------------
// PROBE G: null as a first-class value in events
hr('PROBE G: null property value in events');
{
  const g = new Graph();
  const v = g.addVertex({ labels: ['Person'], properties: { name: 'Hank', manager: 'X' } });
  const seen: any[] = [];
  const off = g.on('@graph/VertexPropertyChanged', (e: any) => seen.push(e.value));
  v.setProperty('manager', null); // set to null (still present)
  off();
  line(
    `set-to-null event: ${JSON.stringify(seen.map((s) => ({ key: s.key, value: s.value, previous: s.previous })))}`,
  );
  line(
    `manager now present? ${'manager' in v.properties} value=${JSON.stringify(v.getProperty('manager'))}`,
  );
}

function pick(v: any) {
  if (v == null) return v;
  const o: any = {};
  for (const k of ['key', 'value', 'previous', 'keys', 'next', 'label']) if (k in v) o[k] = v[k];
  if (typeof v.getProperty === 'function') o._name = v.getProperty('name');
  return o;
}
