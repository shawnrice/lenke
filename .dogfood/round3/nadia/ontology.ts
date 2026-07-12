/**
 * Ontology / taxonomy explorer — dogfooding @lenke/tree (TreeNode + Trie),
 * @lenke/list (List), and advanced @lenke/gremlin (project/group/groupCount/
 * select/match/choose/coalesce) over a @lenke/core instance graph.
 *
 * Run: bun ontology.ts
 *
 * Author POV: Nadia, first-time lenke user, docs + public API only.
 */

import { Graph, type Vertex } from '@lenke/core';
import {
  traversal,
  run,
  toArray,
  V,
  hasLabel,
  has,
  in_,
  out,
  label,
  values,
  count,
  fold,
  order,
  project,
  group,
  groupCount,
  select,
  as_,
  match,
  choose,
  coalesce,
  constant,
  repeat,
  dedupe,
  pipe,
  eq,
  Order,
} from '@lenke/gremlin';
import { List } from '@lenke/list';
import { TreeNode, Trie } from '@lenke/tree';

const hr = (title: string) => console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);

// ---------------------------------------------------------------------------
// 1. Class hierarchy (is-a tree) as a @lenke/tree TreeNode<string>
// ---------------------------------------------------------------------------
// Entity
//  ├─ Animal
//  │   ├─ Mammal ─ {Dog, Cat}
//  │   └─ Bird   ─ {Eagle, Penguin}
//  └─ Plant
//      ├─ Tree
//      └─ Flower

const entity = TreeNode.from('Entity');

const animal = entity.createChild('Animal');
const mammal = animal.createChild('Mammal');
mammal.createChild('Dog');
mammal.createChild('Cat');
const bird = animal.createChild('Bird');
bird.createChild('Eagle');
bird.createChild('Penguin');

const plant = entity.createChild('Plant');
plant.createChild('Tree');
plant.createChild('Flower');

// find-by-value helper (there is no `find`; use the filterDepthFirst generator)
const findClass = (name: string): TreeNode<string> | null =>
  entity.filterDepthFirst((n) => n.value === name).next().value ?? null;

hr('1. CLASS HIERARCHY (TreeNode)');
console.log('depth-first values :', entity.castDepthFirstValue().join(' > '));
console.log('breadth-first      :', entity.castBreadthFirstValue().join(' '));
console.log(
  'leaf count (fold)  :',
  entity.fold<number>((_v, kids) => (kids.length === 0 ? 1 : kids.reduce((a, b) => a + b, 0))),
);

// --- add / detach demo ---
const reptile = animal.createChild('Reptile'); // add
reptile.createChild('Lizard');
console.log('after add Reptile  :', animal.children.map((c) => c.value).join(', '));
reptile.detach(); // cut Reptile + subtree loose
console.log('after detach       :', animal.children.map((c) => c.value).join(', '));

// --- subclasses of a class (transitive) via tree traversal ---
const subclassesOf = (name: string): string[] => {
  const node = findClass(name);
  if (!node) return [];
  return node.castDepthFirstValue().slice(1); // drop the class itself
};
hr('SUBCLASSES OF "Animal" (transitive, via TreeNode)');
console.log(subclassesOf('Animal').join(', '));

// --- serialize round-trip ---
const records = TreeNode.serialize(entity);
const restored = TreeNode.deserialize(records);
console.log('\nserialize round-trip equals original?', TreeNode.equals(entity, restored));

// ---------------------------------------------------------------------------
// 2. Trie for class-name prefix autocomplete (@lenke/tree)
// ---------------------------------------------------------------------------
const allClassNames = entity.castDepthFirstValue();
const nameTrie = Trie.from(allClassNames.map((n, i) => [n, i] as [string, number]));

const autocomplete = (prefix: string): string[] =>
  Array.from(nameTrie.descendantsOf(prefix), (node) => node.word as string).sort();

hr('2. PREFIX SEARCH (Trie)');
for (const p of ['P', 'B', 'En']) {
  console.log(`autocomplete("${p}") ->`, autocomplete(p));
}
console.log('has("Dog")        ?', nameTrie.has('Dog'));
console.log('hasPartial("Ea")  ?', nameTrie.hasPartial('Ea'));

// ---------------------------------------------------------------------------
// 3. Instance property graph (@lenke/core), mirrored from the class tree
// ---------------------------------------------------------------------------
// Class vertices (label CLASS) + SUBCLASS_OF edges, derived by walking the tree.
// Instance vertices carry the class name as their label + an INSTANCE_OF edge.

const g = new Graph();
const classVertex = new Map<string, Vertex>();

// materialise every class as a CLASS vertex
for (const node of entity) {
  classVertex.set(node.value, g.addVertex({ labels: ['CLASS'], properties: { name: node.value } }));
}
// SUBCLASS_OF edges: child --SUBCLASS_OF--> parent
for (const node of entity) {
  if (node.parent) {
    g.addEdge({
      from: classVertex.get(node.value)!,
      to: classVertex.get(node.parent.value)!,
      labels: ['SUBCLASS_OF'],
      properties: {},
    });
  }
}

// instances: [name, className]
const instances: [string, string][] = [
  ['Rex', 'Dog'],
  ['Bella', 'Dog'],
  ['Whiskers', 'Cat'],
  ['Sky', 'Eagle'],
  ['Pingu', 'Penguin'],
  ['Oakley', 'Tree'],
  ['Rosie', 'Flower'],
  ['Fern', 'Flower'],
  ['Daisy', 'Flower'],
];
for (const [name, cls] of instances) {
  const v = g.addVertex({ labels: [cls, 'INSTANCE'], properties: { name, class: cls } });
  g.addEdge({ from: v, to: classVertex.get(cls)!, labels: ['INSTANCE_OF'], properties: {} });
}

// ---------------------------------------------------------------------------
// 4. @lenke/list — ordered result collections
// ---------------------------------------------------------------------------
hr('3. @lenke/list — ordered instance names');
const instanceNames = List.from(instances.map(([n]) => n))
  .filter((n) => n.length > 3)
  .map((n) => n.toUpperCase())
  .sort((a, b) => a.localeCompare(b));
console.log('List.length       :', instanceNames.length); // NOTE: `.length`, not `.size`
console.log('(.size is)        :', (instanceNames as unknown as { size?: number }).size); // undefined
console.log('toArray()         :', instanceNames.toArray());
console.log('head()/last()     :', instanceNames.head(), '/', instanceNames.last());

// ---------------------------------------------------------------------------
// 5. Advanced gremlin — grouping, projection, select, choose/coalesce, match
// ---------------------------------------------------------------------------

hr('4a. INSTANCES GROUPED BY CLASS (group + groupCount)');
// group(): Map<className, name[]>
const grouped = toArray(
  traversal(V(), hasLabel('INSTANCE'), group().by('class').by('name')),
  g,
)[0] as Map<string, string[]>;
for (const [cls, names] of grouped) console.log(`  ${cls.padEnd(8)} -> [${names.join(', ')}]`);

// groupCount(): Map<className, count>
const counts = toArray(traversal(V(), hasLabel('INSTANCE'), groupCount().by('class')), g)[0] as Map<
  string,
  number
>;
console.log('groupCount        :', JSON.stringify(Object.fromEntries(counts)));

hr('4b. PER-CLASS PROJECTION {name, instanceCount, parent}  (project.by sub-traversals)');
// Over CLASS vertices: name, direct-instance count, and parent class name.
// parent uses coalesce so the root ("Entity") reports "<root>" instead of nothing.
const perClass = toArray(
  traversal(
    V(),
    hasLabel('CLASS'),
    order().by('name', Order.asc),
    project(['name', 'instanceCount', 'parent'])
      .by('name')
      .by(traversal(in_('INSTANCE_OF'), count()))
      .by(coalesce(pipe(out('SUBCLASS_OF'), values('name')), constant('<root>'))),
  ),
  g,
) as { name: string; instanceCount: number; parent: string }[];
for (const row of perClass) {
  console.log(`  ${row.name.padEnd(8)} instances=${row.instanceCount}  parent=${row.parent}`);
}

hr('4c. choose() — classify each class as populated / empty');
const classified = toArray(
  traversal(
    V(),
    hasLabel('CLASS'),
    order().by('name', Order.asc),
    project(['name', 'kind'])
      .by('name')
      .by(
        choose(
          pipe(in_('INSTANCE_OF')), // test: has any instance?
          constant('populated'),
          constant('empty'),
        ),
      ),
  ),
  g,
) as { name: string; kind: string }[];
console.log(classified.map((r) => `${r.name}:${r.kind}`).join('  '));

hr('4d. select() with as_ — instance -> its class name');
const selected = toArray(
  traversal(
    V(),
    hasLabel('INSTANCE'),
    as_('inst'),
    out('INSTANCE_OF'),
    as_('cls'),
    select('inst', 'cls').by('name'),
  ),
  g,
).slice(0, 4) as { inst: string; cls: string }[];
for (const r of selected) console.log(`  ${r.inst} : ${r.cls}`);

hr('4e. subclasses of "Animal" via gremlin repeat (cross-check with the tree)');
// repeat incoming SUBCLASS_OF to gather transitive subclasses
const gSubs = toArray(
  traversal(
    V(),
    hasLabel('CLASS'),
    has('name', eq('Animal')),
    repeat(in_('SUBCLASS_OF')).emit(),
    dedupe(),
    values('name'),
    order(),
  ),
  g,
);
console.log('  gremlin:', gSubs.join(', '));
console.log('  tree   :', subclassesOf('Animal').slice().sort().join(', '));

hr('4f. match() — declarative pattern (per source: STUBBED, executor throws?)');
try {
  const m = toArray(
    traversal(
      V(),
      hasLabel('INSTANCE'),
      match(pipe(as_('i'), out('INSTANCE_OF'), as_('c')), pipe(as_('c'), has('name', 'Flower'))),
      select('i').by('name'),
    ),
    g,
  );
  console.log('  match result:', m);
} catch (e) {
  console.log('  match THREW:', (e as Error).message);
}
