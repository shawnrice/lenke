/**
 * MUTATION RUN for item 1869's fused scan dedupe.
 *
 * TWO FILES ARE MUTATED, because the item has two halves with different hazards.
 * `node-values.ts` holds the new rung — a wrong walk is a WRONG ANSWER and the answer tests have
 * teeth. `dedupe-filter.ts` holds the predicate EXTRACTED from `dispatch.ts` — a mistake there is a
 * wrong answer on the PIPELINE too, so its mutants must be caught by tests that never touch the new
 * rung at all.
 *
 * EVIDENCE OF EXECUTION FROM BOTH STREAMS — `bun test` reports to STDERR.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const FILES = {
  rung: '../gremlin/src/executor/node-values.ts',
  filter: '../gremlin/src/executor/runtime.ts',
};
const PRISTINE = {
  rung: '../../crates/lenke-engine/target/pristine-1869-node-values.ts',
  filter: '../../crates/lenke-engine/target/pristine-1869-dedupe-filter.ts',
};

for (const k of Object.keys(FILES)) {
  copyFileSync(FILES[k], PRISTINE[k]);
}

const base = {
  rung: readFileSync(FILES.rung, 'utf8'),
  filter: readFileSync(FILES.filter, 'utf8'),
};

const MUTANTS = [
  {
    file: 'rung',
    name: 'the dedupe predicate never filters',
    from: 'if (key in props && keep(props[key])) {',
    to: 'if (key in props) {',
  },
  {
    file: 'rung',
    name: 'an absent key is emitted as undefined',
    from: 'if (key in props && keep(props[key])) {',
    to: 'if (keep(props[key])) {',
  },
  {
    file: 'rung',
    name: 'a LABELLED dedupe is admitted',
    from: '  if (shape.label !== undefined) {\n    return undefined;\n  }',
    to: '  if (shape.label !== undefined && false) {\n    return undefined;\n  }',
  },
  {
    file: 'rung',
    name: 'a by-modulated dedupe is admitted',
    from: '    (last.bys?.length ?? 0) > 0',
    to: '    false',
  },
  {
    file: 'rung',
    name: 'a labelled (tagged) dedupe is admitted',
    from: '    (last.labels?.length ?? 0) > 0 ||',
    to: '    false ||',
  },
  {
    file: 'filter',
    name: 'EXTRACTED (now in runtime.ts): dates fall to the composite path',
    from: 'if (v instanceof LocalDate && Number.isFinite(v.days)) {',
    to: 'if (v instanceof LocalDate && Number.isFinite(v.days) && false) {',
  },
  {
    file: 'filter',
    name: 'EXTRACTED (now in runtime.ts): NO_VALUE is kept instead of filtered',
    from: '    if (v === NO_VALUE) {\n      return false;\n    }',
    to: '    if (v === NO_VALUE) {\n      return true;\n    }',
  },
  {
    file: 'filter',
    name: 'EXTRACTED (now in runtime.ts): composites key by reference only',
    from: '    if (isComposite) {',
    to: '    if (isComposite && false) {',
  },
  {
    // THE NULL CONTROL for the rung: never selected. It must SURVIVE every answer test (the
    // pipeline answers identically) and DIE on nothing here — which is why the perf A/B, not a
    // test, is what guards the admission. Recorded so the survivor is expected rather than
    // discovered.
    file: 'rung',
    name: 'CONTROL — the rung never selected',
    from: '  const { steps } = plan;\n  const last = steps[steps.length - 1];',
    to: '  const { steps } = plan;\n  const last = steps[steps.length - 1];\n\n  if (steps.length > 0) {\n    return undefined;\n  }',
  },
];

const TESTS = [
  'src/executor/node-values-dedupe.test.ts',
  // THE PIPELINE'S OWN DEDUPE TESTS, so a mutant in the EXTRACTED predicate is caught by code
  // that never goes near the new rung. Without these the extraction would be untested.
  'src/dedupe-key-namespace.test.ts',
  'src/dedupe-temporal.test.ts',
  'src/multitype-dedupe-skip.test.ts',
];

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
    cwd: '../gremlin',
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

const restoreAll = () => {
  for (const k of Object.keys(FILES)) {
    copyFileSync(PRISTINE[k], FILES[k]);
  }
};

const baseline = runTests();

console.log(`baseline: ran=${baseline.ran} failed=${baseline.failed} exit=${baseline.status}\n`);

if (!baseline.ran || baseline.failed) {
  restoreAll();

  throw new Error('baseline is not green; refusing to run mutants');
}

for (const m of MUTANTS) {
  restoreAll(); // before each, never only after the loop

  const occurrences = base[m.file].split(m.from).length - 1;

  if (occurrences !== 1) {
    console.log(`${m.name.padEnd(50)} ANCHOR MATCHED ${occurrences} TIMES — not applied`);
    continue;
  }

  writeFileSync(FILES[m.file], base[m.file].replace(m.from, m.to));
  console.log(`${m.name.padEnd(50)} ${verdictOf(runTests())}`);
}

restoreAll();
console.log('\nrestored.');
