// ROUND 7 — live-query correctness under a stream of mutations, CORRECT deps.
//
// Sets up several live aggregations with correctly-declared deps, then applies
// dozens of insert/update/delete mutations, asserting after EACH that every
// live snapshot equals a fresh one-shot query. Exit code != 0 on any staleness.
import { makeDashboardStore, expectLiveEqualsFresh, LIB_PRESENT } from './dashboard.ts';

if (!LIB_PRESENT) {
  console.error('liblenke_core.so missing — run `bun run build:rust` first.');
  process.exit(2);
}

const store = makeDashboardStore();

// --- The dashboard's live queries, with CORRECT deps -----------------------
// Revenue by category (groups by category, sums amount) — touches Order label,
// category key, amount key.
const REVENUE =
  'MATCH (o:Purchase) RETURN o.category AS category, sum(o.amount) AS revenue ORDER BY category';
const revenue = store.liveQuery(REVENUE, { deps: ['Purchase', 'category', 'amount'] });

// Order count by status.
const BY_STATUS = 'MATCH (o:Purchase) RETURN o.status AS status, count(*) AS n ORDER BY status';
const byStatus = store.liveQuery(BY_STATUS, { deps: ['Purchase', 'status'] });

// Top products by revenue-in-category (a scalar total).
const TOTAL = 'MATCH (o:Purchase) RETURN sum(o.amount) AS total, count(*) AS orders';
const total = store.liveQuery(TOTAL, { deps: ['Purchase', 'amount'] });

// Paid-only revenue (filter on status).
const PAID = "MATCH (o:Purchase) WHERE o.status = 'paid' RETURN sum(o.amount) AS paidRevenue";
const paid = store.liveQuery(PAID, { deps: ['Purchase', 'status', 'amount'] });

const checks: Array<[typeof revenue, string]> = [
  [revenue, REVENUE],
  [byStatus, BY_STATUS],
  [total, TOTAL],
  [paid, PAID],
];

// keep subscriptions live (as a React tree would)
const unsubs = checks.map(([lq]) => lq.subscribe(() => {}));

let failures = 0;
let step = 0;
const checkAll = (note: string) => {
  step += 1;
  let anyFail = false;
  for (const [lq, text] of checks) {
    const r = expectLiveEqualsFresh(store, lq, text, undefined, `${note}`);
    if (!r.ok) {
      anyFail = true;
      failures += 1;
    }
  }
  console.log(`step ${String(step).padStart(2)} ${anyFail ? 'FAIL' : 'ok  '}  ${note}`);
};

// prime
checkAll('initial');

// --- The mutation stream ----------------------------------------------------
const M = (q: string) => store.mutate((g) => g.query(q));

// 1. inserts (new orders across categories/statuses)
M("INSERT (:Purchase {oid: 'o4', category: 'books', amount: 45, status: 'pending'})");
checkAll('insert o4 books/pending');
M("INSERT (:Purchase {oid: 'o5', category: 'toys', amount: 20, status: 'paid'})");
checkAll('insert o5 toys/paid (new category)');
M("INSERT (:Purchase {oid: 'o6', category: 'gadgets', amount: 200, status: 'paid'})");
checkAll('insert o6 gadgets/paid');

// 2. in-place amount updates (the sharp case: SET only bumps the key epoch)
M("MATCH (o:Purchase {oid: 'o1'}) SET o.amount = 175");
checkAll('update o1.amount 100->175');
M("MATCH (o:Purchase {oid: 'o3'}) SET o.amount = 33");
checkAll('update o3.amount 30->33');

// 3. status transitions (moves rows between groups)
M("MATCH (o:Purchase {oid: 'o2'}) SET o.status = 'paid'");
checkAll('update o2.status pending->paid');
M("MATCH (o:Purchase {oid: 'o4'}) SET o.status = 'cancelled'");
checkAll('update o4.status pending->cancelled');

// 4. category re-assignment (moves rows between revenue groups)
M("MATCH (o:Purchase {oid: 'o5'}) SET o.category = 'gadgets'");
checkAll('update o5.category toys->gadgets');

// 5. deletes
M("MATCH (o:Purchase {oid: 'o6'}) DETACH DELETE o");
checkAll('delete o6');
M("MATCH (o:Purchase {oid: 'o1'}) DETACH DELETE o");
checkAll('delete o1');

// 6. REMOVE a property (null-first-class: REMOVE, not SET null) — amount gone
M("MATCH (o:Purchase {oid: 'o2'}) REMOVE o.amount");
checkAll('remove o2.amount');

// 7. re-add amount via SET
M("MATCH (o:Purchase {oid: 'o2'}) SET o.amount = 60");
checkAll('re-set o2.amount = 60');

// 8. a rapid burst of amount updates in a single mutate (batched)
store.mutate((g) => {
  g.query("MATCH (o:Purchase {oid: 'o2'}) SET o.amount = 61");
  g.query("MATCH (o:Purchase {oid: 'o3'}) SET o.amount = 34");
  g.query("INSERT (:Purchase {oid: 'o7', category: 'books', amount: 12, status: 'paid'})");
});
checkAll('batched: two updates + one insert in one mutate()');

// 9. a no-op mutate (read only) must not break snapshots
store.mutate((g) => g.query('MATCH (o:Purchase) RETURN count(*) AS c'));
checkAll('read-only mutate (no version bump)');

// 10. delete everything of a category then re-check
M("MATCH (o:Purchase) WHERE o.category = 'books' DETACH DELETE o");
checkAll('delete all books orders');

for (const u of unsubs) u();
store[Symbol.dispose]();

console.log('\n==================================================');
console.log(
  failures === 0
    ? `PASS — all ${step} steps: live === fresh for every query (CORRECT deps)`
    : `FAIL — ${failures} stale snapshot(s) across ${step} steps`,
);
process.exit(failures === 0 ? 0 : 1);
