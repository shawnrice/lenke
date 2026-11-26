/**
 * DOES `bounded-reach-answers.test.ts` HAVE TEETH? (item 1848)
 *
 * R6 is the control: it stops the bounded arm being reached at all. If it SURVIVES, the file is
 * testing the enumeration path and says nothing about the BFS.
 *
 * Both streams are read before the exit code — `bun test` reports to STDERR.
 *
 *     bun bounded-reach-mutants.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/reachability.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1848-mut.ts`;

const MUTANTS = {
  'R1 the depth cap is off by one (one level too few)': [
    ['for (let depth = 1; depth < spec.maxDepth', 'for (let depth = 1; depth < spec.maxDepth - 1'],
  ],
  'R2 the depth cap is off by one (one level too many)': [
    ['for (let depth = 1; depth < spec.maxDepth', 'for (let depth = 1; depth <= spec.maxDepth'],
  ],
  'R3 the bound is ignored entirely (unbounded closure)': [
    ['maxDepth: q.max ?? undefined,', 'maxDepth: undefined,'],
  ],
  'R4 a minimum above one is admitted (shortest-distance is then unsound)': [
    ['q !== undefined && (q.min ?? 0) <= 1 &&', 'q !== undefined &&'],
  ],
  'R5 ACYCLIC is admitted (it diverges from set reachability)': [
    [
      "!['trail', 'walk', 'simple'].includes(p.mode ?? 'trail') ||",
      "!['trail', 'walk', 'simple', 'acyclic'].includes(p.mode ?? 'trail') ||",
    ],
  ],
  'R6 the bounded gate is closed again (null-result control)': [
    ['(q.max === null || q.max >= 1)', '(q.max === null)'],
  ],
  'R7 the frontier is not advanced (only depth 1 is ever reached)': [
    ['      frontier = next;', '      frontier = [];'],
  ],
};

const restore = () => copyFileSync(PRISTINE, SRC);

const apply = (edits) => {
  let applied = 0;

  for (const [find, replace] of edits) {
    const s = readFileSync(SRC, 'utf8');
    const hits = s.split(find).length - 1;

    if (hits !== 1) {
      console.log(`     anchor matched ${hits} times — NOT applied`);
      continue;
    }

    writeFileSync(SRC, s.replace(find, replace));
    applied += 1;
  }

  return applied;
};

const build = () => {
  try {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};

const runTests = () => {
  const r = spawnSync(
    'bun',
    ['test', 'src/bounded-reach-answers.test.ts', 'src/reachability.test.ts'],
    { cwd: `${ROOT}/packages/gql`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

copyFileSync(SRC, PRISTINE);

console.log(
  '# bounded-reach-mutants — R6 is the control: if it SURVIVES the tests prove nothing\n',
);

try {
  for (const [label, edits] of Object.entries(MUTANTS)) {
    restore();

    const applied = apply(edits);

    if (applied !== edits.length) {
      console.log(`${label}\n     BROKEN MUTANT — ${applied}/${edits.length} applied\n`);
      continue;
    }

    if (!build()) {
      console.log(`${label}\n     CAUGHT (did not compile)\n`);
      continue;
    }

    const { code, text } = runTests();

    if (!/\d+ pass|\d+ fail/.test(text)) {
      console.log(`${label}\n     DID-NOT-RUN — no result line on either stream\n`);
      continue;
    }

    const fails = /([1-9]\d*) fail/.exec(text);

    console.log(
      `${label}\n     ${code === 0 ? 'SURVIVED' : `CAUGHT (${fails ? fails[1] : '?'} failing)`}\n`,
    );
  }
} finally {
  restore();
  build();
  console.log('# restored and rebuilt');
}
