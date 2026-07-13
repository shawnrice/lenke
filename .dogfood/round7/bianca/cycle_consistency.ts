// Cycle termination + consistency checks + materialized inference.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  toArray,
  traversal,
  V,
  out,
  in_,
  has,
  hasLabel,
  values,
  repeat,
  dedupe,
  path,
  cyclicPath,
  simplePath,
  regex,
} from '@lenke/gremlin';

import { buildOntology, closureProper, closureReflexive } from './ontology';

const onto = buildOntology();
const g = onto.g;
const gqlNames = (q: string, key = 'n') => (query(g, q) as any[]).map((r) => r[key]);
const gqlSet = (q: string, key = 'n') => new Set<string>(gqlNames(q, key));
const sortA = (a: any[]) => JSON.stringify([...a].sort());

console.log('############ CYCLE: Cyc_X -> Cyc_Y -> Cyc_Z -> Cyc_X ############');
// Reasoning-correct answer: superclasses of Cyc_X in a cyclic hierarchy = ALL of {Cyc_Y, Cyc_Z, Cyc_X}
// (each reachable, and X is its own superclass through the loop).
const jsReflexive = closureReflexive(onto.parents, 'Cyc_X');
const jsProper = closureProper(onto.parents, 'Cyc_X');
console.log('JS reflexive (cycle-safe) superclasses of Cyc_X:', sortA([...jsReflexive]));
console.log('JS proper superclasses of Cyc_X:', sortA([...jsProper]));

// --- GQL var-length on the cycle (TRAIL / edge-distinct => terminates) ---
console.log(
  '\nGQL * on cycle:',
  sortA(
    gqlNames(`MATCH (x:Class {name:'Cyc_X'})-[:SUBCLASS_OF]->*(s) RETURN DISTINCT s.name AS n`),
  ),
);
console.log(
  'GQL + on cycle:',
  sortA(
    gqlNames(`MATCH (x:Class {name:'Cyc_X'})-[:SUBCLASS_OF]->+(s) RETURN DISTINCT s.name AS n`),
  ),
);
console.log(
  'GQL + raw rows (no distinct):',
  sortA(gqlNames(`MATCH (x:Class {name:'Cyc_X'})-[:SUBCLASS_OF]->+(s) RETURN s.name AS n`)),
);
console.log(
  'GQL {1,10} bounded on cycle:',
  sortA(
    gqlNames(
      `MATCH (x:Class {name:'Cyc_X'})-[:SUBCLASS_OF]->{1,10}(s) RETURN DISTINCT s.name AS n`,
    ),
  ),
);

// --- Gremlin repeat on the cycle: does it terminate? emit collects each hop; dedupe caps growth
console.log(
  '\nGrem repeat(out).emit() dedupe on cycle:',
  sortA(
    toArray(
      traversal(
        V(),
        has('name', 'Cyc_X'),
        repeat(out('SUBCLASS_OF')).emit(),
        dedupe(),
        values('name'),
      ),
      g,
    ),
  ),
);

// Compare to JS reasoning answer:
const gqlPlusSet = gqlSet(
  `MATCH (x:Class {name:'Cyc_X'})-[:SUBCLASS_OF]->+(s) RETURN DISTINCT s.name AS n`,
);
console.log(
  '\n>>> Does GQL + set == JS proper (which for a cycle is all 3)?',
  jsProper.size === gqlPlusSet.size && [...jsProper].every((x) => gqlPlusSet.has(x)),
);
console.log('    JS proper =', sortA([...jsProper]), ' GQL+ =', sortA([...gqlPlusSet]));

console.log('\n############ CONSISTENCY 1: detect a SUBCLASS_OF cycle ############');
// Approach A (Gremlin): repeat(out).until(cyclicPath()) then path() — find loops.
const cyclesG = toArray(
  traversal(V(), hasLabelClass(), repeat(out('SUBCLASS_OF')).until(cyclicPath()).emit(), path()),
  g,
) as any[];
// Filter to paths whose first === last (member of its own cycle)
function pname(p: any) {
  // path elements are vertices; get name
  return p.map((el: any) => (el && el.properties ? el.properties.name : String(el)));
}
const memberCycles = cyclesG.map(pname).filter((p) => p.length > 1 && p[0] === p[p.length - 1]);
console.log(
  'Gremlin cyclicPath member-cycles found (sample):',
  JSON.stringify(memberCycles.slice(0, 5)),
);

// Approach B (GQL): a class reachable back to itself via >=1 hop is on a cycle.
// (x)-[:SUBCLASS_OF]->+(x)  where endpoint name == start name.
const selfLoop = gqlNames(
  `MATCH (x:Class)-[:SUBCLASS_OF]->+(s:Class) WHERE s.name = x.name RETURN DISTINCT x.name AS n`,
);
console.log('GQL classes on a SUBCLASS_OF cycle (x reaches itself):', sortA(selfLoop));

console.log('\n############ CONSISTENCY 2: instance typed to two DISJOINT classes ############');
// DISJOINT_WITH(Plant, Animal); "contradiction" typed to both.
const contradictions = gqlNames(
  `MATCH (i:Individual)-[:TYPE]->(a:Class)-[:DISJOINT_WITH]-(b:Class)<-[:TYPE]-(i) RETURN DISTINCT i.name AS n`,
);
console.log(
  'GQL instances typed to two disjoint classes (undirected DISJOINT_WITH):',
  sortA(contradictions),
);
// Also try directed both ways since ~ may matter:
const contraDir = gqlNames(
  `MATCH (i:Individual)-[:TYPE]->(a:Class)-[:DISJOINT_WITH]->(b:Class), (i)-[:TYPE]->(b) RETURN DISTINCT i.name AS n`,
);
console.log('GQL contradictions (directed DISJOINT_WITH + comma-join):', sortA(contraDir));

// Should also catch disjointness inherited via subclass: if i is a Plant-subclass instance AND an Animal.
// (not built here, but note the closure form):
const contraInferred = gqlNames(
  `MATCH (i:Individual)-[:TYPE]->(c1)-[:SUBCLASS_OF]->*(a:Class)-[:DISJOINT_WITH]->(b:Class), (i)-[:TYPE]->(c2)-[:SUBCLASS_OF]->*(b) RETURN DISTINCT i.name AS n`,
);
console.log('GQL contradictions with SUBCLASS closure on both sides:', sortA(contraInferred));

function hasLabelClass() {
  return has('name', regex('^Cyc_')); // narrow the cycle scan to the cyclic corner for speed
}
