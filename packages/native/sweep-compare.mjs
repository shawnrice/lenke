/**
 * Compare a two-arm, multi-round shape sweep and report only what SEPARATES.
 *
 * Input: lines of `R<round> <arm> {"shape":…,"ms":…}` on stdin or a file path argv[2].
 *
 * ⚠️ IT REPORTS DISJOINTNESS, NOT A RATIO. A ratio of medians over 2-3 rounds is what produced
 * item 1746's phantom 5% regression (the isolated per-row run refuted it at 1.2%), so a row whose
 * arm ranges OVERLAP is printed as `flat` whatever its medians say. Only rows whose ranges are
 * fully separated get a direction, and those are the only ones worth acting on from a sweep this
 * wide — the rest need their own per-row instrument.
 */
import { readFileSync } from 'node:fs';

const [, , path] = process.argv;
const text = readFileSync(path, 'utf8');
const by = new Map();

for (const line of text.split('\n')) {
  const m = /^R(\d+)\s+(\w+)\s+(\{.*\})\s*$/.exec(line.trim());

  if (m === null) {
    continue;
  }

  let row;

  try {
    row = JSON.parse(m[3]);
  } catch {
    continue;
  }

  if (typeof row.ms !== 'number' || typeof row.shape !== 'string') {
    continue;
  }

  const key = row.shape;

  if (!by.has(key)) {
    by.set(key, { pre: [], now: [] });
  }

  const slot = by.get(key)[m[2]];

  if (slot !== undefined) {
    slot.push(row.ms);
  }
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);

  return s.length === 0 ? Number.NaN : s[Math.floor(s.length / 2)];
};

const rows = [];

for (const [shape, { pre, now }] of by) {
  if (pre.length === 0 || now.length === 0) {
    rows.push({ shape, verdict: `INCOMPLETE pre=${pre.length} now=${now.length}` });
    continue;
  }

  const preMin = Math.min(...pre);
  const preMax = Math.max(...pre);
  const nowMin = Math.min(...now);
  const nowMax = Math.max(...now);
  const ratio = med(pre) / med(now);
  // Disjoint means every reading of one arm beats every reading of the other.
  const disjoint = nowMax < preMin || preMax < nowMin;
  let verdict = 'flat';

  if (disjoint) {
    verdict = ratio > 1 ? `FASTER ${ratio.toFixed(2)}x` : `SLOWER ${(1 / ratio).toFixed(2)}x`;
  }

  rows.push({
    shape,
    verdict,
    pre: pre.map((x) => x.toFixed(1)).join(' '),
    now: now.map((x) => x.toFixed(1)).join(' '),
  });
}

const interesting = rows.filter((r) => r.verdict !== 'flat');

console.log(`${rows.length} shapes; ${interesting.length} with DISJOINT arm ranges:\n`);

for (const r of interesting.sort((a, b) => a.shape.localeCompare(b.shape))) {
  console.log(`  ${r.shape.padEnd(22)} ${r.verdict.padEnd(14)} pre[${r.pre}]  now[${r.now}]`);
}

console.log(`\nflat (ranges overlap, no direction readable): ${rows.length - interesting.length}`);
