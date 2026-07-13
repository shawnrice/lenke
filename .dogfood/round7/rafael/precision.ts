/**
 * Precision crucible: prove where float-dollars loses money vs exact BigInt cents.
 * Everything is checked through GQL sum()/arithmetic (the engine), not just JS.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

let seed = 12345;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// EXPERIMENT A: can GQL sum(dollars), rounded to cents, disagree with exact
// BigInt cents on a single hot account? Scale magnitude + count until it breaks.
// ---------------------------------------------------------------------------
function trial(
  nPostings: number,
  maxDollars: number,
): {
  exactCents: bigint;
  gqlFloatDollars: number;
  gqlIntCents: number;
  roundedFloatCents: number;
  wrongCent: boolean;
  rawDriftCents: number;
} {
  const g = new Graph();
  const acct = g.addVertex({ labels: ['A'], properties: {} });
  const txn = g.addVertex({ labels: ['T'], properties: {} });
  let exact = 0n;
  for (let i = 0; i < nPostings; i++) {
    const dollars = ri(1, maxDollars);
    const cents = ri(0, 99);
    const signed = (i % 2 === 0 ? 1n : -1n) * (BigInt(dollars) * 100n + BigInt(cents));
    exact += signed;
    g.addEdge({
      from: txn,
      to: acct,
      labels: ['P'],
      properties: { cents: Number(signed), dollars: Number(signed) / 100 },
    });
  }
  const gqlFloatDollars = query(g, 'MATCH ()-[p:P]->() RETURN sum(p.dollars) AS s')[0].s as number;
  const gqlIntCents = query(g, 'MATCH ()-[p:P]->() RETURN sum(p.cents) AS s')[0].s as number;
  const roundedFloatCents = Math.round(gqlFloatDollars * 100);
  return {
    exactCents: exact,
    gqlFloatDollars,
    gqlIntCents,
    roundedFloatCents,
    wrongCent: BigInt(roundedFloatCents) !== exact,
    rawDriftCents: Math.abs(gqlFloatDollars * 100 - Number(exact)),
  };
}

console.log('=== EXPERIMENT A: force a wrong rounded-cent balance ===');
console.log(
  'nPostings  maxDollars   exactCents        floatRoundCents   intCents   rawDrift(cents)  WRONG?',
);
let firstWrong: any = null;
for (const [n, maxD] of [
  [10_000, 5_000],
  [100_000, 50_000],
  [200_000, 1_000_000],
  [500_000, 10_000_000],
  [1_000_000, 100_000_000],
  [2_000_000, 1_000_000_000],
  [4_000_000, 10_000_000_000],
] as const) {
  const r = trial(n, maxD);
  console.log(
    `${String(n).padEnd(10)} ${String(maxD).padEnd(12)} ${r.exactCents.toString().padEnd(17)} ${String(r.roundedFloatCents).padEnd(17)} ${String(r.gqlIntCents).padEnd(10)} ${r.rawDriftCents.toFixed(4).padEnd(16)} ${r.wrongCent}`,
  );
  if (r.wrongCent && !firstWrong) firstWrong = { n, maxD, ...r };
  // sanity: int cents must ALWAYS be exact
  if (BigInt(r.gqlIntCents) !== r.exactCents) {
    console.log(
      '  !!! INT CENTS ALSO WRONG at n=',
      n,
      ' (integer overflow?) exact=',
      r.exactCents.toString(),
    );
  }
}
if (firstWrong) {
  console.log(
    `\n>>> FLOAT PRODUCED A WRONG CENT: at ${firstWrong.n} postings / $${firstWrong.maxD} max, ` +
      `float balance = ${firstWrong.roundedFloatCents}¢ but exact = ${firstWrong.exactCents}¢ ` +
      `(off by ${Number(firstWrong.exactCents) - firstWrong.roundedFloatCents}¢)`,
  );
} else {
  console.log(
    '\n>>> Float sum, rounded, stayed correct across these scales (raw drift shown above).',
  );
}

// ---------------------------------------------------------------------------
// EXPERIMENT B: float ARITHMETIC inside GQL corrupts real accounting math.
// ---------------------------------------------------------------------------
console.log('\n=== EXPERIMENT B: GQL float arithmetic (tax / extended price) ===');
const g2 = new Graph();
// An invoice line: qty=3, unitPrice=$0.10  => extended should be $0.30 exactly.
g2.addVertex({ labels: ['Line'], properties: { qty: 3, px: 0.1, amt: 19.99, rate: 0.0825 } });
const bTests = [
  ['0.1 + 0.2', 'RETURN 0.1 + 0.2 AS x'],
  ['qty * px (3 * 0.10)', 'MATCH (l:Line) RETURN l.qty * l.px AS x'],
  ['tax 19.99 * 0.0825', 'MATCH (l:Line) RETURN l.amt * l.rate AS x'],
  ['19.99*0.0825*100 (cents)', 'MATCH (l:Line) RETURN l.amt * l.rate * 100 AS x'],
];
for (const [label, q] of bTests) {
  const x = query(g2, q)[0].x;
  console.log(`  ${label.padEnd(28)} => ${x}`);
}

// ---------------------------------------------------------------------------
// EXPERIMENT C: the double-entry ZERO-SUM invariant under float.
// A perfectly balanced ledger: does GQL sum(dollars) == 0?
// ---------------------------------------------------------------------------
console.log('\n=== EXPERIMENT C: zero-sum invariant under float ===');
const g3 = new Graph();
const a3 = g3.addVertex({ labels: ['A'], properties: {} });
const t3 = g3.addVertex({ labels: ['T'], properties: {} });
let exact3 = 0n;
for (let i = 0; i < 20_000; i++) {
  const cents = BigInt(ri(1, 100_000)); // up to $1000
  const signed = i % 2 === 0 ? cents : -cents;
  exact3 += signed;
  g3.addEdge({
    from: t3,
    to: a3,
    labels: ['P'],
    properties: { cents: Number(signed), dollars: Number(signed) / 100 },
  });
}
// make it exactly balanced by appending the negation of the running exact
const fix = -exact3;
g3.addEdge({
  from: t3,
  to: a3,
  labels: ['P'],
  properties: { cents: Number(fix), dollars: Number(fix) / 100 },
});
const zInt = query(g3, 'MATCH ()-[p:P]->() RETURN sum(p.cents) AS s')[0].s as number;
const zFloat = query(g3, 'MATCH ()-[p:P]->() RETURN sum(p.dollars) AS s')[0].s as number;
console.log('  balanced ledger, 20001 postings');
console.log('  int   sum(cents)   =', zInt, ' -> == 0 ?', zInt === 0);
console.log('  float sum(dollars) =', zFloat, ' -> == 0 ?', zFloat === 0);
console.log(
  '  A naive integrity check `sum(dollars) <> 0` would',
  zFloat !== 0 ? 'FALSE-ALARM on a correct ledger.' : 'pass.',
);

console.log('\nDONE');
