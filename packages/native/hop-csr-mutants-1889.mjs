/**
 * DOES `hop-values-csr.test.ts` HAVE TEETH? (item 1889)
 *
 * ⚠️ TWO WALKS AND A POLICY, so the anchors that appear twice declare it: the lazy iterator and the
 * eager `drain` are the same loop written twice (item 169's rule), and a mutant must be able to hit
 * EACH. `which` selects the occurrence — a facility item 1888 added after three mutants landed in
 * the wrong walk.
 *
 * ⚠️ AND THE POLICY IS MUTATED SEPARATELY, because it is a route CHOICE: answer-equivalent, so only
 * its own unit tests can catch it.
 *
 *     bun hop-csr-mutants-1889.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { csr: `${ROOT}/packages/gremlin/src/executor/hop-values-csr.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1889`;
// BOTH test files, because the two halves catch different mutants: the answer file catches a
// missing slice, the ROUTE file catches a rung that starts claiming shapes it must leave alone —
// and a route change is answer-equivalent, which is `perf-gate-needs-its-own-test` exactly.
const TESTS = ['src/executor/hop-values-csr.test.ts'];

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  [
    'the run bound is off by one — LAZY iterator',
    'csr',
    'const to = from + memo.len[slot];',
    'const to = from + memo.len[slot] + 1;',
    2,
    0,
  ],
  [
    'the run bound is off by one — EAGER drain',
    'csr',
    'const to = from + memo.len[slot];',
    'const to = from + memo.len[slot] + 1;',
    2,
    1,
  ],
  [
    'the far vertex is the SLOT, not the flat buffer target',
    'csr',
    'const value = pick(vtx[memo.flat[i]]);',
    'const value = pick(vtx[slot]);',
    2,
  ],
  [
    'the missing-key drop is disabled',
    'csr',
    '{ pick: (e) => e.properties[valueKey], drops: true }',
    '{ pick: (e) => e.properties[valueKey], drops: false }',
    1,
  ],
  [
    'the DIRECTION is ignored — every hop reads the out-adjacency',
    'csr',
    "forward: hop.kind === 'out',",
    'forward: true,',
    1,
  ],
  [
    'a MULTI-TYPE hop is admitted (an edge with two named types counts twice)',
    'csr',
    "if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {",
    "if (hop.kind !== 'out' && hop.kind !== 'in') {",
    1,
  ],
  [
    '`both` is admitted, which one CSR cannot express',
    'csr',
    "if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {",
    'if (hop.labels.length !== 1) {',
    1,
  ],
  [
    'the second-call policy claims the FIRST call too',
    'csr',
    "if (!seenBefore(graph, hop.kind === 'out', hop.labels[0])) {",
    'if (false) {',
    1,
  ],
  [
    'the policy never resets on a topology write',
    'csr',
    'if (entry === undefined || entry.tv !== tv) {',
    'if (entry === undefined) {',
    1,
  ],
  [
    'the policy ignores the DIRECTION in its key',
    'csr',
    // eslint-disable-next-line no-template-curly-in-string -- this is a SOURCE ANCHOR, not a template
    "const key = `${forward ? '>' : '<'}${type}`;",
    'const key = type;',
    1,
  ],
  [
    'the eager `drain` and the lazy walk disagree (drain drops nothing)',
    'csr',
    `        if (!drops || value !== undefined) {
          out.push(value);
        }`,
    `        out.push(value);`,
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry above. */
const EXPECTED_SURVIVORS = new Set();

/**
 * ⚠️ BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gremlin`,
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

  for (const [name, which, from, to, want, occurrence = 0] of MUTANTS) {
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

    const parts = pristine.split(from);

    writeFileSync(
      SRCS[which],
      `${parts.slice(0, occurrence + 1).join(from)}${to}${parts.slice(occurrence + 1).join(from)}`,
    );

    const r = run();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text);

    if (!ran && r.code !== 124) {
      console.log(`  ⚠️ DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
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
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
