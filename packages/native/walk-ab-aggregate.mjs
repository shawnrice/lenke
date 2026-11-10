/**
 * Aggregate a `hop-walk-fanin-ab.sh` log into one cell-per-row table.
 *
 * `p25` per PROCESS and the MEDIAN across rounds, per item 1367: the noise here is process-level, so
 * a mean across rounds inverts verdicts and a single round is not a reading. Prints the per-round
 * series alongside the summary so a bimodal cell is visible rather than averaged away (CLAUDE.md's
 * estimator rule — a summary of a bimodal series is a lie).
 *
 * Also prints `rowCount` and `digest` per arm, because the whole table is void if the arms stopped
 * answering the same question: a paged arm legitimately differs by ONE row, and anything else means
 * the fixture knob changed the answer rather than the route (item 1416's vacuous-answer trap).
 *
 *     node walk-ab-aggregate.mjs <log> [fastArmShapeSuffix]
 */
import { readFileSync } from 'node:fs';

const [, , logPath] = process.argv;

if (logPath === undefined) {
  throw new Error('usage: node walk-ab-aggregate.mjs <log>');
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** cell -> shape -> { p25s, rowCount, digest } */
const cells = new Map();

for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  const m = /^cell fanout=(\S+) fanin=(\S+) round=(\S+) shape=(\S+) (\{.*\})$/.exec(line.trim());

  if (m === null) {
    continue;
  }

  const [, fanout, fanin, , shape, json] = m;
  const r = JSON.parse(json);
  const key = `fanout=${fanout} fanin=${fanin}`;

  if (!cells.has(key)) {
    cells.set(key, new Map());
  }

  const byShape = cells.get(key);

  if (!byShape.has(shape)) {
    byShape.set(shape, { p25s: [], rowCount: r.rowCount, digest: r.digest, vacuous: false });
  }

  const e = byShape.get(shape);

  e.p25s.push(r.p25);
  e.rowCount = r.rowCount;
  e.digest = r.digest;
  e.vacuous = e.vacuous === true ? true : r.VACUOUS_ZERO_ANSWER === true;
}

let bad = 0;

for (const [cell, byShape] of cells) {
  const shapes = [...byShape.keys()];
  // ⚠️ NAMED BY SUFFIX, NOT BY SORT ORDER. The `…page` arm is the START-DRIVEN one (its `OFFSET 1`
  // is what forces that walk, item 1777); the bare arm is far-driven. Deriving this from a sort
  // would silently mislabel both arms — and so invert every verdict in the table — for any future
  // pair whose names do not happen to collate that way.
  const start = shapes.find((n) => n.endsWith('page'));
  const far = shapes.find((n) => !n.endsWith('page'));
  const f = far === undefined ? undefined : byShape.get(far);
  const s = start === undefined ? undefined : byShape.get(start);

  if (f === undefined || s === undefined) {
    console.log(`${cell}  INCOMPLETE: ${shapes.join(',')}`);
    bad += 1;
    continue;
  }

  const fm = median(f.p25s);
  const sm = median(s.p25s);
  const ratio = sm / fm;
  const rowsOk = Math.abs(f.rowCount - s.rowCount) === 1;
  const flags = [
    rowsOk ? '' : `⚠️ ROWS ${f.rowCount}/${s.rowCount}`,
    f.vacuous || s.vacuous ? '⚠️ VACUOUS' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!rowsOk || f.vacuous || s.vacuous) {
    bad += 1;
  }

  const digests = f.digest === s.digest ? 'same' : `${f.digest}/${s.digest}`;
  const suffix = flags === '' ? '' : `  ${flags}`;

  console.log(
    `${cell.padEnd(22)} far ${fm.toFixed(3).padStart(9)}  start ${sm.toFixed(3).padStart(9)}  start/far ${ratio.toFixed(2)}x  ${ratio > 1 ? 'FAR wins' : 'START wins'}  rows ${f.rowCount}/${s.rowCount}  digest ${digests}${suffix}`,
  );
  console.log(
    `${' '.repeat(22)}   far rounds ${f.p25s.map((x) => x.toFixed(2)).join(' ')}   start rounds ${s.p25s.map((x) => x.toFixed(2)).join(' ')}`,
  );
}

console.log(bad === 0 ? 'all cells comparable' : `${bad} cell(s) NOT comparable — see flags`);
process.exit(bad === 0 ? 0 : 1);
