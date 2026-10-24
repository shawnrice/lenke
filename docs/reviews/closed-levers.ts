#!/usr/bin/env bun
/**
 * Index every REJECTED / REVERTED / REFUTED lever recorded IN THE SOURCE, and search it.
 *
 *   bun docs/reviews/closed-levers.ts                  # the whole index
 *   bun docs/reviews/closed-levers.ts inline props     # "has this been tried?" in one command
 *   bun docs/reviews/closed-levers.ts --orphans        # only the markers carrying no item number
 *
 * ## Why this exists
 *
 * CLAUDE.md gives two rules that point at two different stores:
 *
 * - "has this lever been tried?" → `CLOSED.md`, then the audit item it cites;
 * - "Record rejected optimizations with their numbers, **next to the code they would have
 *   changed**."
 *
 * So the code is a deliberate store of refutations — and it had no index, while `CLOSED.md` has
 * two (`open-markers.ts` and its own tables). Three consecutive items were spent finding that out:
 *
 * - **710** priced a lever the audit had already priced through a different entry point, and
 *   learned that a profiler's self-time is an attribution rather than a counterfactual.
 * - **712** diagnosed a live spelling flag and named a next step.
 * - **713** BUILT that next step, measured it converging, and then found
 *   `rejectedByElementDirect`'s own 🛑 marker: tried and reverted at item **644**, same mechanism,
 *   same magnitude, and rejected for a correctness reason. The ablation reproduced the exact test
 *   failure 644 cites. `CLOSED.md` was searched first, for `inline`, for `clause`, and for the row
 *   names; 644 is in none of those, because its reason lives in that code comment.
 *
 * The miss was not carelessness and not the wrong pattern — it was the wrong STORE, and the store
 * that held the answer could not be searched as a whole. One grep now covers it.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether a hit is a rejected OPTIMIZATION. `store.rs` says "REJECTED if `key`
 * backs a unique constraint", which is API behaviour and not a lever, and a script that tried to
 * tell them apart would become one more thing to distrust (`open-markers.ts` makes the same
 * choice, for the same reason). It reports candidates and the reader judges.
 *
 * It also does not replace `CLOSED.md`. A lever refuted in a commit message or an audit item and
 * NOT annotated at the call site is invisible here — which is what `--orphans` is for: a marker
 * with no item number is one a reader cannot follow up, and those are worth annotating.
 */

const ROOTS = ['packages', 'crates'];

// The vocabulary this repo actually uses, gathered by grepping for each form rather than guessed.
// `WITHDRAWN` and `NOT BUILT` are included because items 312 and 442 used them for the same act.
const MARKERS = /(REJECTED|REVERTED|REFUTED|WITHDRAWN|NOT BUILT|WAS TRIED|DECLINED ON|🛑)/;

/** `(item 644)` / `(audit item 424)` / `item 358` — the first one on the line. */
const ITEM = /\(?\b(?:audit )?item\s+(\d{2,4})\b\)?/i;

const args = process.argv.slice(2);
const orphansOnly = args.includes('--orphans');
const needle = args.filter((a) => !a.startsWith('--')).join(' ');

type Hit = { file: string; line: number; item: string; text: string; body: string };

/**
 * Fold text to bare words for matching. The FIRST version of this script searched the raw line
 * and so returned NOTHING for `inline props` — the marker it was built for reads inline
 * `` `props` ``, and the backticks broke a literal match. Items 694/695 made the same mistake one
 * store over: a sweep is only as good as its pattern.
 */
const fold = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const files = (
  await Promise.all(
    ROOTS.map(async (root) => {
      const proc = Bun.spawn(
        [
          'find',
          root,
          '-type',
          'f',
          '(',
          '-name',
          '*.ts',
          '-o',
          '-name',
          '*.rs',
          ')',
          '-not',
          '-path',
          '*/node_modules/*',
          '-not',
          '-path',
          '*/dist/*',
          '-not',
          '-path',
          '*/target/*',
          '-not',
          '-path',
          '*/target-wasm/*',
        ],
        { stdout: 'pipe' },
      );

      return (await new Response(proc.stdout).text()).split('\n').filter(Boolean);
    }),
  )
).flat();

const hits: Hit[] = [];

for (const file of files) {
  // A test file's own `REJECTED` is usually a fixture string, not a recorded lever.
  if (file.includes('.test.')) {
    continue;
  }

  const lines = (await Bun.file(file).text()).split('\n');

  lines.forEach((raw, i) => {
    const text = raw.trim();

    // COMMENTS ONLY. A lever is recorded in prose; `REJECTED` in code is an identifier or a
    // string, and including those made the first run of this script 40% noise.
    if (!/^(\/\/|\/\*|\*|#)/.test(text) || !MARKERS.test(text)) {
      return;
    }

    // The marker line plus the rest of its COMMENT BLOCK, because a lever's subject is usually
    // named a line or two below the word REJECTED — searching only the matched line is the same
    // false negative as the backticks, one axis over.
    const block: string[] = [];

    for (let j = i; j < Math.min(lines.length, i + 14); j += 1) {
      const t = lines[j].trim();

      if (!/^(\/\/|\/\*|\*|#)/.test(t)) {
        break;
      }

      block.push(t);
    }

    hits.push({
      file,
      line: i + 1,
      item: block.join(' ').match(ITEM)?.[1] ?? '',
      text: text.replace(/^(\/\/+|\/\*+|\*+|#+)\s?/, '').slice(0, 96),
      body: fold(block.join(' ')),
    });
  });
}

const shown = hits
  .filter((h) => (orphansOnly ? h.item === '' : true))
  .filter((h) => needle === '' || `${fold(h.file)} ${h.body}`.includes(fold(needle)));

for (const h of shown) {
  const where = `${h.file}:${h.line}`;

  console.log(`${h.item.padStart(4)}  ${where.padEnd(46)} ${h.text}`);
}

const withItem = hits.filter((h) => h.item !== '').length;

console.log(
  `\n${shown.length} shown of ${hits.length} markers in ${files.length} files` +
    ` — ${withItem} cite an item, ${hits.length - withItem} do not (see --orphans).`,
);

if (needle !== '' && shown.length === 0) {
  console.log(
    `\nNothing recorded at a call site for "${needle}". That is NOT "never tried" —\n` +
      'check CLOSED.md and the audit too; this script only sees what was annotated in source.',
  );
}
