/**
 * THE LAZY-EMISSION COVERAGE SCREEN (item 1616) — does any test actually DRAIN each generator in
 * the two TS executors?
 *
 * ⚠️ THE QUESTION IS NOT "is this code tested" BUT "is this ROUTE taken by a test", and the two come
 * apart in a specific, repeating way. Item 1615 found two mutants SURVIVING in a fused walk's LAZY
 * loop while their EAGER twins died: every `HopWalk` in the Gremlin executor is written twice — a
 * generator and a `drain()` — and `toArray` with an empty residual reads `drain`, so a suite that
 * only calls `toArray` reaches the eager copy and never the generator. `hop-values.ts`' header
 * states the rule that keeps the two loops from DRIFTING; nothing stated that the tests reach both.
 *
 * The mutant is deliberately crude and universal: DUPLICATE one `yield`. Every row through that loop
 * then comes out twice, which no fixture and no unspecified-order liberty can excuse — GQL's row
 * order is unspecified but its row MULTISET is not. A survivor therefore means the loop is drained
 * by nothing.
 *
 * What it found on its first run:
 *
 * ```text
 *   gremlin   9/13 caught
 *     hop-values.ts:454                  the THREE-OR-MORE-TYPES walk
 *     start-filtered-hop-values.ts:229   the `both(T)` walk, OUT bucket
 *     start-filtered-hop-values.ts:241   the `both(T)` walk, IN bucket
 *     optional-hop.ts:83                 `optional`'s non-vertex passthrough
 *   gql      10/11 caught
 *     executor/matching.ts:1261          `anyWalk`, the bare-`ANY` trail enumerator
 * ```
 *
 * All five are now covered (`lazy-walk-coverage.test.ts`, `bare-any-walk.test.ts`) and the screen
 * reads 13/13 and 11/11. Run it after adding a `HopWalk`, a selector driver, or any generator in
 * these files.
 *
 * ⚠️ IT MUST RUN THE SUITE OF THE PACKAGE IT MUTATES. A mutation against `packages/gql/src` is
 * invisible to `packages/native`'s tests, which import `@lenke/gql` — the BUILT DIST — so they
 * sail straight past it until a rebuild. That is `fuzzers-read-built-dists` applied to a unit test,
 * and it is why `anyWalk`'s claim is asserted in BOTH packages.
 *
 *     node lazy-emission-screen.mjs              # both engines
 *     node lazy-emission-screen.mjs gremlin      # one of them
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const WHICH = process.argv[2] ?? 'all';

/** A bare emission on its own line: `yield value;`, `yield t;`, `yield row;`. */
const YIELD = /^(\s*)yield ([A-Za-z_$][\w$.]*);\s*$/;

const TARGETS = [
  {
    engine: 'gremlin',
    pkg: 'packages/gremlin',
    files: [
      'src/executor/hop-values.ts',
      'src/executor/start-filtered-hop-values.ts',
      'src/executor/hop-chain-values.ts',
      'src/executor/node-values.ts',
      'src/executor/optional-hop.ts',
      'src/executor/index-seed.ts',
    ],
  },
  {
    engine: 'gql',
    pkg: 'packages/gql',
    files: [
      'src/executor.ts',
      'src/executor/matching.ts',
      'src/executor/clauses.ts',
      'src/executor/scalars.ts',
      'src/executor/shortcuts.ts',
      'src/executor/ordered-rows.ts',
    ],
  },
].filter((t) => WHICH === 'all' || t.engine === WHICH);

/**
 * ⚠️ THE PRISTINE COPIES LIVE UNDER `target/`, which is gitignored AND survives the reboot a runaway
 * mutant may force. `/tmp` does not: CLAUDE.md records a scratchpad wiped by exactly that reboot,
 * with the file reconstructed by hand from `git diff`.
 */
const SAFE = join(ROOT, 'crates/lenke-engine/target/lazy-emission-screen');

mkdirSync(SAFE, { recursive: true });

const runSuite = (pkg) => {
  const p = spawnSync('bun', ['test'], {
    cwd: join(ROOT, pkg),
    encoding: 'utf8',
    timeout: 1_800_000,
    /**
     * ⚠️ `maxBuffer` IS LOAD-BEARING AND THE DEFAULT 1 MB IS NOT ENOUGH, which this screen found by
     * misreporting its own result. One GQL mutant fails 655 tests; bun prints a diff per failure,
     * the output blew past 1 MB, `spawnSync` killed the child, and the run came back `status: null`
     * — which the check below reads as DID-NOT-RUN. So the LOUDEST mutant in the pass looked like
     * the one nothing covered, which is the exact inversion this instrument exists to prevent.
     */
    maxBuffer: 256 * 1024 * 1024,
  });

  // ⚠️ BOTH STREAMS. `bun test` writes its result line to STDERR, never stdout — a check that reads
  // one stream calls a passing run "did not run" and a failing one a pass (items 767, 772-773).
  return { code: p.status, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
};

const resultLine = (out, suffix) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith(suffix)) ?? '?';

let totalSurvived = 0;

for (const { engine, pkg, files } of TARGETS) {
  const pristine = new Map();

  for (const f of files) {
    const text = readFileSync(join(ROOT, pkg, f), 'utf8');

    pristine.set(f, text);
    writeFileSync(join(SAFE, `${engine}__${f.replaceAll('/', '__')}`), text);
  }

  const restore = () => {
    for (const [f, text] of pristine) {
      writeFileSync(join(ROOT, pkg, f), text);
    }
  };

  const sites = [];

  for (const f of files) {
    pristine
      .get(f)
      .split('\n')
      .forEach((line, i) => {
        if (YIELD.test(line)) {
          sites.push({ file: f, line: i + 1, text: line.trim() });
        }
      });
  }

  restore();

  const base = runSuite(pkg);

  console.log(
    `\n### ${engine}: ${sites.length} emission sites — baseline ${resultLine(base.out, 'pass')}`,
  );

  if (base.code !== 0) {
    throw new Error(`${engine} baseline is RED; fix that before screening`);
  }

  const survived = [];

  for (const { file, line, text } of sites) {
    restore();

    const lines = readFileSync(join(ROOT, pkg, file), 'utf8').split('\n');
    const [indent] = /^\s*/.exec(lines[line - 1]);

    lines.splice(line, 0, `${indent}${text}`);
    writeFileSync(join(ROOT, pkg, file), lines.join('\n'));

    const { code, out } = runSuite(pkg);
    const tag = `${file}:${line}`;
    const fails = resultLine(out, 'fail');

    if (!out.includes('Ran ')) {
      console.log(`  ${tag.padEnd(44)} DID-NOT-RUN exit ${code}`);
      survived.push(tag);
    } else if (code !== 0) {
      console.log(`  ${tag.padEnd(44)} CAUGHT      ${fails}`);
    } else {
      console.log(`  ${tag.padEnd(44)} SURVIVED    ${fails}   ${text}`);
      survived.push(tag);
    }
  }

  restore();
  totalSurvived += survived.length;
  console.log(
    `  => ${sites.length - survived.length}/${sites.length} caught${
      survived.length > 0 ? `; SURVIVED: ${survived.join(', ')}` : ''
    }`,
  );
}

if (totalSurvived > 0) {
  console.log(
    '\nA SURVIVOR IS A GENERATOR NO TEST DRAINS. Reaching a lazy walk takes a RESIDUAL — a trailing' +
      '\n`limit` leaves a step in `rest`, so `run` wraps the generator instead of reading `drain`.',
  );
  process.exitCode = 1;
}
