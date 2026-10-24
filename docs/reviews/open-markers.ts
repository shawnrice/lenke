#!/usr/bin/env bun
/**
 * Pair every OPEN marker in `CLOSED.md` with the item that follows it.
 *
 *   bun docs/reviews/open-markers.ts            # the current working range (item 600+)
 *   bun docs/reviews/open-markers.ts 300        # from item 300
 *
 * ## Why this exists
 *
 * `CLOSED.md` is the index to read before pricing a target, and CLAUDE.md says plainly: "a list
 * that lags is the failure it exists to prevent." It lags in ONE specific way, and three
 * consecutive items were spent discovering that:
 *
 * - **694** found five stale markers. **Four of the five were closed by the item IMMEDIATELY
 *   FOLLOWING them** — one even says "Next item." That is the mechanism: an item ends by naming
 *   what it leaves open, the next item closes exactly that, and nothing goes back to amend the
 *   first. The record is accurate when written and wrong as a whole.
 * - **695** found three more that 694 had missed, because 694 grepped case-sensitive `OPEN` and
 *   they said "Still open", "remains open", "unbuilt". A sweep is only as good as its pattern.
 * - **696** found one more that 695 had missed, because 695 "verified" it by grepping for the
 *   NUMBER being closed (`2.98x`) instead of reading the next item — which is exactly what 694's
 *   own note had prescribed. Item 638 had closed it while quoting a different figure.
 *
 * Each failure was at a different level: the pattern, then the verification method. So the fix is
 * neither a better grep nor more care — it is making the check MECHANICAL. This script does the
 * part that was wrong every time: it finds the markers with a pattern that covers the phrasings,
 * and it shows the NEXT ITEM beside each one, which is where the answer nearly always is.
 *
 * It deliberately does NOT decide staleness. Reading the next item is the judgement, and a script
 * that guessed would become one more thing to distrust.
 *
 * ## The habit this supports
 *
 * CLAUDE.md's rule covers appending ("add its line to CLOSED.md in the same commit"). The other
 * half, learned at 694-696: **when an item closes something a PREVIOUS item left open, amend that
 * previous entry too.** Of the nine stale markers found across those three items, FIVE were
 * written by the same author who then closed them a few items later.
 */

const FILE = 'docs/reviews/CLOSED.md';
const SINCE = Number(process.argv[2] ?? 600);

// Every phrasing that has actually been used for "this is not done". Items 694-696 each lost a
// marker to a gap in this list; add to it rather than narrowing it.
const MARKER =
  /still open|remains open|left open|^#+ *open\b|not yet built|not yet measured|unbuilt|is open\b|stays open/i;
// Lines that already carry their own resolution, or are the bookkeeping items themselves.
const RESOLVED =
  /closed at|closed by|fixed at|fixed by|superseded|answered at|~~|came true|STALE MARKER/i;

const lines = (await Bun.file(FILE).text()).split('\n');
const headers: { line: number; item: number }[] = [];

for (const [i, l] of lines.entries()) {
  const m = /^## (\d+)/.exec(l);

  if (m) {
    headers.push({ line: i, item: Number(m[1]) });
  }
}

type Row = { at: number; owner: number | null; next: number | null; text: string };
const rows: Row[] = [];

for (const [i, l] of lines.entries()) {
  if (!MARKER.test(l) || RESOLVED.test(l)) {
    continue;
  }

  const owner = headers.filter((h) => h.line < i).at(-1)?.item ?? null;

  if (owner === null || owner < SINCE) {
    continue;
  }

  rows.push({
    at: i + 1,
    owner,
    next: headers.find((h) => h.line > i)?.item ?? null,
    text: l.trim().slice(0, 68),
  });
}

if (rows.length === 0) {
  console.log(`no unresolved OPEN markers at or after item ${SINCE}`);
  process.exit(0);
}

console.log(`\n${rows.length} unresolved marker(s) at or after item ${SINCE} in ${FILE}\n`);
console.log(`${'line'.padStart(7)}  ${'item'.padStart(5)}  ${'NEXT'.padStart(5)}  marker`);

for (const r of rows) {
  console.log(
    `${String(r.at).padStart(7)}  ${String(r.owner).padStart(5)}  ` +
      `${String(r.next ?? '-').padStart(5)}  ${r.text}`,
  );
}

console.log(
  '\nFor each row, read item NEXT. Four of five stale markers at item 694 were closed by the\n' +
    'item immediately after them, and five of the nine found across 694-696 were written by the\n' +
    'author who then closed them. If NEXT closed it, amend the marker — do not only append.',
);
