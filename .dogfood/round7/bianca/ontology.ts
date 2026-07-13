// Build a realistic class/instance knowledge graph + an INDEPENDENT JS reference model.
//
// Structure:
//  - Classes with SUBCLASS_OF edges (child -[:SUBCLASS_OF]-> parent).
//  - A deep, wide hierarchy generated as a tree, then EXTRA parent links added to
//    create DIAMONDS (multiple inheritance) at deterministic points.
//  - One deliberately-introduced SUBCLASS_OF CYCLE in an isolated corner.
//  - Instances (Individuals) with TYPE edges (instance -[:TYPE]-> class).
//  - Properties with SUBPROPERTY_OF edges (property -[:SUBPROPERTY_OF]-> super).
//  - PART_OF edges among "part" classes (transitive meronymy).
//
// The JS model stores plain adjacency so every inferred set can be checked against
// an independent BFS/DFS transitive closure.
import { Graph } from '@lenke/core';

export interface Onto {
  g: Graph;
  classNames: string[];
  instanceNames: string[];
  vId: Map<string, string>; // name -> vertex id
  // adjacency (child -> direct parents) for SUBCLASS_OF
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
  // instance -> direct declared classes (TYPE)
  typeOf: Map<string, string[]>;
  // PART_OF: part -> wholes
  partOf: Map<string, string[]>;
  // properties
  propParents: Map<string, string[]>; // prop -> super props (SUBPROPERTY_OF)
  // class -> properties declared directly on it (via HAS_PROP edge modeled as prop set)
  classProps: Map<string, string[]>;
  cycleNodes: string[]; // names participating in the deliberate cycle
  diamondApex?: string; // a class that is a diamond apex (two parents joining)
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildOntology(seed = 7): Onto {
  const g = new Graph();
  const rand = mulberry32(seed);
  const vId = new Map<string, string>();
  const vtx = new Map<string, any>();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const typeOf = new Map<string, string[]>();
  const partOf = new Map<string, string[]>();
  const propParents = new Map<string, string[]>();
  const classProps = new Map<string, string[]>();
  const classNames: string[] = [];
  const instanceNames: string[] = [];

  const addClass = (name: string) => {
    const v = g.addVertex({ labels: ['Class'], properties: { name } });
    vId.set(name, v.id);
    vtx.set(name, v);
    classNames.push(name);
    parents.set(name, []);
    children.set(name, []);
    classProps.set(name, []);
  };
  const subclass = (child: string, parent: string) => {
    g.addEdge({
      from: vtx.get(child),
      to: vtx.get(parent),
      labels: ['SUBCLASS_OF'],
      properties: {},
    });
    parents.get(child)!.push(parent);
    children.get(parent)!.push(child);
  };

  // ---- Build a deep tree of classes. Root "Thing". ~ a few hundred classes. ----
  addClass('Thing');
  const byDepth: string[][] = [['Thing']];
  let counter = 0;
  const DEPTH = 8;
  for (let d = 1; d <= DEPTH; d++) {
    const prev = byDepth[d - 1];
    const level: string[] = [];
    for (const p of prev) {
      // each parent gets 2-3 children (tree), narrowing at deeper levels
      const nkids = d < 6 ? 2 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 2);
      for (let k = 0; k < nkids; k++) {
        const name = `C${d}_${counter++}`;
        addClass(name);
        subclass(name, p);
        level.push(name);
      }
    }
    byDepth.push(level);
    if (classNames.length > 320) break;
  }

  // ---- DIAMONDS: give some classes a SECOND parent from a shallower level. ----
  // Pick pairs where a class at depth d also subclasses another class at depth d-1
  // whose subtree is disjoint => a genuine diamond joining at "Thing" or an inner apex.
  let diamondApex: string | undefined;
  const midLevel = byDepth[4] ?? [];
  const upperLevel = byDepth[2] ?? [];
  for (let i = 0; i < midLevel.length && i < 40; i++) {
    const child = midLevel[i];
    const extra = upperLevel[(i * 7) % Math.max(1, upperLevel.length)];
    // Avoid adding a parent that is already an ancestor via the tree (keep it a real 2nd path).
    if (extra && extra !== child && !isAncestorTree(parents, child, extra)) {
      subclass(child, extra);
      if (!diamondApex) diamondApex = child;
    }
  }

  // A hand-built explicit DIAMOND we can assert on precisely:
  //   D_bottom -> D_left -> D_top ;  D_bottom -> D_right -> D_top
  ['D_top', 'D_left', 'D_right', 'D_bottom'].forEach(addClass);
  subclass('D_left', 'D_top');
  subclass('D_right', 'D_top');
  subclass('D_bottom', 'D_left');
  subclass('D_bottom', 'D_right');
  subclass('D_top', 'Thing');

  // ---- DELIBERATE CYCLE (isolated corner): X -> Y -> Z -> X ----
  ['Cyc_X', 'Cyc_Y', 'Cyc_Z'].forEach(addClass);
  subclass('Cyc_X', 'Cyc_Y');
  subclass('Cyc_Y', 'Cyc_Z');
  subclass('Cyc_Z', 'Cyc_X'); // closes the loop
  const cycleNodes = ['Cyc_X', 'Cyc_Y', 'Cyc_Z'];

  // ---- PART_OF among some dedicated part classes (transitive). ----
  // Engine -> Car -> Fleet  (part-of chain), plus a diamond part-of.
  ['Fleet', 'Car', 'Engine', 'Piston', 'Wheel'].forEach(addClass);
  const partof = (part: string, whole: string) => {
    g.addEdge({ from: vtx.get(part), to: vtx.get(whole), labels: ['PART_OF'], properties: {} });
    if (!partOf.has(part)) partOf.set(part, []);
    partOf.get(part)!.push(whole);
  };
  partof('Piston', 'Engine');
  partof('Engine', 'Car');
  partof('Wheel', 'Car');
  partof('Car', 'Fleet');

  // ---- PROPERTIES with SUBPROPERTY_OF, and property attachment to classes. ----
  const addProp = (name: string) => {
    const v = g.addVertex({ labels: ['Property'], properties: { name } });
    vId.set(name, v.id);
    vtx.set(name, v);
    propParents.set(name, []);
  };
  const subprop = (child: string, parent: string) => {
    g.addEdge({
      from: vtx.get(child),
      to: vtx.get(parent),
      labels: ['SUBPROPERTY_OF'],
      properties: {},
    });
    propParents.get(child)!.push(parent);
  };
  ['relatedTo', 'knows', 'friendOf', 'partOfProp'].forEach(addProp);
  subprop('knows', 'relatedTo');
  subprop('friendOf', 'knows'); // friendOf -> knows -> relatedTo

  // Attach a property to an ANCESTOR class so instances inherit it.
  // Model: a class HAS_PROP a property node. We attach "hasWheels" to a mid class.
  addProp('hasWheels');
  const attachProp = (cls: string, prop: string) => {
    g.addEdge({ from: vtx.get(cls), to: vtx.get(prop), labels: ['HAS_PROP'], properties: {} });
    classProps.get(cls)!.push(prop);
  };
  // Attach to D_top so D_bottom (a descendant) inherits it.
  attachProp('D_top', 'hasWheels');
  attachProp('Car', 'hasWheels');

  // ---- INSTANCES: thousands, TYPE-edged to leaf-ish classes. ----
  const leafish = classNames.filter(
    (n) => (children.get(n)?.length ?? 0) === 0 && n.startsWith('C'),
  );
  const INSTANCES = 3000;
  for (let i = 0; i < INSTANCES; i++) {
    const name = `i${i}`;
    const cls = leafish[Math.floor(rand() * leafish.length)];
    const v = g.addVertex({ labels: ['Individual'], properties: { name } });
    vId.set(name, v.id);
    vtx.set(name, v);
    instanceNames.push(name);
    typeOf.set(name, []);
    g.addEdge({ from: v, to: vtx.get(cls), labels: ['TYPE'], properties: {} });
    typeOf.get(name)!.push(cls);
  }

  // A handful of instances typed to explicit diamond classes for property-inheritance tests.
  const typedInstance = (name: string, cls: string) => {
    const v = g.addVertex({ labels: ['Individual'], properties: { name } });
    vId.set(name, v.id);
    vtx.set(name, v);
    instanceNames.push(name);
    typeOf.set(name, [cls]);
    g.addEdge({ from: v, to: vtx.get(cls), labels: ['TYPE'], properties: {} });
  };
  typedInstance('diamondInst', 'D_bottom'); // should inherit hasWheels from D_top
  typedInstance('carInst', 'Engine'); // Engine is a class here too

  // ---- A CONSISTENCY probe: instance typed to two DISJOINT classes. ----
  // Declare two classes disjoint (DISJOINT_WITH edge), then type an instance to both.
  addClass('Plant');
  addClass('Animal');
  subclass('Plant', 'Thing');
  subclass('Animal', 'Thing');
  g.addEdge({
    from: vtx.get('Plant'),
    to: vtx.get('Animal'),
    labels: ['DISJOINT_WITH'],
    properties: {},
  });
  const bad = g.addVertex({ labels: ['Individual'], properties: { name: 'contradiction' } });
  vId.set('contradiction', bad.id);
  instanceNames.push('contradiction');
  typeOf.set('contradiction', ['Plant', 'Animal']);
  g.addEdge({ from: bad, to: vtx.get('Plant'), labels: ['TYPE'], properties: {} });
  g.addEdge({ from: bad, to: vtx.get('Animal'), labels: ['TYPE'], properties: {} });

  return {
    g,
    classNames,
    instanceNames,
    vId,
    parents,
    children,
    typeOf,
    partOf,
    propParents,
    classProps,
    cycleNodes,
    diamondApex,
  };
}

// tree-only ancestor check (before diamonds/cycles added) to avoid adding redundant links
function isAncestorTree(parents: Map<string, string[]>, node: string, cand: string): boolean {
  const seen = new Set<string>();
  const stack = [...(parents.get(node) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (p === cand) return true;
    if (seen.has(p)) continue;
    seen.add(p);
    stack.push(...(parents.get(p) ?? []));
  }
  return false;
}

// ============ INDEPENDENT JS TRANSITIVE-CLOSURE REFERENCE ============

// All ancestors reachable via `adj` from `start`, EXCLUDING start (proper), cycle-safe.
export function closureProper(adj: Map<string, string[]>, start: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return out;
}

// Reflexive closure: includes start.
export function closureReflexive(adj: Map<string, string[]>, start: string): Set<string> {
  const s = closureProper(adj, start);
  s.add(start);
  return s;
}

// All descendants (reverse direction) proper.
export function descendantsProper(children: Map<string, string[]>, start: string): Set<string> {
  return closureProper(children, start);
}
