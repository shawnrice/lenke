/*
 * Item 2046 — WHICH GREMLIN RUNGS DOES NO BENCHMARK SHAPE REACH?
 *
 * **THE ROUTE CENSUS CANNOT ANSWER THIS.** It counts `applyStep` calls, so it says "fused" or
 * "generic" for a SHAPE — never which RUNG did the fusing, and never that a rung exists which no
 * shape visits at all. Item 2028 found the reconverging families had no census rows by reading
 * `pickFor` by hand across five files; item 2036 found the same for `hasLabel`. **This asks the
 * question mechanically**, with V8's own per-function coverage: run the benchmark shapes, then list
 * every exported rung whose function was never ENTERED.
 *
 * An unreached rung is not necessarily dead — it may serve a shape no screen happens to ask. That is
 * exactly the blind spot worth knowing: a rung nothing measures can rot (item 1870's 678x regression
 * sat in a shipped rung invisibly) and a gap in it cannot be found by timing.
 *
 * IT MUST RUN UNDER `node`, not `bun` — `NODE_V8_COVERAGE` is a V8/node facility. The wrapper
 * below sets it and re-reads the JSON, so there is nothing to remember at the call site.
 *
 *     bun rung-coverage-2046.mjs        # spawns the node pass itself
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const GREMLIN_SRC = join(HERE, '..', 'gremlin', 'src', 'executor');

/*
 * Every exported RUNG entry point, read from the SOURCE so the list cannot go stale.
 *
 * FILTERED BY NAME SHAPE, because a bare "every exported const" sweep pulled in scores of helpers
 * (`maxLocal`, `pageRankStep`, `tupleKey`, …) and buried the question. A rung is the thing `run`
 * consults to claim a plan, and they are named for it.
 */
const RUNG = /(Shortcut|HopValues|Hop|Csr|Fusion|Walk|Residual|Existence|Shape|Step)$/;

/*
 * **A SECOND PATTERN, BECAUSE THE SUFFIX ONE MISSED FIFTEEN ROUTE-DECIDERS (item 2071).** The
 * comment above says the list "cannot go stale", and as a list it cannot — but the FILTER could, and
 * had: every `fusable*` gate and every `*Projected*` emit ends in `Count`, `Cap`, `Fold`, `Order`,
 * `Bag`, `List`, `MinMax`, `TopK` or `Barrier`, none of which the suffix pattern matches. ELEVEN of
 * the fifteen predate item 2069, so a residual gate could have sat unreached for a long time with
 * this audit reporting full coverage.
 *
 * These are rungs by the audit's own definition — "the thing `run` consults to claim a plan". They
 * are matched by PREFIX (`fusable`/`fused`) and by the `Projected` infix the emit helpers share,
 * which is narrow enough to keep the scores of helpers the suffix filter was written to exclude out.
 */
const RESIDUAL_RUNG = /^(?:fusable|fused)|Projected[A-Za-z]*$/;
const rungs = [
  ...new Set(
    readdirSync(GREMLIN_SRC)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .flatMap((f) =>
        [
          ...readFileSync(join(GREMLIN_SRC, f), 'utf8').matchAll(
            /^export const ([a-zA-Z0-9]+) = \(/gm,
          ),
        ].map((m) => m[1]),
      ),
  ),
]
  .filter((n) => RUNG.test(n) || RESIDUAL_RUNG.test(n))
  .sort();

/*
 * The shapes to exercise: the workload screen's own list, so "reached" means "reached by the
 * benchmark corpus" rather than by something invented here. Written to a temp module that the node
 * pass imports.
 */
const driver = `
import { Graph } from '@lenke/core';
import * as G from '@lenke/gremlin';

const g = new Graph();

for (let i = 0; i < 400; i += 1) {
  g.addVertex({ id: 'v' + i, labels: i % 6 === 2 ? ['T', 'U'] : ['T'], properties: { k: i % 7, n: i, s: 's' + (i % 5) } });
}

g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { k: -1, n: -1, s: 'off' } });

for (let i = 0; i < 1600; i += 1) {
  const from = i % 400;
  const hop = Math.floor(i / 400);

  g.addEdge({
    id: 'e' + i,
    from: g.getVertexById('v' + from),
    to: g.getVertexById('v' + ((from * 7 + 3 + hop * 2654435761) % 400)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: i % 13 },
  });
}

const { V, out, in_, both, values, count, hasLabel, has, order, dedupe, limit, path, optional,
  coalesce, choose, branch, identity, constant, union, groupCount, select, as_, fold, max, min,
  sum, traversal, toArray, where, neq, gt, and, or, not, aggregate, store } = G;

// EVERY SHAPE RUN TWICE: the second-ask policy makes several rungs DECLINE their first call, so a
// single pass would report them unreached when they are merely cold. (No backticks in here: this
// text lives inside a template literal, and node --check caught the first version.)
const failures = [];

const shapes = [
  // ITEM 2068: the three shapes that reach aggregateStep, which this audit had reported NEVER
  // ENTERED. aggregate('x').cap('x') does NOT reach it -- item 1911's fused residual claims that
  // shape whole -- so dropping the cap is the only way in. Added here as well as to both screens,
  // because an audit that keeps reporting a gap already covered elsewhere teaches you to ignore it.
  //
  // NO BACKTICKS IN THIS LIST. It is embedded in the generated driver's TEMPLATE LITERAL, so a
  // backtick here terminates it -- the trap items 2036, 2046 and 2049 each hit, and which this file
  // already asserts against for the driver's own text.
  () => traversal(V(), out('E'), aggregate('x'), count()),
  // ITEM 2071: shapes for two rungs that PROVABLY WORK but had no shape here. Widening the rung
  // FILTER without widening the SHAPES turns "unmatched" into "never entered" - which reads as an
  // engine gap and is an instrument artifact. The census reports both of these FUSED.
  () => traversal(V(), out('E'), values('n'), aggregate('x')),
  () => traversal(V(), out('E'), groupCount().by('n')),
  () => traversal(V(), groupCount().by('n')),
  () => traversal(V(), out('E'), store('x'), values('n')),
  () => traversal(V(), aggregate('x'), values('n')),
  () => traversal(V(), values('n')),
  () => traversal(V(), count()),
  () => traversal(V(), hasLabel('T'), values('n')),
  () => traversal(V(), hasLabel('T'), count()),
  () => traversal(V(), hasLabel('T'), values('n'), order()),
  () => traversal(V(), hasLabel('T'), out('E'), values('n')),
  () => traversal(V(), out('E'), values('n')),
  () => traversal(V(), out('E'), count()),
  () => traversal(V(), out('E'), out('E'), values('n')),
  () => traversal(V(), out('E'), dedupe(), count()),
  () => traversal(V(), in_('E'), values('n')),
  () => traversal(V(), both('E'), count()),
  () => traversal(V(), has('k', 3), values('n')),
  () => traversal(V(), has('k', gt(3)), count()),
  () => traversal(V(), values('n'), order()),
  () => traversal(V(), values('n'), fold()),
  () => traversal(V(), values('n'), max()),
  () => traversal(V(), values('n'), min()),
  () => traversal(V(), values('n'), sum()),
  () => traversal(V(), values('n'), dedupe()),
  () => traversal(V(), values('n'), limit(5)),
  () => traversal(V(), optional(traversal(out('E'))), values('n')),
  () => traversal(V(), optional(traversal(out('E'))), count()),
  () => traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), values('n')),
  () => traversal(V(), coalesce(traversal(out('E')), traversal(in_('E'))), count()),
  () => traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))), values('n')),
  () => traversal(V(), choose(has('k', 3), traversal(out('E')), traversal(in_('E'))), count()),
  () => traversal(V(), branch(traversal(values('k'))).option(3, traversal(out('E'))).none(traversal(identity())), values('n')),
  () => traversal(V(), union(traversal(out('E')), traversal(in_('E'))), count()),
  () => traversal(V(), groupCount({ by: 'k' })),
  () => traversal(V(), as_('a'), out('E'), select('a')),
  () => traversal(V(), out('E'), path()),
  () => traversal(V(), where(traversal(out('E'))), values('n')),
  () => traversal(V(), where(traversal(out('E'))), count()),
  () => traversal(V(), out('E'), where(neq('a'))),
  () => traversal(V('v1', 'v2'), values('n')),
  () => traversal(V(), out('F'), values('n')),
  () => traversal(V(), out('E'), values('n'), limit(5)),
  () => traversal(V(), out('E'), values('k'), order(), limit(5)),
  () => traversal(V(), constant(7)),
  // Item 2046's additions: the shapes the first sweep proved NOTHING reached. sub-plan-existence.ts
  // fuses and/or/not over a one-step sub-plan (the bare where() case was already covered), and
  // count-shortcut.ts has a two-hop DENSE shape that only the COUNT form reaches.
  () => traversal(V(), and(traversal(out('E')), traversal(out('F'))), values('n')),
  () => traversal(V(), or(traversal(out('E')), traversal(out('F'))), values('n')),
  () => traversal(V(), not(traversal(out('E'))), values('n')),
  () => traversal(V(), where(and(traversal(out('E')), traversal(out('F')))), count()),
  () => traversal(V(), out('E'), out('E'), count()),
  () => traversal(V(), out('E'), out('F'), count()),
];

for (let pass = 0; pass < 2; pass += 1) {
  for (const [i, mk] of shapes.entries()) {
    try {
      toArray(mk(), g);
    } catch (e) {
      // A SWALLOWED THROW USED TO BE INVISIBLE, AND THAT COST ITEM 2068 THREE RUNS. Three new
      // shapes referenced aggregate/store, which the driver did not destructure from the
      // namespace, so every one threw on an undefined callee -- and the audit reported the SAME
      // "36 reached, aggregateStep NEVER ENTERED" it had before, which reads as "the shape does not
      // reach it" rather than "the shape did not run". Item 2033's rule: an absent global and zero
      // calls are indistinguishable unless you say which happened.
      //
      // A shape a BUILD refuses is still a data point, so this is not fatal -- but it is REPORTED.
      failures.push(i + ': ' + String(e && e.message ? e.message : e));
    }
  }
}

process.stdout.write(JSON.stringify({ shapes: shapes.length, failures }));
`;

/*
 * **THE ASSERTION THIS FILE ONLY HAD A COMMENT ABOUT (item 2068).** A backtick anywhere in the
 * driver's text terminates the template it lives in, and the failure surfaces as a SyntaxError about
 * whatever identifier followed it — nothing that names the real cause. The trap has now fired at
 * items 2036, 2046, 2049 and TWICE inside 2068, the second time in a comment warning about it. Item
 * 2046's entry says this probe "now asserts no backtick survives", but the file carried only a prose
 * note; this is the assertion.
 */
if (driver.includes('\u0060')) {
  throw new Error(
    'a BACKTICK survives inside the generated driver — it would terminate the template and the error ' +
      'would name an unrelated identifier. Rewrite the offending comment or string without one.',
  );
}

const dir = mkdtempSync(join(tmpdir(), 'rungcov-'));
const driverPath = join(HERE, 'rung-coverage-driver-2046-tmp.mjs');

writeFileSync(driverPath, driver);

/*
 * `node` BY NAME, NOT `process.execPath` — this wrapper itself runs under `bun`, where
 * `process.execPath` IS bun, and bun does not honour NODE_V8_COVERAGE. The first version spawned bun
 * with a node-only env var and reported "no coverage recorded", which reads like a broken facility
 * rather than the wrong interpreter.
 */
/*
 * THE DRIVER IS DELETED IN A `finally`, AND IT WAS NOT (item 2068). It is written into THIS
 * directory rather than the temp dir — deliberately, so `@lenke/gremlin` resolves — and nothing
 * removed it, so every run of this probe left a generated file in the repo that `bun run lint` then
 * failed on (`prefer-template`, four times). A probe that breaks the gate after it runs is a probe
 * nobody runs twice.
 */
let out;

try {
  out = execFileSync('node', [driverPath], {
    env: { ...process.env, NODE_V8_COVERAGE: dir },
    encoding: 'utf8',
  });
} finally {
  rmSync(driverPath, { force: true });
}

const driverResult = JSON.parse(out);
const shapeCount = driverResult.shapes;

/*
 * A SHAPE THAT THREW IS REPORTED, NOT SWALLOWED (item 2068). Three shapes referencing
 * `aggregate`/`store` threw on an undefined callee because the driver did not destructure them, and
 * the audit reported the same "NEVER ENTERED" as before — indistinguishable from the shape genuinely
 * not reaching the rung. This makes the two cases different on the page.
 */
if (driverResult.failures !== undefined && driverResult.failures.length > 0) {
  console.log(
    `\n  ${String(driverResult.failures.length)} shape(s) THREW and reached nothing — a coverage ` +
      `gap below may be this, not the rung:\n    ${driverResult.failures.join('\n    ')}`,
  );
}

/** V8 writes one or more coverage files; find the gremlin dist's entry in whichever has it. */
const entries = readdirSync(dir)
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .flatMap((j) => j.result ?? [])
  .filter((s) => s.url.includes('gremlin') && s.url.endsWith('index.mjs'));

if (entries.length === 0) {
  throw new Error(
    `no coverage recorded for the gremlin dist in ${dir} — is NODE_V8_COVERAGE honoured?`,
  );
}

const counts = new Map();

for (const script of entries) {
  for (const fn of script.functions) {
    const hits = fn.ranges.reduce((a, r) => a + r.count, 0);

    counts.set(fn.functionName, (counts.get(fn.functionName) ?? 0) + hits);
  }
}

const unreached = rungs.filter((r) => (counts.get(r) ?? 0) === 0);
const reached = rungs.filter((r) => (counts.get(r) ?? 0) > 0);

console.log(`\n  ${shapeCount} shapes x 2 passes; ${rungs.length} exported rungs in source\n`);
console.log(`  REACHED (${reached.length}):`);
console.log(`    ${reached.join(', ')}\n`);
console.log(`  NEVER ENTERED (${unreached.length}) — no benchmark shape here reaches these:`);

for (const r of unreached) {
  console.log(`    ${r}`);
}
