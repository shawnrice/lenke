// Build/dependency impact-analysis over a lenke @lenke/core Graph, queried with
// @lenke/gremlin fluent traversals.
//
// Model: each package is a vertex (:PACKAGE {name}); an edge A -[:DEPENDS_ON]-> B
// means "A depends on B" (A's build consumes B). Therefore:
//   - "what breaks if I change X"  = X's transitive DEPENDENTS = walk INCOMING edges (in_)
//   - "what X needs to build"      = X's transitive DEPENDENCIES = walk OUTGOING edges (out)
//
// Run: bun impact.ts
import { Graph, type Vertex } from '@lenke/core';
import {
  bind,
  pipe,
  traversal,
  V,
  has,
  out,
  in_,
  outE,
  inV,
  where,
  within,
  repeat,
  path,
  dedupe,
  values,
  cyclicPath,
  shortestPath,
  ShortestPath,
  subgraph,
  cap,
  count,
} from '@lenke/gremlin';

// ---------------------------------------------------------------------------
// 1. Build a realistic ~20-node dependency graph, WITH a deliberate cycle.
// ---------------------------------------------------------------------------
const g = new Graph();

const pkgNames = [
  'core', 'logger', 'config', 'utils', 'errors',
  'http-client', 'db-driver', 'orm', 'cache', 'auth',
  'api-server', 'web-ui', 'cli', 'scheduler', 'metrics',
  'plugin-a', 'plugin-b', 'billing', 'notifications', 'gateway',
];

const V_: Record<string, Vertex> = {};
for (const name of pkgNames) {
  V_[name] = g.addVertex({ labels: ['PACKAGE'], properties: { name, team: 'platform' } });
}

// A depends-on B  =>  edge A -> B
const deps: [string, string][] = [
  ['logger', 'core'],
  ['config', 'core'],
  ['utils', 'core'],
  ['errors', 'core'],
  ['http-client', 'core'], ['http-client', 'logger'], ['http-client', 'errors'],
  ['db-driver', 'core'], ['db-driver', 'logger'], ['db-driver', 'config'],
  ['orm', 'db-driver'], ['orm', 'utils'], ['orm', 'errors'],
  ['cache', 'core'], ['cache', 'config'],
  ['auth', 'http-client'], ['auth', 'orm'], ['auth', 'cache'],
  ['metrics', 'core'], ['metrics', 'logger'],
  ['scheduler', 'core'], ['scheduler', 'metrics'],
  ['api-server', 'auth'], ['api-server', 'orm'], ['api-server', 'http-client'], ['api-server', 'metrics'],
  ['web-ui', 'http-client'], ['web-ui', 'auth'],
  ['cli', 'config'], ['cli', 'orm'], ['cli', 'logger'],
  ['billing', 'orm'], ['billing', 'auth'], ['billing', 'notifications'],
  ['notifications', 'http-client'], ['notifications', 'scheduler'],
  ['gateway', 'api-server'], ['gateway', 'auth'],
  ['plugin-a', 'api-server'],
  ['plugin-b', 'gateway'],
  // ---- The deliberate cycle: billing -> notifications -> scheduler -> billing
  ['scheduler', 'billing'],
];

for (const [from, to] of deps) {
  g.addEdge({ from: V_[from], to: V_[to], labels: ['DEPENDS_ON'], properties: {} });
}

console.log(`Graph: ${pkgNames.length} packages, ${deps.length} DEPENDS_ON edges\n`);

const q = bind(g);
const name = (v: Vertex) => v.getProperty<string>('name');

// ---------------------------------------------------------------------------
// 2. "What breaks if I change X?" — transitive DOWNSTREAM (dependents).
//    Walk incoming DEPENDS_ON, emitting every hop, then dedupe.
// ---------------------------------------------------------------------------
function downstream(target: string): string[] {
  const rows = q.toArray(
    traversal(
      V(),
      has('name', target),
      repeat(in_('DEPENDS_ON')).emit(),
      dedupe(),
      values('name'),
    ),
  ) as string[];
  return rows.sort();
}

console.log('=== Blast radius: what breaks if I change `core`? ===');
console.log(downstream('core'));

console.log('\n=== what breaks if I change `orm`? ===');
console.log(downstream('orm'));

// ---------------------------------------------------------------------------
// 3. Shortest dependency path between two packages.
//    From `gateway`, shortest path (following DEPENDS_ON) to `core`.
// ---------------------------------------------------------------------------
console.log('\n=== Shortest dependency path: gateway ~> core ===');
const sp = q.toArray(
  traversal(
    V(),
    has('name', 'gateway'),
    shortestPath().with(ShortestPath.target, has('name', 'core')),
  ),
) as Vertex[][];
for (const p of sp) {
  console.log('  ' + p.map(name).join(' -> '));
}

// ---------------------------------------------------------------------------
// 4. Find dependency CYCLES.
//    repeat(out).until(cyclicPath()) walks until the path revisits a vertex.
// ---------------------------------------------------------------------------
console.log('\n=== Dependency cycles reachable from each package ===');
const rawCycles = q.toArray(
  traversal(
    V(),
    repeat(out('DEPENDS_ON')).until(cyclicPath()),
    path(),
  ),
) as Vertex[][];

// Keep only "true" cycles: paths whose first === last (the start is a cycle member),
// then canonicalize so we print each distinct loop once.
const seen = new Set<string>();
const cycles: string[][] = [];
for (const p of rawCycles) {
  if (p[0] !== p.at(-1)) continue; // start merely *reaches* a cycle; skip
  const namesOnPath = p.map(name);
  // rotate to smallest element for canonical form (drop the duplicated tail first)
  const ring = namesOnPath.slice(0, -1);
  const min = Math.min(...ring.map((_, i) => i), 0);
  void min;
  const start = ring.indexOf([...ring].sort()[0]);
  const canon = [...ring.slice(start), ...ring.slice(0, start)];
  const key = canon.join('>');
  if (!seen.has(key)) {
    seen.add(key);
    cycles.push([...canon, canon[0]]);
  }
}
if (cycles.length === 0) console.log('  (none)');
for (const c of cycles) console.log('  CYCLE: ' + c.join(' -> '));

// ---------------------------------------------------------------------------
// 5. Blast-radius SUBGRAPH: collect the edges of everything depending on `errors`,
//    materialize them into a Graph via subgraph(key) + cap(key).
// ---------------------------------------------------------------------------
console.log('\n=== Blast-radius subgraph around `errors` (dependents + their edges) ===');
// NOTE: subgraph() inside a repeat() body does NOT survive to an outer cap()
// (the repeat body runs in a throwaway RunContext). So we do it in one pass:
// take the whole blast set (errors + all transitive dependents), source them
// by id, and capture their outgoing DEPENDS_ON edges into a real Graph.
const blastNames = new Set(['errors', ...downstream('errors')]);
const blastIds = pkgNames.filter((n) => blastNames.has(n)).map((n) => V_[n].id);

const capped = q.toArray(
  traversal(
    V(...blastIds),
    outE('DEPENDS_ON'),
    // keep only edges that stay inside the blast set (induced subgraph)
    where(pipe(inV(), has('name', within(...blastNames)))),
    subgraph('blast'),
    cap('blast'),
  ),
);
const sub = capped[0];
if (sub instanceof Graph) {
  const verts = [...sub.getVerticesByLabel('PACKAGE')]
    .map((v) => v.getProperty<string>('name'))
    .sort();
  const edgeCount = [...sub.getVerticesByLabel('PACKAGE')]
    .reduce((acc, v) => acc + v.edgesFromByLabel('DEPENDS_ON').size, 0);
  console.log(`  blast subgraph: ${verts.length} vertices, ${edgeCount} edges`);
  console.log('  vertices:', verts);
} else {
  console.log('  cap() returned (not a Graph):', typeof sub, sub);
}

// ---------------------------------------------------------------------------
// 6. Bonus: typed property read + count of direct dependents.
// ---------------------------------------------------------------------------
console.log('\n=== Direct dependent counts (fan-in) ===');
for (const target of ['core', 'auth', 'orm', 'http-client']) {
  const c = q.toArray(
    traversal(V(), has('name', target), in_('DEPENDS_ON'), count()),
  )[0];
  console.log(`  ${target}: ${c} direct dependents`);
}
