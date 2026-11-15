// Item 1918 — DOES EVERY FUSED WALK EMIT IN THE GENERIC PIPELINE'S ORDER?
//
// `fusableProjectedAggregate` refuses `sum`/`mean` on this premise (`aggregation.ts`, and the same
// decision on the GQL side at items 1830/1853): "an f64 addition is order-sensitive in its last ulp,
// the fused walk's visit order is not the pipeline's by construction, and byte-identity with the
// Rust engine is a hard invariant". It costs 2.7x: `V().out(E).values(k).sum()` measures 174.35 ms
// against the `values` floor's 64.60, to ADD numbers the floor already materialized.
//
// `fusedorder-check-1918.mjs` refuted the premise for ONE shape. But `fusedProjectedResidual` folds
// the residual of WHATEVER walk `fusedProjectedValues` produced — the CSR arm, the bucket arm, a
// chain, a dedupe, an edge-filtered hop — so one shape is not enough. This asks every shape that
// can reach that fold.
//
// ⚠️ THE DECLINE IS A `limit` ABOVE THE ROW COUNT, which `gremlin-route-screen.mjs` reports as
// generic (`[take]`) where the bare spelling is a SHORTCUT. It changes the route and no answer.
//
// ⚠️ AND EVERY ROW CARRIES ITS OWN CONTROL: the same values REVERSED must sum differently, or that
// row's agreement is an artefact of associative input and proves nothing. The first version of the
// single-shape probe failed exactly this and said so.
//
//     bun fusedorder-matrix-1918.mjs
import { Graph } from '@lenke/core';
import {
  V,
  both,
  dedupe,
  gt,
  has,
  inV,
  in_,
  limit,
  out,
  outE,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 5);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['P', 'Q'] : ['P'],
    // A reciprocal ramp: magnitudes span widely and no single term dominates, so reversing the
    // multiset changes the f64. Verified before use — integers would add associatively and could
    // not validate anything.
    properties: { k: 1 / (i + 1), n: i % 50 },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const BIG = 100_000_000;

/**
 * Each row: a name, the fused steps, and the SAME question with the fusion declined.
 *
 * ⚠️ OBJECTS RATHER THAN TUPLES so the spread below is never inferred as possibly-a-string — a
 * mixed tuple `[string, Step[], Step[]]` makes `...fusedSteps` a lint error about spreading a
 * string, which is noise rather than a finding.
 */
const ROWS = [
  {
    name: 'out typed',
    fused: [out('E'), values('k')],
    generic: [out('E'), limit(BIG), values('k')],
  },
  {
    name: 'in typed',
    fused: [in_('E'), values('k')],
    generic: [in_('E'), limit(BIG), values('k')],
  },
  {
    name: 'both typed',
    fused: [both('E'), values('k')],
    generic: [both('E'), limit(BIG), values('k')],
  },
  { name: 'out UNtyped', fused: [out(), values('k')], generic: [out(), limit(BIG), values('k')] },
  {
    name: 'out MULTI-type',
    fused: [out('E', 'F'), values('k')],
    generic: [out('E', 'F'), limit(BIG), values('k')],
  },
  {
    name: 'chain out out',
    fused: [out('E'), out('E'), values('k')],
    generic: [out('E'), out('E'), limit(BIG), values('k')],
  },
  {
    name: 'outE inV',
    fused: [outE('E'), inV(), values('k')],
    generic: [outE('E'), inV(), limit(BIG), values('k')],
  },
  {
    name: 'edge-filtered',
    fused: [outE('E'), has('w', gt(3)), inV(), values('k')],
    generic: [outE('E'), has('w', gt(3)), inV(), limit(BIG), values('k')],
  },
  {
    name: 'far-filtered',
    fused: [out('E'), has('n', gt(10)), values('k')],
    generic: [out('E'), has('n', gt(10)), limit(BIG), values('k')],
  },
  {
    name: 'deduped by key',
    fused: [out('E'), dedupe().by('k'), values('k')],
    generic: [out('E'), dedupe().by('k'), limit(BIG), values('k')],
  },
  {
    name: 'values then dedupe',
    fused: [out('E'), values('k'), dedupe()],
    generic: [out('E'), limit(BIG), values('k'), dedupe()],
  },
];

const add = (xs) => {
  let t = 0;

  for (const x of xs) {
    t += x;
  }

  return t;
};

let bad = 0;
let vacuous = 0;

for (const { name, fused, generic } of ROWS) {
  const a = toArray(traversal(V(), ...fused), g);
  const b = toArray(traversal(V(), ...generic), g);

  let firstDiff = -1;

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      firstDiff = i;
      break;
    }
  }

  const sameOrder = a.length === b.length && firstDiff === -1;
  const sa = add(a);
  const sumsAgree = sa === add(b);
  // THE PER-ROW CONTROL: can this row's value multiset see order at all?
  const canSeeOrder = add([...a].reverse()) !== sa;

  if (!canSeeOrder) {
    vacuous += 1;
  }

  if (!sameOrder || !sumsAgree) {
    bad += 1;
  }

  const verdict = sameOrder && sumsAgree ? '✅ same order, same sum' : '❌ DIFFERS';
  const ctrl = canSeeOrder ? 'control: sees order' : '⚠️ CONTROL VACUOUS — proves nothing';

  console.log(
    `${name.padEnd(20)} ${String(a.length).padStart(7)} vs ${String(b.length).padStart(7)} values   ` +
      `${verdict.padEnd(24)} ${ctrl}`,
  );

  if (!sameOrder) {
    console.log(
      `    first difference at index ${firstDiff}: ${String(a[firstDiff])} vs ${String(b[firstDiff])}`,
    );
  }
}

const vacNote =
  vacuous > 0 ? `   ⚠️ ${vacuous} row(s) had a VACUOUS control and prove nothing` : '';

console.log(
  `\n${bad === 0 ? '✅' : '❌'} ${ROWS.length - bad}/${ROWS.length} shapes agree on BOTH order and sum${vacNote}`,
);
process.exit(bad === 0 && vacuous === 0 ? 0 : 1);
