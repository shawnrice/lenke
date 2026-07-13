// Build a realistic weighted directed network + independent JS reference algorithms.
import { Graph } from '@lenke/core';

export interface Net {
  g: Graph;
  // adjacency: nodeName -> [{to, w}]
  adj: Map<string, { to: string; w: number }[]>;
  names: string[];
  idOf: Map<string, string>; // name -> vertex id
}

// Deterministic PRNG so runs are reproducible.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A GRID DAG: node r_c. Edges go right (c->c+1) and down (r->r+1). Pure DAG => easy to verify.
// Plus optional "shortcut" and "back" edges we add explicitly for cycle/weight probing.
export function buildGrid(rows: number, cols: number, seed = 42): Net {
  const g = new Graph();
  const rand = mulberry32(seed);
  const idOf = new Map<string, string>();
  const vtx = new Map<string, any>();
  const names: string[] = [];
  const adj = new Map<string, { to: string; w: number }[]>();

  const name = (r: number, c: number) => `n_${r}_${c}`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nm = name(r, c);
      const v = g.addVertex({ labels: ['Node'], properties: { name: nm, row: r, col: c } });
      idOf.set(nm, v.id);
      vtx.set(nm, v);
      names.push(nm);
      adj.set(nm, []);
    }
  }

  const link = (fromN: string, toN: string, w: number, label = 'ROAD') => {
    g.addEdge({
      from: vtx.get(fromN),
      to: vtx.get(toN),
      labels: [label],
      properties: { w, cost: w },
    });
    adj.get(fromN)!.push({ to: toN, w });
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nm = name(r, c);
      if (c + 1 < cols) link(nm, name(r, c + 1), 1 + Math.floor(rand() * 9));
      if (r + 1 < rows) link(nm, name(r + 1, c), 1 + Math.floor(rand() * 9));
    }
  }

  return { g, adj, names, idOf };
}

// ---- Independent reference algorithms (plain JS over `adj`) ----

// BFS hop-count shortest path length; returns Infinity if unreachable.
export function bfsHops(adj: Net['adj'], src: string, dst: string): number {
  if (src === dst) return 0;
  const seen = new Set([src]);
  let frontier = [src];
  let hops = 0;
  while (frontier.length) {
    hops++;
    const next: string[] = [];
    for (const u of frontier) {
      for (const { to } of adj.get(u) ?? []) {
        if (to === dst) return hops;
        if (!seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

// All nodes reachable from src within maxHops (inclusive), EXCLUDING src itself.
export function reachableWithin(adj: Net['adj'], src: string, maxHops: number): Set<string> {
  const dist = new Map([[src, 0]]);
  let frontier = [src];
  let hops = 0;
  while (frontier.length && hops < maxHops) {
    hops++;
    const next: string[] = [];
    for (const u of frontier) {
      for (const { to } of adj.get(u) ?? []) {
        if (!dist.has(to)) {
          dist.set(to, hops);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  const out = new Set(dist.keys());
  out.delete(src);
  return out;
}

// All reachable nodes (unbounded), excluding src.
export function reachableAll(adj: Net['adj'], src: string): Set<string> {
  const seen = new Set([src]);
  const stack = [src];
  while (stack.length) {
    const u = stack.pop()!;
    for (const { to } of adj.get(u) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  seen.delete(src);
  return seen;
}

// Dijkstra weighted shortest cost; Infinity if unreachable.
export function dijkstra(adj: Net['adj'], src: string, dst: string): number {
  const dist = new Map<string, number>([[src, 0]]);
  const visited = new Set<string>();
  while (true) {
    // pick unvisited min (small graph, linear scan is fine)
    let u: string | null = null;
    let best = Infinity;
    for (const [k, d] of dist) {
      if (!visited.has(k) && d < best) {
        best = d;
        u = k;
      }
    }
    if (u === null) break;
    if (u === dst) return best;
    visited.add(u);
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) dist.set(to, nd);
    }
  }
  return dist.get(dst) ?? Infinity;
}

// Count all distinct simple paths from src to dst (DAG => all paths are simple).
export function countPaths(adj: Net['adj'], src: string, dst: string): number {
  const memo = new Map<string, number>();
  const go = (u: string): number => {
    if (u === dst) return 1;
    if (memo.has(u)) return memo.get(u)!;
    let total = 0;
    for (const { to } of adj.get(u) ?? []) total += go(to);
    memo.set(u, total);
    return total;
  };
  return go(src);
}
