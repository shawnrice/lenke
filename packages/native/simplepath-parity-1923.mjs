// Item 1923 — DOES THE REWRITTEN `simplePath` ANSWER WHAT THE GENERIC ONE ANSWERS, AT SCALE?
//
// `V().out(T).simplePath()` is rewritten to `V().as_(t).out(T).where(neq(t))` — a shape item 1912
// already fuses — because at depth one `simplePath` is "near !== far", the hop minus its self-loops.
// **308.81 -> 37.81 ms, 8.17x.**
//
// THAT LANDS BELOW THE PLAIN HOP'S 50.21, WHICH LOOKS WRONG AND IS NOT: item 1913 measured
// exactly this fused shape at 38.96 against the hop control's 41.18 and noted it "should always have
// been below — it reads the same properties minus the self-loops". So the rewrite lands on an
// independently measured number rather than on a surprise. Corroboration, not a coincidence.
//
// STILL, A ROW COUNT CANNOT TELL A CORRECT REWRITE FROM ONE THAT DROPS THE WRONG ROWS. The oracle
// is a DECLINING spelling: a `limit` above the row count makes the plan one step too long, so the
// gate refuses and the generic path answers the identical question.
//
//     bun simplepath-parity-1923.mjs
import { Graph } from '@lenke/core';
import {
  V,
  cyclicPath,
  in_,
  limit,
  out,
  simplePath,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8 } });
}

let selfLoops = 0;

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);
  const to = (i * 7 + 3 + hop * 2_654_435_761) % N;

  if (to === i) {
    selfLoops += 1;
  }

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(to + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

// THE FIXTURE MUST CONTAIN SELF-LOOPS or `simplePath` and the plain hop agree and the comparison
// proves nothing — the shape of error CLAUDE.md's "an answer INVARIANT to the property you varied"
// rule is about.
console.log(`fixture: ${N} vertices, ${N * FANOUT} edges, ${selfLoops} self-loop(s)`);

if (selfLoops === 0) {
  console.error(
    'NO SELF-LOOPS: simplePath cannot differ from the plain hop here. Probe is vacuous.',
  );
  process.exit(1);
}

/** An element's id, or the value itself for a scalar row. */
const idOf = (v) => String(v?.id ?? v);

const BIG = 100_000_000;

const ROWS = [
  { name: 'out E', fused: [out('E'), simplePath()], generic: [out('E'), simplePath(), limit(BIG)] },
  { name: 'in E', fused: [in_('E'), simplePath()], generic: [in_('E'), simplePath(), limit(BIG)] },
  {
    name: 'out E + values',
    fused: [out('E'), simplePath(), values('n')],
    generic: [out('E'), simplePath(), values('n'), limit(BIG)],
  },
  // The complement, which is NOT rewritten — it must be untouched.
  {
    name: 'cyclicPath (refused)',
    fused: [out('E'), cyclicPath()],
    generic: [out('E'), cyclicPath(), limit(BIG)],
  },
  // Depth two, which is a DIFFERENT test and must stay generic.
  {
    name: 'two hops (refused)',
    fused: [out('E'), out('E'), simplePath()],
    generic: [out('E'), out('E'), simplePath(), limit(BIG)],
  },
];

let bad = 0;

for (const { name, fused, generic } of ROWS) {
  // Asked TWICE so both the cold (bucket) and warm (CSR) arms are compared — item 1891's reason.
  for (const pass of ['cold', 'warm']) {
    const a = toArray(traversal(V(), ...fused), g);
    const b = toArray(traversal(V(), ...generic), g);
    let firstDiff = -1;

    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (idOf(a[i]) !== idOf(b[i])) {
        firstDiff = i;
        break;
      }
    }

    const ok = a.length === b.length && firstDiff === -1;

    if (!ok) {
      bad += 1;
    }

    console.log(
      `${name.padEnd(22)} ${pass.padEnd(5)} fused ${String(a.length).padStart(7)}  ` +
        `generic ${String(b.length).padStart(7)}  ${ok ? 'identical' : `DIFFERS at ${firstDiff}`}`,
    );
  }
}

// And the arithmetic: simplePath must drop exactly the self-loops of that type.
const plain = toArray(traversal(V(), out('E')), g).length;
const simple = toArray(traversal(V(), out('E'), simplePath()), g).length;
const cyclic = toArray(traversal(V(), out('E'), cyclicPath()), g).length;

const partitions = plain === simple + cyclic;
const verdict = partitions ? 'they partition the hop' : 'THEY DO NOT PARTITION IT';

console.log(`\nout(E) ${plain} = simplePath ${simple} + cyclicPath ${cyclic}  ${verdict}`);
process.exit(bad === 0 && partitions ? 0 : 1);
