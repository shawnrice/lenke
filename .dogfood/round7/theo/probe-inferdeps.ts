import { inferDeps } from '@lenke/native';

// ROUND 7 — does the recommended inferDeps() helper UNDER-grab, so a user who
// trusts it gets silently-stale live queries? The regex matches `.key` and
// `:Label`, but an inline-map filter `{status: 'paid'}` in a MATCH pattern has
// NO dot — so its key is missed. Deps then omit a key the query filters on.
import { makeDashboardStore, canonRows, LIB_PRESENT } from './dashboard.ts';

if (!LIB_PRESENT) process.exit(2);
const line = (s = '') => console.log(s);

// A perfectly reasonable query using the inline-map property filter form.
const Q = "MATCH (o:Purchase {status: 'paid'}) RETURN count(*) AS paidOrders";
const deps = inferDeps(Q);
line(`query    : ${Q}`);
line(`inferDeps: ${JSON.stringify(deps)}   <- does it include 'status'?`);
line();

const store = makeDashboardStore();
// The user does exactly what the README suggests: derive deps with inferDeps.
const lq = store.liveQuery(Q, { deps });
lq.subscribe(() => {});
line(`initial live : ${canonRows(lq.getSnapshot())}  (o1,o3 are paid => 2)`);

// Flip a pending order to paid — an in-place SET, bumps only epoch('status').
store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o2'}) SET o.status = 'paid'"));
const live = canonRows(lq.getSnapshot());
const fresh = canonRows(store.graph.query(Q));
line(`after o2 -> paid:`);
line(`  live  : ${live}`);
line(`  fresh : ${fresh}`);
line(
  `  => ${live === fresh ? 'consistent' : "STALE — inferDeps under-grabbed 'status' (inline-map key has no dot)"}`,
);

// And the mirror: a paid order leaving the set.
store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o1'}) SET o.status = 'refunded'"));
const live2 = canonRows(lq.getSnapshot());
const fresh2 = canonRows(store.graph.query(Q));
line(`after o1 -> refunded:`);
line(`  live  : ${live2}  fresh : ${fresh2}  => ${live2 === fresh2 ? 'consistent' : 'STALE'}`);
store[Symbol.dispose]();
