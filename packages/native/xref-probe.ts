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

/** Backticked snake_case: the shape of a Rust fn, type or module name. */
const NAME = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
/** The comment has to claim it is talking about the other engine, unless `--all`. */
const CLAIM = /native|rust|engine\b|crate|\.rs\b/i;
/** snake_case words that are not Rust items. */
const IGNORE = new Set([
  'node_modules',
  'package_json',
  'no_std',
  'type_complexity',
  'prefer_for_of',
]);

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

const rust = walk(join(ROOT, 'crates'), [], '.rs')
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

type Hit = { file: string; line: number; name: string; text: string };
const hits: Hit[] = [];

const SELF = import.meta.path;

for (const file of walk(join(ROOT, 'packages'), [], '.ts')) {
  if (file === SELF) {
    continue;
  }

  const lines = readFileSync(file, 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const s = line.trimStart();

    if (!s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')) {
      continue;
    }

    if (line.includes('xref:gone')) {
      continue;
    }

    if (!ALL && !CLAIM.test(line)) {
      continue;
    }

    for (const m of line.matchAll(NAME)) {
      const name = m[1] ?? '';

      if (IGNORE.has(name) || rust.includes(name)) {
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
