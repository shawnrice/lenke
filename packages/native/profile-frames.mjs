/**
 * Shared frame cross-checking for the profile screens: is a hot frame's code already PRICED?
 *
 * EXTRACTED because there are now two screens over the same corpus — `runtime-profile-analyze.mjs`
 * (CPU self time) and `runtime-heap-analyze.mjs` (allocation self size) — and this logic has already
 * had FOUR defects found by pointing it at a new surface:
 *
 *   * item 1358: `n/a` ("could not check") was being laundered into "already recorded" by the
 *     verdict line, hiding the LARGEST frame in three of five GQL shapes; and the fix for it was a
 *     silent NO-OP on its first run because Node reports frame URLs as `file:///abs/path` and the
 *     guard required a leading `/`.
 *   * item 1359: a SHORT accessor property (`get to` -> `to`) fell past the length guard into the
 *     enclosing-declaration scan and was attributed to `WIDE_BAG`, an unrelated bag of keys; and the
 *     mention count was a SUBSTRING search, inflating `pick` to 202 where 53 are the identifier.
 *   * item 1360: the screen flagged its OWN probe's fixture builders as top unpriced frames.
 *
 * Duplicating that into a second analyzer is how the fifth defect ends up fixed in only one copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
export const ACCESSOR = /^(?:get|set) ([A-Za-z_$][\w$]*)$/;

/**
 * A frame from the PROBE rather than from the engine. A probe's fixture builder is genuinely hot and
 * its names are of course absent from the audit, so it reports as a top unpriced frame every run.
 * The GQL probe's `build` escaped notice for two items only because "build" appears 841 times in the
 * documents, which is luck rather than a guard.
 */
export const isHarnessFrame = (where) => /-probe\.(?:mjs|ts)$/.test(where.split(':')[0]);

/**
 * Count a name as an IDENTIFIER, not as a substring.
 *
 * Measured before changing it, because the obvious generalisation is wrong: `values` reads 1118
 * substring / 1070 word-bound / 974 inside backticks, so its big number is genuine code coverage and
 * not prose noise. The fix re-ranks common-word frames only.
 */
const countIdentifier = (name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g');

  return docs.reduce((acc, d) => acc + (d.match(re) ?? []).length, 0);
};

/** -1 means "not a checkable identifier"; otherwise the mention count across both stores. */
export const mentions = (name) => {
  if (name.length < 4 || name.startsWith('(') || name.startsWith('RegExp:')) {
    return -1;
  }

  const accessor = ACCESSOR.exec(name);

  if (accessor !== null) {
    // A SHORT property is not a usable search term, and an accessor whose property cannot be
    // searched is honestly unknown — better that than naming the wrong code.
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

const srcCache = new Map();

/**
 * The ENCLOSING named function for an unnameable frame, so it can be cross-checked after all.
 *
 * V8 reports an anonymous closure at its ENCLOSING declaration's line, because the hot code is the
 * `return (graph, params) => {...}` of a compile-time builder. So the nearest `const <name> =` at or
 * above that line names the code — `topKNodeWalk`, not `(anonymous)` — and THAT is a real identifier
 * a document can mention.
 */
export const enclosingName = (rawUrl, line) => {
  // Node reports `file:///abs/path`, not `/abs/path`. Requiring a leading slash made this whole pass
  // a no-op on its first run (item 1358).
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

  // Walk UP from the reported line. 400 lines is ample for one builder and stops a runaway scan from
  // attributing a frame to some unrelated function far above it.
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0 && i > line - 400; i -= 1) {
    const m = /^(?:const|let|function\*?)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/.exec(lines[i]);

    if (m !== null) {
      return m[1];
    }
  }

  return undefined;
};

/** `-1` -> `n/a`, `0` -> `ZERO`, otherwise the count. */
export const tagFor = (m) => {
  if (m === -1) {
    return '   n/a';
  }

  return m === 0 ? '  ZERO' : String(m).padStart(6);
};

/**
 * Attach the checkable name to a raw frame, applying the enclosing-declaration fallback.
 * `where` is `file:line`; `url`/`line` locate the source for that fallback.
 */
export const describeFrame = ({ name, where, url, line }) => {
  const enclosing =
    mentions(name) === -1 && !ACCESSOR.test(name) ? enclosingName(url, line) : undefined;

  return { name, where, enclosing, checkName: enclosing ?? name };
};

/**
 * The two verdict buckets, kept together because item 1358's bug was conflating them: UNPRICED is a
 * finding, NOT CHECKABLE is an admission. Folding the second into "every hot frame is recorded" is
 * what hid the largest frame in three of five shapes.
 */
export const verdict = (rows, total, floor = 0.02) => {
  const big = rows.filter((r) => r.value / total > floor && !isHarnessFrame(r.where));

  return {
    unpriced: big.filter((r) => mentions(r.checkName) === 0),
    unchecked: big.filter((r) => mentions(r.checkName) === -1),
  };
};
