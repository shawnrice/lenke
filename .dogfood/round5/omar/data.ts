import { Graph } from '@lenke/core';

// Deterministic seeded RNG (mulberry32) so runs are reproducible and
// independently verifiable in plain JS.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Dataset {
  g: Graph;
  // raw arrays for independent verification
  users: { id: string; name: string }[];
  items: { id: string; name: string; categoryId: string }[];
  categories: { id: string; name: string }[];
  // interaction tuples (by string id)
  purchased: { user: string; item: string; weight: number }[];
  viewed: { user: string; item: string; weight: number }[];
  rated: { user: string; item: string; rating: number }[];
  // handy maps id->vertexId in graph
  userVid: Map<string, ReturnType<Graph['addVertex']>>;
  itemVid: Map<string, ReturnType<Graph['addVertex']>>;
}

export function buildDataset(opts?: {
  users?: number;
  items?: number;
  categories?: number;
  seed?: number;
}): Dataset {
  const nUsers = opts?.users ?? 2000;
  const nItems = opts?.items ?? 500;
  const nCats = opts?.categories ?? 20;
  const rand = rng(opts?.seed ?? 12345);

  const g = new Graph();

  const categories = Array.from({ length: nCats }, (_, i) => ({
    id: `c${i}`,
    name: `Category ${i}`,
  }));
  const catVid = new Map<string, ReturnType<Graph['addVertex']>>();
  for (const c of categories) {
    catVid.set(
      c.id,
      g.addVertex({ labels: ['Category'], properties: { cid: c.id, name: c.name } }),
    );
  }

  const items = Array.from({ length: nItems }, (_, i) => {
    const categoryId = `c${Math.floor(rand() * nCats)}`;
    return { id: `i${i}`, name: `Item ${i}`, categoryId };
  });
  const itemVid = new Map<string, ReturnType<Graph['addVertex']>>();
  for (const it of items) {
    const v = g.addVertex({ labels: ['Item'], properties: { iid: it.id, name: it.name } });
    itemVid.set(it.id, v);
    g.addEdge({ from: v, to: catVid.get(it.categoryId)!, labels: ['IN_CATEGORY'], properties: {} });
  }

  const users = Array.from({ length: nUsers }, (_, i) => ({ id: `u${i}`, name: `User ${i}` }));
  const userVid = new Map<string, ReturnType<Graph['addVertex']>>();
  for (const u of users) {
    userVid.set(u.id, g.addVertex({ labels: ['User'], properties: { uid: u.id, name: u.name } }));
  }

  // Give items a popularity skew (Zipf-ish): lower-index items are more popular.
  const popularity = items.map((_, idx) => 1 / (idx + 1));
  const popSum = popularity.reduce((a, b) => a + b, 0);
  const cumPop: number[] = [];
  let acc = 0;
  for (const p of popularity) {
    acc += p / popSum;
    cumPop.push(acc);
  }
  const pickItem = () => {
    const r = rand();
    // binary search
    let lo = 0,
      hi = cumPop.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumPop[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return items[lo];
  };

  const purchased: Dataset['purchased'] = [];
  const viewed: Dataset['viewed'] = [];
  const rated: Dataset['rated'] = [];
  // dedup guards: at most one PURCHASED edge per (user,item)
  const pset = new Set<string>();
  const vset = new Set<string>();
  const rset = new Set<string>();

  for (const u of users) {
    // each user purchases between 3 and 25 distinct items
    const nP = 3 + Math.floor(rand() * 23);
    for (let k = 0; k < nP; k++) {
      const it = pickItem();
      const key = `${u.id}|${it.id}`;
      if (pset.has(key)) continue;
      pset.add(key);
      const weight = 1 + Math.floor(rand() * 5); // quantity 1..5
      purchased.push({ user: u.id, item: it.id, weight });
      g.addEdge({
        from: userVid.get(u.id)!,
        to: itemVid.get(it.id)!,
        labels: ['PURCHASED'],
        properties: { weight },
      });
    }
    // views (superset-ish, more of them)
    const nV = 5 + Math.floor(rand() * 30);
    for (let k = 0; k < nV; k++) {
      const it = pickItem();
      const key = `${u.id}|${it.id}`;
      if (vset.has(key)) continue;
      vset.add(key);
      const weight = 1 + Math.floor(rand() * 10);
      viewed.push({ user: u.id, item: it.id, weight });
      g.addEdge({
        from: userVid.get(u.id)!,
        to: itemVid.get(it.id)!,
        labels: ['VIEWED'],
        properties: { weight },
      });
    }
    // ratings only for a subset of purchased items
    for (const p of purchased.filter((p) => p.user === u.id)) {
      if (rand() < 0.5) continue;
      const key = `${u.id}|${p.item}`;
      if (rset.has(key)) continue;
      rset.add(key);
      const rating = 1 + Math.floor(rand() * 5); // 1..5
      rated.push({ user: u.id, item: p.item, rating });
      g.addEdge({
        from: userVid.get(u.id)!,
        to: itemVid.get(p.item)!,
        labels: ['RATED'],
        properties: { rating },
      });
    }
  }

  return {
    g,
    users,
    items,
    categories,
    purchased,
    viewed,
    rated,
    userVid,
    itemVid,
  };
}
