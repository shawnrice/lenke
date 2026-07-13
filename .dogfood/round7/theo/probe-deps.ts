import { inferDeps } from '@lenke/native';

// ROUND 7 — the deps invalidation model. Does an UNDER-declared `deps` silently
// return a STALE live snapshot after a mutation? (The crown jewel.)
//
// Epoch model (from crates/lenke-core/src/graph.rs):
//   INSERT vertex -> touches its labels + all property keys
//   INSERT edge   -> touches edge type + all property keys
//   SET   x.k = v -> touches ONLY key `k` (NOT the element's labels)   <-- sharp
//   REMOVE x.k    -> touches ONLY key `k`
//   DELETE vertex -> touches its labels + every key it carried
// The store's fingerprint = sum(graph.epoch(dep) for dep in deps). If no declared
// dep's epoch moved, getSnapshot() returns the CACHED (stale) array even though
// version bumped and subscribers were notified.
import { makeDashboardStore, canonRows, LIB_PRESENT } from './dashboard.ts';

if (!LIB_PRESENT) process.exit(2);

const line = (s = '') => console.log(s);
const header = (s: string) => {
  line();
  line(`### ${s}`);
};

// ---------------------------------------------------------------------------
header('A. UNDER-declared property key: sum() goes SILENTLY STALE on in-place SET');
{
  const store = makeDashboardStore();
  const SUM = 'MATCH (o:Purchase) RETURN sum(o.amount) AS total';
  // BUG BAIT: label declared, but the property key `amount` the sum reads is NOT.
  const lq = store.liveQuery(SUM, { deps: ['Purchase'] });
  let notified = 0;
  lq.subscribe(() => {
    notified += 1;
  });

  line(`initial live  : ${canonRows(lq.getSnapshot())}`);
  store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o1'}) SET o.amount = 999"));
  const live = canonRows(lq.getSnapshot());
  const fresh = canonRows(store.graph.query(SUM));
  line(`after SET amount=999:`);
  line(`  subscriber notified? ${notified} time(s)  (version DID bump)`);
  line(`  live snapshot : ${live}`);
  line(`  fresh query   : ${fresh}`);
  line(
    `  => ${live === fresh ? 'consistent' : 'STALE — live query returned a WRONG value the UI would render'}`,
  );
  store[Symbol.dispose]();
}

// ---------------------------------------------------------------------------
header('B. Same under-declaration is SAFE for INSERT/DELETE but UNSAFE for UPDATE');
{
  const store = makeDashboardStore();
  const SUM = 'MATCH (o:Purchase) RETURN sum(o.amount) AS total';
  const lq = store.liveQuery(SUM, { deps: ['Purchase'] }); // missing 'amount'
  lq.subscribe(() => {});
  line(`start          : live=${canonRows(lq.getSnapshot())}`);

  store.mutate((g) => g.query("INSERT (:Purchase {oid: 'x', amount: 5, status: 'paid'})"));
  const afterInsert = canonRows(lq.getSnapshot());
  const freshInsert = canonRows(store.graph.query(SUM));
  line(
    `after INSERT    : live=${afterInsert} fresh=${freshInsert}  ${afterInsert === freshInsert ? '(caught: INSERT bumps the label epoch)' : 'STALE'}`,
  );

  store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'x'}) SET o.amount = 500"));
  const afterUpd = canonRows(lq.getSnapshot());
  const freshUpd = canonRows(store.graph.query(SUM));
  line(
    `after SET       : live=${afterUpd} fresh=${freshUpd}  ${afterUpd === freshUpd ? '(ok)' : 'STALE: UPDATE only bumps the amount epoch, which is NOT in deps'}`,
  );
  line('=> under-declaring a property key hides UNTIL the first in-place update — a latent trap.');
  store[Symbol.dispose]();
}

// ---------------------------------------------------------------------------
header('C. UNDER-declared edge type: an edge-driven live query stales on new edge');
{
  const store = makeDashboardStore();
  store.mutate((g) => {
    g.query(
      "MATCH (o:Purchase {oid: 'o1'}), (i:Item {sku: 'P1'}) INSERT (o)-[:CONTAINS {qty: 2}]->(i)",
    );
  });
  const Q = 'MATCH (:Purchase)-[c:CONTAINS]->(:Item) RETURN count(*) AS lines';
  // BUG BAIT: vertex labels declared, edge type CONTAINS omitted.
  const lq = store.liveQuery(Q, { deps: ['Purchase', 'Item'] });
  lq.subscribe(() => {});
  line(`start          : live=${canonRows(lq.getSnapshot())}`);
  store.mutate((g) => {
    g.query(
      "MATCH (o:Purchase {oid: 'o2'}), (i:Item {sku: 'P2'}) INSERT (o)-[:CONTAINS {qty: 1}]->(i)",
    );
  });
  const live = canonRows(lq.getSnapshot());
  const fresh = canonRows(store.graph.query(Q));
  line(
    `after new edge : live=${live} fresh=${fresh}  ${live === fresh ? '(ok)' : 'STALE: INSERT edge bumps only the CONTAINS type epoch (+edge keys), never the vertex labels'}`,
  );
  store[Symbol.dispose]();
}

// ---------------------------------------------------------------------------
header('D. Does inferDeps() protect these queries? (over-grab is safe)');
{
  const qs = [
    'MATCH (o:Purchase) RETURN sum(o.amount) AS total',
    "MATCH (o:Purchase) WHERE o.status = 'paid' RETURN sum(o.amount) AS r",
    'MATCH (:Purchase)-[c:CONTAINS]->(:Item) RETURN count(*) AS lines',
    'MATCH (o:Purchase) RETURN o.category AS category, sum(o.amount) AS revenue ORDER BY category',
    'MATCH (o:Purchase) RETURN count(*) AS n',
  ];
  for (const q of qs) {
    line(`inferDeps: ${JSON.stringify(inferDeps(q))}`);
    line(`   for: ${q}`);
  }
  line(
    '=> inferDeps grabs :Label / :TYPE and .key tokens. Check each covers what the query reads.',
  );
}

// ---------------------------------------------------------------------------
header('E. Over-declared deps: correct, but pays extra recomputes');
{
  const store = makeDashboardStore();
  const Q = 'MATCH (o:Purchase) RETURN count(*) AS n';
  // over-declares `amount` and an unrelated `Item` label the query never reads.
  const lq = store.liveQuery(Q, { deps: ['Purchase', 'amount', 'Item', 'status', 'category'] });
  lq.subscribe(() => {});
  let s = lq.getSnapshot();
  const recomputes = () => {
    const n = lq.getSnapshot();
    const changed = n !== s;
    s = n;
    return changed;
  };
  recomputes();
  store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o1'}) SET o.amount = 111"));
  line(
    `SET amount (result unchanged: count is ${canonRows(lq.getSnapshot())}) -> recomputed? ${recomputes()}  (over-declared 'amount' forced a needless recompute)`,
  );
  store.mutate((g) => g.query("INSERT (:Item {sku: 'ZZ', name: 'x', category: 'c'})"));
  line(
    `INSERT unrelated Item -> recomputed? ${recomputes()}  (over-declared 'Item' forced a needless recompute)`,
  );
  line('=> over-declaring is always CORRECT, just wasteful. Prefer it to under-declaring.');
  store[Symbol.dispose]();
}
