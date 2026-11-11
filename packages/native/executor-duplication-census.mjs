/**
 * WHICH EXECUTOR FUNCTIONS ARE NEAR-DUPLICATES OF EACH OTHER? (item 1787)
 *
 * The companion question to `rung-precedence-census.mjs`. That probe asks which of the twenty rungs
 * answers each shape; this one asks what the rungs are MADE of, and whether the same walk has been
 * written more than once.
 *
 * ## Why this question, and why now
 *
 * The refactor this branch exists for was opened on the theory that the executor had become too
 * fragmented — that specializations had multiplied until some were no longer reached. Two checks
 * have already refuted the simple forms of that:
 *
 *   - the rung census: 73/83 shapes reach a rung, 5 contested, all 3 contested pairs ordered right,
 *     and the 3 rungs that never fire are a CORPUS GAP (`FOR`/reachability shapes), not dead code;
 *   - a definition scan: of 969 top-level functions across both executors, exactly ONE is
 *     unreferenced (`farMaskSlotOrder`) and one is test-only (`estimateSeed`).
 *
 * So there is no dead code to delete. What is left is the other kind of fragmentation: code that is
 * all live, but says the same thing twice. That costs three things — the polymorphism item 159
 * priced (a shared module-scope walk going megamorphic cost 1.29x), the per-edit toll
 * `executor-edits-perturb` prices at up to 16% on unrelated rows, and the reader's time.
 *
 * ## What it measures, and what a high score does NOT mean
 *
 * For every pair of top-level functions it reports token-level similarity after stripping comments
 * and normalizing whitespace. Identifier names are KEPT — two walks that differ only in which
 * variable they bind are the interesting case, and erasing names would also erase the difference
 * between a far-driven and a start-driven walk.
 *
 * A HIGH SCORE IS A CANDIDATE, NOT A FINDING, for exactly the reason the rung census says a starved
 * rung is a candidate: two walks may be near-identical in text and deliberately separate in the
 * engine. Item 159 measured adding one branch to the unfiltered hop inner loop at 1.6x for the hot
 * shape, and a SHARED module-scope walk at 1.29x from going polymorphic. The top row this probe
 * reports is exactly such a case: `stackedWalk` and `pairSlotWalk` are byte-identical but for their
 * names, and item 1681 made them so ON PURPOSE, because V8's inline caches live on the FUNCTION
 * rather than the call site, so one function serving depths 2-5 has worse caches for each than one
 * function per depth. Collapsing that pair cost the depth-3 row 1.26x. So "these two are 99.8% the
 * same" is the start of a cost argument, never its conclusion.
 *
 * ## Reading the output
 *
 *   the pair table   most-similar first, with each function's code size, so a 95% pair of 8-line
 *                    helpers can be told from a 95% pair of 60-line walks
 *   SAME FILE        both in one module — usually a deliberate specialization pair
 *   CROSS FILE       in different modules — more often genuine divergence that drifted
 *   asymmetry        a pair where one copy cites items the other does not; see that section
 *
 * Run: bun executor-duplication-census.mjs [minSimilarity] [minCodeLines]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['../gql/src/executor', '../gremlin/src/executor'];

const MIN_SIM = Number(process.argv[2] ?? 0.8);
const MIN_LINES = Number(process.argv[3] ?? 12);

/** Strip line and block comments without touching string contents. Line COUNT is preserved. */
const stripComments = (src) => {
  let out = '';
  let i = 0;
  // code | line | block | sq | dq | tpl
  let mode = 'code';

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        i += 2;
        continue;
      }

      if (c === '/' && d === '*') {
        mode = 'block';
        i += 2;
        continue;
      }

      if (c === "'") {
        mode = 'sq';
      } else if (c === '"') {
        mode = 'dq';
      } else if (c === '`') {
        mode = 'tpl';
      }

      out += c;
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }

      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (c === '*' && d === '/') {
        mode = 'code';
        i += 2;
        continue;
      }

      if (c === '\n') {
        out += c;
      }

      i += 1;
      continue;
    }

    // inside a string literal
    out += c;

    if (c === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }

    if (
      (mode === 'sq' && c === "'") ||
      (mode === 'dq' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code';
    }

    i += 1;
  }

  return out;
};

const DECL =
  /^(?:export\s+)?(?:const\s+([A-Za-z_$][\w$]*)\s*[:=]|function\s+([A-Za-z_$][\w$]*)|async\s+function\s+([A-Za-z_$][\w$]*))/;

/**
 * Pull top-level functions out of one module. Brace-matched from the declaration, so a nested
 * closure stays part of its owner rather than becoming its own row — which matters here, because
 * the "two closures chosen once" pattern puts the interesting code INSIDE a factory.
 */
const functionsOf = (file, src) => {
  const clean = stripComments(src);
  const lines = clean.split('\n');
  const raw = src.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL.exec(lines[i]);

    if (m === null) {
      continue;
    }

    const name = m[1] ?? m[2] ?? m[3];
    let depth = 0;
    let started = false;
    let j = i;
    const body = [];

    for (; j < lines.length; j += 1) {
      const L = lines[j];

      body.push(L);

      for (const ch of L) {
        if (ch === '{' || ch === '(' || ch === '[') {
          depth += 1;
          started = true;
        } else if (ch === '}' || ch === ')' || ch === ']') {
          depth -= 1;
        }
      }

      if (started && depth <= 0) {
        break;
      }

      // runaway guard
      if (j - i > 900) {
        break;
      }
    }

    const codeLines = body.filter((L) => L.trim().length > 0).length;

    if (codeLines >= MIN_LINES) {
      // The DOC BLOCK above the declaration, walked backwards through comment and blank lines.
      let k = i - 1;
      const doc = [];

      while (k >= 0) {
        const s = raw[k].trim();

        if (
          s === '' ||
          s.startsWith('*') ||
          s.startsWith('/*') ||
          s.startsWith('//') ||
          s === '*/'
        ) {
          doc.unshift(raw[k]);
          k -= 1;
          continue;
        }

        break;
      }

      // CITATIONS ARE SCANNED OVER THE **RAW** BODY, NOT `body`.
      //
      // `body` comes from the comment-STRIPPED source, so scanning it for "item NNN" finds only
      // what the doc block above happens to carry. The first cut of this screen did exactly that
      // and reported `startOnlyHopCount` as citing nothing while its twin cited six items — when
      // in fact its own BODY cites 1067, 119, 162, 321, 164 and 163 in inline comments. The row
      // was backwards, and it was caught only by diffing the pair by hand against the screen's
      // claim. A screen whose evidence is comments cannot read a comment-stripped body.
      const rawBody = raw.slice(i, j + 1).join('\n');
      const cited = new Set(
        [...`${doc.join('\n')}\n${rawBody}`.matchAll(/items?\s+(\d{2,4})/gi)].map((hit) => hit[1]),
      );

      out.push({ file, name, codeLines, text: body.join('\n'), start: i + 1, cited });
    }

    i = j;
  }

  return out;
};

/** Token stream: identifiers, numbers and punctuation. Names KEPT, see the header. */
const tokenize = (t) => t.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\sA-Za-z_$\d]/g) ?? [];

/** Token bigram counts, the basis of the Dice coefficient below. */
const bigrams = (ts) => {
  const m = new Map();

  for (let i = 0; i + 1 < ts.length; i += 1) {
    const g = `${ts[i]}\u0000${ts[i + 1]}`;

    m.set(g, (m.get(g) ?? 0) + 1);
  }

  return m;
};

const countOf = (m) => [...m.values()].reduce((s, n) => s + n, 0);

/**
 * Similarity on token bigrams — order-sensitive enough to separate a real duplicate from two
 * functions that merely share a vocabulary, and cheap enough to run over every pair.
 */
const similarity = (a, b) => {
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;

  for (const [g, n] of ga) {
    const o = gb.get(g);

    if (o !== undefined) {
      shared += Math.min(n, o);
    }
  }

  const total = countOf(ga) + countOf(gb);

  return total === 0 ? 0 : (2 * shared) / total;
};

const fns = [];

for (const d of DIRS) {
  let names;

  try {
    names = readdirSync(d);
  } catch {
    console.error(`SKIP ${d} (not found — run this from packages/native)`);
    continue;
  }

  for (const n of names) {
    if (!n.endsWith('.ts') || n.endsWith('.test.ts') || n.endsWith('.d.ts')) {
      continue;
    }

    const p = join(d, n);

    fns.push(...functionsOf(p, readFileSync(p, 'utf8')));
  }
}

if (fns.length === 0) {
  console.error('ABORT: no functions extracted — the extractor is broken, not the code clean');
  process.exit(1);
}

for (const f of fns) {
  f.toks = tokenize(f.text);
}

const pairs = [];

for (let i = 0; i < fns.length; i += 1) {
  for (let j = i + 1; j < fns.length; j += 1) {
    const s = similarity(fns[i].toks, fns[j].toks);

    if (s >= MIN_SIM) {
      pairs.push({ s, a: fns[i], b: fns[j] });
    }
  }
}

pairs.sort((x, y) => y.s - x.s || y.a.codeLines + y.b.codeLines - (x.a.codeLines + x.b.codeLines));

const short = (p) => p.replace('../', '').replace('/src/executor', '');

console.log(`functions extracted (>= ${MIN_LINES} code lines)   ${fns.length}`);
console.log(`pairs at or above ${MIN_SIM.toFixed(2)} similarity        ${pairs.length}`);
console.log();

let sameFile = 0;
let crossFile = 0;

for (const { s, a, b } of pairs) {
  const same = a.file === b.file;

  if (same) {
    sameFile += 1;
  } else {
    crossFile += 1;
  }

  console.log(
    `${(s * 100).toFixed(1)}%  ${same ? 'SAME FILE ' : 'CROSS FILE'}  ` +
      `${a.name} (${a.codeLines}L) <-> ${b.name} (${b.codeLines}L)`,
  );
  console.log(`         ${short(a.file)}:${a.start}   |   ${short(b.file)}:${b.start}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE ASYMMETRY SCREEN: a near-duplicate where ONE copy cites items the other does not.
//
// This is the screen the census was extended for, and item 1787 is why. `hasSubquery`,
// `containsSubquery` and `hasSubqueryExpr` were three copies of one compile-time AST walk, and item
// 1500 replaced `Object.values(...).some(...)` with `for...in` in exactly ONE of them, because the
// array form allocated once per visited node. The other two never got it. Nothing failed, nothing
// drifted in behaviour, and no test could notice — the copies still agreed on every answer.
//
// An item citation is a record that someone MEASURED this code. So a pair where one side cites an
// item the other does not is the signature of a fix that landed on one copy, which is the precise
// mechanism behind "the code fragmented and some optimizations stopped being hit".
//
// ASYMMETRY IS WEAKER EVIDENCE THAN SIMILARITY, and in both directions. A citation may be about the
// function's PURPOSE rather than a fix — item 1681 on `pairSlotWalk` documents why that duplication
// must STAY, so that pair is asymmetric and must not be collapsed. A deliberate MIRROR pair also
// reads asymmetric simply because each side says "see the twin" instead of repeating the other's
// items, which is what `startOnlyHopCount`/`farOnlyHopCount` do. And a fix applied to one copy with
// no comment at all leaves no citation to find, so a clean screen is not proof. Read the cited item
// before acting on a row.
const asymmetric = pairs.filter(
  ({ a, b }) =>
    [...a.cited].some((c) => !b.cited.has(c)) || [...b.cited].some((c) => !a.cited.has(c)),
);

console.log();
console.log(
  `=== ASYMMETRIC CITATIONS: one copy was measured, the other may not have been (${asymmetric.length}) ===`,
);

for (const { s, a, b } of asymmetric) {
  const onlyA = [...a.cited].filter((c) => !b.cited.has(c));
  const onlyB = [...b.cited].filter((c) => !a.cited.has(c));

  console.log(`  ${(s * 100).toFixed(1)}%  ${a.name} <-> ${b.name}`);

  if (onlyA.length > 0) {
    console.log(`          only ${a.name} cites: ${onlyA.map((i) => `item ${i}`).join(', ')}`);
  }

  if (onlyB.length > 0) {
    console.log(`          only ${b.name} cites: ${onlyB.map((i) => `item ${i}`).join(', ')}`);
  }
}

console.log();
console.log('=== summary ===');
console.log(`  pairs in ONE module (deliberate specialization, usually)   ${sameFile}`);
console.log(`  pairs ACROSS modules (drift, more often)                   ${crossFile}`);
console.log();
console.log('A high score is a CANDIDATE, not a finding — see this file header: item 159 priced a');
console.log('shared module-scope walk at 1.29x from going polymorphic, and item 1681 duplicated a');
console.log('122-line walk on purpose. Each row needs its own A/B before anything is collapsed.');
