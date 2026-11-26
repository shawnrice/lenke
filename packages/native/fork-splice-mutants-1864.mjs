/**
 * MUTATION RUN for item 1864's forked-pattern splice.
 *
 * A REWRITE'S MUTANTS ARE NOT A ROUTE CHOICE'S. Splicing CHANGES THE PATTERN, so a wrong splice
 * is a wrong ANSWER and the answer tests have teeth — but a splice that never fires is
 * answer-equivalent and invisible to them, which is why `splice-forked-patterns.test.ts` asserts
 * the AST shape (one pattern, two segments, first direction flipped) rather than a route. Item
 * 1844's own note records why: `countShortcut` fires for both spellings, so a route assertion
 * passes with the rewrite disabled.
 *
 * EVIDENCE OF EXECUTION FROM BOTH STREAMS — `bun test` reports to STDERR.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '../gql/src/executor/rewrites.ts';
const PRISTINE = '../../crates/lenke-engine/target/pristine-1864-rewrites.ts';

copyFileSync(SRC, PRISTINE);

const base = readFileSync(SRC, 'utf8');

const MUTANTS = [
  {
    name: 'direction NOT flipped',
    from: 'segments: [{ ...seg, rel: { ...seg.rel, direction: flipped }, node: left.start }],',
    to: 'segments: [{ ...seg, rel: { ...seg.rel }, node: left.start }],',
  },
  {
    name: 'start and far node NOT swapped',
    from: '    start: seg.node,\n',
    to: '    start: left.start,\n',
  },
  {
    name: 'a multi-segment left leg ADMITTED',
    from: '  if (left.segments.length !== 1) {\n    return null;\n  }',
    to: '  if (left.segments.length < 1) {\n    return null;\n  }',
  },
  {
    // Replaces the removed `left.start.variable !== joinOn` guard, whose mutant survived because
    // the enclosing condition strictly implies it. This one tests the half that IS live.
    name: 'fork taken without a shared start variable',
    from: '        left.start.variable !== undefined && right.start.variable === left.start.variable',
    to: '        left.start.variable !== undefined',
  },
  {
    name: 'an UNDIRECTED leg admitted',
    from: "const REVERSED: Record<string, 'out' | 'in' | 'both'> = { out: 'in', in: 'out' };",
    to: "const REVERSED: Record<string, 'out' | 'in' | 'both'> = { out: 'in', in: 'out', both: 'both' };",
  },
  {
    // THE NULL CONTROL: the fork splice never fires. It must SURVIVE the answer tests (the comma
    // form still answers down the general matcher) and DIE on the AST-shape assertions.
    name: 'CONTROL — the fork splice never fires',
    from: '      if (forked === null) {\n        continue;\n      }',
    to: '      if (forked === null || true) {\n        continue;\n      }',
  },
];

const TESTS = [
  'src/splice-forked-patterns.test.ts',
  'src/splice-chained-patterns.test.ts',
  'src/keyed-count-orientation.test.ts',
  'src/routes-fired.test.ts',
];

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
  const fails = /(\d+) fail/.exec(both);

  return {
    ran: /\d+ (pass|fail)/.test(both),
    failed: fails !== null && fails[1] !== '0',
    status: r.status,
  };
};

const baseline = runTests();

console.log(`baseline: ran=${baseline.ran} failed=${baseline.failed} exit=${baseline.status}\n`);

if (!baseline.ran || baseline.failed) {
  copyFileSync(PRISTINE, SRC);

  throw new Error('baseline is not green; refusing to run mutants');
}

for (const m of MUTANTS) {
  copyFileSync(PRISTINE, SRC); // restore BEFORE each, never only after the loop

  const occurrences = base.split(m.from).length - 1;

  if (occurrences !== 1) {
    console.log(`${m.name.padEnd(40)} ANCHOR MATCHED ${occurrences} TIMES — not applied`);
    continue;
  }

  writeFileSync(SRC, base.replace(m.from, m.to));
  console.log(`${m.name.padEnd(40)} ${verdictOf(runTests())}`);
}

copyFileSync(PRISTINE, SRC);
console.log('\nrestored.');
