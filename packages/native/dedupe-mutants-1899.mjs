/**
 * DOES `hop-values-dedupe.test.ts` HAVE TEETH? (item 1899)
 *
 * ⚠️ TWO WALKS, so the anchors that appear twice declare it and `which`-occurrence selects one: the
 * lazy `[Symbol.iterator]` and the eager `drain` are the same loop written twice (item 169's rule),
 * and item 1889 caught a run-bound off-by-one in the drain that SURVIVED in the iterator.
 *
 * ⚠️ AND THE GATE GETS MORE MUTANTS THAN THE WALK, because that is where item 1899's real bug was:
 * `byKey` testing `typeof by === 'string'` made the whole `dedupe().by(k)` spelling silently decline
 * for a measured 257 ms against the other spelling's 65. A gate that quietly admits nothing is the
 * failure mode here, and only a test asserting the ANSWER on that spelling can see it.
 *
 *     bun dedupe-mutants-1899.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { ded: `${ROOT}/packages/gremlin/src/executor/hop-values-dedupe.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1899`;
const TESTS = ['src/executor/hop-values-dedupe.test.ts'];

/** `[name, which, from, to, expectedOccurrences, occurrence?]` */
const MUTANTS = [
  ['the `by` key need not equal the projected key', 'ded', 'fourth.keys[0] === by', 'true', 1],
  [
    'a `by` carrying a traversal is admitted as a key',
    'ded',
    "return by.kind === 'key' && by.direction === undefined ? by.key : undefined;",
    "return by.kind === 'key' || by.kind === 'traversal' ? 'n' : undefined;",
    1,
  ],
  [
    "the `by` spelling is declined outright (item 1899's own bug, restored)",
    'ded',
    "if (third.kind === 'dedupe' && fourth.kind === 'values') {",
    'if (false) {',
    1,
  ],
  [
    'a label-scoped `dedupe(label)` is admitted — `values` spelling',
    'ded',
    '(fourth.labels?.length ?? 0) === 0 &&',
    'true &&',
    1,
  ],
  [
    'a label-scoped `dedupe(label)` is admitted — `by` spelling',
    'ded',
    '(third.labels?.length ?? 0) === 0 &&',
    'true &&',
    1,
  ],
  [
    'a trailing `by` on the `values` spelling is admitted',
    'ded',
    '(fourth.bys?.length ?? 0) === 0',
    'true',
    1,
  ],
  [
    'a multi-key `values` is admitted — `by` spelling',
    'ded',
    'fourth.keys.length === 1 &&',
    'true &&',
    1,
  ],
  [
    'a multi-key `values` is admitted — `values` spelling',
    'ded',
    'return third.keys.length === 1 &&',
    'return true &&',
    1,
  ],
  [
    'the DIRECTION is ignored — every hop reads the out-adjacency',
    'ded',
    "forward: hop.kind === 'out',",
    'forward: true,',
    1,
  ],
  [
    'a MULTI-TYPE hop is admitted (a two-type edge counts twice)',
    'ded',
    "if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {",
    "if (hop.kind !== 'out' && hop.kind !== 'in') {",
    1,
  ],
  [
    '`both` is admitted, which one CSR cannot express',
    'ded',
    "if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {",
    'if (hop.labels.length !== 1) {',
    1,
  ],
  [
    '`V(ids)` is admitted',
    'ded',
    "if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {",
    "if (source.kind !== 'V') {",
    1,
  ],
  [
    'the tail is dropped — a step after the projection is ignored',
    'ded',
    'rest: steps.slice(4),',
    'rest: [],',
    1,
  ],
  [
    'the CSR run bound is off by one — EAGER drain (occurrence 0)',
    'ded',
    'const to = memo.off[slot] + memo.len[slot];',
    'const to = memo.off[slot] + memo.len[slot] + 1;',
    2,
    0,
  ],
  [
    'the CSR run bound is off by one — LAZY iterator (occurrence 1)',
    'ded',
    'const to = memo.off[slot] + memo.len[slot];',
    'const to = memo.off[slot] + memo.len[slot] + 1;',
    2,
    1,
  ],
  [
    'the far vertex is the SLOT, not the flat target — EAGER drain (occurrence 0)',
    'ded',
    'const value = vtx[memo.flat[i]].properties[key];',
    'const value = vtx[slot].properties[key];',
    2,
    0,
  ],
  [
    'the far vertex is the SLOT, not the flat target — LAZY iterator (occurrence 1)',
    'ded',
    'const value = vtx[memo.flat[i]].properties[key];',
    'const value = vtx[slot].properties[key];',
    2,
    1,
  ],
  // ⚠️ EACH MISSING-KEY ANCHOR CARRIES ITS OWN PRECEDING LINE, because the three arms' guard blocks
  // are byte-identical and a bare guard matched 3 times.
  [
    'a MISSING key is deduped as a value — CSR arm, LAZY iterator',
    'ded',
    `const value = vtx[memo.flat[i]].properties[key];

        if (value !== undefined) {
          yield value;
        }`,
    `const value = vtx[memo.flat[i]].properties[key];

        yield value;`,
    1,
  ],
  [
    'a MISSING key is deduped as a value — CSR arm, EAGER drain (item 1913)',
    'ded',
    'if (value !== undefined && keep(value)) {\n            out.push(value);\n          }',
    'if (keep(value)) {\n            out.push(value);\n          }',
    1,
  ],
  [
    'the DRAIN drops the dedupe filter (item 1913)',
    'ded',
    'if (value !== undefined && keep(value)) {\n            out.push(value);\n          }',
    'if (value !== undefined) {\n            out.push(value);\n          }',
    1,
  ],
  [
    'a MISSING key is deduped as a value — bucket arm',
    'ded',
    `const value = (fwd ? e.to : e.from).properties[key];

      if (value !== undefined) {
        yield value;
      }`,
    `yield (fwd ? e.to : e.from).properties[key];`,
    1,
  ],
  [
    'the bucket arm reads the NEAR end — EAGER drain (occurrence 0)',
    'ded',
    'const value = (fwd ? e.to : e.from).properties[key];',
    'const value = (fwd ? e.from : e.to).properties[key];',
    2,
    0,
  ],
  [
    'the bucket arm reads the NEAR end — LAZY iterator (occurrence 1)',
    'ded',
    'const value = (fwd ? e.to : e.from).properties[key];',
    'const value = (fwd ? e.from : e.to).properties[key];',
    2,
    1,
  ],
  [
    'the dedupe is dropped — LAZY iterator',
    'ded',
    `      if (keep(far)) {
        yield far;
      }`,
    `      yield far;`,
    1,
  ],
  [
    'the dedupe set is rebuilt per vertex rather than per walk — DRAIN (item 1913)',
    'ded',
    'if (value !== undefined && keep(value)) {\n            out.push(value);\n          }',
    'if (value !== undefined && valueDedupeFilter()(value)) {\n            out.push(value);\n          }',
    1,
  ],
  [
    'the dedupe set is rebuilt per element — LAZY iterator',
    'ded',
    '      if (keep(far)) {\n        yield far;\n      }',
    '      if (valueDedupeFilter()(far)) {\n        yield far;\n      }',
    1,
  ],
];

/**
 * Names that MUST survive, each with its reason.
 *
 * ⚠️ THE CSR ARM'S OWN MUTANTS ARE NOT HERE and that is deliberate: `seenBefore` is item 1889's
 * policy, mutated by `hop-csr-mutants-1889.mjs` against `hop-values-csr.test.ts`. Duplicating them
 * would test that file's subject through this file's suite.
 */
const EXPECTED_SURVIVORS = new Set();

/**
 * ⚠️ TWO MUTANTS WERE REMOVED RATHER THAN COVERED, which is the other thing a survivor can mean.
 * They disabled the `adjacentEdges` fallback arm in `farValues`, and no test could reach it:
 * `soleTypeBucket` returns `undefined` only for `both` or a multi-label hop, both refused by the
 * gate, so the arm was DEAD. It is deleted in the same commit; a survivor is a question about the
 * CODE as often as about the suite.
 */

/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/**
 * ⚠️ BOTH STREAMS, ALWAYS: `bun test` writes `N pass` to **stderr**, and item 767 read an empty
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
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ` +
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
