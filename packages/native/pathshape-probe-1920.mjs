// Item 1920 — WHAT EXACTLY DOES `V().out(T).path()` RETURN, and which spellings share the shape?
//
// `path: hop path` is the Gremlin workload screen's top row — **124.55 ms for 600,000 rows** against
// the plain hop's 50.65 — and it makes `planReadsPath` TRUE, so every fused walk in the package is
// gated out and it runs the generic traverser pipeline. Items 1912/1914 established the pattern for
// riding past that guard: claim the WHOLE plan, so no downstream step can ask for a path.
//
// ⚠️ BUT THE SHAPE HAS TO BE READ OFF THE ENGINE, NOT ASSUMED. CLAUDE.md records hand oracles in
// this corpus being wrong four times in one stretch, and a fusion built on a guessed path layout
// would be a wrong answer that no aggregate shows. So this prints the real thing first: how many
// elements, in what order, and what each one is.
//
//     bun pathshape-probe-1920.mjs
import { Graph } from '@lenke/core';
import {
  V,
  both,
  count,
  in_,
  inV,
  limit,
  out,
  outE,
  path,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const g = new Graph();

for (const id of ['a', 'b', 'c', 'd']) {
  g.addVertex({ id, labels: ['P'], properties: { n: id } });
}

const vx = (id) => g.getVertexById(id);

g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: { w: 1 } });
g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: { w: 2 } });
// A SELF-LOOP, because it is the one shape where near and far are the same element.
g.addEdge({ id: 'e3', from: vx('d'), to: vx('d'), labels: ['E'], properties: { w: 3 } });
g.addEdge({ id: 'e4', from: vx('a'), to: vx('c'), labels: ['F'], properties: { w: 4 } });

/** Render an element or value so the path's CONTENTS are visible, not just its length. */
const show = (v) => {
  if (v === null || v === undefined) {
    return String(v);
  }

  if (typeof v === 'object' && 'id' in v) {
    const kind = 'fromId' in v || 'from' in v ? 'E' : 'V';

    return `${kind}:${String(v.id)}`;
  }

  return JSON.stringify(v);
};

const CASES = [
  ['V().out(E).path()', traversal(V(), out('E'), path())],
  ['V().path()', traversal(V(), path())],
  ['V().out(E).out(E).path()', traversal(V(), out('E'), out('E'), path())],
  ['V().outE(E).path()', traversal(V(), outE('E'), path())],
  ['V().outE(E).inV().path()', traversal(V(), outE('E'), inV(), path())],
  ['V().in(E).path()', traversal(V(), in_('E'), path())],
  ['V().both(E).path()', traversal(V(), both('E'), path())],
  ['V().out(E).values(n).path()', traversal(V(), out('E'), values('n'), path())],
  // What a DECLINING spelling must answer identically — the oracle for any fusion.
  ['V().out(E).path().limit(99)', traversal(V(), out('E'), path(), limit(99))],
  ['V().out(E).path().count()', traversal(V(), out('E'), path(), count())],
  // ⚠️ `path().by(k)` projects EACH element through the modulator — a different answer per element,
  // and a mutant that let the gate admit it SURVIVED item 1920's first battery because no test
  // asked. Printed so the expected values are read off the engine, not guessed.
  ['V().out(E).path().by(n)', traversal(V(), out('E'), path().by('n'))],
];

for (const [name, plan] of CASES) {
  let got;

  try {
    got = toArray(plan, g);
  } catch (e) {
    console.log(`${name.padEnd(32)} THREW ${String(e).slice(0, 50)}`);
    continue;
  }

  const rendered = got.map((p) => (Array.isArray(p) ? `[${p.map(show).join(' ')}]` : show(p)));

  console.log(`${name.padEnd(32)} ${got.length} rows  ${rendered.slice(0, 5).join('  ')}`);
}

console.log(
  '\n⚠️ READ THE ELEMENT KINDS: a fusion may only claim the spellings whose path it can build\n' +
    '   directly. A hop to a VERTEX gives [near, far]; an EDGE step puts the EDGE in the path, and\n' +
    '   `values()` puts a SCALAR there — different layouts, so a single rung cannot serve all three\n' +
    '   without being told which.',
);
