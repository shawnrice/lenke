/**
 * Item 2015 — answer-equivalence battery for `V().branch(values(k)).option(m, <arm>)….none(<arm>)`.
 *
 * ⚠️⚠️ **THE FIXTURE THAT PRICED THIS RUNG CANNOT CHECK IT.** `coalesce-vs-optional-1990.mjs` gives
 * EVERY vertex an `n` and an out-edge, so three of the four semantics this route has to get right
 * are invisible there:
 *
 * ```text
 *     a MISSING test key   -> `values(k)` yields NOTHING, so `sawResult` is false and the traverser
 *                             goes to `default` — NOT to an `option(undefined)`
 *     NO `none()` arm      -> an unmatched traverser is DROPPED, the OPPOSITE of `choose`'s
 *                             absent-else pass-through (item 2014's rung)
 *     a MISSING projected
 *     key on a FAR vertex  -> `values(k)` drops the row rather than emitting `undefined`
 * ```
 *
 * So this fixture makes the test key sparse, the projected key sparser, leaves one vertex matching
 * no option, and gives one vertex no edge at all.
 *
 * ⚠️ COMPARED POSITIONALLY against the general path, not as a checksum. Gremlin stream order for a
 * single-type step with no `order()` is compared ORDERED against native by `gremlin-fuzz`'s
 * `unordered` decision ([[order-is-unspecified]] does not cover it), so a route that reorders is
 * WRONG rather than merely different — and a checksum cannot see that (item 1955).
 *
 * HOW TO GET THE ORACLE: make the rung DECLINE — replace `branchValueHop(effective, graph)` in
 * `fusedProjectedValues`' chain with `(false ? branchValueHop(effective, graph) : undefined)`,
 * rebuild (`npx nx build @lenke/gremlin`), run, keep the output; then restore, rebuild, run, diff.
 *
 * ⚠️ NOT `undefined ??` IN FRONT, which is what `battery-2014.mjs` used to say: `undefined ?? f()`
 * evaluates `f()`, so it disables nothing and compares the route against itself. See that file's
 * header for the correction.
 *
 *     cd packages/native && bun battery-2015.mjs
 */
import { Graph } from '@lenke/core';
import {
  both,
  branch,
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
 * ⚠️ `t` IS THE TEST KEY (SPARSE) AND `p` THE PROJECTED ONE (SPARSER). The `t` values deliberately
 * include one that matches no option (2), one vertex with no `t` at all, a vertex with no `p`, and a
 * vertex with no edge of any type.
 */
const VERTS = [
  ['a', { t: 0, p: 10 }],
  ['b', { t: 1, p: 11 }],
  ['c', { t: 2, p: 12 }],
  ['d', { t: 0 }],
  ['e', { p: 14 }],
  ['f', { t: 0 }],
  ['h', { t: 'x', p: 16 }],
  ['i', { t: true, p: 17 }],
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
E('e2', 'a', 'd'); // `d` has no `p`, so a `values('p')` projection must DROP this row
E('e3', 'c', 'b');
E('e4', 'd', 'e', 'F'); // an F edge only
E('e5', 'h', 'i');
E('e6', 'i', 'h');
// `f` has no edge of any type.

const B = () => branch(values('t'));

const SHAPES = {
  'two hops + none, values': () =>
    traversal(V(), B().option(0, out('E')).option(1, in_('E')).none(identity()), values('p')),
  'two hops + none, elements': () =>
    traversal(V(), B().option(0, out('E')).option(1, in_('E')).none(identity())),
  // ⚠️ NO `none()` — an unmatched traverser is DROPPED, which is the semantic `choose` reverses.
  'no none, values': () => traversal(V(), B().option(0, out('E')), values('p')),
  'no none, elements': () => traversal(V(), B().option(0, out('E'))),
  'identity option, hop none': () =>
    traversal(V(), B().option(0, identity()).none(out('E')), values('p')),
  'both arm': () => traversal(V(), B().option(0, both('E')).none(identity()), values('p')),
  'untyped arm': () => traversal(V(), B().option(0, out()).none(identity()), values('p')),
  'multi-type arm': () =>
    traversal(V(), B().option(0, out('E', 'F')).none(identity()), values('p')),
  'inward none': () => traversal(V(), B().option(0, out('E')).none(in_('E')), values('p')),
  'string + bool keys': () =>
    traversal(V(), B().option('x', out('E')).option(true, in_('E')).none(identity()), values('p')),
  'all identity': () => traversal(V(), B().option(0, identity()).none(identity()), values('p')),
  'id projection': () => traversal(V(), B().option(0, out('E')).none(identity()), values('p')),
  'duplicate option key': () =>
    traversal(V(), B().option(0, out('E')).option(0, in_('E')).none(identity()), values('p')),
  'trailing step': () =>
    traversal(V(), B().option(0, out('E')).none(identity()), values('p'), identity()),
  // ⚠️ SHAPES THE RUNG MUST DECLINE — here so a gate that wrongly admits one shows as a diff.
  'LIST KEY (declines)': () => traversal(V(), B().option([1], out('E')).none(identity())),
  'NaN KEY (declines)': () => traversal(V(), B().option(Number.NaN, out('E')).none(identity())),
  'NULL KEY (declines)': () => traversal(V(), B().option(null, out('E')).none(identity())),
  'HOP TEST (declines)': () =>
    traversal(V(), branch(out('E')).option(0, out('E')).none(identity())),
  'MULTI-KEY TEST (declines)': () =>
    traversal(V(), branch(values('t', 'p')).option(0, out('E')).none(identity())),
  'CONST ARM (declines)': () => traversal(V(), B().option(0, constant('x')).none(identity())),
  'CONST NONE (declines)': () => traversal(V(), B().option(0, out('E')).none(constant('x'))),
  'MULTI-STEP ARM (declines)': () =>
    traversal(
      V(),
      B()
        .option(0, traversal(out('E'), out('E')))
        .none(identity()),
    ),
  'NARROWED SOURCE (declines)': () =>
    traversal(V('a'), B().option(0, out('E')).none(identity()), values('p')),
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

  console.log(
    `${same ? '  ' : '⚠️'} ${name.padEnd(28)} ${same ? got[0] : got.join('\n     VS  ')}`,
  );
}

console.log(`\n${String(unstable)} UNSTABLE`);
