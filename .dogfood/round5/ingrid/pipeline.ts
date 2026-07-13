// ETL pipeline: ingest 3 external systems in different formats, reconcile/dedupe
// with _MERGE + createUniqueConstraint, then round-trip through all 5 codecs.
import { Graph, LocalDate, LocalDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  serialize,
  deserialize,
  graphContentEqual,
  FORMATS,
  decodeNodes,
  decodeEdges,
  type FormatName,
} from '@lenke/serialization';

const line = (s = '') => console.log(s);

// ---------------------------------------------------------------------------
// 1. INGEST — three "external systems", three formats
// ---------------------------------------------------------------------------

// System A: a CSV export of customers (Neo4j admin-import style: nodes + edges).
const customersNodesCsv = [
  'id,:LABEL,email:string,name:string,vip:boolean,tags:string[]',
  'c1,Customer,"alice@example.com","Alice, the ""Great""",true,"gold;silver"',
  'c2,Customer,"bob@example.com","Bob",false,"bronze"',
  // unicode + a value that looks like a formula (spreadsheet-injection surface)
  'c3,Customer,"chidi@example.com","Chidi 日本語 👩‍💻",false,"=SUM(A1)"',
].join('\n');
const customersEdgesCsv = 'id,:START_ID,:END_ID,:TYPE'; // no edges in this export

// System B: an NDJSON order stream. Note c2's email cased differently and a
// brand-new customer c9 that the CSV export never saw.
const ordersNdjson = [
  '{"type":"node","id":"o1","labels":["Order"],"properties":{"total":42.5,"placed":{"@date":"2026-01-15"}}}',
  '{"type":"node","id":"o2","labels":["Order"],"properties":{"total":0.1,"placed":{"@date":"2026-02-01"}}}',
  '{"type":"edge","id":"e-o1","from":"c1","to":"o1","labels":["PLACED"],"properties":{}}',
  '{"type":"edge","id":"e-o2","from":"c9","to":"o2","labels":["PLACED"],"properties":{}}',
].join('\n');

// System C: a GraphSON product dump, with a null-in-list property (dimensions
// with an unknown/missing middle value) — the tricky value.
const productsGraphson = JSON.stringify({
  vertices: [
    {
      '@type': 'g:Vertex',
      '@value': {
        id: 'p1',
        label: 'Product',
        properties: {
          sku: [{ '@type': 'g:VertexProperty', '@value': { value: 'SKU-1', label: 'sku' } }],
          price: [
            {
              '@type': 'g:VertexProperty',
              '@value': { value: { '@type': 'g:Double', '@value': 19.99 }, label: 'price' },
            },
          ],
          dims: [
            {
              '@type': 'g:VertexProperty',
              '@value': { value: { '@type': 'g:List', '@value': [10, null, 5] }, label: 'dims' },
            },
          ],
        },
      },
    },
  ],
  edges: [],
});

const graph = new Graph();
decodeNodes(customersNodesCsv, graph);
decodeEdges(customersEdgesCsv, graph);
deserialize(ordersNdjson, 'ndjson', graph);
deserialize(productsGraphson, 'graphson', graph);

line('=== after ingest ===');
line(`vertices=${[...graph.vertices].length} edges=${[...graph.edges].length}`);
// c9 was auto-created as a bare endpoint by the ndjson edge — needs reconciling.
line(`c9 pre-merge labels=${JSON.stringify([...(graph.getVertexById('c9')?.labels ?? [])])}`);

// ---------------------------------------------------------------------------
// 2. RECONCILE / DEDUPE — unique constraint on email + _MERGE upsert
// ---------------------------------------------------------------------------
graph.createUniqueConstraint('Customer', 'email');

// A late "CRM master" feed arrives; _MERGE upserts by the email key: c1 exists
// (update path), c9 is a fresh full record (create path). Uses the node form.
const crmFeed = [
  { email: 'alice@example.com', name: 'Alice G.', vip: true },
  { email: 'dana@example.com', name: 'Dana', vip: false },
];
for (const rec of crmFeed) {
  query(
    graph,
    `_MERGE (c:Customer {email: $email, name: $name, vip: $vip})
       _ON_CREATE SET c.source = 'crm'
       _ON_UPDATE SET c.name = $name, c.vip = $vip`,
    rec,
  );
}

// Reconcile the bare c9 endpoint: give it a Customer identity keyed by email.
query(
  graph,
  `_MERGE (c:Customer {email: $email, name: $name}) _ON_CREATE SET c.source = 'orders'`,
  {
    email: 'carol@example.com',
    name: 'Carol',
  },
);

line('\n=== after reconcile ===');
const custs = query<{ email: string; name: string }>(
  graph,
  'MATCH (c:Customer) RETURN c.email AS email, c.name AS name',
);
line(`customers=${custs.length}`);
for (const c of custs) line(`  ${c.email}  ${c.name}`);

// Prove the unique constraint actually blocks a duplicate insert.
let dupBlocked = false;
try {
  query(graph, `INSERT (:Customer {email: 'alice@example.com'})`);
} catch (e) {
  dupBlocked =
    (e as any).code === 'E_CONSTRAINT_VIOLATION' || /constraint/i.test((e as Error).message);
}
line(`duplicate email insert blocked by constraint: ${dupBlocked}`);

// ---------------------------------------------------------------------------
// 3. ROUND-TRIP FIDELITY — export to each codec, re-import, content-compare
// ---------------------------------------------------------------------------
line('\n=== round-trip across all codecs ===');
for (const fmt of FORMATS as FormatName[]) {
  const text = serialize(graph, fmt);
  const back = deserialize(text, fmt);
  const eq = graphContentEqual(back, graph);
  line(`  ${fmt.padEnd(9)} content-equal=${eq}  bytes=${text.length}`);
}

// Focus: does the product's null-in-list dims survive each codec?
line('\n=== null-in-list [10, null, 5] survival per codec ===');
for (const fmt of FORMATS as FormatName[]) {
  const back = deserialize(serialize(graph, fmt), fmt);
  const p1 = back.getVertexById('p1');
  const dims = p1 ? (p1.properties as any).dims : '<lost>';
  line(`  ${fmt.padEnd(9)} dims=${JSON.stringify(dims)}`);
}
