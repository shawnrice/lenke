// Build/dependency impact-analysis over a package graph using @lenke/gremlin.
//
// Model: each package is a PACKAGE vertex; `A -[:DEPENDS_ON]-> B` means
// "A depends on B" (A's build consumes B). So:
//   - "what breaks if I change X"  = transitive *dependents* of X = follow
//     incoming DEPENDS_ON edges (in_).
//   - "shortest dependency path A→B" = follow outgoing DEPENDS_ON edges.
//
// Run: bun .dogfood/tomas/impact.ts

import { Graph, type Vertex } from '@lenke/core';
import {
  traversal,
  run,
  toArray,
  bind,
  V,
  out,
  in_,
  repeat,
  path,
  dedupe,
  values,
  has,
  hasLabel,
  both,
  cyclicPath,
  outE,
  inE,
  inV,
  subgraph,
  cap,
  shortestPath,
  ShortestPath,
} from '@lenke/gremlin';

// ---------------------------------------------------------------------------
// 1. Build the graph.
// ---------------------------------------------------------------------------
const g = new Graph();

// name -> Vertex, so edges read naturally.
const pkg: Record<string, Vertex> = {};
const add = (name: string) => {
  pkg[name] = g.addVertex({ labels: ['PACKAGE'], properties: { name } });
};

// A little monorepo: foundational libs at the bottom, apps at the top.
const names = [
  'logger', 'config', 'utils', 'errors', 'fp', 'list',
  'core', 'emitter', 'codec-json', 'codec-csv',
  'gremlin', 'gql', 'planner', 'index', 'store',
  'native', 'cli', 'server', 'web', 'devtools',
];
names.forEach(add);

// A -> B  ==  A DEPENDS_ON B
const deps: [string, string][] = [
  ['utils', 'logger'],
  ['utils', 'config'],
  ['errors', 'logger'],
  ['fp', 'utils'],
  ['list', 'fp'],
  ['core', 'utils'],
  ['core', 'errors'],
  ['core', 'fp'],
  ['core', 'list'],
  ['core', 'emitter'],
  ['emitter', 'utils'],
  ['codec-json', 'core'],
  ['codec-csv', 'core'],
  ['gremlin', 'core'],
  ['gremlin', 'errors'],
  ['gremlin', 'fp'],
  ['gql', 'core'],
  ['gql', 'planner'],
  ['planner', 'core'],
  ['planner', 'index'],
  ['index', 'core'],
  ['store', 'core'],
  ['store', 'codec-json'],
  ['native', 'core'],
  ['native', 'gremlin'],
  ['cli', 'gremlin'],
  ['cli', 'gql'],
  ['cli', 'store'],
  ['server', 'gql'],
  ['server', 'store'],
  ['web', 'gremlin'],
  ['web', 'devtools'],
  ['devtools', 'gremlin'],
  // --- an intentional dependency CYCLE: planner <-> index -> store -> planner
  ['store', 'planner'], // store depends on planner, planner depends on index depends on... make it cyclic:
  ['index', 'store'],   // index <-> store cycle (index->store->planner->index)
];

for (const [from, to] of deps) {
  g.addEdge({ from: pkg[from], to: pkg[to], labels: ['DEPENDS_ON'], properties: {} });
}

console.log(`graph: ${names.length} packages, ${deps.length} DEPENDS_ON edges\n`);

const q = bind(g);
const nameOf = (v: Vertex) => v.properties.name as string;

// ---------------------------------------------------------------------------
// 2. Blast radius: what breaks if I change `core`?  (transitive dependents)
// ---------------------------------------------------------------------------
const target = 'core';
const dependents = q
  .toArray(traversal(V(), has('name', target), repeat(in_('DEPENDS_ON')).emit(), dedupe()))
  .map((v) => nameOf(v as Vertex))
  .sort();

console.log(`[blast radius] changing "${target}" transitively affects ${dependents.length}:`);
console.log('  ' + dependents.join(', ') + '\n');

// ---------------------------------------------------------------------------
// 3. Transitive downstream deps of an app: what does `cli` pull in?
// ---------------------------------------------------------------------------
const cliDeps = q
  .toArray(traversal(V(), has('name', 'cli'), repeat(out('DEPENDS_ON')).emit(), dedupe()))
  .map((v) => nameOf(v as Vertex))
  .sort();
console.log(`[deps] "cli" transitively depends on ${cliDeps.length}:`);
console.log('  ' + cliDeps.join(', ') + '\n');

// ---------------------------------------------------------------------------
// 4. Shortest dependency path: how does `web` reach `logger`?
// ---------------------------------------------------------------------------
const paths = toArray(
  traversal(
    V(),
    has('name', 'web'),
    shortestPath().with(ShortestPath.target, has('name', 'logger')),
  ),
  g,
) as Vertex[][];

if (paths.length === 0) {
  console.log('[shortest path] web -> logger: none found\n');
} else {
  const p = paths[0].map(nameOf).join(' -> ');
  console.log(`[shortest path] web -> logger (${paths[0].length} nodes): ${p}\n`);
}

// ---------------------------------------------------------------------------
// 5. Cycle detection: find packages that sit on a dependency cycle.
//    A vertex is on a cycle iff a path of length>=1 returns to it.
//    Use both()+repeat over the path, filtered by cyclicPath().
// ---------------------------------------------------------------------------
const onCycle = new Set<string>();
for (const name of names) {
  const start = pkg[name].id;
  // start is on a cycle iff it appears in its own distance>=1 forward closure.
  const closure = toArray(
    traversal(V(start), repeat(out('DEPENDS_ON')).times(names.length).emit(), dedupe()),
    g,
  ) as Vertex[];
  if (closure.some((v) => v.id === start)) onCycle.add(name);
}
console.log(`[cycles] packages on a dependency cycle: ${[...onCycle].sort().join(', ') || '(none)'}`);

// Print one concrete cycle path via repeat(...).path() + cyclicPath().
const cyclePaths = toArray(
  traversal(
    V(pkg['store'].id),
    repeat(out('DEPENDS_ON')).times(names.length),
    cyclicPath(),
    path(),
  ),
  g,
) as Vertex[][];
// Each cyclic path revisits some vertex; slice out the loop (first..second seen).
const loop = cyclePaths
  .map((p) => {
    const ids = p.map((v) => v.id);
    for (let j = 0; j < ids.length; j++) {
      const k = ids.indexOf(ids[j], j + 1);
      if (k !== -1) return p.slice(j, k + 1);
    }
    return null;
  })
  .find((x): x is Vertex[] => x !== null);
if (loop) console.log(`  e.g. ${loop.map(nameOf).join(' -> ')}`);
console.log();

// ---------------------------------------------------------------------------
// 6. Blast-radius SUBGRAPH: capture the DEPENDS_ON edges among the dependents
//    of `errors` into a real @lenke/core Graph via subgraph()/cap().
// ---------------------------------------------------------------------------
const sgResult = toArray(
  traversal(
    // every edge whose *target* is in errors' blast radius; collect it.
    V(),
    has('name', 'errors'),
    repeat(in_('DEPENDS_ON')).emit(), // the affected vertices
    dedupe(),
    inE('DEPENDS_ON'),                // their incoming DEPENDS_ON edges
    subgraph('blast'),
    cap('blast'),
  ),
  g,
) as Graph[];

if (sgResult.length) {
  const sg = sgResult[0];
  const vCount = sg.getVerticesByLabel('PACKAGE').size;
  console.log(`[subgraph] blast-radius subgraph around "errors": ${vCount} vertices captured`);
}

// dummy references so unused-import lint stays quiet during exploration
void [run, hasLabel, both, values, outE, inV, cyclicPath, path];
