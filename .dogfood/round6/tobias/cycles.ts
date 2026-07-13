// Cycle detection + weighted cost accumulation.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  toArray,
  traversal,
  V,
  has,
  out,
  outE,
  inV,
  path,
  values,
  repeat,
  cyclicPath,
  simplePath,
  both,
} from '@lenke/gremlin';

// Small directed graph WITH cycles. a->b->c->a (cycle), c->d, d->e, e->d (2-cycle), f isolated-ish
const g = new Graph();
const V_ = (n: string) => g.addVertex({ labels: ['P'], properties: { name: n } });
const nodes: Record<string, any> = {};
for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) nodes[n] = V_(n);
const edges: [string, string, number][] = [
  ['a', 'b', 3],
  ['b', 'c', 2],
  ['c', 'a', 5], // 3-cycle a-b-c
  ['c', 'd', 1],
  ['d', 'e', 4],
  ['e', 'd', 2], // 2-cycle d-e
  ['f', 'a', 1],
];
const adj = new Map<string, { to: string; w: number }[]>();
for (const n of Object.keys(nodes)) adj.set(n, []);
for (const [s, d, w] of edges) {
  g.addEdge({ from: nodes[s], to: nodes[d], labels: ['E'], properties: { w } });
  adj.get(s)!.push({ to: d, w });
}

// JS reference: is a node on a directed cycle? (Tarjan-ish via DFS from node back to itself)
function onCycle(start: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  let first = true;
  while (stack.length) {
    const u = stack.pop()!;
    if (!first && u === start) return true;
    first = false;
    if (seen.has(u)) continue;
    seen.add(u);
    for (const { to } of adj.get(u) ?? []) {
      if (to === start) return true;
      stack.push(to);
    }
  }
  return false;
}

console.log('=== Cycle membership (is X on a directed cycle?) ===');
for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) {
  const ref = onCycle(n);
  // Gremlin: repeat(out).until(cyclicPath()).path(); on-cycle iff a returned path has first===last
  const cyclesG = toArray(
    traversal(V(), has('name', n), repeat(out('E')).until(cyclicPath()).times(20), path()),
    g,
  ) as any[][];
  const gremOn = cyclesG.some((p) => p[0] === p.at(-1));
  console.log(
    `${n}: ref=${ref} gremlin=${gremOn} [${ref === gremOn ? 'OK' : 'MISMATCH'}]  (cyclicPath hits=${cyclesG.length})`,
  );
}

console.log('\n=== GQL cycle detection probe ===');
for (const q of [
  // self-return via bounded var-length: does a path of length k return to start?
  `MATCH (a:P {name:'a'})-[:E]->{1,6}(a) RETURN count(*) AS c`,
  `MATCH (a:P {name:'f'})-[:E]->{1,6}(f2:P {name:'f'}) RETURN count(*) AS c`,
]) {
  try {
    const r = query(g, q);
    console.log('OK :', q.replace(/\s+/g, ' ').slice(0, 60), '->', JSON.stringify(r[0]));
  } catch (e) {
    console.log('ERR:', q.slice(0, 50), '->', (e as Error).message.slice(0, 60));
  }
}
// verify GQL self-return count vs ref
{
  // number of a->...->a walks of length 1..6. a-b-c-a is len 3; a-b-c-a-b-c-a len 6. => 2
  const r = query(g, `MATCH (a:P {name:'a'})-[:E]->{1,6}(a) RETURN count(*) AS c`);
  console.log('  GQL a->a walks(1..6):', r[0].c, '(expected 2: len3 and len6)');
}

console.log('\n=== Weighted cost accumulation along a path (probe the ceiling) ===');
// path a->b->c->d, weights 3+2+1 = 6. Directed.
// JS ref weighted path cost for the simple directed path a->b->c->d
function pathCost(seq: string[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < seq.length; i++)
    sum += (adj.get(seq[i]) ?? []).find((e) => e.to === seq[i + 1])!.w;
  return sum;
}
console.log('ref cost a->b->c->d =', pathCost(['a', 'b', 'c', 'd']));

// Gremlin: can we sum edge weights along a traversal? path() with outE/inV includes edge elements.
try {
  const paths = toArray(
    traversal(
      V(),
      has('name', 'a'),
      outE('E'),
      inV(),
      outE('E'),
      inV(),
      outE('E'),
      inV(),
      has('name', 'd'),
      path(),
    ),
    g,
  ) as any[][];
  for (const p of paths) {
    const edgeW = p
      .filter((el: any) => typeof el?.properties?.w === 'number' && el.from)
      .map((el: any) => el.properties.w);
    // fallback: edges are objects w/ from/to; sum all numeric w on edge-like elements
    const ws = p
      .filter((el: any) => el && el.from !== undefined && el.to !== undefined)
      .map((el: any) => el.properties.w);
    console.log(
      '  gremlin path elems:',
      p.map((el: any) => el.properties?.name ?? `[e:w=${el.properties?.w}]`).join(' '),
      '=> sum',
      ws.reduce((a: number, b: number) => a + b, 0),
    );
  }
} catch (e) {
  console.log('  outE/inV path ERR:', (e as Error).message.slice(0, 80));
}

// Can a single traversal RETURN the summed cost? Try map over path via sack-substitute.
// Gremlin has no sack (known). Probe: is there any in-traversal accumulator? Try project+path+manual.
console.log('\n=== GQL: sum edge weights along fixed path ===');
try {
  const r = query(
    g,
    `MATCH (a:P {name:'a'})-[r1:E]->(b)-[r2:E]->(c)-[r3:E]->(d:P {name:'d'}) RETURN r1.w + r2.w + r3.w AS cost`,
  );
  console.log('  GQL fixed-length edge-weight sum:', JSON.stringify(r));
} catch (e) {
  console.log('  GQL ERR:', (e as Error).message.slice(0, 80));
}
console.log('\n=== GQL: sum edge weights along VARIABLE-length path (the real question) ===');
try {
  const r = query(g, `MATCH (a:P {name:'a'})-[r:E]->+(d:P {name:'d'}) RETURN r`);
  console.log('  GQL var-length edge binding:', JSON.stringify(r).slice(0, 120));
} catch (e) {
  console.log('  GQL ERR:', (e as Error).message.slice(0, 90));
}
