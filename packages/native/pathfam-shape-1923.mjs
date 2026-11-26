// Item 1923 — WHAT DO `simplePath`, `cyclicPath` AND `path().by(k)` ACTUALLY RETURN on a one-hop
// plan, and are they expressible without the path?
//
// Item 1921 made the path-dependent family visible; item 1922 took `tree()`'s key. What is left at
// the top of the Gremlin screen is all in that family:
//
//     pathdep: tree           593.34 ms    (after item 1922's 2.18x)
//     pathdep: path().by(k)   314.01       600,000 rows
//     pathdep: simplePath     308.81       599,998 rows
//     pathdep: cyclicPath     161.82             2 rows
//     -----------------------------------------------------
//     hop1: values             50.21       the same 600,000 rows, fused
//
// THE HYPOTHESIS, which is what this probe tests rather than assumes: on a plan whose path is
// exactly `[near, far]`, `simplePath()` is "near !== far" — the hop MINUS its self-loops — and
// `cyclicPath()` is its complement, only the self-loops. Both would then be tag-free, exactly as
// item 1912 found for `where(neq(tag))` and item 1920 for `path()`.
//
// READ OFF THE ENGINE, NOT PREDICTED. CLAUDE.md records hand oracles in this corpus being wrong
// FIVE times, most recently at item 1921 (`bothE.otherV` was six rows, not five). What these steps
// yield — the far vertex, or the path? — decides whether one row shape can serve them.
//
//     bun pathfam-shape-1923.mjs
import { Graph } from '@lenke/core';
import {
  V,
  count,
  cyclicPath,
  in_,
  limit,
  out,
  outE,
  inV,
  path,
  simplePath,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const g = new Graph();

for (const id of ['a', 'b', 'c', 'd']) {
  g.addVertex({ id, labels: ['P'], properties: { n: id } });
}

const vx = (id) => g.getVertexById(id);

g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: {} });
// THE SELF-LOOP is the ONLY edge `simplePath` and `cyclicPath` disagree on at depth one, so it is
// the whole discrimination.
g.addEdge({ id: 'e3', from: vx('d'), to: vx('d'), labels: ['E'], properties: {} });
g.addEdge({ id: 'e4', from: vx('a'), to: vx('c'), labels: ['F'], properties: {} });

const show = (v) => {
  if (v === null || v === undefined) {
    return String(v);
  }

  if (Array.isArray(v)) {
    return `[${v.map(show).join(' ')}]`;
  }

  if (typeof v === 'object' && 'id' in v) {
    return `${'fromId' in v || 'from' in v ? 'E' : 'V'}:${String(v.id)}`;
  }

  return JSON.stringify(v);
};

const CASES = [
  ['V().out(E)', traversal(V(), out('E'))],
  ['V().out(E).simplePath()', traversal(V(), out('E'), simplePath())],
  ['V().out(E).cyclicPath()', traversal(V(), out('E'), cyclicPath())],
  ['V().out(E).simplePath().values(n)', traversal(V(), out('E'), simplePath(), values('n'))],
  ['V().out(E).path().by(n)', traversal(V(), out('E'), path().by('n'))],
  // Two hops, where `simplePath` is no longer just a self-loop test.
  ['V().out(E).out(E).simplePath()', traversal(V(), out('E'), out('E'), simplePath())],
  // Incoming, and an edge step, to see how far one row shape could reach.
  ['V().in(E).simplePath()', traversal(V(), in_('E'), simplePath())],
  ['V().outE(E).inV().simplePath()', traversal(V(), outE('E'), inV(), simplePath())],
  // The declining spellings — the oracle for any fusion that claims the whole plan.
  ['V().out(E).simplePath().limit(99)', traversal(V(), out('E'), simplePath(), limit(99))],
  ['V().out(E).simplePath().count()', traversal(V(), out('E'), simplePath(), count())],
];

for (const [name, plan] of CASES) {
  let got;

  try {
    got = toArray(plan, g);
  } catch (e) {
    console.log(`${name.padEnd(36)} THREW ${String(e).slice(0, 50)}`);
    continue;
  }

  console.log(
    `${name.padEnd(36)} ${String(got.length).padStart(2)} rows  ${got.map(show).join('  ')}`,
  );
}

console.log(
  '\nTHE QUESTION TO READ OFF THIS: does `simplePath()` yield the FAR VERTEX (so the row shape is\n' +
    "   the plain hop's, and the step is only a filter) or the PATH? And is the only difference from\n" +
    '   `out(E)` the self-loop? If both hold at depth one, the shape is tag-free.',
);
