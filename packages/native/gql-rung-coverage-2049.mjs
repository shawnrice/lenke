/*
 * Item 2049 — WHICH GQL RUNGS DOES NO BENCHMARK SHAPE REACH?
 *
 * Item 2046 did this for Gremlin with V8's per-function coverage and found three optimization rungs
 * that no screen or census touched (one of which hid a 1.40x equivalent-spelling gap, items
 * 2046/2047). **The GQL engine has never had the same audit**, and it has the larger rung set: 34
 * `detect*` shape detectors against the profile probe's 51 query shapes.
 *
 * 🔑 **THE CORPUS IS READ OUT OF `runtime-profile-probe.mjs`'s SOURCE**, not duplicated here, so the
 * two cannot drift. It is read-only and the parsed count is ASSERTED — a regex that silently matched
 * fewer shapes would understate coverage and invent unreached rungs, which is the failure mode item
 * 2048 just spent a whole item on (a `name: \d+,` pattern that skipped `16_384`).
 *
 * ⚠️ `node` BY NAME, not `process.execPath`: this runs under `bun`, where `process.execPath` IS bun,
 * and bun does not honour NODE_V8_COVERAGE (item 2046 lost a run to that).
 *
 *     bun gql-rung-coverage-2049.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const GQL_SRC = join(HERE, '..', 'gql', 'src', 'executor');

/*
 * The GQL engine's rung entry points, read from SOURCE.
 *
 * ⚠️⚠️ **`detect*` ALONE WAS NOT THE WHOLE SET (item 2072).** Item 2071 found the GREMLIN audit's
 * suffix filter missing fifteen route-deciders while its rung LIST was derived correctly, and the same
 * check here finds the `*Applies` family invisible: `twoHopFilteredCsrApplies`,
 * `twoHopUnfilteredCsrApplies`, `filteredChainCsrApplies`, `csrDegreeProductApplies`,
 * `csrGatedDegreeProductApplies`, `farDrivenPredicatedApplies` — six functions whose entire job is to
 * say whether a rung claims a plan, which is this audit's own definition of a rung.
 *
 * ⚠️ **DECIDERS ONLY, NOT THE WALKS THEY SERVE.** `gql/src/executor` exports 458 consts; `allWalk`,
 * `shortestWalk`, `walkSegments` and `projectedRows` are implementations, and pulling them in would
 * bury the question exactly as the Gremlin audit's own comment warns. The second pattern is three
 * suffixes plus two named decision predicates, and nothing else.
 */
const DECIDER = /^export const ((?:detect[a-zA-Z0-9]+|[a-zA-Z0-9]+(?:Applies|Shape|Seek))) = \(/gm;

/** Two decision predicates that carry no shared suffix; named rather than pattern-matched. */
const NAMED_DECIDERS = ['seekIsWorthIt', 'endpointFoldBeatsRowWalk'];

const rungs = [
  ...new Set([
    ...readdirSync(GQL_SRC)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .flatMap((f) => [...readFileSync(join(GQL_SRC, f), 'utf8').matchAll(DECIDER)])
      .map((m) => m[1]),
    ...NAMED_DECIDERS,
  ]),
].sort();

/*
 * ⚠️ THE FLOOR IS RAISED WITH THE PATTERN. It was 30 for `detect*` alone; widening the pattern without
 * widening the guard would let a future drift back to 34 pass silently, which is the whole failure
 * mode this guard exists for.
 */
if (rungs.length < 40) {
  throw new Error(`parsed only ${rungs.length} rungs — the regex has drifted`);
}

/** The query texts, read out of the profile probe so there is ONE corpus. */
const probeSrc = readFileSync(join(HERE, 'runtime-profile-probe.mjs'), 'utf8');
const shapesBlock = probeSrc.slice(
  probeSrc.indexOf('const SHAPES = {'),
  probeSrc.indexOf('\n};', probeSrc.indexOf('const SHAPES = {')),
);
/*
 * ⚠️⚠️ **MY FIRST EXTRACTION SILENTLY LOST TWO SHAPES AND TRUNCATED A THIRD**, and the audit still
 * reported a clean result — which is how a weaker corpus flatters coverage. A single-quoted,
 * single-line pattern missed:
 *
 *   - `stringfn`, which uses DOUBLE quotes because its text contains `'ZZZ'`;
 *   - `proj10`, a CONCATENATION across two lines — the regex took the first fragment and produced a
 *     syntactically invalid query that threw `Unexpected 'eof' in expression`.
 *
 * So each entry's slice now has its `//` comments stripped and ALL its string fragments joined,
 * which handles both quote styles and concatenation. Same family of error as item 2048's
 * `name: \d+,` missing `16_384`: a regex over source that skips a legal spelling.
 */
const entryStarts = [...shapesBlock.matchAll(/^ {2}([a-zA-Z0-9]+):/gm)];
const texts = entryStarts.map((m, idx) => {
  const from = m.index + m[0].length;
  const to = idx + 1 < entryStarts.length ? entryStarts[idx + 1].index : shapesBlock.length;
  const body = shapesBlock
    .slice(from, to)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fragments = [...body.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((f) =>
    (f[1] ?? f[2]).replace(/\\'/g, "'").replace(/\\"/g, '"'),
  );

  return [m[1], fragments.join('')];
});

if (texts.length < 50 || texts.some(([, t]) => t.length < 10)) {
  throw new Error(
    `extraction drifted: ${texts.length} shapes, shortest ${Math.min(...texts.map(([, t]) => t.length))} chars`,
  );
}

const driver = `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = 400;
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['P'], properties: { k: i % 97, s: 's' + (i % 50), n: i } });
}

for (let e = 0; e < NODES * 3; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: 'e' + e,
    from: g.getVertexById('v' + i),
    to: g.getVertexById('v' + ((i * 7 + 3 + hop * 2654435761) % NODES)),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

const texts = ${JSON.stringify(texts)};
let ran = 0;
let failed = 0;
const bad = [];

// Twice: several rungs decline a cold second-ask structure and serve the shape only afterwards.
for (let pass = 0; pass < 2; pass += 1) {
  for (const [, text] of texts) {
    try {
      for (const _ of query(g, text)) {
        break;
      }
      ran += 1;
    } catch (e) {
      failed += 1;
      bad.push(text.slice(0, 40) + ' :: ' + String(e).slice(0, 60));
    }
  }
}

/*
 * A SYNTAX ERROR MEANS THE EXTRACTION IS WRONG, NOT THE ENGINE, and it must fail loudly: a truncated
 * query exercises fewer rungs and makes the coverage result look better than it is. This is what
 * caught the concatenated proj10 shape. (No backticks in this comment: it lives inside a template
 * literal, and that is the THIRD time this session the same trap fired.)
 */
if (failed > 0) {
  throw new Error('shapes failed to run (extraction is suspect):\\n' + bad.join('\\n'));
}

process.stdout.write(JSON.stringify({ ran, failed, shapes: texts.length }));
`;

/*
 * ⚠️ THE TEMPLATE MUST CONTAIN NO BACKTICK. A backticked identifier in a comment inside it terminates
 * the template, and `node --check` reports the error at a confusing place. This fired three times in
 * one session (items 2036, 2046, 2049), so it is asserted rather than remembered.
 */
if (driver.includes('`')) {
  throw new Error(
    'the generated driver contains a backtick, which terminates the template literal',
  );
}

const dir = mkdtempSync(join(tmpdir(), 'gqlcov-'));
const driverPath = join(HERE, 'gql-rung-coverage-driver-2049-tmp.mjs');

writeFileSync(driverPath, driver);

let out;

try {
  out = execFileSync('node', [driverPath], {
    env: { ...process.env, NODE_V8_COVERAGE: dir },
    encoding: 'utf8',
  });
} finally {
  unlinkSync(driverPath);
}

const summary = JSON.parse(out);
const entries = readdirSync(dir)
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .flatMap((j) => j.result ?? [])
  .filter((s) => s.url.includes('/gql/') && s.url.endsWith('index.mjs'));

if (entries.length === 0) {
  throw new Error(`no coverage recorded for the gql dist in ${dir}`);
}

const counts = new Map();

for (const script of entries) {
  for (const fn of script.functions) {
    counts.set(
      fn.functionName,
      (counts.get(fn.functionName) ?? 0) + fn.ranges.reduce((a, r) => a + r.count, 0),
    );
  }
}

const unreached = rungs.filter((r) => (counts.get(r) ?? 0) === 0);

console.log(
  `\n  ${summary.shapes} shapes x 2 passes (${summary.ran} ran, ${summary.failed} threw); ${rungs.length} detect* rungs\n`,
);
console.log(`  REACHED (${rungs.length - unreached.length})`);
console.log(`\n  ⚠️ NEVER ENTERED (${unreached.length}):`);

for (const r of unreached) {
  console.log(`    ${r}`);
}
