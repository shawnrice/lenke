// Reasoning queries in BOTH engines, each verified against the independent JS closure.
import { query } from '@lenke/gql';
import { toArray, traversal, V, out, in_, has, values, repeat, dedupe, emit } from '@lenke/gremlin';

import {
  buildOntology,
  closureProper,
  closureReflexive,
  descendantsProper,
  type Onto,
} from './ontology';

const onto = buildOntology();
const g = onto.g;

let pass = 0;
let fail = 0;
const fails: string[] = [];

function eqSet(
  a: Set<string>,
  b: Set<string>,
): { ok: boolean; missing: string[]; extra: string[] } {
  const missing = [...b].filter((x) => !a.has(x)); // in expected, not in actual
  const extra = [...a].filter((x) => !b.has(x)); // in actual, not in expected
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function check(label: string, actual: Set<string>, expected: Set<string>) {
  const { ok, missing, extra } = eqSet(actual, expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}  (|set|=${actual.size})`);
  } else {
    fail++;
    const msg = `FAIL  ${label}\n        actual=${actual.size} expected=${expected.size}\n        missing(inExpNotAct)=${JSON.stringify(missing.slice(0, 10))}\n        extra(inActNotExp)=${JSON.stringify(extra.slice(0, 10))}`;
    fails.push(msg);
    console.log(`  ${msg}`);
  }
}

const gqlSet = (q: string, params: any, key: string) =>
  new Set<string>((query(g, q, params) as any[]).map((r) => r[key]));
const gremSet = (plan: any) => new Set<string>(toArray(plan, g) as string[]);

console.log('\n############ 1. TRANSITIVE CLOSURE: all superclasses ############');
{
  // Pick a deep class with a diamond above it.
  const target = 'D_bottom';
  const expProper = closureProper(onto.parents, target); // superclasses, excluding self
  const expReflexive = closureReflexive(onto.parents, target);
  console.log(
    `target=${target}  JS proper superclasses=${expProper.size}, reflexive=${expReflexive.size}`,
  );

  // GQL +  -> proper (>=1 hop)
  check(
    'GQL  -[:SUBCLASS_OF]->+  == JS proper superclasses',
    gqlSet(
      `MATCH (x:Class {name:$n})-[:SUBCLASS_OF]->+(s) RETURN DISTINCT s.name AS n`,
      { n: target },
      'n',
    ),
    expProper,
  );
  // GQL *  -> reflexive (>=0 hop, includes self)
  check(
    'GQL  -[:SUBCLASS_OF]->*  == JS reflexive superclasses (incl self)',
    gqlSet(
      `MATCH (x:Class {name:$n})-[:SUBCLASS_OF]->*(s) RETURN DISTINCT s.name AS n`,
      { n: target },
      'n',
    ),
    expReflexive,
  );
  // Gremlin repeat(out).emit() -> proper
  check(
    'Grem repeat(out).emit() dedupe == JS proper superclasses',
    gremSet(
      traversal(
        V(),
        has('name', target),
        repeat(out('SUBCLASS_OF')).emit(),
        dedupe(),
        values('name'),
      ),
    ),
    expProper,
  );
}

console.log('\n############ 2. DIAMOND dedup (explicit D_bottom) ############');
{
  // D_bottom -> D_left -> D_top ; D_bottom -> D_right -> D_top ; D_top -> Thing
  // Proper superclasses should be {D_left, D_right, D_top, Thing} with NO double count.
  const expProper = closureProper(onto.parents, 'D_bottom');
  console.log('JS D_bottom proper superclasses:', JSON.stringify([...expProper].sort()));
  const rawRows = query(
    g,
    `MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->+(s) RETURN s.name AS n`,
  ) as any[];
  console.log(
    'GQL raw + rows (may contain dup D_top/Thing via 2 paths):',
    JSON.stringify(rawRows.map((r) => r.n).sort()),
  );
  const dtopCount = rawRows.filter((r) => r.n === 'D_top').length;
  console.log(`  D_top appears ${dtopCount} time(s) in raw rows (2 paths exist; TRAIL semantics)`);
  check(
    'GQL DISTINCT + on diamond == JS set',
    gqlSet(
      `MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->+(s) RETURN DISTINCT s.name AS n`,
      {},
      'n',
    ),
    expProper,
  );
  check(
    'Grem repeat(out).emit() dedupe on diamond == JS set',
    gremSet(
      traversal(
        V(),
        has('name', 'D_bottom'),
        repeat(out('SUBCLASS_OF')).emit(),
        dedupe(),
        values('name'),
      ),
    ),
    expProper,
  );
}

console.log(
  '\n############ 3. TYPE INFERENCE: all instances of a class incl subclasses ############',
);
{
  // Instances of class C (direct + via any subclass). Pick a mid-level class with many descendants.
  // Find a class with a large descendant set.
  let best = 'Thing';
  let bestN = -1;
  for (const c of onto.classNames) {
    const d = descendantsProper(onto.children, c).size;
    if (d > bestN && d < 60) {
      bestN = d;
      best = c;
    }
  }
  const target = best;
  const subclasses = descendantsProper(onto.children, target); // proper descendants
  const selfAndSub = new Set(subclasses);
  selfAndSub.add(target);
  // JS: instances whose declared type is in selfAndSub.
  const expInstances = new Set<string>();
  for (const [inst, types] of onto.typeOf) {
    if (types.some((t) => selfAndSub.has(t))) expInstances.add(inst);
  }
  console.log(
    `target=${target}  #subclasses(incl self)=${selfAndSub.size}  JS inferred instances=${expInstances.size}`,
  );

  // GQL: instance -[:TYPE]-> c , c -[:SUBCLASS_OF]->* target  (star so direct-typed count too)
  check(
    'GQL  (i)-[:TYPE]->(c)-[:SUBCLASS_OF]->*(target) == JS inferred instances',
    gqlSet(
      `MATCH (i:Individual)-[:TYPE]->(c:Class)-[:SUBCLASS_OF]->*(t:Class {name:$n}) RETURN DISTINCT i.name AS n`,
      { n: target },
      'n',
    ),
    expInstances,
  );
  // Gremlin: from target, walk incoming SUBCLASS_OF* (all subclasses incl self via emitBefore), then incoming TYPE.
  check(
    'Grem target <-SUBCLASS_OF*(incl self)<- subclasses <-TYPE<- instances == JS',
    gremSet(
      traversal(
        V(),
        has('name', target),
        repeat(in_('SUBCLASS_OF')).emitBefore(), // include target itself + all subclasses
        dedupe(),
        in_('TYPE'),
        dedupe(),
        values('name'),
      ),
    ),
    expInstances,
  );
}

console.log('\n############ 4. TRANSITIVE PART_OF ############');
{
  const target = 'Piston';
  const expWholes = closureProper(onto.partOf, target); // Engine, Car, Fleet
  console.log('JS Piston part-of closure:', JSON.stringify([...expWholes].sort()));
  check(
    'GQL  (Piston)-[:PART_OF]->+  == JS part-of closure',
    gqlSet(`MATCH (x:Class {name:'Piston'})-[:PART_OF]->+(w) RETURN DISTINCT w.name AS n`, {}, 'n'),
    expWholes,
  );
  check(
    'Grem repeat(out PART_OF).emit() == JS part-of closure',
    gremSet(
      traversal(
        V(),
        has('name', 'Piston'),
        repeat(out('PART_OF')).emit(),
        dedupe(),
        values('name'),
      ),
    ),
    expWholes,
  );
}

console.log(
  '\n############ 5. PROPERTY INHERITANCE (instance inherits ancestor-class prop) ############',
);
{
  // diamondInst : D_bottom.  hasWheels attached to D_top (ancestor).  Should inherit.
  // JS expectation:
  const instType = onto.typeOf.get('diamondInst')![0]; // D_bottom
  const anc = closureReflexive(onto.parents, instType); // D_bottom..D_top..Thing
  const expProps = new Set<string>();
  for (const c of anc) for (const p of onto.classProps.get(c) ?? []) expProps.add(p);
  console.log('JS inherited props for diamondInst:', JSON.stringify([...expProps].sort()));
  // GQL: i -TYPE-> c -SUBCLASS_OF->* a -HAS_PROP-> p
  check(
    'GQL  instance inherits ancestor-class property == JS',
    gqlSet(
      `MATCH (i:Individual {name:'diamondInst'})-[:TYPE]->(c)-[:SUBCLASS_OF]->*(a)-[:HAS_PROP]->(p) RETURN DISTINCT p.name AS n`,
      {},
      'n',
    ),
    expProps,
  );
  check(
    'Grem instance inherits ancestor-class property == JS',
    gremSet(
      traversal(
        V(),
        has('name', 'diamondInst'),
        out('TYPE'),
        repeat(out('SUBCLASS_OF')).emitBefore(),
        dedupe(),
        out('HAS_PROP'),
        dedupe(),
        values('name'),
      ),
    ),
    expProps,
  );
}

console.log('\n############ 6. PROPERTY HIERARCHY (SUBPROPERTY_OF closure) ############');
{
  const expSuper = closureProper(onto.propParents, 'friendOf'); // knows, relatedTo
  console.log('JS friendOf super-properties:', JSON.stringify([...expSuper].sort()));
  check(
    'GQL  (friendOf)-[:SUBPROPERTY_OF]->+ == JS',
    gqlSet(
      `MATCH (x:Property {name:'friendOf'})-[:SUBPROPERTY_OF]->+(s) RETURN DISTINCT s.name AS n`,
      {},
      'n',
    ),
    expSuper,
  );
}

console.log(`\n############ SUMMARY: ${pass} pass / ${fail} fail ############`);
if (fails.length) {
  console.log('\nFAILURES:\n' + fails.join('\n'));
}
