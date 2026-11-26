/**
 * DOES `where-current-specialized.test.ts` HAVE TEETH? (item 1900)
 *
 * THE SUBJECT IS A SPECIALIZATION, so the mutants come in two kinds and only one kind can be
 * caught by a test: those that change the ANSWER (the comparator's sense, the branch taken for an
 * ordering op) and those that only change the ROUTE (never taking the fast branch). The second kind
 * is declared an expected survivor with its reason, and `neq-prof-1900.mjs` is its gate.
 *
 * `cf.test.ts` IS IN THE TEST SET, not just the new file: it is where `where(neq(label))` was
 * already covered, and a mutation run against the new file alone would credit this change with
 * coverage that predates it.
 *
 *     bun where-mutants-1900.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { flt: `${ROOT}/packages/gremlin/src/executor/filters.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1900`;
const TESTS = ['src/executor/where-current-specialized.test.ts', 'src/steps/cf.test.ts'];

/** `[name, which, from, to, expectedOccurrences, occurrence?]` */
const MUTANTS = [
  [
    'the comparator sense is inverted (eq and neq swap)',
    'flt',
    "const want = pred.op === 'eq';",
    "const want = pred.op === 'neq';",
    1,
  ],
  [
    'the fast branch takes EVERY op, ordering ones included',
    'flt',
    'if (eqish && !isTemporal(end.value)) {',
    'if (true) {',
    1,
  ],
  [
    'the temporal guard is dropped',
    'flt',
    'if (eqish && !isTemporal(end.value)) {',
    'if (eqish) {',
    1,
  ],
  [
    'the fast branch is never taken (route only)',
    'flt',
    'if (eqish && !isTemporal(end.value)) {',
    'if (false) {',
    1,
  ],
  [
    'the fast branch falls through to `matches` as well',
    'flt',
    `      if ((t.value === end.value) === want) {
        yield t;
      }

      continue;`,
    `      if ((t.value === end.value) === want) {
        yield t;
      }`,
    1,
  ],
  [
    'the unbound-label drop is removed',
    'flt',
    `    if (!end.ok) {
      continue; // the referenced label isn't bound → drop, as whereCompareStep does
    }`,
    '',
    1,
  ],
  [
    'the tag is recalled FIRST rather than last',
    'flt',
    "const end = recallTag(t.tags, endKey, 'last');\n\n    if (!end.ok) {\n      continue; // the referenced label isn't bound",
    "const end = recallTag(t.tags, endKey, 'first');\n\n    if (!end.ok) {\n      continue; // the referenced label isn't bound",
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry. */
const EXPECTED_SURVIVORS = new Set([
  // A pure ROUTE change: it removes the optimization and nothing else, so it is answer-equivalent
  // by construction ([[perf-gate-needs-its-own-test]]). `neq-prof-1900.mjs` is what catches it —
  // 234.47 ms pre against 215.37 post, min of three alternated rounds with a flat control.
  'the fast branch is never taken (route only)',
  // `recallTag`'s pop is 'last' in BOTH where-steps and no shape here binds one label twice, so
  // this mutant is a question about a fixture nobody has needed. Stated rather than silently green.
  'the tag is recalled FIRST rather than last',
  // THE TEMPORAL GUARD IS UNPROVEN-REACHABLE SOUNDNESS INSURANCE, and this entry is the honest
  // version of that. The argument it is dead: the tag and the current value share one traverser
  // lineage, `as_` copies the value as-is, `values(k)` returns the STORED Temporal object, and no
  // step between them constructs a new temporal of equal value — so an equal-but-not-identical pair
  // cannot meet here. That is an argument over every value-rebinding step, NOT a proof from the
  // branch's own conditions, which is what let item 1899 delete its dead adjacency arm. Dropping the
  // guard on the strength of it would risk a silent WRONG ANSWER to save one typeof per row, so it
  // stays and the survivor is declared.
  'the temporal guard is dropped',
]);

/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
};

/**
 * BOTH STREAMS, ALWAYS: `bun test` writes `N pass` to **stderr**, and item 767 read an empty
 * stdout and concluded the runner never ran a test.
 */
const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gremlin`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

for (const [key, path] of Object.entries(SRCS)) {
  copyFileSync(path, `${PRISTINE}-${key}.ts`);
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(SRCS)) {
    copyFileSync(`${PRISTINE}-${key}.ts`, path);
  }
};

const survivors = [];

try {
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want, occurrence = 0] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    const parts = pristine.split(from);

    writeFileSync(
      SRCS[which],
      `${parts.slice(0, occurrence + 1).join(from)}${to}${parts.slice(occurrence + 1).join(from)}`,
    );

    const r = run();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text);

    if (!ran && r.code !== 124) {
      console.log(`  DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
      survivors.push(`${name} (no result line)`);
      continue;
    }

    const caught = r.code === 124 ? 'TIMEOUT (caught)' : r.code !== 0;
    const expected = EXPECTED_SURVIVORS.has(name);

    if (caught === false && !expected) {
      survivors.push(name);
    }

    if (caught !== false && expected) {
      survivors.push(`${name} (was expected to SURVIVE and did not — update the entry)`);
    }

    console.log(
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
