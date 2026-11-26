/**
 * DOES `distinct-rows-two-column.test.ts` HAVE TEETH? (item 1886)
 *
 * IT PASSED ON ITS FIRST RUN, AND SO DOES A TEST THAT CHECKS NOTHING. And this area has a
 * history: items 1561 and 1562 each shipped a SILENT ANSWER CHANGE in the one-column keyer, so a
 * two-column keyer whose tests were never mutated is exactly the third.
 *
 * EACH MUTANT IS ANCHOR-ASSERTED for its occurrence count (items 1870/1873 each had a mutant
 * that never applied), and a verdict needs evidence of EXECUTION: `bun test` writes `N pass` to
 * **stderr**, so both streams are concatenated and a result line is required before the exit code
 * is read.
 *
 *     bun distinct2-mutants-1886.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { clauses: `${ROOT}/packages/gql/src/executor/clauses.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1886`;
// BOTH test files, because the two halves catch different mutants: the answer file catches a
// missing slice, the ROUTE file catches a rung that starts claiming shapes it must leave alone —
// and a route change is answer-equivalent, which is `perf-gate-needs-its-own-test` exactly.
// BOTH width files: the two-column arm must not break the one-column one, and the one-column file
// is where every equivalence class was first written down (items 1561/1562).
const TESTS = ['src/distinct-rows-two-column.test.ts', 'src/distinct-rows-one-column.test.ts'];

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  /**
   * THE COLLISION MUTANT, and the FIRST version of it was the wrong mutant — worth recording
   * because it looked right. Replacing the object branch with `if (false)` sends an element to
   * `keys.prims.get(a)`, which keys it by OBJECT IDENTITY rather than by `@id`: no collision with a
   * string, just a different equivalence class, and nothing available discriminates it because this
   * engine hands out one shared instance per id. The mutant that tests the two maps is the one that
   * puts the element's STRING key into the map raw values live in.
   */
  [
    'ONE map at the first position — an element bucket keyed by its `@id` STRING',
    'clauses',
    `    const found = keys.refs.get(k);

    if (found !== undefined) {
      return found;
    }

    const made = newOneColumnKeys();

    keys.refs.set(k, made);`,
    `    const found = keys.prims.get(k);

    if (found !== undefined) {
      return found;
    }

    const made = newOneColumnKeys();

    keys.prims.set(k, made);`,
    1,
  ],
  [
    'the SECOND column is ignored — the pair keys on the first alone',
    'clauses',
    'addOneColumnKey(secondColumnKeys(keys, a), b);',
    'addOneColumnKey(secondColumnKeys(keys, a), undefined);',
    1,
  ],
  [
    'the second column is read as the FIRST (both positions read column 1)',
    'clauses',
    `const secondColumnValue = (row: Row): unknown => {
  let first = true;`,
    `const secondColumnValue = (row: Row): unknown => {
  let first = false;`,
    1,
  ],
  [
    'the set-op PROBE stops at the bucket — it never reads column 2',
    'clauses',
    'return bucket !== undefined && hasOneColumnKey(bucket, b);',
    'return bucket !== undefined;',
    1,
  ],
  [
    'the width test is off by one — THREE columns key on two',
    'clauses',
    `  if (isWidth(rows, 2)) {
    const keys = newTwoColumnKeys();`,
    `  if (isWidth(rows, 2) || isWidth(rows, 3)) {
    const keys = newTwoColumnKeys();`,
    1,
  ],
  /**
   * AN EXPECTED SURVIVOR, and item 475's rule is why it is kept rather than deleted: a surviving
   * mutant means "redundant" as readily as "untested", and the two have opposite fixes. Here it is
   * REDUNDANT for the answer — a one-column right side keys as `(v, undefined)` pairs, which
   * collapse exactly as their `rowKeyOf` strings do, and a right side of mixed widths is possible
   * either way since `isWidth` reads `rows[0]`. It stays because the ONE-column arm beside it makes
   * the same check for the same defensive reason (its note: "an EMPTY left declines rather than
   * assuming"), and because `union` is the one caller that CAN be handed mixed widths — item 1561
   * shipped a silent answer change there. Same call as `unsortedPageRoute`'s
   * `typeof proj.skip === 'number'`, which is also redundant at runtime and also kept.
   */
  [
    'EXPECTED SURVIVOR — union admits a mixed-width right side',
    'clauses',
    'if (isWidth(left, 2) && isWidth(right, 2)) {',
    'if (isWidth(left, 2)) {',
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry above. */
const EXPECTED_SURVIVORS = new Set(['EXPECTED SURVIVOR — union admits a mixed-width right side']);

/**
 * BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
};

const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

// Each of the three sources gets its own pristine copy under `target/` (gitignored, and it survives
// the reboot a runaway mutant may force — CLAUDE.md's rule, learned when `/tmp` was wiped).
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
  // The BASELINE must pass, or every mutant "fails" for the wrong reason.
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop — an interrupted run must
    // not leave a mutant in the tree for `git diff` to be the only thing standing in its way.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    writeFileSync(SRCS[which], pristine.replace(from, to));

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
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(30)} ` +
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
