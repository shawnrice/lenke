/*
 * Item 2062 — WHICH shapes reach `countProjectedWalk`, and does the walk hand it a `drain`?
 *
 * Item 2061 left a measured 1.88x in that function. With a `drain` present it builds the whole array
 * and reads `.length`, so a query returning ONE NUMBER materializes every row:
 *
 *     countProjectedWalk = (values) => [values.drain === undefined ? countIterable(values) : values.drain().length]
 *
 * ⚠️⚠️ **WHETHER `countIterable` IS BETTER IS GENUINELY OPEN, which is why this starts with a census
 * and not a patch.** Item 1998 measured a walk WITHOUT a drain at **1.55x** — a generator's per-yield
 * cost can lose to a tight drain loop even though the drain allocates an array. So the question is
 * per-SHAPE, and the first thing needed is the list of shapes that actually arrive here.
 *
 * ⚠️ GUESSING FROM ROW NAMES WOULD BE WRONG IN BOTH DIRECTIONS: `scan: count` is answered in closed
 * form from a bucket `size` (O(1), 0.00 ms on the screen) and never reaches this function, while a
 * row whose name says nothing about counting may still land here through a residual.
 *
 * ⚠️ IT IS A MUTATION RUN — pristine copy under `target/`, restore in a `finally`, and the patch is
 * ASSERTED PRESENT before any shape is measured, because a silently-unpatched build would report
 * "nothing reaches it" indistinguishably from the truth (item 2033 made exactly that mistake).
 *
 *     bun countwalk-census-2062.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/aggregation.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-2062-aggregation.ts`;
const MARKER = 'COUNTWALK_CENSUS_2062';
const NODES = Number(process.env.NODES ?? 20_000);

const ANCHOR = `export const countProjectedWalk = (values: HopWalk): unknown[] => [
  values.drain === undefined ? countIterable(values) : values.drain().length,
];`;

const PATCHED = `export const countProjectedWalk = (values: HopWalk): unknown[] => {
  // ${MARKER}
  const g = globalThis as unknown as { __cpw?: string[] };

  g.__cpw ??= [];
  g.__cpw.push(values.drain === undefined ? 'iterate' : 'drain');

  return [values.drain === undefined ? countIterable(values) : values.drain().length];
};`;

/** Count-bearing shapes, plus two that must NOT arrive here. */
const SHAPES = {
  'scan: count': 'traversal(V(), count())',
  'scan: has count': "traversal(V(), has('k', 3), count())",
  'scan: where values count': "traversal(V(), where(traversal(out('E'))), values('k'), count())",
  'hop1: count': "traversal(V(), out('E'), count())",
  'hop1: has count': "traversal(V(), out('E'), has('k', 3), count())",
  'hop1: dedupe count': "traversal(V(), out('E'), dedupe(), count())",
  'hop1: values count': "traversal(V(), out('E'), values('k'), count())",
  'hop2: count': "traversal(V(), out('E'), out('E'), count())",
  'hop2: has count': "traversal(V(), out('E'), out('E'), has('k', 3), count())",
  'hop2: values count': "traversal(V(), out('E'), out('E'), values('k'), count())",
  'edgef: outE has count': "traversal(V(), outE('E'), has('w', 3), count())",
  'edgef: outE has inV count': "traversal(V(), outE('E'), has('w', 3), inV(), count())",
  // CONTROLS: no count at all, so a hit here would mean the patch is reporting someone else's call.
  'control: scan values': "traversal(V(), values('k'))",
  'control: hop1 fold': "traversal(V(), out('E'), values('k'), fold())",
};

const build = () => {
  execFileSync('npx', ['nx', 'build', '@lenke/gremlin'], { cwd: ROOT, stdio: 'ignore' });
};

const driver = (expr) => `
import { Graph } from '@lenke/core';
import { V, count, dedupe, fold, has, inV, out, outE, toArray, traversal, values, where } from '@lenke/gremlin';

const g = new Graph();
const N = ${String(NODES)};

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['T'], properties: { k: i % 50, s: 's' + (i % 7), w: i % 11 } });
}

for (let e = 0; e < N; e += 1) {
  g.addEdge({
    id: 'e' + e,
    from: g.getVertexById('v' + e),
    to: g.getVertexById('v' + ((e * 7 + 3) % N)),
    labels: ['E'],
    properties: { w: e % 11 },
  });
}

toArray(${expr}, g);

const seen = globalThis.__cpw ?? [];
console.log(JSON.stringify({ calls: seen.length, kinds: [...new Set(seen)] }));
`;

let restored = false;

try {
  if (!existsSync(PRISTINE)) {
    copyFileSync(SRC, PRISTINE);
  }

  const original = readFileSync(PRISTINE, 'utf8');

  if (!original.includes(ANCHOR)) {
    throw new Error(
      'ANCHOR not found in the pristine source — countProjectedWalk has changed shape',
    );
  }

  writeFileSync(SRC, original.replace(ANCHOR, PATCHED));

  if (!readFileSync(SRC, 'utf8').includes(MARKER)) {
    throw new Error('patch did not land');
  }

  build();

  /*
   * ⚠️ THE PATCH IS ASSERTED TO BE LIVE IN THE BUILT DIST before anything is measured. An absent
   * global and zero calls are indistinguishable (item 2033), so a shape KNOWN to reach the function
   * must report a call, or the whole census is meaningless.
   */
  const probe = JSON.parse(
    execFileSync('bun', ['-e', driver(SHAPES['scan: where values count'])], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
    }),
  );

  if (probe.calls === 0) {
    throw new Error(
      'the instrumented build reports ZERO calls for `scan: where values count` — the dist is stale or the patch is not reached; refusing to report a census',
    );
  }

  console.log(
    `\n#  patch live (probe row saw ${String(probe.calls)} call(s)), N=${String(NODES)}\n`,
  );
  console.log(`  ${'row'.padEnd(28)} ${'calls'.padStart(5)}  walk hands it`);
  console.log(`  ${'-'.repeat(28)} ${'-'.repeat(5)}  ${'-'.repeat(14)}`);

  for (const [name, expr] of Object.entries(SHAPES)) {
    const out = JSON.parse(
      execFileSync('bun', ['-e', driver(expr)], {
        cwd: `${ROOT}/packages/native`,
        encoding: 'utf8',
      }),
    );
    const kinds = out.kinds.length === 0 ? '—' : out.kinds.join('+');

    console.log(`  ${name.padEnd(28)} ${String(out.calls).padStart(5)}  ${kinds}`);
  }

  console.log(
    '\n#  `drain` means the array is built and `.length` read — the 1.88x item 2061 measured.' +
      '\n#  `iterate` means it already counts without allocating, so those rows cannot gain.\n',
  );
} finally {
  copyFileSync(PRISTINE, SRC);
  restored = true;
  build();
  console.log(`#  restored and rebuilt (${restored ? 'ok' : 'FAILED'})`);
}
