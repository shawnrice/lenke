/**
 * Can ANY pipeline observe `match()` sharing its live tag map? (item 1560)
 *
 * The solver carries one mutable tag map down its DFS and snapshots it per solution, because
 * `extend` propagates `tags` by reference. Item 1560 made that snapshot conditional — and then
 * three mutants that skip it when it IS supposedly needed survived the whole suite, including a
 * `barrier()` test written specifically to catch them.
 *
 * The hypothesis that failed: "a buffering step makes sharing observable." The pipeline is
 * pull-based, so a consumer reads a traverser's tags before the solver advances; if nothing
 * actually retains traversers across the solver's next step, sharing is never observable.
 *
 * This probe exists to settle it by EXPERIMENT rather than by reading step impls: run the same
 * question through every shape that might retain traversers, and compare against the known answer.
 * Run it against a build with the snapshot FORCED OFF — any row that disagrees with the comment
 * below is a shape where the snapshot is load-bearing, and the one to write a test around.
 *
 * Correct answers, from a build with the snapshot always ON:
 *   plain select        [2,3,3]
 *   barrier+select      [2,3,3]
 *   aggregate+select    [2,3,3]
 *   dedupe+select       [2,3,3]
 */
import { Graph } from '@lenke/core';
import * as m from '@lenke/gremlin';

const g = new Graph();
const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
g.addEdge({ id: 'e2', from: b, to: c, labels: ['E'] });
g.addEdge({ id: 'e3', from: a, to: c, labels: ['E'] });

const pat = () => m.match(m.pipe(m.as_('a'), m.out('E'), m.as_('b')));

const SHAPES = {
  'plain select': () => m.traversal(m.V(), pat(), m.select('b'), m.values('k')),
  'barrier+select': () => m.traversal(m.V(), pat(), m.barrier(), m.select('b'), m.values('k')),
  'aggregate+select': () =>
    m.traversal(m.V(), pat(), m.aggregate('x'), m.select('b'), m.values('k')),
  'dedupe+select': () => m.traversal(m.V(), pat(), m.dedupe(), m.select('b'), m.values('k')),
  'order after select': () => m.traversal(m.V(), pat(), m.select('b'), m.order(), m.values('k')),
  'fold after select': () => m.traversal(m.V(), pat(), m.select('b'), m.values('k'), m.fold()),
  'count (the skip path)': () => m.traversal(m.V(), pat(), m.count()),
  // Retain the traversers by hand: drain `run` into an array, THEN read. This is the strongest
  // form — if even this cannot see the sharing, nothing in the pipeline can.
  'manual drain': null,
};

for (const [name, build] of Object.entries(SHAPES)) {
  if (build === null) {
    continue;
  }

  let out;

  try {
    out = JSON.stringify(m.toArray(build(), g));
  } catch (e) {
    out = `THREW: ${e.message.slice(0, 70)}`;
  }

  console.log(name.padEnd(24), out);
}

// The manual drain: collect every emitted traverser value first, read nothing until the solver has
// finished entirely, then look. `run` yields VALUES (the bindings map), so this reads the bindings
// each traverser carried rather than going through `select`.
const drained = [...m.run(m.traversal(m.V(), pat()), g)];

console.log(
  'manual drain'.padEnd(24),
  JSON.stringify(drained.map((row) => (row instanceof Map ? row.get('b')?.id : row))),
);
