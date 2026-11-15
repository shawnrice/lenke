// Item 1953 — IS THE TEMPLATE CLONE TESTED ANYWHERE? A mechanical sweep over every fold site.
//
// Item 1952 found that replacing `{ ...template }` with `template` in the walk it had just built
// survived the ENTIRE repo: nothing inside the engine mutates a projected row, and two aliased rows
// carry identical values, so no differential test can see it. The rows go to the CALLER though, and
// aliasing is observable the moment they write to one — so each of these is a load-bearing line.
//
// 🔑 THE SWEEP IS MECHANICAL ON PURPOSE. There are eleven fold sites in `hop-projection.ts` and
// working out by hand which query shape reaches each is exactly the kind of reasoning that produced
// item 1952's gap. Replacing the i-th occurrence and running the suite ASKS the question instead.
//
// ⚠️ A SURVIVOR HERE IS NOT A SLOW PATH, IT IS AN UNTESTED CONTRACT. Report, then write the test.
//
//     bun clone-sweep-1953.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '/home/shawn/projects/pl-graph/packages/gql/src/executor/hop-projection.ts';
const PRISTINE = '/home/shawn/projects/pl-graph/crates/lenke-engine/target/pristine-hop-1953.ts';

copyFileSync(SRC, PRISTINE);

const original = readFileSync(PRISTINE, 'utf8');
const NEEDLE = '{ ...template }';

/*
 * ⚠️ CODE SITES ONLY. The first run of this sweep reported 11 sites and 8 survivors — and two of
 * the "survivors" were the string `{ ...template }` appearing in PROSE, inside the comments that
 * explain the fold. Mutating a comment of course survives, and reporting it as an untested contract
 * is a false alarm that would have sent me writing tests for nothing. A line whose first non-space
 * character is `*` or `//` is documentation, not a fold.
 */
const isCodeLine = (line) => {
  const t = line.trimStart();

  return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
};

/** Every code-site offset, oldest first. */
const SITES = (() => {
  const lines = original.split('\n');
  const out = [];
  let offset = 0;

  for (const [i, line] of lines.entries()) {
    if (line.includes(NEEDLE) && isCodeLine(line)) {
      out.push({ offset: offset + line.indexOf(NEEDLE), line: i + 1 });
    }

    offset += line.length + 1;
  }

  return out;
})();
const total = SITES.length;

/** Replace ONLY the nth code site, so each is tested on its own. */
const mutateNth = (text, n) => {
  const { offset } = SITES[n];

  return `${text.slice(0, offset)}template${text.slice(offset + NEEDLE.length)}`;
};

/** The nth site's line, and the nearest preceding `const <name> = ` declaration. */
const describeNth = (text, n) => {
  const { offset, line } = SITES[n];
  const decl = [...text.slice(0, offset).matchAll(/^const (\w+) = /gm)].at(-1);

  return { line, owner: decl === undefined ? '?' : decl[1] };
};

const resultLine = /(\d+)\s+pass|(\d+)\s+fail|test result:/;

const runSuite = () => {
  const r = spawnSync('bun', ['test', 'src/'], {
    cwd: '/home/shawn/projects/pl-graph/packages/gql',
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // BOTH streams, then the exit code — `bun test` reports to STDERR.
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const fails = /(\d+)\s+fail/.exec(both);

  return {
    ran: resultLine.test(both),
    failing: fails === null ? 0 : Number(fails[1]),
    status: r.status,
  };
};

const base = runSuite();

console.log(
  `${String(total)} fold sites; baseline ran=${String(base.ran)} failing=${String(base.failing)}\n`,
);

if (!base.ran || base.failing !== 0) {
  console.log('⚠️ BASELINE NOT CLEAN');
  process.exit(1);
}

const survivors = [];

for (let n = 0; n < total; n += 1) {
  const { line, owner } = describeNth(original, n);

  writeFileSync(SRC, mutateNth(original, n));

  const r = runSuite();

  // Restore BEFORE the next mutant, never only after the loop.
  copyFileSync(PRISTINE, SRC);

  const killed = r.ran && r.failing > 0;

  console.log(
    `${killed ? '✅ caught' : '❌ SURVIVED'}  ${String(line).padStart(5)}  ${owner.padEnd(38)}  ${killed ? `${String(r.failing)} failing` : 'aliasing is invisible'}`,
  );

  if (!killed) {
    survivors.push({ line, owner });
  }
}

copyFileSync(PRISTINE, SRC);
console.log('\n# restored');

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} UNTESTED CLONE SITE(S):`);

  for (const s of survivors) {
    console.log(`  - ${SRC.split('/').pop()}:${String(s.line)}  ${s.owner}`);
  }
}
