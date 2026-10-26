/**
 * Item 921: what does `compareCodePoints`' surrogate GUARD cost, and is a cheaper guard correct?
 *
 * BOTH CANDIDATE GUARDS ARE REFUTED AND THE REMAINING OPTION IS DECLINED. This file is kept as the
 * record, because each arm is one somebody would otherwise reach for again.
 *
 * Found by `runtime-profile-probe.mjs`: on a sorted-page query the regex `[\uD800-\uDBFF]` is 6.9%
 * of the profile and `compareCodePoints` another 8.0%. The comparator exists for a real reason —
 * JS orders by UTF-16 code UNIT and Rust by code POINT, and they disagree when an astral char
 * meets a BMP char in U+E000..U+FFFF — so cross-engine byte-identity depends on it. But its
 * fast-path GUARD scans BOTH WHOLE STRINGS with a regex on EVERY comparison, re-establishing a
 * fact about each string O(log N) times during a sort.
 *
 *   data        floor      ref     scan    ref/scan
 *   ascii         0.8      2.1      1.9       1.08x
 *   prefixed      1.2      2.7      9.5       0.28x   <- 3.6x WORSE
 *   astral        0.9      3.2      1.7       1.95x
 *
 * (A first run read 1.10 / 0.24 / 1.88 — same direction and the same verdict on every arm, so the
 * conclusions do not rest on either run alone.)
 *
 * `scan` (regex replaced by a manual charCode loop, trivially equivalent) is REFUTED: 1.10x on
 * ASCII is inside the noise band CLAUDE.md puts at ~10%, and on strings with a long shared prefix
 * it is 4.2x WORSE. V8's character-class match beats a hand-written loop; the regex is good.
 *
 * `diff` (decide from the first differing code unit) is REFUTED ON CORRECTNESS — see its own
 * comment, and the corpus note below it, which is the more valuable finding.
 *
 * The one sound option left is hoisting the guard OUT of the comparator, since the per-string
 * result is invariant: a sort could test each key once instead of O(log N) times. The `floor`
 * column bounds it — floor is the bare native compare, which no guard can beat — and a hoist can
 * only ever remove the regex itself: 133.8 ms of a 1952 ms profile, so ~1.07x on that query shape
 * at absolute best, for an invasive change to a comparator that is generic over value types.
 * DECLINED on that ceiling, which sits at the boundary where CLAUDE.md requires a bespoke harness.
 *
 * Usage: node codepoint-guard-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const HAS_SURROGATE = /[\uD800-\uDBFF]/;

const slowPath = (a, b) => {
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(j);

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }

    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }

  if (i < a.length) {
    return 1;
  }

  return j < b.length ? -1 : 0;
};

/**
 * Verbatim copy of `packages/gql/src/executor/scalars.ts`'s `compareCodePoints`.
 *
 * A copy because the real one is module-internal and cannot be imported — and comparing a
 * dist-imported function against local arms would differ in more than its body (item 897's
 * cross-arm asymmetry). `validateRefAgainstEngine` checks the copy against the REAL engine by
 * sorting the corpus through an actual GQL `ORDER BY`.
 */
const ref = (a, b) => {
  if (!HAS_SURROGATE.test(a) && !HAS_SURROGATE.test(b)) {
    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  return slowPath(a, b);
};

const hasHighSurrogate = (s) => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) {
      return true;
    }
  }

  return false;
};

/** ARM `scan`: identical semantics, no regex. REFUTED on measurement (see the header). */
const scan = (a, b) => {
  if (!hasHighSurrogate(a) && !hasHighSurrogate(b)) {
    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  return slowPath(a, b);
};

/**
 * ARM `diff`: decide from the first differing code unit. REFUTED ON CORRECTNESS, and it is the
 * PREMISE that fails rather than a detail, so no narrowing of the astral test rescues it.
 *
 * It assumes equal unit prefixes imply equal code-POINT prefixes. They do not: segmentation
 * depends on the FOLLOWING unit, so one high surrogate can begin a pair in one string and be LONE
 * in the other, making `"😀"` (a single astral char) and `"\ud83d"` (a lone
 * surrogate then U+E000) agree on unit 0 while disagreeing on what unit 0 MEANS. Making it correct
 * needs both strings proven free of lone surrogates — the whole-string scan the arm existed to
 * avoid.
 *
 * Its first version also had a narrower bug the corpus DID catch: the astral test was
 * `cb >= 0xe000`, which missed a lone LOW surrogate (0xDC00..0xDFFF). An astral code point is
 * >= U+10000 and any unpaired unit is <= 0xFFFF, so the astral side wins whatever the other unit
 * is. Fixing that made the arm pass — against a corpus that could not see the real defect.
 */
const diff = (a, b) => {
  const n = a.length < b.length ? a.length : b.length;
  let k = 0;

  while (k < n && a.charCodeAt(k) === b.charCodeAt(k)) {
    k += 1;
  }

  if (k === n) {
    if (a.length === b.length) {
      return 0;
    }

    return a.length < b.length ? -1 : 1;
  }

  const ca = a.charCodeAt(k);
  const cb = b.charCodeAt(k);
  const aAstral =
    ca >= 0xd800 && ca <= 0xdbff && k + 1 < a.length && (a.charCodeAt(k + 1) & 0xfc00) === 0xdc00;
  const bAstral =
    cb >= 0xd800 && cb <= 0xdbff && k + 1 < b.length && (b.charCodeAt(k + 1) & 0xfc00) === 0xdc00;

  if (aAstral !== bAstral) {
    return aAstral ? 1 : -1;
  }

  return ca < cb ? -1 : 1;
};

/** Every arm, by name. Declared here because the correctness pass below uses it too. */
const ARMS = { ref, scan, diff, floor: null };

// ---------------------------------------------------------------------------- correctness first

const ASTRAL = String.fromCodePoint(0x1f600);
const PUA = '';
const HIGH_BMP = '￿';

const CORPUS = [
  '',
  'a',
  'ab',
  'b',
  'abc',
  's1',
  's10',
  's2',
  'Z',
  'z',
  ASTRAL,
  `a${ASTRAL}`,
  `${ASTRAL}a`,
  PUA,
  `a${PUA}`,
  HIGH_BMP,
  `a${HIGH_BMP}`,
  `${ASTRAL}${PUA}`,
  `${PUA}${ASTRAL}`,
  // Lone surrogates, and the SEGMENTATION COLLISION the first corpus missed. These share 0xD83D
  // with ASTRAL so the collision actually gets built: the first corpus used 0xD800 for its lone
  // surrogates and 0xD83D for its astral one, so the two never met and `diff` "agreed" on all 676
  // pairs. A corpus that does not CONSTRUCT the case your hypothesis calls dangerous will agree
  // with anything — which, behind a hard byte-identity invariant, is how a wrong comparator ships.
  //
  // Built with `fromCharCode`, not written as literals: a lone surrogate is not valid UTF-8 and
  // does not survive a round-trip through this file (a pair written here earlier was silently
  // normalised into one real character).
  String.fromCharCode(0xd800),
  String.fromCharCode(0xdc00),
  String.fromCharCode(0xd83d),
  String.fromCharCode(0xd83d, 0xe000),
  String.fromCharCode(0xd83d, 0xd83d),
  String.fromCharCode(0xd83d, 0x61),
  String.fromCharCode(0xdbff, 0xdfff),
];

/** `diff` is retracted, so it is reported and NOT timed. */
const RETRACTED = new Set(['diff']);

/** Keyed rather than tuples so a name is always a `string` in a template literal. */
const CHECKED = ['scan', 'diff'];

const sign = (x) => {
  if (x < 0) {
    return -1;
  }

  return x > 0 ? 1 : 0;
};

const esc = (s) =>
  JSON.stringify(s).replace(
    /[^\x20-\x7e"]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * The copy is only a valid baseline if it IS the engine's order. Sort the corpus through a real
 * `ORDER BY` and compare with the copy's own sort; if they differ, every number below is measured
 * against the wrong reference.
 */
const validateRefAgainstEngine = () => {
  const g = new Graph();

  CORPUS.forEach((v, i) => {
    g.addVertex({ id: `n${i}`, labels: ['S'], properties: { v } });
  });

  const fromEngine = query(g, 'MATCH (n:S) RETURN n.v AS v ORDER BY v').map((r) => r.v);
  const fromCopy = [...CORPUS].sort(ref);

  if (fromEngine.length !== fromCopy.length) {
    throw new Error(`engine returned ${fromEngine.length} rows for ${fromCopy.length} inputs`);
  }

  for (let i = 0; i < fromCopy.length; i += 1) {
    if (fromEngine[i] !== fromCopy[i]) {
      throw new Error(
        `the copy is NOT the engine's order at ${i}: engine ${esc(fromEngine[i])}, copy ${esc(fromCopy[i])}`,
      );
    }
  }

  console.log(
    `ref copy validated against a real ORDER BY over ${CORPUS.length} strings: IDENTICAL`,
  );
};

validateRefAgainstEngine();

const mismatching = new Set();
let bad = 0;

for (const a of CORPUS) {
  for (const b of CORPUS) {
    const want = sign(ref(a, b));

    for (const name of CHECKED) {
      const got = sign(ARMS[name](a, b));

      if (got !== want) {
        bad += 1;
        mismatching.add(name);

        if (bad <= 6) {
          console.log(
            `  MISMATCH ${name}(${esc(a)}, ${esc(b)}) = ${String(got)}, ref = ${String(want)}`,
          );
        }
      }
    }
  }
}

const verdict = bad === 0 ? 'ALL AGREE' : `${bad} MISMATCHES`;

console.log(`correctness over ${CORPUS.length ** 2} ordered pairs x 2 arms: ${verdict}`);

for (const name of mismatching) {
  if (!RETRACTED.has(name)) {
    console.log(`arm ${name} disagrees and is NOT retracted — fix or drop it before timing`);
    process.exit(1);
  }
}

if (mismatching.size > 0) {
  console.log(`retracted on correctness, not timed: ${[...mismatching].join(', ')}`);
}

// ---------------------------------------------------------------------------- then timing

const REPS = 14;
const DROP = 3;
const ROUNDS = 3;

const ascii = Array.from({ length: 2000 }, (_, i) => `s${i % 1000}`);
const prefixed = Array.from({ length: 2000 }, (_, i) => `user:tenant:aaaaaaaaaaaaaaaa:${i % 1000}`);
const astral = Array.from({ length: 2000 }, (_, i) => `${ASTRAL}s${i % 1000}`);

/** The FLOOR: native order only. No arm can reach it; it bounds what any guard could ever buy. */
const floor = (a, b) => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

ARMS.floor = floor;

const timeOne = (fn, data) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    let sink = 0;
    const t0 = performance.now();

    for (const left of data) {
      for (let j = 0; j < data.length; j += 32) {
        sink += fn(left, data[j]);
      }
    }

    series.push(performance.now() - t0);

    if (!Number.isFinite(sink)) {
      throw new Error('sink went non-finite — the arm did not run');
    }
  }

  // Item 884's estimator rule for this path: drop the visible JIT warm-up, take the median.
  const plateau = series.slice(DROP).sort((x, y) => x - y);

  return plateau[Math.floor(plateau.length / 2)];
};

const best = {};
const DATASETS = { ascii, prefixed, astral };
const DATA_NAMES = ['ascii', 'prefixed', 'astral'];

for (let round = 0; round < ROUNDS; round += 1) {
  const names = round % 2 === 1 ? ['scan', 'ref'] : ['ref', 'scan'];

  for (const dname of DATA_NAMES) {
    for (const name of [...names, 'floor']) {
      const key = `${dname}::${name}`;

      (best[key] ??= []).push(timeOne(ARMS[name], DATASETS[dname]));
    }
  }
}

console.log(`\n# guard cost, median of ${REPS - DROP}, min of ${ROUNDS} alternated rounds (ms)\n`);
console.log('  data        floor      ref     scan    ref/scan');

for (const dname of DATA_NAMES) {
  const m = (n) => Math.min(...best[`${dname}::${n}`]);
  const f = m('floor');
  const r = m('ref');
  const sc = m('scan');

  console.log(
    `  ${dname.padEnd(10)} ${f.toFixed(1).padStart(6)} ${r.toFixed(1).padStart(8)} ${sc.toFixed(1).padStart(8)} ${(r / sc).toFixed(2).padStart(10)}x`,
  );
}
