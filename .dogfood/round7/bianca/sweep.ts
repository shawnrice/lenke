// EXHAUSTIVE crown-jewel verification: for EVERY class, compare the engine's
// superclass closure (GQL + / Gremlin repeat.emit) and descendant/instance
// closure against the independent JS closure. Any mismatch is the money bug.
import { query } from '@lenke/gql';
import { toArray, traversal, V, out, in_, has, values, repeat, dedupe } from '@lenke/gremlin';

import { buildOntology, closureProper, closureReflexive, descendantsProper } from './ontology';

const onto = buildOntology();
const g = onto.g;

const setEq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a: Set<string>, b: Set<string>) => ({
  missing: [...b].filter((x) => !a.has(x)),
  extra: [...a].filter((x) => !b.has(x)),
});

// Prepared-ish: we call query per class (fine for a few hundred).
function gqlSuper(name: string): Set<string> {
  return new Set(
    (
      query(g, `MATCH (x:Class {name:$n})-[:SUBCLASS_OF]->+(s) RETURN DISTINCT s.name AS n`, {
        n: name,
      }) as any[]
    ).map((r) => r.n),
  );
}
function gremSuper(name: string): Set<string> {
  return new Set(
    toArray(
      traversal(
        V(),
        has('name', name),
        repeat(out('SUBCLASS_OF')).emit(),
        dedupe(),
        values('name'),
      ),
      g,
    ) as string[],
  );
}

let gqlFails = 0;
let gremFails = 0;
let checked = 0;
const sampleFails: string[] = [];

for (const c of onto.classNames) {
  const js = closureProper(onto.parents, c);
  const gq = gqlSuper(c);
  const gr = gremSuper(c);
  checked++;
  if (!setEq(gq, js)) {
    gqlFails++;
    if (sampleFails.length < 12) sampleFails.push(`GQL  ${c}: ${JSON.stringify(diff(gq, js))}`);
  }
  if (!setEq(gr, js)) {
    gremFails++;
    if (sampleFails.length < 12) sampleFails.push(`GREM ${c}: ${JSON.stringify(diff(gr, js))}`);
  }
}

console.log(`SUPERCLASS closure sweep over ${checked} classes:`);
console.log(`  GQL + DISTINCT  mismatches vs JS: ${gqlFails}`);
console.log(`  Gremlin emit    mismatches vs JS: ${gremFails}`);
if (sampleFails.length) console.log('  SAMPLES:\n   ' + sampleFails.join('\n   '));

// ---- Also sweep TYPE-inference closure (instances-of incl subclasses) for a sample of classes ----
console.log('\nTYPE-INFERENCE closure sweep (sample of 40 classes):');
const sample = onto.classNames.filter((_, i) => i % Math.ceil(onto.classNames.length / 40) === 0);
let tiFail = 0;
for (const c of sample) {
  const selfSub = new Set(descendantsProper(onto.children, c));
  selfSub.add(c);
  const expInst = new Set<string>();
  for (const [inst, types] of onto.typeOf) if (types.some((t) => selfSub.has(t))) expInst.add(inst);
  const gq = new Set<string>(
    (
      query(
        g,
        `MATCH (i:Individual)-[:TYPE]->(k)-[:SUBCLASS_OF]->*(t:Class {name:$n}) RETURN DISTINCT i.name AS n`,
        {
          n: c,
        },
      ) as any[]
    ).map((r) => r.n),
  );
  if (!setEq(gq, expInst)) {
    tiFail++;
    console.log(`  MISMATCH ${c}: ${JSON.stringify(diff(gq, expInst))}`);
  }
}
console.log(`  type-inference mismatches: ${tiFail} / ${sample.length}`);

console.log(
  `\nOVERALL: ${gqlFails + gremFails + tiFail === 0 ? 'ALL SETS MATCH JS CLOSURE' : 'MISMATCHES FOUND (see above)'}`,
);
