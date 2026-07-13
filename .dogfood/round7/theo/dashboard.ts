// Shared harness for the round-7 live-query analytics dashboard dogfood.
//
// Builds an Order/LineItem/Product graph, a reactive store over it, and helpers
// to (a) run a FRESH one-shot query and (b) compare a live snapshot to it. The
// whole point: after every mutation, `live.getSnapshot()` must equal a fresh
// `graph.query(...)` for the SAME text+params — byte for byte.
import { existsSync } from 'node:fs';

import { createEmptyGraph, type QueryParams, type Row } from '@lenke/native';
import { createStore, type Store } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';

const LIB = new URL('../../../crates/lenke-core/target/release/liblenke_core.so', import.meta.url)
  .pathname;

export const LIB_PRESENT = existsSync(LIB);

/** A blank store with a handful of Order vertices and a couple of Products. */
export const makeDashboardStore = (): Store => {
  const backend = createFfiBackend(LIB);
  const g = createEmptyGraph(backend);
  const store = createStore(g);

  store.mutate((graph) => {
    // Products
    graph.query("INSERT (:Item {sku: 'P1', name: 'Widget', category: 'gadgets'})");
    graph.query("INSERT (:Item {sku: 'P2', name: 'Gizmo', category: 'gadgets'})");
    graph.query("INSERT (:Item {sku: 'P3', name: 'Novel', category: 'books'})");
    // Orders: category + amount + status live directly on the Order for simple aggs.
    graph.query("INSERT (:Purchase {oid: 'o1', category: 'gadgets', amount: 100, status: 'paid'})");
    graph.query(
      "INSERT (:Purchase {oid: 'o2', category: 'gadgets', amount: 50, status: 'pending'})",
    );
    graph.query("INSERT (:Purchase {oid: 'o3', category: 'books', amount: 30, status: 'paid'})");
  });

  return store;
};

/** Deterministic, order-independent JSON for comparing row sets. */
export const canonRows = (rows: readonly Row[]): string => {
  const norm = rows.map((r) =>
    JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))),
  );
  norm.sort();
  return `[${norm.join(',')}]`;
};

/** Assert a live snapshot equals a fresh one-shot query for the same text/params. */
export const expectLiveEqualsFresh = (
  store: Store,
  live: { getSnapshot: () => Row[] },
  text: string,
  params: QueryParams | undefined,
  label: string,
): { ok: boolean; live: string; fresh: string } => {
  const snap = live.getSnapshot();
  const fresh = store.graph.query(text, params);
  const a = canonRows(snap);
  const b = canonRows(fresh);
  const ok = a === b;
  if (!ok) {
    console.log(`  ✗ STALE [${label}]`);
    console.log(`      live : ${a}`);
    console.log(`      fresh: ${b}`);
  }
  return { ok, live: a, fresh: b };
};
