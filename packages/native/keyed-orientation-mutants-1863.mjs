/**
 * MUTATION RUN for item 1863's keyedCountOf orientation widening.
 *
 * UNLIKE MOST ROUTE CHOICES IN THIS REPO, A RELAXATION HERE IS A WRONG ANSWER, not a slow one —
 * this rung COMPUTES the count rather than choosing between two routes that agree. So the answer
 * tests have teeth against a loosened gate. What they cannot catch is a gate wrongly TIGHTENED,
 * which silently abandons the arm; the route assertions (`takesTheRung`) are what cover that, and
 * both kinds of mutant are below.
 *
 * EVIDENCE OF EXECUTION COMES FROM BOTH STREAMS. `bun test` writes its `N pass` / `N fail` line
 * to STDERR, not stdout — items 767 and 772-773 each got this wrong in a different direction, once
 * reading an empty stdout as "never ran" and once printing DID-NOT-RUN for clean passes. This
 * concatenates the two, looks for a result line, and only then reads the exit code.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '../gql/src/executor/shortcuts.ts';
const PRISTINE = '../../crates/lenke-engine/target/pristine-1863-shortcuts.ts';

copyFileSync(SRC, PRISTINE);

const base = readFileSync(SRC, 'utf8');

const MUTANTS = [
  {
    name: 'orientation-ignored (the PRE behaviour)',
    from: "out: keyIsEnd ? rel.direction !== 'out' : rel.direction === 'out',",
    to: "out: rel.direction !== 'out',",
  },
  {
    name: 'self-loop pattern ADMITTED',
    from: '    if (keyIsEnd === keyIsStart) {\n      return null;',
    to: '    if (keyIsEnd && !keyIsStart && false) {\n      return null;',
  },
  {
    name: 'far label read off the KEY node',
    from: 'label: farNode.label,',
    to: 'label: keyNode.label,',
  },
  {
    name: 'key label read off the FAR node',
    from: '    if (keyNode.label !== undefined) {\n      keyLabels.push(keyNode.label);',
    to: '    if (farNode.label !== undefined) {\n      keyLabels.push(farNode.label);',
  },
  {
    name: 'key/far swapped for the INLINE predicates',
    from: '    const inFar = inlineOf(farNode);\n    const inKey = inlineOf(keyNode);',
    to: '    const inFar = inlineOf(keyNode);\n    const inKey = inlineOf(farNode);',
  },
  {
    // THE NULL CONTROL: the rung never selected. It must SURVIVE the answer tests (declining
    // computes the same count down the general matcher) and DIE on the route assertions.
    name: 'CONTROL — rung never selected',
    from: '  if (patterns.length !== 2) {\n    return null;\n  }',
    to: '  if (patterns.length !== 2 || true) {\n    return null;\n  }',
  },
];

const TESTS = ['src/keyed-count-orientation.test.ts', 'src/routes-fired.test.ts'];

/** A timeout (124) or an OOM kill (137) IS the mutant being caught, not a harness failure. */
const verdictOf = (r) => {
  if (!r.ran) {
    return 'DID-NOT-RUN';
  }

  if (r.status === 124 || r.status === 137) {
    return `CAUGHT (exit ${String(r.status)})`;
  }

  return r.failed ? 'CAUGHT' : 'SURVIVED';
};

const runTests = () => {
  const r = spawnSync('bun', ['test', ...TESTS], {
    cwd: '../gql',
    encoding: 'utf8',
    timeout: 300_000,
  });
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const ran = /\d+ (pass|fail)/.test(both);
  const fails = /(\d+) fail/.exec(both);

  return { ran, failed: fails !== null && fails[1] !== '0', status: r.status, both };
};

console.log('baseline:');
const baseline = runTests();

const warn = baseline.ran ? '' : '  NO RESULT LINE — the harness is not running tests';

console.log(`  ran=${baseline.ran} failed=${baseline.failed} exit=${baseline.status}${warn}`);

if (!baseline.ran || baseline.failed) {
  copyFileSync(PRISTINE, SRC);

  throw new Error('baseline is not green; refusing to run mutants');
}

console.log('');

for (const m of MUTANTS) {
  // RESTORE BEFORE EACH, never only after the loop: an interrupted run must not leave a mutant in
  // the tree with only `git diff` standing between it and a commit.
  copyFileSync(PRISTINE, SRC);

  const occurrences = base.split(m.from).length - 1;

  if (occurrences !== 1) {
    console.log(`${m.name.padEnd(42)} ANCHOR MATCHED ${occurrences} TIMES — not applied`);
    continue;
  }

  writeFileSync(SRC, base.replace(m.from, m.to));

  const r = runTests();
  const verdict = verdictOf(r);

  console.log(`${m.name.padEnd(42)} ${verdict}`);
}

copyFileSync(PRISTINE, SRC);
console.log('\nrestored.');
