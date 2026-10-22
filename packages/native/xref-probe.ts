/**
 * CROSS-ENGINE REFERENCE PROBE — do the native names cited in TypeScript comments still exist?
 *
 * The two engines are kept byte-identical, and the way a reader crosses from one to the other is
 * a comment: _"Mirrors the native `varlen_distinct_endpoint_count`"_. Those citations are the
 * only index there is, and **they rot silently** — nothing compiles them, nothing tests them, and
 * a rename on the Rust side leaves a dead name behind that reads exactly like a live one.
 *
 * Item 612 found the first batch by hand: `shortcuts.ts`'s header pointed at `try_count_edges`,
 * `try_count_two_hop` and `try_reachable_distinct` — all three gone from the crate, so a reader
 * looking for the native twin of a GQL fast path was given three dead starting points. Grepping
 * the pattern elsewhere turned up 63 more.
 *
 * This is a PROBE, not a test, for the same reason `spelling-probe.ts` is: the signal needs a
 * human. A snake_case word in a comment is usually a Rust item but is sometimes a TS-local
 * identifier, a config key or a file stem, so a threshold in CI would be noise. Run it after a
 * Rust rename, and when adding a cross-engine citation.
 *
 *   bun run xref            # every unresolved citation that claims to name the native side
 *   bun run xref --all      # every unresolved snake_case citation, claim or not
 *
 * A comment that names a dead symbol ON PURPOSE — recording that it was removed, or quoting an
 * old name — ends with the marker `xref:gone` and is skipped. This file skips itself, since its
 * own docstring cites three such names.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ALL = process.argv.includes('--all');

/**
 * Backticked snake_case, optionally module-qualified: the shape of a Rust fn, type or module
 * name. A BARE name must carry an underscore, because a single lowercase word in a comment is
 * usually English, not an item. A QUALIFIED one (`value::equals`) need not — the `::` is already
 * unambiguous, and refusing those would let a citation go INVISIBLE rather than get checked,
 * which is the failure this probe exists to prevent.
 */
const NAME = /`((?:[a-z][a-z0-9_]*::)+[a-z][a-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
/**
 * The comment has to claim it is talking about the other engine, unless `--all`.
 *
 * Tested against the whole comment BLOCK, not the one line. It used to be per-line, and that
 * hid fifteen real dead citations at item 614: a doc comment opens with "Mirrors the native
 * …" and names the symbol three lines down, so the line carrying the name has no keyword on
 * it. Per-line, those only showed under `--all`, mixed in with the config keys and file stems
 * that make `--all` too noisy to read.
 */
const CLAIM = /native|rust|engine\b|crate|\.rs\b/i;
/** snake_case words that are not Rust items. */
const IGNORE = new Set([
  'node_modules',
  'package_json',
  'no_std',
  'type_complexity',
  'prefer_for_of',
  // The built cdylib's filename, not a Rust item — it lives under `target/`, which is
  // excluded from the haystack, so it can never resolve.
  'liblenke_engine',
]);

/** Is this trimmed line inside a comment? */
const isComment = (t: string): boolean =>
  t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');

const walk = (dir: string, out: string[], ext: string): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target' || name === 'target-wasm') {
      continue;
    }

    const p = join(dir, name);

    if (statSync(p).isDirectory()) {
      walk(p, out, ext);
    } else if (name.endsWith(ext)) {
      out.push(p);
    }
  }

  return out;
};

// The haystack is every Rust file's CONTENTS **and its path**. The path matters: a comment
// legitimately cites an example or module by its file stem (`skipcast_426`), which appears
// nowhere inside the file itself, and without the paths the probe reports it as rot.
const rustFiles = walk(join(ROOT, 'crates'), [], '.rs');
const rust = rustFiles.map((p) => `${relative(ROOT, p)}\n${readFileSync(p, 'utf8')}`).join('\n');

type Hit = { file: string; line: number; name: string; text: string };
const hits: Hit[] = [];

const SELF = import.meta.path;

for (const file of walk(join(ROOT, 'packages'), [], '.ts')) {
  if (file === SELF) {
    continue;
  }

  const lines = readFileSync(file, 'utf8').split('\n');

  // Each run of contiguous comment lines is ONE block, and the claim is tested over the
  // whole block (see CLAIM). Blocks are precomputed so the scan below stays a single pass.
  const blockClaims: boolean[] = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length;) {
    if (!isComment((lines[i] ?? '').trimStart())) {
      i++;
      continue;
    }

    let j = i;

    while (j < lines.length && isComment((lines[j] ?? '').trimStart())) {
      j++;
    }

    const claims = CLAIM.test(lines.slice(i, j).join('\n'));

    for (let k = i; k < j; k++) {
      blockClaims[k] = claims;
    }

    i = j;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const s = line.trimStart();

    if (!isComment(s)) {
      continue;
    }

    if (line.includes('xref:gone')) {
      continue;
    }

    if (!ALL && !blockClaims[i]) {
      continue;
    }

    for (const m of line.matchAll(NAME)) {
      const name = m[1] ?? '';
      // A qualified citation resolves on its LAST segment: `value::equals` is satisfied by
      // `fn equals` in the crate. The module half is prose — `value.rs` may be re-homed to
      // another crate without the function moving, and the segment is what a reader greps.
      const needle = name.includes('::') ? (name.split('::').pop() ?? name) : name;

      if (IGNORE.has(name) || rust.includes(needle)) {
        continue;
      }

      hits.push({ file: relative(ROOT, file), line: i + 1, name, text: s.slice(0, 100) });
    }
  }
}

const byName = new Map<string, Hit[]>();

for (const h of hits) {
  const list = byName.get(h.name) ?? [];

  list.push(h);
  byName.set(h.name, list);
}

const scope = ALL ? 'snake_case citations' : 'citations that CLAIM a native name';

console.log(`${hits.length} unresolved ${scope}, across ${byName.size} distinct names.\n`);

for (const [name, list] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${name}  (${list.length})`);

  for (const h of list) {
    console.log(`      ${h.file}:${h.line}  ${h.text}`);
  }
}

if (hits.length === 0) {
  console.log('Every cited native name resolves.');
}
