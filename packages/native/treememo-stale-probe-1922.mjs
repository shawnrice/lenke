// Item 1922 — WHAT FIXTURE MAKES THE TREE-KEY MEMO OBSERVABLE?
//
// FOUR GATE MUTANTS SURVIVED the first battery — "memo ON unconditionally", "keysStable forced
// true", "gate inverted", "keysStable defaults true" — i.e. the tests did NOT catch a memo being
// used on a plan that mutates. That is the whole correctness argument for the gate, so the tests
// were wrong rather than the gate.
//
// WHY THE FIRST FIXTURE COULD NOT SEE IT. `a->b, b->c` with `out(E).property(z,2).tree()`:
// traverser order is a's edges then b's, so for `[a,b]` the property runs on the FAR end `b` BEFORE
// `tree` keys it. `b` is therefore mutated before its FIRST keying, and a memo stores the
// already-mutated key — the same answer either way. The observed "1 of 2 keys mentions z" was just
// "`a` was never mutated, `b` was", not a memo-visible difference.
//
// WHAT IS NEEDED: an element keyed EARLY, mutated LATER, and keyed AGAIN. That needs a CYCLE, so
// that a vertex appearing as a NEAR end in an early path becomes a FAR end (and so gets mutated) in
// a later one.
//
//     bun treememo-stale-probe-1922.mjs
import { Graph } from '@lenke/core';
import { V, out, property, toArray, traversal, tree } from '@lenke/gremlin';

const build = () => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (i) => g.getVertexById(i);

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: {} });
  // THE CYCLE-CLOSING EDGE, which is what makes the staleness observable: `a` is a NEAR end in
  // the first traverser (keyed clean) and the FAR end of this one (so mutated) in the last.
  g.addEdge({ id: 'e3', from: vx('c'), to: vx('a'), labels: ['E'], properties: {} });

  return g;
};

const report = (name, plan) => {
  const g = build();
  const [built] = toArray(plan, g);
  const keys = Object.keys(built);
  const withZ = keys.filter((k) => k.includes('"z"')).length;
  // How many DISTINCT top-level keys mention the same vertex id? Two entries for one id is the
  // signature of the same element keyed on both sides of its own mutation.
  const perId = {};

  for (const k of keys) {
    const id = /"id":"([^"]+)"/.exec(k)?.[1] ?? '?';

    perId[id] = (perId[id] ?? 0) + 1;
  }

  const doubled = Object.entries(perId)
    .filter(([, n]) => n > 1)
    .map(([id, n]) => `${id}x${n}`);

  const dbl = doubled.length > 0 ? `   <- DOUBLE-KEYED: ${doubled.join(',')}` : '';

  console.log(`${name.padEnd(34)} ${keys.length} top keys, ${withZ} mention z${dbl}`);

  /*
   * THE TOP LEVEL CANNOT SHOW IT, which the first version of this probe missed: every vertex has
   * exactly one out-edge, so there are always three top-level keys. The staleness lives in a NESTED
   * position — `a` is keyed CLEAN at the top (traverser 1) and again, after its own mutation, UNDER
   * `c` (traverser 3). So the whole tree has to be read, not its first level.
   */
  const nested = [];

  for (const [k, child] of Object.entries(built)) {
    const nid = /"id":"([^"]+)"/.exec(k)?.[1] ?? '?';

    for (const ck of Object.keys(child)) {
      const cid = /"id":"([^"]+)"/.exec(ck)?.[1] ?? '?';

      nested.push(`${nid}>${cid}${ck.includes('"z"') ? '+z' : ''}`);
    }
  }

  console.log(`${' '.repeat(34)} nested: ${nested.sort().join('  ')}`);
};

report('plain tree (no mutation)', traversal(V(), out('E'), tree()));
report('hop then property then tree', traversal(V(), out('E'), property('z', 2), tree()));

console.log(
  '\nA vertex appearing TWICE among the top-level keys is the same element keyed before and after\n' +
    '   its own mutation — the case a memo would collapse into one. If this fixture shows it and the\n' +
    '   gate is working, a mutant turning the memo on unconditionally MUST change the key count.',
);
