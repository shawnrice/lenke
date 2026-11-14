/**
 * WHICH GREMLIN SHAPES FALL THROUGH EVERY SHORTCUT? (item 1855)
 *
 * ⚠️ THE GQL TWIN FOUND A 27.7x GAP AND THIS SURFACE HAS NO EQUIVALENT SCREEN. Item 1854 could ask
 * `compileLinear` directly which detectors claim a shape, because the GQL planner hands back a
 * `CLinear` whose fields ARE the routes. Gremlin has no such object: `run` is a ladder of
 * shortcuts, each returning early, and a plan that matches none of them simply falls through to
 * the generic traverser pipeline. So "which rung claimed this?" cannot be read off a value.
 *
 * ⚠️ SO THE SIGNAL IS `applyStep`, THE GENERIC PIPELINE'S SINGLE ENTRY. Every step the generic
 * path executes goes through it; a whole-plan shortcut returns before the loop is reached. Patching
 * that ONE function to count its calls therefore separates "a shortcut answered this" from "the
 * traverser pipeline ran", which is exactly the route question — and it reports the STEP KINDS it
 * saw, so a plan that is partly fused reads differently from one that is wholly generic.
 *
 * ⚠️ IT IS A MUTATION RUN, so it keeps a pristine copy under `target/` and restores in a `finally`
 * — an interrupted run must not leave an instrumented engine in the tree. The instrumented build is
 * asserted present before any shape is measured, because a silently-unpatched build would report
 * every shape as "shortcut" and look like very good news.
 *
 * ⚠️ AND A GENERIC ROUTE IS NOT AUTOMATICALLY A DEFECT. Most Gremlin steps have no shortcut and
 * never will; the pipeline IS the implementation. What this screen is for is the shape whose
 * NEIGHBOUR is fused while it is not — `out().values()` fused but `out().out().values()` not, say.
 * So the output groups by base and marks the shapes whose siblings differ.
 *
 *     bun gremlin-route-screen.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/dispatch.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1855-dispatch.ts`;
const MARKER = 'ROUTE_SCREEN_1855';

const ANCHOR = `export const applyStep = (`;

/** Each traversal, as the source a child will evaluate. Grouped so siblings sit together. */
const SHAPES = {
  'scan: values': "traversal(V(), values('k'))",
  'scan: hasLabel values': "traversal(V(), hasLabel('T'), values('k'))",
  'scan: count': 'traversal(V(), count())',
  'scan: dedupe values': "traversal(V(), values('k'), dedupe())",
  'scan: order values': "traversal(V(), values('k'), order())",
  'scan: limit values': "traversal(V(), values('k'), limit(10))",
  'hop1: values': "traversal(V(), out('E'), values('k'))",
  'hop1: count': "traversal(V(), out('E'), count())",
  'hop1: id': "traversal(V(), out('E'), id())",
  'hop1: dedupe count': "traversal(V(), out('E'), dedupe(), count())",
  'hop1: has count': "traversal(V(), out('E'), has('k', 3), count())",
  'hop1: order values': "traversal(V(), out('E'), values('k'), order())",
  'hop1: limit values': "traversal(V(), out('E'), values('k'), limit(10))",
  'hop2: values': "traversal(V(), out('E'), out('E'), values('k'))",
  'hop2: count': "traversal(V(), out('E'), out('E'), count())",
  'hop2: dedupe count': "traversal(V(), out('E'), out('E'), dedupe(), count())",
  'hop2: order values': "traversal(V(), out('E'), out('E'), values('k'), order())",
  'hop3: values': "traversal(V(), out('E'), out('E'), out('E'), values('k'))",
  'hop3: count': "traversal(V(), out('E'), out('E'), out('E'), count())",
  'agg: values sum': "traversal(V(), values('k'), sum())",
  'agg: hop values sum': "traversal(V(), out('E'), values('k'), sum())",
  'agg: groupCount': "traversal(V(), groupCount().by('k'))",
  'agg: hop groupCount': "traversal(V(), out('E'), groupCount().by('k'))",
  'agg: hop2 groupCount': "traversal(V(), out('E'), out('E'), groupCount().by('k'))",
};

const IMPORTS =
  "import { V, count, dedupe, groupCount, has, hasLabel, id, limit, order, out, sum, toArray, traversal, values } from '@lenke/gremlin';";

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerInDist = () =>
  readFileSync(`${ROOT}/packages/gremlin/dist/esm/index.mjs`, 'utf8').includes(MARKER);

const measure = (src) => {
  const code = `
import { Graph } from '@lenke/core';
${IMPORTS}
const N = 2000;
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['T'], properties: { k: i % 7 } });
}
for (let i = 0; i < N; i += 1) {
  g.addEdge({ id: 'e' + i, from: g.getVertexById('v' + i), to: g.getVertexById('v' + ((i * 7 + 3) % N)), labels: ['E'] });
}
globalThis.${MARKER} = [];
toArray(${src}, g);
const kinds = [...new Set(globalThis.${MARKER})].sort();
process.stdout.write(JSON.stringify({ calls: globalThis.${MARKER}.length, kinds }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', code], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

copyFileSync(SRC, PRISTINE);

try {
  const s = readFileSync(PRISTINE, 'utf8');

  if (s.split(ANCHOR).length - 1 !== 1) {
    throw new Error('applyStep anchor not found exactly once — the probe needs updating');
  }

  writeFileSync(
    SRC,
    s.replace(
      `${ANCHOR}
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {`,
      `${ANCHOR}
  step: Step,
  stream: Iterable<Traverser<unknown>>,
  graph: Graph,
  ctx: RunContext = newContext(),
): Iterable<Traverser<unknown>> => {
  const ${MARKER}_sink = (globalThis as Record<string, unknown>).${MARKER};

  if (Array.isArray(${MARKER}_sink)) {
    ${MARKER}_sink.push(step.kind);
  }
`,
    ),
  );
  build();

  if (!markerInDist()) {
    throw new Error('ARM ASSERTION FAILED: the instrumented build does not carry the marker');
  }

  console.log('# gremlin-route-screen — `applyStep` calls mean the GENERIC pipeline ran\n');
  console.log('# 0 calls = a whole-plan shortcut answered it\n');

  const rows = [];

  for (const [name, src] of Object.entries(SHAPES)) {
    const r = measure(src);

    rows.push([name, r]);
    console.log(
      `  ${r.calls === 0 ? 'SHORTCUT' : 'generic '}  ${name.padEnd(24)} ${String(r.calls).padStart(7)} applyStep call(s)${r.kinds.length > 0 ? `   [${r.kinds.join(' ')}]` : ''}`,
    );
  }

  // Siblings that disagree: same base, one fused and one not.
  const byBase = new Map();

  for (const [name, r] of rows) {
    const [base] = name.split(':');

    byBase.set(base, [...(byBase.get(base) ?? []), [name, r.calls === 0]]);
  }

  const split = [...byBase].filter(([, v]) => new Set(v.map(([, fused]) => fused)).size > 1);

  console.log(
    '\n# bases whose shapes DISAGREE on the route (a fused sibling beside a generic one):',
  );

  for (const [base, v] of split) {
    console.log(
      `  ${base}: ${v.map(([n, fused]) => `${n.split(': ')[1]}=${fused ? 'fused' : 'generic'}`).join(', ')}`,
    );
  }

  console.log(
    '\n# ⚠️ A generic route is NOT a defect on its own — most steps have no shortcut and never ' +
      'will. The candidates are the DISAGREEMENTS above, and each still needs pricing against its ' +
      'own sibling before it is a finding (item 1854: a route difference is not always a cost one).',
  );
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('# restored and rebuilt');
}
