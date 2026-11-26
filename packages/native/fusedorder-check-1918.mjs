// Item 1918 — IS THE FUSED WALK'S ELEMENT ORDER THE SAME AS THE GENERIC PIPELINE'S?
//
// `fusableProjectedAggregate` admits `min`/`max` and REFUSES `sum`/`mean`, on this argument
// (`aggregation.ts`): "Those two are ORDER-SENSITIVE in the last ulp of an f64 addition, and
// byte-identity with the Rust engine is a hard invariant here — a different summation order is a
// different answer. The fused walk's visit order is not the traverser pipeline's by construction."
//
// That refusal costs real time: `V().out(E).values(k).sum()` measures **174.35 ms against the
// `values` floor's 64.60** — 2.7x to ADD numbers the floor already materialized — and `mean` 185.36.
// `min`/`max`, which are fused, sit at 86.44 / 74.70.
//
// A "NOT BUILT BECAUSE X" NOTE IS A CLAIM ABOUT X. The premise here is checkable: if the fused
// walk emits in the SAME order as the generic pipeline, then summing in the fused order is summing
// in the contract order, and the ulp argument does not bind.
//
// AND THERE IS A SECOND, STRONGER REASON TO CHECK: the fused `values` walk's OUTPUT ORDER is
// already a compared answer. `out(E).values(k)` returns 800,000 values whose order the differential
// fuzzer compares against Rust element for element. So the fused order either already equals the
// contract order, or `values` itself is broken.
//
// THE DECLINE: `gremlin-route-screen.mjs` reports `hop1: limit values` as generic (1 `applyStep`
// call, `[take]`) where `hop1: values` is a SHORTCUT with 0 — so a `limit` above the row count
// forces the generic pipeline while changing no answer.
//
//     bun fusedorder-check-1918.mjs
import { Graph } from '@lenke/core';
import { V, limit, out, sum, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 5);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['P'],
    /**
     * VALUES THAT MAKE SUMMATION ORDER OBSERVABLE, and the FIRST ATTEMPT DID NOT. Integers add
     * associatively, so a fixture of them could not validate anything — but neither could the first
     * try here (`i % 7 === 0 ? 1e16 : 1 / (i + 3)`): the big term recurs ~N/7 times, dominates, and
     * the sum came out bit-identical FORWARD AND REVERSED. The control below caught that and said
     * so. A reciprocal ramp spans magnitudes without one term dominating, and reversing it does
     * change the f64 (verified before it went in here).
     */
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

const FUSED = traversal(V(), out('E'), values('k'));
const GENERIC = traversal(V(), out('E'), limit(10_000_000), values('k'));

const a = toArray(FUSED, g);
const b = toArray(GENERIC, g);

console.log(`fused   ${a.length} values`);
console.log(`generic ${b.length} values   (limit 10,000,000 forces the generic pipeline)`);

let firstDiff = -1;

for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) {
    firstDiff = i;
    break;
  }
}

const sameLen = a.length === b.length;
const sameOrder = sameLen && firstDiff === -1;

console.log(
  sameOrder
    ? "ELEMENT ORDER IS IDENTICAL — the refusal's premise (\"the fused walk's visit order is not\n" +
        '   the traverser pipeline\'s by construction") does not hold for this shape.'
    : `ORDER DIFFERS at index ${firstDiff} (lengths ${a.length} vs ${b.length}) — the refusal stands.`,
);

// And the consequence the refusal is actually about: do the two orders sum to the same f64?
const add = (xs) => {
  let t = 0;

  for (const x of xs) {
    t += x;
  }

  return t;
};

const sa = add(a);
const sb = add(b);

console.log(`\nsum in fused order   ${sa.toExponential(20)}`);
console.log(`sum in generic order ${sb.toExponential(20)}`);
console.log(
  sa === sb
    ? 'bit-identical, as identical orders must be'
    : 'the two orders sum DIFFERENTLY — this is the ulp hazard, and it is real for this fixture',
);

// A control proving the fixture CAN expose an order difference, so the agreement above is evidence
// rather than an artefact of associative input.
const shuffled = [...a].reverse();

const revSum = add(shuffled);
const revNote =
  revSum === sa
    ? 'equal — this fixture cannot see order, so it proves nothing'
    : 'differs, so this fixture CAN see summation order';

console.log(`\nCONTROL sum of the SAME values REVERSED ${revSum.toExponential(20)}  ${revNote}`);

// What the engine itself answers through each route, for completeness.
console.log(
  `\nengine sum, fused route declined (limit): ${toArray(traversal(V(), out('E'), limit(10_000_000), values('k'), sum()), g)[0].toExponential(20)}`,
);
console.log(
  `engine sum, normal spelling:              ${toArray(traversal(V(), out('E'), values('k'), sum()), g)[0].toExponential(20)}`,
);
