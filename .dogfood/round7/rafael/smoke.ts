import { Graph, LocalDate } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const a = g.addVertex({ labels: ['Account'], properties: { code: '1000', name: 'Cash' } });
const t = g.addVertex({
  labels: ['Transaction'],
  properties: { ref: 'T1', date: new LocalDate(2026, 1, 15) },
});
g.addEdge({ from: t, to: a, labels: ['POSTING'], properties: { cents: 500 } });
g.addEdge({ from: t, to: a, labels: ['POSTING'], properties: { cents: -300 } });

// 1. sum aggregation
console.log(
  'SUM cents:',
  JSON.stringify(query(g, 'MATCH ()-[p:POSTING]->() RETURN sum(p.cents) AS total')),
);

// 2. float sum
const fg = new Graph();
const v = fg.addVertex({ labels: ['X'], properties: {} });
for (const c of [0.1, 0.2]) fg.addEdge({ from: v, to: v, labels: ['E'], properties: { amt: c } });
console.log(
  'FLOAT SUM 0.1+0.2:',
  JSON.stringify(query(fg, 'MATCH ()-[e:E]->() RETURN sum(e.amt) AS s')),
);

// 3. event veto
const vg = new Graph();
vg.on('@graph/EdgeAdded', (ev) => {
  if ((ev.value.properties as any).bad) {
    ev.preventDefault();
  }
});
const vv = vg.addVertex({ labels: ['X'], properties: {} });
vg.addEdge({ from: vv, to: vv, labels: ['E'], properties: { bad: true } });
console.log('VETO edgeCount (expect 0):', vg.edgeCount);

// 4. unique constraint
const cg = new Graph();
cg.createUniqueConstraint('Account', 'code');
cg.addVertex({ labels: ['Account'], properties: { code: '1000' } });
try {
  cg.addVertex({ labels: ['Account'], properties: { code: '1000' } });
  console.log('UNIQUE core addVertex: NO THROW (constraint not enforced by core API)');
} catch (e: any) {
  console.log('UNIQUE core addVertex threw:', e.code ?? e.message);
}
// via GQL INSERT
try {
  query(cg, "INSERT (:Account {code: '1000'})");
  console.log('UNIQUE gql INSERT: NO THROW');
} catch (e: any) {
  console.log('UNIQUE gql INSERT threw:', e.code ?? e.message);
}
console.log('Accounts with code 1000 in cg:', cg.getVerticesByLabel('Account').size);

// 5. temporal date range query
console.log(
  'DATE RANGE:',
  JSON.stringify(
    query(
      g,
      "MATCH (t:Transaction) WHERE t.date >= DATE '2026-01-01' AND t.date <= DATE '2026-12-31' RETURN t.ref AS ref",
    ),
  ),
);
