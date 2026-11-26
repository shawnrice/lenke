/**
 * WHICH RUNG CLAIMS THE TWO-HOP GREMLIN COUNT? (item 1845)
 *
 * `V().out().out().count()` measures 51.5 ms at 200k/1M — 10 ns a path, which is ENUMERATION —
 * while `V().out().out().out().count()` measures 22.9 ms for FIVE TIMES the paths, 0.9 ns each,
 * which is algebra. Both go through `countShortcut`, and `hopChainCount` carries a two-hop DEGREE
 * INNER PRODUCT (item 590) that is one pass over vertices. So the fast rung exists and something
 * above it in the chain is answering first.
 *
 * TIMING CANNOT TELL "DECLINED" FROM "MORE WORK" (`rung-precedence-decides-speed`), so this
 * probe does not infer the culprit — it DISABLES each candidate in turn and re-measures. The rung
 * whose removal makes the two-hop count fast is the one starving the inner product.
 *
 * EACH ARM IS ITS OWN PROCESS and each build is asserted by a marker in the built dist, so an
 * arm that silently failed to apply cannot read as a null result.
 *
 *     bun rung-starve-probe-1845.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/count-shortcut.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1845-cs.ts`;

/** Each candidate: the call site to neutralise, and a marker proving the edit reached the dist. */
const CANDIDATES = {
  'none (baseline)': null,
  'filterChainCount disabled': 'filterChainCount(mid, graph)',
  'startFilteredHopCount disabled': 'startFilteredHopCount(mid, graph)',
  'bothFilteredHopCount disabled': 'bothFilteredHopCount(mid, graph)',
};

const MARKER = 'STARVE_PROBE_1845';

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerCount = () => {
  const r = spawnSync('grep', ['-c', MARKER, `${ROOT}/packages/gremlin/dist/esm/index.mjs`], {
    encoding: 'utf8',
  });

  return Number((r.stdout ?? '0').trim());
};

const measure = (depth) => {
  const src = `
import { Graph } from '@lenke/core';
import { V, count, out, toArray, traversal } from '@lenke/gremlin';
const N = 200000;
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['P'], properties: { n: i % 8 } });
}
for (let k = 0; k < N * 5; k += 1) {
  const to = ((k % N) * 104729 + Math.floor(k / N) * 977) % N;
  g.addEdge({ id: 'e' + k, from: g.getVertexById('v' + ((k * 7919) % N)), to: g.getVertexById('v' + to), labels: ['KNOWS'], properties: { w: k % 7 } });
}
const hops = Array.from({ length: ${depth} }, () => out('KNOWS'));
const tr = traversal(V(), ...hops, count());
const s = [];
let ans = 0;
for (let r = 0; r < 8; r += 1) {
  const t0 = performance.now();
  ans = toArray(tr, g)[0];
  s.push(performance.now() - t0);
}
const kept = s.slice(3).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ ms: kept[Math.floor(kept.length / 2)], ans }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

console.log('# rung-starve-probe — the two-hop count, with each candidate rung disabled\n');
console.log(
  '# a rung whose removal makes 2 hops FAST was answering a shape a faster rung wanted\n',
);

try {
  for (const [label, callSite] of Object.entries(CANDIDATES)) {
    copyFileSync(PRISTINE, SRC);

    if (callSite !== null) {
      const s = readFileSync(SRC, 'utf8');

      if (s.split(callSite).length - 1 !== 1) {
        console.log(`${label.padEnd(32)} anchor not unique — skipped`);
        continue;
      }

      // NOT A COMMENT. The first version marked the arm with `/* MARKER */` and the bundler
      // stripped it, so the arm assertion failed on the very first disabled arm — which is the
      // assertion doing its job. An assignment to a NAMED global survives minification.
      writeFileSync(
        SRC,
        s.replace(
          callSite,
          `((globalThis as Record<string, unknown>).${MARKER} = 1, undefined as never)`,
        ),
      );
    }

    build();

    const n = markerCount();
    const expected = callSite === null ? 0 : 1;

    if (n > 0 !== expected > 0) {
      throw new Error(`ARM ASSERTION FAILED: ${label} dist marker count ${n}`);
    }

    const two = measure(2);
    const three = measure(3);

    console.log(
      `${label.padEnd(32)} 2hop ${two.ms.toFixed(1).padStart(7)} ms (${two.ans})   ` +
        `3hop ${three.ms.toFixed(1).padStart(7)} ms (${three.ans})`,
    );
  }
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('\n# restored and rebuilt');
}
