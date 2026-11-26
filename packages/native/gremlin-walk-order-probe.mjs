/**
 * DOES GREMLIN'S FUSED HOP-CHAIN WALK VISIT FAR-END ELEMENTS IN THE SAME ORDER AS THE GENERIC
 * TRAVERSER PIPELINE? (item 1834)
 *
 * THIS IS ITEM 1833's NAMED BLOCKER. `groupCount` costs 14.8x its own pair floor because the
 * tally rides the generic walk while `values(k)` rides `hopChainValuesShortcut` at 15 ns/row — and
 * the obvious fix (tally the fused values) is only sound if the two walks agree on ORDER.
 * `groupCount` returns a **Map**, whose iteration order is first-occurrence order of the keys, and
 * byte-identity with the Rust engine is a hard invariant. Item 1831 asked exactly this question of
 * the GQL rungs; this is its Gremlin twin.
 *
 * THE ORACLE IS THE SAME QUERY WITH THE SHORTCUT FORCED TO DECLINE, which is the only honest way
 * to get the generic route for an IDENTICAL question. Every surface spelling that avoids the
 * shortcut also changes what is returned (`path()` tracks paths, `valueMap` yields maps), so a
 * comparison against one of those would compare two different questions. This runs the query, then
 * re-runs it with `hopChainValuesShortcut` returning `undefined`, and compares the SEQUENCES.
 *
 * IT IS A MUTATION RUN, SO IT RESTORES THE FILE AND REBUILDS BEFORE AND AFTER, and it asserts
 * the arm it claims: the fused arm must have the shortcut live and the generic arm must not. An A/B
 * whose arms are not asserted cannot tell a null from a mistake (item 1824 learned that).
 *
 *     bun gremlin-walk-order-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const TARGET = `${ROOT}/packages/gremlin/src/executor/hop-chain-values.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1834-hopchain.ts`;
const MARKER = 'MUTANT-1834-NO-SHORTCUT';

/** The traversals to compare. One line each, run in a child so the module graph is fresh. */
const CASES = {
  'hop2 values': "traversal(V(), hasLabel('P'), out('E'), out('E'), values('k'))",
  'hop3 values': "traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), values('k'))",
  'hop2 filtered': "traversal(V(), hasLabel('P'), out('E'), hasLabel('P'), out('E'), values('k'))",
};

const FIXTURES = {
  'fanout 1 sequential': { fanout: 1, stride: '(i + 1) % N' },
  'fanout 1 scattered': { fanout: 1, stride: '(i * 7919) % N' },
  'fanout 3 scattered': { fanout: 3, stride: '(i * 7 + 3 + h * 2654435761) % N' },
  'fanout 5 dense': { fanout: 5, stride: '(i * 13 + h * 977) % N' },
};

const child = (fixture, traversalSrc) => {
  const { fanout, stride } = FIXTURES[fixture];
  const src = `
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
const N = 400;
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['P'], properties: { k: i % 37 } });
}
let e = 0;
for (let h = 0; h < ${fanout}; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({ id: 'e' + (e++), from: g.getVertexById('v' + i), to: g.getVertexById('v' + (${stride})), labels: ['E'] });
  }
}
process.stdout.write(JSON.stringify(toArray(${traversalSrc}, g)));
`;

  return execFileSync('bun', ['--input-type=module', '-e', src], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const shortcutLiveInDist = () =>
  !readFileSync(`${ROOT}/packages/gremlin/dist/esm/index.mjs`, 'utf8').includes(MARKER);

copyFileSync(TARGET, PRISTINE);

try {
  // ── ARM 1: the shortcut live ──────────────────────────────────────────────────────────────────
  build();

  if (!shortcutLiveInDist()) {
    throw new Error('ARM ASSERTION FAILED: the fused arm already carries the mutant marker');
  }

  const fused = {};

  for (const fixture of Object.keys(FIXTURES)) {
    for (const [name, src] of Object.entries(CASES)) {
      fused[`${fixture}|${name}`] = child(fixture, src);
    }
  }

  // ── ARM 2: the shortcut forced to decline ─────────────────────────────────────────────────────
  const s = readFileSync(PRISTINE, 'utf8');
  const anchor =
    'export const hopChainValuesShortcut = (plan: Plan, graph: Graph): HopValues | undefined => {';

  if (s.split(anchor).length - 1 !== 1) {
    throw new Error('anchor not found exactly once — the probe needs updating');
  }

  writeFileSync(
    TARGET,
    s.replace(
      anchor,
      `${anchor}\n  if (String(graph) !== '${MARKER}') {\n    return undefined;\n  }`,
    ),
  );
  build();

  if (shortcutLiveInDist()) {
    throw new Error('ARM ASSERTION FAILED: the generic arm does NOT carry the mutant marker');
  }

  console.log('# gremlin-walk-order-probe — arms asserted via a marker in the built dist');
  console.log(
    '# "same order" = an IDENTICAL value SEQUENCE from the two routes, not the same set\n',
  );

  let mismatch = false;

  for (const fixture of Object.keys(FIXTURES)) {
    console.log(`## ${fixture}`);

    for (const [name] of Object.entries(CASES)) {
      const key = `${fixture}|${name}`;
      const generic = child(fixture, CASES[name]);
      const a = JSON.parse(fused[key]);
      const b = JSON.parse(generic);

      if (a.length === 0 || b.length === 0) {
        console.log(`   ${name.padEnd(16)} VACUOUS — ${a.length}/${b.length}, proves nothing`);
        continue;
      }

      if (fused[key] === generic) {
        console.log(`   ${name.padEnd(16)} same order (${a.length} values)`);
        continue;
      }

      mismatch = true;

      const sameSet =
        [...a].sort((x, y) => String(x).localeCompare(String(y))).join('|') ===
        [...b].sort((x, y) => String(x).localeCompare(String(y))).join('|');
      let at = -1;

      for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
          at = i;
          break;
        }
      }

      console.log(
        `   ${name.padEnd(16)} DIFFERS at ${at} (${String(a[at])} vs ${String(b[at])}), ` +
          `lengths ${a.length}/${b.length}, same multiset: ${sameSet}`,
      );
    }

    console.log('');
  }

  console.log(
    mismatch
      ? '# VERDICT: the two walks DIFFER in order. A fused groupCount would change the Map order.'
      : '# VERDICT: no mismatch on these fixtures. Evidence, not proof — see the header.',
  );
} finally {
  copyFileSync(PRISTINE, TARGET);
  build();
}
