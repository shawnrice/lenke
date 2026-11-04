/**
 * Aggregate self time per frame from a `.cpuprofile`, then report which frames are UNPRICED —
 * their function name appears nowhere in `CLOSED.md` or the audit.
 *
 * The cross-check is the whole point. Item 919 established that a profiler finds what hand-placed
 * timers cannot, but a profile's top frames are mostly hot for reasons already written down, and
 * re-deriving those is the expensive path CLAUDE.md warns about. A hot frame with ZERO mentions in
 * either store is the one worth a tick.
 *
 * Run it with `runtime-profile-probe.mjs`, which produces one profile per query shape:
 *
 *     for S in control point hopfilter sortedpage grouped; do
 *       node --cpu-prof --cpu-prof-dir=$D --cpu-prof-name=$S.cpuprofile \
 *            runtime-profile-probe.mjs $S 2000
 *     done
 *     node runtime-profile-analyze.mjs $D
 *
 * WHAT IT CANNOT TELL YOU, learned by getting it wrong (item 921): a frame's NAME is not its
 * code. V8 synthesises names for anonymous closures from whatever binding they were assigned
 * through, so `(env) => propOf(env.binding.get(variable), key)` profiles as `variable.variable`
 * and a regex literal profiles as `RegExp: <pattern>`. Those strings can never appear in a
 * document, so "ZERO mentions" says nothing about whether the code is priced — and that closure's
 * path is items 216/224/230's territory, heavily measured. Such names report `n/a`, and so do
 * Node's own loader frames, which are startup cost in someone else's code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , DIR] = process.argv;
const ROOT = new URL('../../', import.meta.url).pathname;

/** Startup cost in Node itself — trivially "unpriced", and it buries the engine frames. */
const NODE_INTERNAL = new Set([
  'compileSourceTextModule',
  'compileForInternalLoader',
  'requireBuiltin',
  'initializeESMLoader',
]);

const docs = ['docs/reviews/CLOSED.md', 'docs/reviews/2026-08-31-ts-audit.md'].map((p) =>
  readFileSync(join(ROOT, p), 'utf8'),
);

/** An accessor frame: `get properties`, `set labels`. */
const ACCESSOR = /^(?:get|set) ([A-Za-z_$][\w$]*)$/;

/**
 * A frame from the PROBE rather than from the engine. A probe's fixture builder is genuinely hot and
 * its names are of course absent from the audit, so it reports as a top unpriced frame every run —
 * the write-path screen flagged `addEdgeOnly`, `setProps` and `removeVertices`, all harness. The GQL
 * probe's `build` escaped notice only because "build" appears 841 times in the documents.
 */
const isHarnessFrame = (r) => /-probe\.(?:mjs|ts)$/.test(r.where.split(':')[0]);

/**
 * Count a name as an IDENTIFIER, not as a substring.
 *
 * A plain `split(name).length - 1` counts the English word inside prose, which inflated `pick` to
 * 202 where only 53 are the identifier. Measured before changing it, because the inflation is NOT
 * uniform and the obvious generalisation is wrong: `values` reads 1118 substring / 1070 word-bound
 * / 974 inside backticks, so it is genuinely well-covered and not an artifact. This fix changes the
 * ranking of common-word frames only; it overturned none of item 1358's conclusions.
 */
const countIdentifier = (name) => {
  const re = new RegExp(
    `(?<![A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`,
    'g',
  );

  return docs.reduce((acc, d) => acc + (d.match(re) ?? []).length, 0);
};

/** Self time per (functionName, file:line), summed over samples. */
const selfTime = (profilePath) => {
  const prof = JSON.parse(readFileSync(profilePath, 'utf8'));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  const deltas = prof.timeDeltas ?? [];

  prof.samples.forEach((id, i) => {
    const node = byId.get(id);

    if (node === undefined) {
      return;
    }

    const cf = node.callFrame;
    const name = cf.functionName === '' ? '(anonymous)' : cf.functionName;
    const url = cf.url ?? '';
    const file = url.split('/').at(-1);
    const key = `${name}\u0000${file}:${cf.lineNumber + 1}\u0000${url}\u0000${cf.lineNumber + 1}`;

    totals.set(key, (totals.get(key) ?? 0) + (deltas[i] ?? 0));
  });

  return totals;
};

/**
 * The ENCLOSING named function for an unnameable frame, so it can be cross-checked after all.
 *
 * Item 921 suppressed synthetic names because a name V8 invented can never appear in a document,
 * so "ZERO mentions" was meaningless for them. That was right, and it over-corrected: the biggest
 * frame in three of the five shapes is an `(anonymous)` closure, the verdict line then said "every
 * hot frame is already recorded", and `n/a` ("could not check") had been laundered into "checked".
 *
 * V8 reports such a frame at its ENCLOSING declaration's line, not the closure's own, because the
 * closure is the `return (graph, params) => {...}` of a compile-time builder. So the nearest
 * `const <name> = ` / `function <name>` at or above that line names the code — and THAT name is a
 * real identifier which a document can mention. `topKNodeWalk`, not `(anonymous)`.
 */
const srcCache = new Map();

const enclosingName = (rawUrl, line) => {
  // Node reports `file:///abs/path`, not `/abs/path`. Requiring a leading slash made this whole
  // pass a no-op on its first run, which the re-run caught only because the frames it was built
  // for were still printed as NOT CHECKABLE.
  const url = rawUrl.startsWith('file://') ? rawUrl.slice('file://'.length) : rawUrl;

  if (!url.startsWith('/') || line < 1) {
    return undefined;
  }

  if (!srcCache.has(url)) {
    try {
      srcCache.set(url, readFileSync(url, 'utf8').split('\n'));
    } catch {
      srcCache.set(url, undefined);
    }
  }

  const lines = srcCache.get(url);

  if (lines === undefined) {
    return undefined;
  }

  // Walk UP from the reported line. 400 lines is ample for one builder and stops a runaway scan
  // from attributing a frame to some unrelated function far above it.
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0 && i > line - 400; i -= 1) {
    const m = /^(?:const|let|function\*?)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/.exec(lines[i]);

    if (m !== null) {
      return m[1];
    }
  }

  return undefined;
};

/** -1 means "not a checkable identifier"; otherwise the mention count across both stores. */
const mentions = (name) => {
  if (name.length < 4 || name.startsWith('(') || name.startsWith('RegExp:')) {
    return -1;
  }

  // An accessor frame is named `get properties` / `set labels`. The PROPERTY is a real checkable
  // identifier, so check it rather than falling through to the enclosing-declaration scan — which
  // walks out of the class body and lands on whatever unrelated `const` precedes it (it attributed
  // `get properties` to `WIDE_BAG$1`, a bag of keys it has nothing to do with).
  const accessor = ACCESSOR.exec(name);

  if (accessor !== null) {
    // A SHORT property is not a usable search term — `get to` would look up `to`, which the length
    // guard rejects, and the frame then fell through to the enclosing-declaration scan and was
    // attributed to `WIDE_BAG`, an unrelated bag of keys, in two Gremlin shapes. An accessor whose
    // property cannot be searched is honestly unknown, so say so rather than naming the wrong code.
    return accessor[1].length < 4 ? -1 : countIdentifier(accessor[1]);
  }

  if (name.includes(' ') || NODE_INTERNAL.has(name)) {
    return -1;
  }

  // `variable.variable` / `name.name` — the giveaway shape of a V8-synthesised closure name.
  const dotted = name.split('.');

  if (dotted.length === 2 && dotted[0] === dotted[1]) {
    return -1;
  }

  return countIdentifier(name);
};

const tagFor = (m) => {
  if (m === -1) {
    return '   n/a';
  }

  return m === 0 ? '  ZERO' : String(m).padStart(6);
};

const profiles = readdirSync(DIR)
  .filter((x) => x.endsWith('.cpuprofile'))
  .sort();

for (const f of profiles) {
  const rows = [...selfTime(join(DIR, f)).entries()]
    .map(([k, us]) => {
      const [name, where, url, lineStr] = k.split('\u0000');
      // An unnameable frame gets one more chance: the enclosing declaration IS checkable. An
      // ACCESSOR is excluded — its enclosing declaration is whatever `const` precedes the class,
      // which is not its code (the `get to` -> `WIDE_BAG` misattribution `mentions` describes).
      const enclosing =
        mentions(name) === -1 && !ACCESSOR.test(name)
          ? enclosingName(url, Number(lineStr))
          : undefined;

      return {
        name,
        where,
        enclosing,
        checkName: enclosing ?? name,
        ms: us / 1000,
      };
    })
    .sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((a, r) => a + r.ms, 0);

  console.log(`\n### ${f}  (${total.toFixed(0)} ms sampled)`);
  console.log('     ms   share  mentions  frame');

  for (const r of rows.slice(0, 22)) {
    const share = ((100 * r.ms) / total).toFixed(1).padStart(5);
    const shown = r.enclosing === undefined ? r.name : `${r.name} in ${r.enclosing}`;

    console.log(
      `  ${r.ms.toFixed(1).padStart(7)}  ${share}%  ${tagFor(mentions(r.checkName))}  ${shown} @ ${r.where}`,
    );
  }

  // THE PROBE'S OWN FRAMES ARE NOT FINDINGS. A probe file is named `*-probe.mjs`/`*-probe.ts`, its
  // fixture builder is genuinely hot (it builds the graph), and its function names are of course
  // absent from the audit — so it reports as a top unpriced frame every run. The write-path screen
  // flagged `addEdgeOnly`, `setProps` and `removeVertices`, all of them harness. The GQL probe's
  // `build` escaped notice only because "build" happens to appear 841 times in the documents.
  const big = rows.slice(0, 40).filter((r) => r.ms / total > 0.02 && !isHarnessFrame(r));
  const unpriced = big.filter((r) => mentions(r.checkName) === 0);
  // Frames that are STILL unnameable after the enclosing-declaration pass. These are the honest
  // residual: not "recorded", just unknown. Reporting them separately is the whole point of this
  // change — the old verdict line counted them as recorded and hid the largest frame in 3 of 5
  // shapes behind that wording.
  const unchecked = big.filter((r) => mentions(r.checkName) === -1);

  if (unpriced.length === 0) {
    console.log('  (no unpriced frame over 2%)');
  } else {
    console.log('  UNPRICED and over 2% of the profile:');

    for (const r of unpriced) {
      const via = r.enclosing === undefined ? '' : ` (via enclosing ${r.enclosing})`;

      console.log(`    - ${r.checkName} @ ${r.where}  ${r.ms.toFixed(1)} ms${via}`);
    }
  }

  if (unchecked.length > 0) {
    console.log('  NOT CHECKABLE and over 2% — unknown, NOT recorded:');

    for (const r of unchecked) {
      console.log(`    - ${r.name} @ ${r.where}  ${r.ms.toFixed(1)} ms`);
    }
  }
}
