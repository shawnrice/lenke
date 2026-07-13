/**
 * Invariant enforcement: unique constraints + event veto, and where they fall
 * short for a real ledger (atomic multi-posting transactions).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

// ---------------------------------------------------------------------------
// 1. UNIQUE account code — where is it actually enforced?
// ---------------------------------------------------------------------------
console.log('=== UNIQUE CONSTRAINT enforcement surface ===');
const g = new Graph();
g.createUniqueConstraint('Account', 'code');

// (a) core API
g.addVertex({ labels: ['Account'], properties: { code: '1000' } });
let coreThrew = false;
try {
  g.addVertex({ labels: ['Account'], properties: { code: '1000' } });
} catch {
  coreThrew = true;
}
console.log(
  'core addVertex duplicate threw?',
  coreThrew,
  '(count:',
  g.getVerticesByLabel('Account').size,
  ')',
);

// (b) GQL INSERT
let gqlThrew = false;
try {
  query(g, "INSERT (:Account {code: '1000'})");
} catch {
  gqlThrew = true;
}
console.log(
  'gql INSERT duplicate threw?',
  gqlThrew,
  '(count:',
  g.getVerticesByLabel('Account').size,
  ')',
);
console.log('--> constraint is enforced ONLY through the GQL write path, not core addVertex.\n');

// ---------------------------------------------------------------------------
// 2. EVENT VETO for a per-posting invariant: money must be integer cents.
// ---------------------------------------------------------------------------
console.log('=== VETO: reject a POSTING whose cents is non-integer ===');
const lg = new Graph();
let vetoed = 0;
lg.on('@graph/EdgeAdded', (ev) => {
  const c = (ev.value.properties as any).cents;
  if (typeof c !== 'number' || !Number.isInteger(c)) {
    ev.preventDefault();
    vetoed++;
  }
});
const acct = lg.addVertex({ labels: ['Account'], properties: { code: '1000' } });
const txn = lg.addVertex({ labels: ['Txn'], properties: { ref: 'T1' } });
lg.addEdge({ from: txn, to: acct, labels: ['POSTING'], properties: { cents: 500 } }); // ok
lg.addEdge({ from: txn, to: acct, labels: ['POSTING'], properties: { cents: 5.5 } }); // rejected
console.log('postings on graph:', lg.getEdgesByLabel('POSTING').size, '(expect 1)');
console.log('vetoed:', vetoed, '(expect 1)');
console.log('NOTE: veto is SILENT — addEdge returned an Edge object either way; no throw.\n');

// prove the silent-return hazard
const bad = lg.addEdge({ from: txn, to: acct, labels: ['POSTING'], properties: { cents: 9.9 } });
console.log(
  'addEdge of a vetoed posting returned:',
  bad ? 'an Edge (looks like success!)' : 'null',
);
console.log('  but is it in the graph?', lg.getEdgesByLabel('POSTING').has(bad));

// ---------------------------------------------------------------------------
// 3. The invariant you CANNOT express with a veto: debits == credits.
//    A transaction is (Txn vertex + N posting edges) added over many calls.
//    At the moment any single edge is added, the full posting set isn't known,
//    so no per-event listener can decide "this transaction is balanced".
//    You must stage in app code and commit — but there is NO atomic multi-write,
//    so a crash mid-commit leaves a half-posted, unbalanced transaction.
// ---------------------------------------------------------------------------
console.log('\n=== BALANCED-TXN invariant needs app-level staging (no atomic multi-write) ===');
type Leg = { code: string; cents: number };
function postTransaction(graph: Graph, ref: string, legs: Leg[]): boolean {
  const sum = legs.reduce((s, l) => s + l.cents, 0);
  if (sum !== 0) {
    console.log(`  REJECT ${ref}: unbalanced by ${sum}¢ (validated in app code, pre-commit)`);
    return false;
  }
  // commit — NOT atomic: if this loop throws partway, the graph keeps the
  // vertices/edges already written.
  const t = graph.addVertex({ labels: ['Txn'], properties: { ref } });
  for (const l of legs) {
    let a = [...graph.getVerticesByLabel('Account')].find((v) => v.properties.code === l.code);
    if (!a) a = graph.addVertex({ labels: ['Account'], properties: { code: l.code } });
    graph.addEdge({ from: t, to: a, labels: ['POSTING'], properties: { cents: l.cents } });
  }
  return true;
}
const bg = new Graph();
console.log(
  'balanced   :',
  postTransaction(bg, 'T1', [
    { code: '1000', cents: 500 },
    { code: '4000', cents: -500 },
  ]),
);
console.log(
  'unbalanced :',
  postTransaction(bg, 'T2', [
    { code: '1000', cents: 500 },
    { code: '4000', cents: -400 },
  ]),
);
console.log(
  'txns committed:',
  bg.getVerticesByLabel('Txn').size,
  '(expect 1 — the unbalanced one never got a Txn node because we validate first)',
);

// Demonstrate the non-atomic hazard: a mid-commit failure leaves partial state.
console.log('\n=== NON-ATOMIC hazard: mid-commit failure leaves partial postings ===');
const hg = new Graph();
const t = hg.addVertex({ labels: ['Txn'], properties: { ref: 'T9' } });
const a1 = hg.addVertex({ labels: ['Account'], properties: { code: '1000' } });
hg.addEdge({ from: t, to: a1, labels: ['POSTING'], properties: { cents: 1000 } });
try {
  // second leg blows up (simulate: account lookup returns undefined -> addEdge with undefined `to`)
  hg.addEdge({ from: t, to: undefined as any, labels: ['POSTING'], properties: { cents: -1000 } });
} catch (e: any) {
  console.log('second leg threw:', e.code ?? e.message);
}
const bal = query(hg, 'MATCH ()-[p:POSTING]->() RETURN sum(p.cents) AS s')[0].s;
console.log(
  'graph balance after failed commit:',
  bal,
  '¢ (expect 0 for a real txn; got a dangling +1000 -> books unbalanced)',
);

console.log('\nDONE');
