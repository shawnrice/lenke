// Item 1962 — teeth for the permuted sort arm. ORDER is byte-identity on a sort path, so the
// mutants that matter are the ones that permute rows rather than the ones that drop them.
//
// Both streams are concatenated and searched for a result line BEFORE the exit code is read:
// `bun test` reports to STDERR.
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '/home/shawn/projects/pl-graph/packages/gql/src/executor/node-scan.ts';
const PRISTINE =
  '/home/shawn/projects/pl-graph/crates/lenke-engine/target/pristine-nodescan-1962.ts';

copyFileSync(SRC, PRISTINE);

const original = readFileSync(PRISTINE, 'utf8');

const MUTANTS = [
  {
    name: '\u26a0\u26a0 THE PERMUTATION IS IGNORED, so rows come out in SCAN order',
    expect: 'kill',
    from: '      out.push(rows[idx[j]]);',
    to: '      out.push(rows[j]);',
  },
  {
    name: '\u26a0\u26a0 THE SORT IS DROPPED (identity permutation)',
    expect: 'kill',
    from: '      idx.sort((a, b) => compareSort(vals[a], vals[b], descending, nullsFirst));',
    to: '      idx.sort((a, b) => 0 * (a - b));',
  },
  {
    name: '\u26a0\u26a0 THE SINGLE-AXIS COMPARATOR IS REVERSED',
    expect: 'kill',
    from: '      idx.sort((a, b) => compareSort(vals[a], vals[b], descending, nullsFirst));',
    to: '      idx.sort((a, b) => compareSort(vals[b], vals[a], descending, nullsFirst));',
  },
  {
    name: '\u26a0\u26a0 `descending` IS IGNORED on the single axis',
    expect: 'kill',
    from: '      idx.sort((a, b) => compareSort(vals[a], vals[b], descending, nullsFirst));',
    to: '      idx.sort((a, b) => compareSort(vals[a], vals[b], false, nullsFirst));',
  },
  {
    name: '\u26a0\u26a0 `nullsFirst` IS IGNORED on the single axis',
    expect: 'kill',
    from: '      idx.sort((a, b) => compareSort(vals[a], vals[b], descending, nullsFirst));',
    to: '      idx.sort((a, b) => compareSort(vals[a], vals[b], descending, undefined));',
  },
  {
    name: '\u26a0\u26a0 THE MULTI-AXIS LOOP STOPS AFTER THE FIRST AXIS',
    expect: 'kill',
    from: `          if (c !== 0) {
            return c;
          }
        }

        return 0;`,
    to: `          return c;
        }

        return 0;`,
  },
  {
    name: '\u26a0\u26a0 THE AXES ARE MAPPED BY POSITION instead of by column NAME',
    expect: 'kill',
    from: '    const at = keys.findIndex((k) => k.col === sort.col);',
    to: '    const at = axes.length;',
  },
  {
    name: '\u26a0\u26a0 A WINDOW IS ADMITTED (the fault rule, and this file\u2019s own oracle)',
    expect: 'kill',
    from: '  if (!noWindow || plan.limit !== undefined || plan.page !== undefined || postSkip !== 0) {',
    to: '  if (plan.page !== undefined) {',
  },
  {
    name: 'the arm is never taken (item 1962 undone)',
    // \u2705 Expected to be CAUGHT by the pure-function gate tests, not by an answer test: the route is
    // answer-equivalent, so only `permutedSortAxes`\u2019 own unit tests can see it. That is
    // perf-gate-needs-its-own-test working as designed.
    expect: 'kill',
    from: '  if (!noWindow || plan.limit !== undefined || plan.page !== undefined || postSkip !== 0) {',
    to: '  if (true || !noWindow) {',
  },
];

const resultLine = /(\d+)\s+pass|(\d+)\s+fail|test result:/;

const runSuite = () => {
  const r = spawnSync('bun', ['test', 'src/'], {
    cwd: '/home/shawn/projects/pl-graph/packages/gql',
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const fails = /(\d+)\s+fail/.exec(both);

  return {
    ran: resultLine.test(both),
    failing: fails === null ? 0 : Number(fails[1]),
    status: r.status,
    signal: r.signal,
  };
};

const base = runSuite();

console.log(`baseline: ran=${String(base.ran)} failing=${String(base.failing)}\n`);

if (!base.ran || base.failing !== 0) {
  console.log('\u26a0\ufe0f BASELINE NOT CLEAN');
  process.exit(1);
}

const unexpected = [];

for (const m of MUTANTS) {
  const count = original.split(m.from).length - 1;

  if (count !== 1) {
    console.log(`\u274c ANCHOR DRIFT (${String(count)})  ${m.name}`);
    unexpected.push(`${m.name} [ANCHOR]`);
    continue;
  }

  writeFileSync(SRC, original.replace(m.from, m.to));

  const r = runSuite();

  copyFileSync(PRISTINE, SRC);

  const died = r.status === 124 || r.status === 137 || r.signal !== null;
  const killed = r.ran && r.failing > 0;
  const verdictOf = () => {
    if (died) {
      return '\u23f1/\ud83d\udca5 non-termination \u2014 CAUGHT';
    }

    // A run with NO result line on either stream is a harness failure, not a survivor \u2014 items
    // 767 and 772-773 conflated those in both directions.
    if (!r.ran) {
      return '\u274c DID-NOT-RUN';
    }

    return killed ? `\u2705 caught   ${String(r.failing)} failing` : '\u274c SURVIVED';
  };
  const verdict = verdictOf();
  const ok = m.expect === 'kill' ? killed || died : !killed && !died && r.ran;

  console.log(`${ok ? '  ' : '\u26a0\ufe0f'} ${verdict.padEnd(30)} ${m.name}`);

  if (!ok) {
    unexpected.push(m.name);
  }
}

copyFileSync(PRISTINE, SRC);
console.log('\n# restored');

if (unexpected.length > 0) {
  console.log(`\n\u26a0\ufe0f ${String(unexpected.length)} UNEXPECTED:`);

  for (const u of unexpected) {
    console.log(`  - ${u}`);
  }
}
