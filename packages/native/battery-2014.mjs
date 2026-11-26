/**
 * Item 2014 — answer-equivalence battery for `choose(<one hop>, <value arm>, <value arm>)`.
 *
 * **THE FIXTURE THAT PRICED THIS RUNG CANNOT CHECK IT.** `coalesce-vs-optional-1990.mjs` gives
 * every vertex an `n`, so `values(n)` never drops a row there — and dropping is the one thing the
 * three arm kinds disagree about:
 *
 * ```text
 *     values(k)     emits NOTHING for a vertex without `k`  — the row DISAPPEARS
 *     identity()    emits the vertex itself                 — always one row
 *     constant(c)   emits `c`                               — always one row
 * ```
 *
 * A route that emitted `undefined` for a missing key would agree on that fixture and diverge on any
 * graph with a sparse property. So this fixture makes the property sparse on purpose.
 *
 * COMPARED POSITIONALLY against the general path. Gremlin stream order for a single-type step with
 * no `order()` is compared ORDERED against native by `gremlin-fuzz`'s `unordered` decision
 * ([[order-is-unspecified]] does not cover it), so a route that reorders is WRONG rather than merely
 * different — and a checksum cannot see that (item 1955).
 *
 * HOW TO GET THE ORACLE: make the rung DECLINE — replace `chooseTestValues(effective, graph)` in
 * `fusedProjectedValues`' chain with `(false ? chooseTestValues(effective, graph) : undefined)`,
 * rebuild (`npx nx build @lenke/gremlin`), run, keep the output; then restore, rebuild, run, diff.
 *
 * **THIS LINE USED TO SAY "put `undefined ??` in front", WHICH DISABLES NOTHING** — `undefined
 * ?? f()` evaluates `f()`, so following it compares the fused route against ITSELF and reports a
 * clean oracle for any wrong answer whatsoever. It is CLAUDE.md's "assert each A/B arm IS the code
 * it claims" in the one place that rule is hardest to see, because both arms build and both run.
 * Item 2015 found it, and re-ran this battery against a real decline: identical, so item 2014's
 * verdict stands — the recipe was wrong, not the route.
 *
 *     cd packages/native && bun battery-2014.mjs
 */
import { Graph } from '@lenke/core';
import {
  both,
  choose,
  constant,
  identity,
  in_,
  out,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const g = new Graph();

/*
 * `n` IS SPARSE AND `m` IS SPARSER. `a`,`c`,`e` have `n`; `b`,`d`,`f` do not — so a `values('n')`
 * arm must DROP exactly those three, and only a fixture shaped like this can tell that from emitting
 * `undefined`. `f` additionally has NO edge of any type, so it exercises the else arm as well.
 */
const VERTS = [
  ['a', { n: 1, m: 'x' }],
  ['b', {}],
  ['c', { n: 3 }],
  ['d', {}],
  ['e', { n: 5, m: 'y' }],
  ['f', {}],
];

for (const [id, props] of VERTS) {
  g.addVertex({ id, labels: ['P'], properties: props });
}

const E = (k, fr, t, l) =>
  g.addEdge({
    id: k,
    from: g.getVertexById(fr),
    to: g.getVertexById(t),
    labels: [l ?? 'E'],
    properties: {},
  });

E('e1', 'a', 'b');
E('e2', 'b', 'c');
E('e3', 'c', 'a'); // a 2-cycle through a
E('e4', 'd', 'e', 'F'); // only an F edge — `d` passes an F test and fails an E one
// `e` has an inbound F edge only; `f` has none at all.

const SHAPES = {
  'E test, values/constant': () => traversal(V(), choose(out('E'), values('n'), constant('none'))),
  'E test, constant/values': () => traversal(V(), choose(out('E'), constant('none'), values('n'))),
  'E test, values/identity': () => traversal(V(), choose(out('E'), values('n'), identity())),
  'E test, identity/constant': () => traversal(V(), choose(out('E'), identity(), constant('none'))),
  // NO ELSE ARM — per TinkerPop the traverser passes through, which is a different answer from an
  // empty arm and the thing `chooseStep`'s comment records against the AST's.
  'E test, values, no else': () => traversal(V(), choose(out('E'), values('n'))),
  'E test, constant, no else': () => traversal(V(), choose(out('E'), constant('none'))),
  // A SPARSER key, so both arms can drop.
  'E test, m/m': () => traversal(V(), choose(out('E'), values('m'), values('m'))),
  // The test's own shapes: inward, `both`, a type only one vertex has, multi-type, untyped.
  'IN test': () => traversal(V(), choose(in_('E'), values('n'), constant('none'))),
  'BOTH test': () => traversal(V(), choose(both('E'), values('n'), constant('none'))),
  'F test': () => traversal(V(), choose(out('F'), values('n'), constant('none'))),
  'multi-type test': () => traversal(V(), choose(out('E', 'F'), values('n'), constant('none'))),
  'untyped test': () => traversal(V(), choose(out(), values('n'), constant('none'))),
  // SHAPES THE RUNG MUST DECLINE — here so a gate that wrongly admits one shows as a diff.
  'HOP ARM (declines)': () => traversal(V(), choose(out('E'), out('E'), constant('none'))),
  'TWO-KEY values (declines)': () =>
    traversal(V(), choose(out('E'), values('n', 'm'), constant('none'))),
  'TWO-STEP TEST (declines)': () =>
    traversal(V(), choose(traversal(out('E'), out('E')), values('n'), constant('none'))),
  'NARROWED SOURCE (declines)': () =>
    traversal(V('a'), choose(out('E'), values('n'), constant('none'))),
  // A trailing step after the wrapper, so `rest` is exercised.
  'with a trailing step': () =>
    traversal(V(), choose(out('E'), values('n'), constant('none')), identity()),
};

const render = (t) =>
  JSON.stringify(
    toArray(t, g).map((x) => (x && typeof x === 'object' && 'id' in x ? `V(${String(x.id)})` : x)),
  );

let unstable = 0;

console.log(`|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)}  three asks each\n`);

for (const [name, make] of Object.entries(SHAPES)) {
  // Three asks: this rung holds no per-graph memo, so all three must agree — and if a later edit
  // adds one, a divergence here is how that shows up.
  const got = [render(make()), render(make()), render(make())];
  const same = got[0] === got[1] && got[1] === got[2];

  if (!same) {
    unstable += 1;
  }

  console.log(`${same ? '  ' : ''} ${name.padEnd(28)} ${same ? got[0] : got.join('\n     VS  ')}`);
}

console.log(`\n${String(unstable)} UNSTABLE`);
