/**
 * Double-entry accounting ledger on lenke (@lenke/core + @lenke/gql).
 *
 * Model:
 *   (:Account {code, name, type})
 *   (:Txn {ref, date})
 *   (:Txn)-[:POSTING {cents:int, dollars:float, side:'D'|'C'}]->(:Account)
 *
 * Sign convention: a POSTING carries signed `cents` (debit > 0, credit < 0).
 * A balanced transaction's postings sum to 0. An account balance is the sum of
 * the signed cents of its incident postings. The whole ledger sums to 0.
 *
 * We build TWO parallel amount encodings on every posting — integer `cents`
 * and IEEE-754 float `dollars` (= cents/100) — and check both against an EXACT
 * BigInt-cents ground truth computed in plain JS.
 */
import { Graph, parseDate, type LocalDate } from '@lenke/core';
import { query } from '@lenke/gql';

// ---------------------------------------------------------------------------
// Deterministic PRNG so runs are reproducible.
// ---------------------------------------------------------------------------
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
type AcctType = 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
const TYPES: AcctType[] = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

const NUM_ACCOUNTS = 200;
const NUM_TXNS = 3000;

const g = new Graph();
const accounts: { v: ReturnType<Graph['addVertex']>; code: string }[] = [];

for (let i = 0; i < NUM_ACCOUNTS; i++) {
  const type = TYPES[i % TYPES.length];
  const code = String(1000 + i);
  const v = g.addVertex({
    labels: ['Account'],
    properties: { code, name: `${type} ${code}`, type },
  });
  accounts.push({ v, code });
}

// ---------------------------------------------------------------------------
// Exact ground truth in BigInt cents, kept in lockstep as we build the graph.
// ---------------------------------------------------------------------------
const exactByAccount = new Map<string, bigint>(); // account.id -> cents
for (const a of accounts) exactByAccount.set(a.v.id, 0n);
let exactGlobal = 0n;

/** Nasty-for-float amounts: mix large magnitudes with sub-dollar cents. */
const pickAmountCents = (): bigint => {
  const dollars = randInt(1, 5000); // up to $5,000
  const cents = randInt(0, 99); // fractional part that floats hate
  return BigInt(dollars) * 100n + BigInt(cents);
};

let unbalancedRejected = 0;

for (let t = 0; t < NUM_TXNS; t++) {
  const txn = g.addVertex({
    labels: ['Txn'],
    properties: { ref: `T${t}`, date: parseDate(dateFor(t)) },
  });

  // Build a balanced set of postings: N debits, N credits, equal totals.
  const legs = randInt(1, 3);
  const postings: { acct: (typeof accounts)[number]; cents: bigint }[] = [];
  let debitTotal = 0n;
  for (let k = 0; k < legs; k++) {
    const amt = pickAmountCents();
    debitTotal += amt;
    postings.push({ acct: accounts[randInt(0, NUM_ACCOUNTS - 1)], cents: amt });
  }
  // Credit side: split debitTotal across `legs` credit accounts.
  const creditAccts = Array.from({ length: legs }, () => accounts[randInt(0, NUM_ACCOUNTS - 1)]);
  let remaining = debitTotal;
  for (let k = 0; k < legs; k++) {
    const amt = k === legs - 1 ? remaining : debitTotal / BigInt(legs);
    remaining -= amt;
    postings.push({ acct: creditAccts[k], cents: -amt });
  }

  // Balance check (exact) BEFORE writing — this is what a veto would enforce.
  const sum = postings.reduce((s, p) => s + p.cents, 0n);
  if (sum !== 0n) {
    unbalancedRejected++;
    g.removeVertex(txn);
    continue;
  }

  for (const p of postings) {
    const cents = p.cents;
    const dollars = Number(cents) / 100; // float encoding
    g.addEdge({
      from: txn,
      to: p.acct.v,
      labels: ['POSTING'],
      properties: {
        cents: Number(cents), // safe: < 2^53
        dollars,
        side: cents >= 0n ? 'D' : 'C',
      },
    });
    exactByAccount.set(p.acct.v.id, exactByAccount.get(p.acct.v.id)! + cents);
    exactGlobal += cents;
  }
}

function dateFor(t: number): string {
  // spread across 2025-01-01 .. 2025-12-31
  const day = t % 365;
  const d = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000);
  return d.toISOString().slice(0, 10);
}

console.log('=== BUILD ===');
console.log('accounts:', g.getVerticesByLabel('Account').size);
console.log('txns:', g.getVerticesByLabel('Txn').size);
console.log('postings:', g.getEdgesByLabel('POSTING').size);
console.log('unbalanced rejected:', unbalancedRejected);
console.log('exact global (cents):', exactGlobal.toString(), '(expect 0)');

// ---------------------------------------------------------------------------
// 1. GLOBAL BALANCE via GQL sum()
// ---------------------------------------------------------------------------
const globInt = query(g, 'MATCH ()-[p:POSTING]->() RETURN sum(p.cents) AS c')[0].c as number;
const globFloat = query(g, 'MATCH ()-[p:POSTING]->() RETURN sum(p.dollars) AS d')[0].d as number;
console.log('\n=== GLOBAL SUM ===');
console.log('int cents sum   :', globInt, '(exact:', exactGlobal.toString() + ')');
console.log('float dollars sum:', globFloat, '(exact: 0)');
console.log('float sum == 0 ? ', globFloat === 0);

// ---------------------------------------------------------------------------
// 2. PER-ACCOUNT BALANCES (trial balance) via GQL, compared to exact BigInt.
// ---------------------------------------------------------------------------
const intRows = query(
  g,
  'MATCH (t:Txn)-[p:POSTING]->(a:Account) RETURN a.code AS code, sum(p.cents) AS bal',
);
const floatRows = query(
  g,
  'MATCH (t:Txn)-[p:POSTING]->(a:Account) RETURN a.code AS code, sum(p.dollars) AS bal',
);

const intByCode = new Map<string, number>();
for (const r of intRows) intByCode.set(r.code as string, r.bal as number);
const floatByCode = new Map<string, number>();
for (const r of floatRows) floatByCode.set(r.code as string, r.bal as number);

const exactByCode = new Map<string, bigint>();
for (const a of accounts) exactByCode.set(a.code, exactByAccount.get(a.v.id)!);

let intMismatch = 0;
let intMaxDriftCents = 0n;
let floatMismatch = 0;
let floatMaxDriftCents = 0;
let floatTotalAbsDriftCents = 0;
for (const [code, exact] of exactByCode) {
  const iv = BigInt(intByCode.get(code) ?? 0);
  if (iv !== exact) {
    intMismatch++;
    const d = iv > exact ? iv - exact : exact - iv;
    if (d > intMaxDriftCents) intMaxDriftCents = d;
  }
  const fvDollars = floatByCode.get(code) ?? 0;
  const fvCents = Math.round(fvDollars * 100); // convert back to cents
  const exactCentsNum = Number(exact);
  const driftCents = Math.abs(fvCents - exactCentsNum);
  // also measure raw (unrounded) drift to expose sub-cent float error
  const rawDrift = Math.abs(fvDollars * 100 - exactCentsNum);
  floatTotalAbsDriftCents += rawDrift;
  if (fvCents !== exactCentsNum) {
    floatMismatch++;
    if (driftCents > floatMaxDriftCents) floatMaxDriftCents = driftCents;
  }
}

console.log('\n=== TRIAL BALANCE (per account, vs exact BigInt) ===');
console.log('accounts checked:', exactByCode.size);
console.log('INT   mismatches:', intMismatch, ' maxDrift(cents):', intMaxDriftCents.toString());
console.log(
  'FLOAT mismatches (after round):',
  floatMismatch,
  ' maxDrift(cents):',
  floatMaxDriftCents,
);
console.log('FLOAT total abs raw sub-cent drift:', floatTotalAbsDriftCents.toFixed(6), 'cents');

// ---------------------------------------------------------------------------
// 3. Does the FLOAT trial balance itself sum to zero? (double-entry integrity)
// ---------------------------------------------------------------------------
let floatTrialSum = 0;
for (const v of floatByCode.values()) floatTrialSum += v;
let intTrialSum = 0n;
for (const v of intByCode.values()) intTrialSum += BigInt(v);
console.log('\n=== TRIAL BALANCE SUMS TO ZERO? ===');
console.log('INT   trial-balance sum (cents):', intTrialSum.toString(), '(expect 0)');
console.log('FLOAT trial-balance sum (dollars):', floatTrialSum, '(expect 0)');

// ---------------------------------------------------------------------------
// 4. ACCOUNT STATEMENT over a date range (temporal) + running balance.
// ---------------------------------------------------------------------------
const someCode = accounts[0].code;
const stmt = query(
  g,
  'MATCH (t:Txn)-[p:POSTING]->(a:Account {code: $code}) ' +
    "WHERE t.`date` >= DATE '2025-01-01' AND t.`date` < DATE '2025-04-01' " +
    'RETURN t.ref AS ref, t.`date` AS dt, p.cents AS cents ORDER BY t.`date`',
  { code: someCode },
);
console.log('\n=== ACCOUNT STATEMENT (Q1 2025) for', someCode, '===');
console.log('rows:', stmt.length);
let running = 0;
for (const r of stmt.slice(0, 5)) {
  running += r.cents as number;
  console.log(
    `  ${(r.dt as LocalDate as any).toJSON?.()['@date'] ?? r.dt}  ${r.ref}  ${r.cents}  running=${running}`,
  );
}

console.log('\nDONE');
