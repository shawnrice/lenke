/**
 * WHICH GREMLIN STEPS CANNOT CROSS THE TEXT BOUNDARY, AND WHOSE FAULT IS IT?
 *
 * The gremlin differential fuzzer feeds the Rust engine by emitting Gremlin TEXT with
 * `planToGremlin`. A step with no arm there can never be compared against native, however many
 * plans are generated — which is how `match()` went years with two wrong answers (items
 * 1793/1794), and how `simplePath`/`cyclicPath` silently cost 28 of every 400 plans before that.
 *
 * ⚠️ THE FUZZER ALREADY TREATS AN EMITTER GAP AS A FINDING rather than a skip, and this does not
 * duplicate that check. The fuzzer's only fires for a step the GENERATOR builds. A step in neither
 * the generator's pool nor the emitter has NO differential coverage at all, and nothing reports it.
 * That is the hole this measures.
 *
 * Three questions per step, each ANSWERED BY RUNNING rather than by reading:
 *
 *   nativeParses   — does the Rust engine accept the step as TEXT? (a string literal in the crate
 *                    can just as easily be an error message)
 *   tsBuilds       — does `@lenke/gremlin`'s builder produce a plan?
 *   emits          — does `planToGremlin` render that plan, or throw?
 *
 * A step that parses natively and builds in TS but does NOT emit is a pure EMITTER GAP: both
 * engines implement it and nothing compares them. That is the `match()` case exactly.
 *
 * ⚠️ AN EARLIER CUT OF THIS PROBE READ `emit.ts` FOR `case '<kind>'` INSTEAD, AND IT LIED TWICE.
 * `as` is handled by an `if` ABOVE the switch and the algorithm steps by a table, so both read as
 * missing; and the control rows were keyed by their DISPLAY NAME rather than their step kind, so
 * `out` — which obviously emits — printed "NO ARM". Calling the emitter is the only oracle here
 * that cannot be fooled by how the emitter is written. The source scan is gone rather than fixed.
 */

import * as G from '@lenke/gremlin';

import { nativeBackend, NATIVE_LIB } from './src/conformance-harness.js';

const MODERN = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"edge","id":"7","labels":["KNOWS"],"from":"1","to":"2","properties":{"weight":0.5}}',
  '{"type":"edge","id":"9","labels":["CREATED"],"from":"1","to":"3","properties":{"weight":0.4}}',
].join('\n');

/**
 * `[step kind, native TEXT, () => Plan]`. Each text is a shape where the step is REACHED, not
 * merely present: a step after a filter that matches nothing parses the same and runs never.
 */
const CASES = [
  [
    'where',
    "g.V().where(__.out('KNOWS')).count()",
    () => G.traversal(G.V(), G.where(G.pipe(G.out('KNOWS'))), G.count()),
  ],
  [
    'and',
    "g.V().and(__.out('KNOWS'), __.has('age')).count()",
    () => G.traversal(G.V(), G.and(G.pipe(G.out('KNOWS')), G.pipe(G.has('age'))), G.count()),
  ],
  [
    'or',
    "g.V().or(__.out('KNOWS'), __.has('lang')).count()",
    () => G.traversal(G.V(), G.or(G.pipe(G.out('KNOWS')), G.pipe(G.has('lang'))), G.count()),
  ],
  ['properties', 'g.V().properties().count()', () => G.traversal(G.V(), G.properties(), G.count())],
  [
    'propertyMap',
    'g.V().propertyMap().count()',
    () => G.traversal(G.V(), G.propertyMap(), G.count()),
  ],
  ['elementMap', 'g.V().elementMap().count()', () => G.traversal(G.V(), G.elementMap(), G.count())],
  ['store', "g.V().store('x').count()", () => G.traversal(G.V(), G.store('x'), G.count())],
  ['cap', "g.V().store('x').cap('x')", () => G.traversal(G.V(), G.store('x'), G.cap('x'))],
  [
    'aggregate',
    "g.V().aggregate('x').count()",
    () => G.traversal(G.V(), G.aggregate('x'), G.count()),
  ],
  ['sample', 'g.V().sample(2).count()', () => G.traversal(G.V(), G.sample(2), G.count())],
  ['barrier', 'g.V().barrier().count()', () => G.traversal(G.V(), G.barrier(), G.count())],
  ['index', "g.V().values('name').index()", () => G.traversal(G.V(), G.values('name'), G.index())],
  ['none', 'g.V().none().count()', () => G.traversal(G.V(), G.none(), G.count())],
  ['hasId', "g.V().hasId('1').count()", () => G.traversal(G.V(), G.hasId('1'), G.count())],
  ['hasNot', "g.V().hasNot('age').count()", () => G.traversal(G.V(), G.hasNot('age'), G.count())],
  [
    'sideEffect',
    "g.V().sideEffect(__.out('KNOWS')).count()",
    () => G.traversal(G.V(), G.sideEffect(G.pipe(G.out('KNOWS'))), G.count()),
  ],
  [
    'subgraph',
    "g.V().outE().subgraph('s').count()",
    () => G.traversal(G.V(), G.outE(), G.subgraph('s'), G.count()),
  ],
  [
    'shortestPath',
    'g.V().shortestPath().count()',
    () => G.traversal(G.V(), G.shortestPath(), G.count()),
  ],
  [
    'hasValue',
    "g.V().properties('name').hasValue('marko').count()",
    () => G.traversal(G.V(), G.properties('name'), G.hasValue('marko'), G.count()),
  ],
  ['loops', 'g.V().repeat(__.out()).until(__.loops().is(2)).count()', undefined],
  // CONTROLS, keyed by STEP KIND like every other row — the earlier cut keyed them by a display
  // name and reported `out` as missing.
  ['out', "g.V().out('KNOWS').count()", () => G.traversal(G.V(), G.out('KNOWS'), G.count())],
  [
    'match',
    "g.V().match(__.as('a').out('KNOWS').as('b')).count()",
    () => G.traversal(G.V(), G.match(G.pipe(G.as_('a'), G.out('KNOWS'), G.as_('b'))), G.count()),
  ],
  [
    'as',
    "g.V().as('a').select('a').count()",
    () => G.traversal(G.V(), G.as_('a'), G.select('a'), G.count()),
  ],
];

if (NATIVE_LIB === undefined) {
  console.error('no native lib — build it with `cargo build --release --features capi`');
  process.exit(1);
}

const backend = nativeBackend();
const bytes = new TextEncoder().encode(MODERN);
const dec = new TextDecoder();
const short = (e) => {
  const m = String(e?.message ?? e).replace(/\s+/g, ' ');

  return m.length > 44 ? `${m.slice(0, 41)}…` : m;
};

const nativeTry = (text) => {
  const handle = backend.graphFromNdjson(bytes);

  try {
    JSON.parse(dec.decode(backend.gremlinJson(handle, text)));

    return 'yes';
  } catch (e) {
    return `no: ${short(e)}`;
  } finally {
    backend.graphFree(handle);
  }
};

const w = (s, n) => String(s).padEnd(n);
const gaps = [];

console.log(`${w('step', 14)}${w('nativeParses', 50)}${w('tsBuilds', 24)}emits`);

for (const [kind, text, build] of CASES) {
  const native = nativeTry(text);
  let builds = 'no builder exercised';
  let emits = 'n/a';

  if (build !== undefined) {
    let plan;

    try {
      plan = build();
      builds = 'yes';
    } catch (e) {
      builds = `no: ${short(e)}`;
    }

    if (plan !== undefined) {
      try {
        G.planToGremlin(plan);
        emits = 'yes';
      } catch (e) {
        emits = G.isTsOnly(e) ? 'ts-only (by design)' : 'NO — EMITTER GAP';
      }
    }
  }

  if (native === 'yes' && builds === 'yes' && emits === 'NO — EMITTER GAP') {
    gaps.push(kind);
  }

  console.log(`${w(kind, 14)}${w(native, 50)}${w(builds, 24)}${emits}`);
}

console.log(
  `\nPURE EMITTER GAPS (native parses it, TS builds it, nothing can compare them): ${gaps.length}` +
    `\n  ${gaps.join(', ')}`,
);
