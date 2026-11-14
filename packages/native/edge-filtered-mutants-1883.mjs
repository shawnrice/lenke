/**
 * DOES `edge-filtered-hop-values.test.ts` HAVE TEETH? (item 1883)
 *
 * ⚠️ IT PASSED ON ITS FIRST RUN, AND SO DOES A TEST THAT CHECKS NOTHING. CLAUDE.md's rule:
 * "Mutate it and check the fuzzer catches it. A generative test whose teeth were never verified is
 * worse than no test, because it is believed."
 *
 * ⚠️ EACH MUTANT IS ANCHOR-ASSERTED. Items 1870 and 1873 both recorded a mutant whose anchor
 * matched 0 or 2 times, so the "pass" meant nothing — the patch had never applied. Every entry
 * below declares the occurrence count it expects and the run fails loudly otherwise.
 *
 * ⚠️ AND A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` /
 * `N fail` to **stderr**, so both streams are concatenated and a result line is required before
 * the exit code is read (items 767/772-773 got this wrong in both directions).
 *
 *     bun edge-filtered-mutants-1883.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/edge-filtered-hop-values.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1883-edge-filtered.ts`;
const TEST = 'src/executor/edge-filtered-hop-values.test.ts';

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  [
    'far end swapped',
    'pick(outward ? edge.to : edge.from)',
    'pick(outward ? edge.from : edge.to)',
    1,
  ],
  [
    'edge predicate deleted',
    'if (!edgeTest(edge)) {\n          continue;\n        }',
    'if (false) {\n          continue;\n        }',
    1,
  ],
  ['no-predicate shape admitted', 'if (at === 2) {', 'if (at === 1) {', 1],
  [
    'direction pairing swapped',
    "const wanted = hop.kind === 'outE' ? 'inV' : 'outV';",
    "const wanted = hop.kind === 'outE' ? 'outV' : 'inV';",
    1,
  ],
  [
    'AND becomes OR',
    'if (!gate(edge)) {\n        return false;\n      }',
    'if (gate(edge)) {\n        return true;\n      }',
    1,
  ],
  [
    'missing-key drop disabled',
    '{ pick: (far) => far.properties[valueKey], drops: true }',
    '{ pick: (far) => far.properties[valueKey], drops: false }',
    1,
  ],
  [
    'bucket direction ignored',
    'outward ? v.adjFrom?.get(type) : v.adjTo?.get(type)',
    'v.adjFrom?.get(type)',
    1,
  ],
];

/**
 * ⚠️ BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', TEST], {
    cwd: `${ROOT}/packages/gremlin`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

copyFileSync(SRC, PRISTINE);

const survivors = [];

try {
  const pristine = readFileSync(PRISTINE, 'utf8');

  // The BASELINE must pass, or every mutant "fails" for the wrong reason.
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop — an interrupted run must
    // not leave a mutant in the tree for `git diff` to be the only thing standing in its way.
    writeFileSync(SRC, pristine);

    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    writeFileSync(SRC, pristine.replace(from, to));

    const r = run();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text);

    if (!ran && r.code !== 124) {
      console.log(`  ⚠️ DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
      survivors.push(`${name} (no result line)`);
      continue;
    }

    const caught = r.code === 124 ? 'TIMEOUT (caught)' : r.code !== 0;

    if (caught === false) {
      survivors.push(name);
    }

    console.log(
      `  ${caught === false ? '❌ SURVIVED' : '✅ caught   '}  ${name.padEnd(30)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  copyFileSync(PRISTINE, SRC);
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
