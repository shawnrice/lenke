/**
 * Equivalent spellings must cost the same — the TypeScript half.
 *
 * `crates/lenke-engine/examples/spelling_probe.rs` does this for the Rust engine:
 * for each group of queries that should be equivalent it prints the canonicalized
 * optimized plan and the measured time, and flags any group whose members
 * disagree. The TS engine has no plan to canonicalize, so time is the only signal
 * here — which makes this a PROBE, run deliberately, not a test with a timing
 * assertion in CI.
 *
 * It exists because this class keeps recurring and keeps being found by accident:
 * audit item 125 found an inline endpoint constraint costing 4x the equivalent
 * clause `WHERE`, and item 121 found a multi-pattern spelling costing 160x. Every
 * historical instance in CLAUDE.md returned the CORRECT answer, so no correctness
 * test could catch it.
 *
 *   cd packages/native && bun spelling-probe.ts
 *   SPELL_N=50000 bun spelling-probe.ts
 *
 * A group is flagged when its slowest member is more than SPELL_TOL (default 2x)
 * the fastest. Answers are compared too: a group whose members disagree on the
 * ANSWER is a correctness bug and is reported first.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 20_000);
const TOL = Number(process.env.SPELL_TOL ?? 2);
const REPS = Number(process.env.SPELL_REPS ?? 5);
/**
 * A group whose SLOWEST member is under this many milliseconds is not compared.
 *
 * A ratio between two sub-millisecond timings is the clock's resolution, not a
 * measurement — the mistake item 124 made against the native engine, which this
 * probe then reproduced against its own O(1) groups: `label on start: redundant
 * vs absent` flagged at 1.5-1.6x on members reading 0.02 and 0.03ms. Both are
 * answered by a bucket-size read; neither is slow; the ratio means nothing.
 */
const FLOOR_MS = Number(process.env.SPELL_FLOOR ?? 1);

const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["P","Q"]' : '["P"]'},"properties":{"k":${i % 50},"s":"s${i % 7}"}}`,
);

for (let e = 0; e < N * 3; e++) {
  lines.push(
    `{"type":"edge","id":"e${e}","labels":${e % 11 === 0 ? '["E","F"]' : '["E"]'},"from":"v${e % N}","to":"v${(e * 7919) % N}","properties":{"w":${e % 5}}}`,
  );
}

const g = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

/** Groups of spellings of ONE question. Every member must answer identically. */
const GROUPS: [string, readonly string[]][] = [
  [
    'node count: inline vs clause WHERE',
    [
      'MATCH (n:P {k: 2}) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P WHERE n.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, FAR endpoint filtered (item 125)',
    [
      'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2) RETURN count(*) AS c',
    ],
  ],
  [
    'hop, START endpoint filtered',
    [
      'MATCH (a:P)-[:E]->(b) WHERE a.k = 2 RETURN count(*) AS c',
      'MATCH (a:P {k: 2})-[:E]->(b) RETURN count(*) AS c',
      'MATCH (a:P WHERE a.k = 2)-[:E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    'operand order: $x = n.k vs n.k = $x',
    [
      'MATCH (n:P) WHERE n.k = 2 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 2 = n.k RETURN count(*) AS c',
    ],
  ],
  [
    'range operand order: 5 <= n.k vs n.k >= 5',
    [
      'MATCH (n:P) WHERE n.k >= 5 RETURN count(*) AS c',
      'MATCH (n:P) WHERE 5 <= n.k RETURN count(*) AS c',
    ],
  ],
  [
    'OR vs IN',
    [
      'MATCH (n:P) WHERE n.k = 2 OR n.k = 7 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k IN [2, 7] RETURN count(*) AS c',
    ],
  ],
  [
    'NOT (=) vs <>',
    [
      'MATCH (n:P) WHERE NOT (n.k = 2) RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k <> 2 RETURN count(*) AS c',
    ],
  ],
  [
    'edge type disjunction order',
    [
      'MATCH (a:P)-[:E|F]->(b) RETURN count(*) AS c',
      'MATCH (a:P)-[:F|E]->(b) RETURN count(*) AS c',
    ],
  ],
  [
    'direction: -> vs reversed <-',
    [
      'MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c',
      'MATCH (b:Q)<-[:E]-(a:P) RETURN count(*) AS c',
    ],
  ],
  [
    'two patterns vs two clauses (items 122/123)',
    [
      'MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*) AS c',
      'MATCH (a:P {k: 1}) MATCH (b:P {k: 2}) RETURN count(*) AS c',
    ],
  ],
  [
    // These three ask for the distinct values of one property and must answer the same ROWS in
    // the same order, which is why the `count(*)` spelling is not among them — it carries an
    // extra column and the probe compares answers. The LET spellings were 9.1x off the bare
    // one: `GROUP BY` takes a BOUND NAME, so a LET is the only way ISO lets you name a
    // grouping key, and the DISTINCT spelling gets written the same way. Item 187 routed
    // DISTINCT-via-LET to the walk and item 188 did the same for a `GROUP BY` with no
    // aggregate, which closed the group — 1.36 / 1.37 / 1.44ms, within 6%.
    'the distinct values of one property',
    [
      'MATCH (n:P) RETURN DISTINCT n.k AS a',
      'MATCH (n:P) LET a = n.k RETURN DISTINCT a',
      'MATCH (n:P) LET a = n.k RETURN a GROUP BY a',
    ],
  ],
  [
    // One grouped count, written the two ways ISO lets you write it. `GROUP BY` takes a BOUND
    // NAME, so the `RETURN` form needs a `LET` to name the key; the `SELECT` form names the
    // PROPERTY and has no `LET` at all. The tally accepted only the first, so the standard's own
    // spelling went down the general grouping path: 69.5ms against 4.1 (audit item 199). The
    // third member adds the `HAVING` the SELECT form exists to carry — it has no `RETURN`
    // counterpart, since `HAVING` is SELECT-statement-only in ISO, so it is here as a member
    // whose cost must stay beside the others rather than as a second spelling of them.
    // The same inline-vs-clause question as the node-count group below, but for a PROJECTION
    // rather than a count — a different path (`detectNodeProjection`, item 204) and so a
    // separate group. Measured in isolation at 20,000 vertices the two read 24.3ns and 34.8ns a
    // vertex, so the inline spelling is ~1.4x ahead: `inlineHolds` -> `satisfies` against a
    // compiled predicate over the same property.
    'a filtered node projection: inline vs clause WHERE (item 204)',
    ['MATCH (n:P) WHERE n.k = 2 RETURN n.s AS s', 'MATCH (n:P {k: 2}) RETURN n.s AS s'],
  ],
  [
    'a grouped count: the LET form vs ISO SELECT (item 199)',
    [
      'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a',
      'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k',
      'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 0',
    ],
  ],
  [
    // `ORDER BY <alias>` IS `ORDER BY <the expression the alias names>`. `aliasDefinition`
    // substitutes it so the top-k keeps INPUT bindings and projects only the rows it emits.
    //
    // Item 144 found the COMPUTED case declining that substitution, measured the alias
    // spelling at 154.8ms against the expression's 89.3 (191.8 for an alias of a function),
    // and concluded it could not be fixed in one engine because the two spellings differ in
    // WHICH QUERIES RAISE. That conclusion was WRONG, and the correction is the thing worth
    // keeping: native projects only the emitted rows (`try_late_materialize`), so TS was the
    // inconsistent engine and the difference was a LIVE cross-engine divergence, not a shared
    // design. Item 145 fixed it in TS alone — 150.6 -> 86.1ms against the expression's 86.3.
    //
    // The pair stays as the regression guard. Note what it still PRINTS, though: ~1.9x, where
    // an isolated harness at the same `SPELL_N` reads 6.66ms against 5.64 (1.18x) and 200,000
    // rows read 86.1 against 86.3. This probe runs twenty-odd queries in one process, so each
    // row's cache state depends on its predecessors and its absolute spread is inflated — the
    // third time that has been confirmed (TS audit items 141, 143, 145). It is a FINDER: a
    // group it flags is worth isolating, and a spread it prints is not a settled delta.
    'ORDER BY alias vs its expression (items 144/145)',
    [
      'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 10',
      'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.k + 1 LIMIT 10',
    ],
  ],
  [
    'ORDER BY plain-column alias vs its expression',
    [
      'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10',
      'MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10',
    ],
  ],
  [
    'label on start: redundant vs absent',
    ['MATCH (a:P)-[:E]->(b) RETURN count(*) AS c', 'MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  ],
  [
    'AND order',
    [
      "MATCH (n:P) WHERE n.k = 2 AND n.s = 's1' RETURN count(*) AS c",
      "MATCH (n:P) WHERE n.s = 's1' AND n.k = 2 RETURN count(*) AS c",
    ],
  ],
  // The multi-segment count families, added in audit item 225 because items 219-222 each closed a
  // spelling gap that this standing instrument did not guard. Every one of them was found by a
  // throwaway probe at the time, and every one was ALREADY OPEN before the item that fixed it:
  //
  //   219  2-hop middle   WHERE 2331.7ms / inline WHERE 1183.1 / inline prop 482.3   (2.4x, 13.3x)
  //   220  2-hop end      forward 2363.5 against the hand-reversed spelling's 118.1  (20.0x)
  //   222  3-hop interior WHERE 9360.5 / inline WHERE 3945.9 / inline prop 560.7      (2.4x, 13.3x)
  //
  // So these are regression guards for four fixes, not speculative coverage.
  //
  // What is deliberately NOT here: the 3-hop END-filtered question. Item 223 established that it
  // stays on the row pipeline ON PURPOSE in both engines — reversing it is a selectivity gamble
  // native priced and declined — so it is ~9s on this fixture, and a group whose slowest member
  // takes seconds would make a probe nobody can afford to run.
  [
    'hop, MIDDLE filtered (item 219)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c) RETURN count(*) AS c',
    ],
  ],
  [
    // The reversed-arrow member is the one that matters most: item 220's whole finding was that
    // the forward spelling and the same question written backwards were 20x apart, and the fix
    // was a planner reversal rather than a new walk. If that reversal ever stops firing, THIS
    // member is what notices.
    'hop, END filtered, including the reversed arrows (item 220)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE c.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2}) RETURN count(*) AS c',
      'MATCH (c)<-[:E]-(b)<-[:E]-(a:P) WHERE c.k = 2 RETURN count(*) AS c',
    ],
  ],
  [
    'three hops, SECOND position filtered (item 222)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE b.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b WHERE b.k = 2)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b {k: 2})-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
  [
    // The third position is gated once per MIDDLE EDGE where the second is gated once per vertex,
    // so these two groups are different questions with different costs — which is why they are two
    // groups and not one. Within each, the three spellings must agree.
    'three hops, THIRD position filtered (item 222)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
  [
    // `P` is carried by every vertex in this fixture, so the label constrains nothing and the two
    // are one question. Item 221's three-hop tally reads a VACUOUS end label as absent, decided
    // per execution; if that collapse regresses, the labelled member pays an endpoint resolve per
    // edge and this group spreads.
    'three hops: a vacuous start label vs none (item 221)',
    [
      'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
      'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c',
    ],
  ],
];

const timed = (q: string): { ms: number; answer: string } => {
  let best = Infinity;
  let answer = '';

  for (let i = 0; i < REPS; i++) {
    const t = performance.now();
    const rows = tsQuery(g, q);

    best = Math.min(best, performance.now() - t);
    answer = JSON.stringify(rows);
  }

  return { ms: best, answer };
};

console.log(`${N} vertices / ${N * 3} edges, min of ${REPS}, flagging spread > ${TOL}x\n`);

const wrong: string[] = [];
const slow: string[] = [];
const fast: string[] = [];

for (const [name, spellings] of GROUPS) {
  // TWO passes, the second in reverse order, keeping the min per spelling.
  //
  // Whichever member runs FIRST in a group pays a large position penalty, and it is the
  // harness's, not the query's. On the `direction` group at N=200,000 the first member read
  // 234.4 / 233.6 / 236.3ms and the second 152.1 / 142.9 / 154.0 — and SWAPPING the two made the
  // penalty follow the POSITION, not the spelling (reversed-first 237.8 / 238.7 / 235.3, with
  // forward then at 148.6 / 158.8 / 146.7). In a process running only that group both read
  // 141.7 / 142.6. So the group had been reported at 1.5-2.1x across audit items 180 and 181
  // with no engine cause at all; the two spellings compile to the same predicate, which is why
  // item 181's fix could not move the number.
  //
  // Timing every spelling in both positions and taking its better reading removes the bias: a
  // spelling that is genuinely slower is slower from either position. It doubles the probe's
  // runtime, which is the right trade for an instrument whose whole output is a ratio.
  const firstPass = spellings.map((q) => timed(q));
  const secondPass: { ms: number; answer: string }[] = [];

  for (let i = spellings.length - 1; i >= 0; i -= 1) {
    secondPass[i] = timed(spellings[i]);
  }

  const runs = spellings.map((q, i) => ({
    q,
    ms: Math.min(firstPass[i].ms, secondPass[i].ms),
    answer: firstPass[i].answer,
  }));
  // Both passes' answers, so a spelling that answers inconsistently is still caught.
  const answers = new Set([...firstPass, ...secondPass].map((r) => r.answer));
  const fastest = Math.min(...runs.map((r) => r.ms));
  const slowest = Math.max(...runs.map((r) => r.ms));
  const spread = slowest / Math.max(fastest, 0.01);
  const tooFast = slowest < FLOOR_MS;
  let flag = '';

  if (answers.size > 1) {
    flag = 'ANSWERS DIFFER';
  } else if (tooFast) {
    flag = 'too fast';
  } else if (spread > TOL) {
    flag = `${spread.toFixed(1)}x`;
  }

  console.log(`${flag.padStart(15)}  ${name}`);

  for (const r of runs) {
    console.log(`                   ${r.ms.toFixed(2).padStart(9)}ms  ${r.q}`);
  }

  if (answers.size > 1) {
    wrong.push(name);

    for (const r of runs) {
      console.log(`                   -> ${r.answer.slice(0, 80)}`);
    }
  } else if (spread > TOL && !tooFast) {
    slow.push(`${name} (${spread.toFixed(1)}x)`);
  } else if (tooFast) {
    fast.push(name);
  }
}

console.log(
  `\n${wrong.length} group(s) disagree on the ANSWER${wrong.length > 0 ? `: ${wrong.join('; ')}` : ''}`,
);
console.log(
  `${slow.length} group(s) over ${TOL}x${slow.length > 0 ? `:\n  - ${slow.join('\n  - ')}` : ''}`,
);
const fastTail = fast.length > 0 ? ` (raise SPELL_N to measure them): ${fast.join('; ')}` : '';

console.log(`${fast.length} group(s) under ${FLOOR_MS}ms, not compared${fastTail}`);
