// EQUIVALENT SPELLINGS MUST COST THE SAME — THE GREMLIN SURFACE (item 1305)
//
//   cd packages/native && bun run spelling:gremlin
//   SPELL_N=200000 SPELL_REPS=9 bun run spelling:gremlin
//   SPELL_ONLY='id lookup' bun run spelling:gremlin     # one group, where no earlier group
//                                                       # has polluted dispatch
//
// WHY THIS FILE EXISTS. CLAUDE.md's "equivalent spellings must cost the same" section records that
// every index-seeding bug the old engine had took one shape — the planner recognised one spelling
// of a predicate and scanned for another that meant exactly the same thing — and that each cost
// 100-300x while RETURNING THE CORRECT ANSWER, so no correctness test could catch it. It then says
// the pure-TS engine needs its own check "and has one".
//
// It has one for ISO-GQL. `spelling-probe.ts` is 207 `MATCH` queries and ZERO `g.V()`. The Gremlin
// surface — a separate implementation with its own executor, steps and shortcut ladder — has a
// cross-engine BENCH (`bench-gremlin.ts`) and no spelling check at all. That bench even carries
// equivalent pairs as adjacent rows with comments saying "these two ask the same question and must
// stay close", which is the claim stated and then left to a human to eyeball.
//
// A user picks GQL xor Gremlin (`single-engine-parallel-naming`), so a surface-only gap costs half
// of them, and items 1035/1038 then 1043/1044 are the same lever built twice because nobody checked
// the twin.
//
// METHOD, mirroring the GQL probe rather than inventing a second one:
//   * THE ANSWER IS CHECKED FIRST and it is the strongest signal here. Two spellings that disagree
//     are not a perf finding at all — they are a conformance bug, or a bad group, and either way
//     the time is meaningless. The GQL probe reports this as "N group(s) disagree on the ANSWER".
//   * NULL CONTROLS: one spelling against ITSELF, so each run carries its own variance at a known
//     cost. A group is judged against the control nearest its own duration. Without this, a 2x
//     flag on a 1ms group and a 2x flag on a 300ms group read the same and are not the same.
//   * A FLOOR: two sub-millisecond readings have no useful ratio, so those groups are reported as
//     not-compared instead of as findings.
//   * 14 reps, DROP THE FIRST THREE as warm-up, MEDIAN of the rest — CLAUDE.md's estimator for the
//     TS per-row path, where `min` reports a rare fast rep and estimates two arms differently.
//
// ⚠️ A FLAG IS NOT YET A FINDING. Re-run the group ALONE with `SPELL_ONLY`, three times, before
// treating a spread as real (item 1073: one isolated run is still one reading). This probe is a
// PROBE and not a test — time is the only signal available, so a threshold in CI would be flaky.
import { Graph as TsGraph } from '@lenke/core';
import {
  E,
  V,
  and,
  both,
  bothE,
  count,
  eq,
  filter,
  gte,
  has,
  hasId,
  hasKey,
  hasLabel,
  hasNot,
  in_,
  inE,
  inV,
  is,
  lt,
  not,
  or,
  out,
  outE,
  toArray,
  traversal,
  union,
  values,
  within,
} from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.SPELL_N ?? 200_000);
const REPS = Number(process.env.SPELL_REPS ?? 14);
const TOL = Number(process.env.SPELL_TOL ?? 2);
const FLOOR_MS = Number(process.env.SPELL_FLOOR ?? 1);
const ONLY = process.env.SPELL_ONLY ?? '';

// THE FIXTURE, and its statistics are asserted below rather than assumed.
//
// Item 1304 is why: that item read a label template, concluded a label was on every vertex, and
// missed four extra nodes appended a thousand lines further down — so a "vacuous label" group was
// anchored on a label that covered 200000 of 200004 vertices and the 1545x it measured meant
// nothing. CLAUDE.md already says "check the fixture's own statistics, not just its output"; here
// the file checks them itself so the next reader cannot repeat it.
//
//   Univ   on EVERY vertex          — the genuinely vacuous label
//   Person on every vertex          — second vacuous label, for the two-label spellings
//   Mgr    on every 3rd vertex      — NON-vacuous, so a label that must really be applied
//   age    i % 90                   — `age >= 45` keeps half
//   k      i % 50                   — a small domain, for `within` against an `or` chain
const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":${
      i % 3 === 0 ? '["Person","Univ","Mgr"]' : '["Person","Univ"]'
    },"properties":{"age":${i % 90},"k":${i % 50},"s":"s${i % 7}"}}`,
);

for (let e = 0; e < N * 2; e++) {
  lines.push(
    `{"type":"edge","id":"e${e}","labels":["T"],"from":"v${(e * 7919) % N}","to":"v${
      (e * 104_729) % N
    }","properties":{"w":${e % 5}}}`,
  );
}

const graph = tsDeserialize(lines.join('\n'), 'ndjson', new TsGraph());

// THE FIXTURE ASSERTIONS. A group below is only as good as the statistic it relies on.
const stat = (label: string) => graph.verticesByLabel.get(label)?.size ?? 0;
const FIXTURE = [
  ['vertexCount', graph.vertexCount, N],
  ['Univ (must be VACUOUS)', stat('Univ'), graph.vertexCount],
  ['Person (must be VACUOUS)', stat('Person'), graph.vertexCount],
] as const;

for (const [what, got, want] of FIXTURE) {
  if (got !== want) {
    console.error(`FIXTURE BROKEN: ${what} is ${got}, expected ${want}`);
    process.exit(1);
  }
}

if (stat('Mgr') === graph.vertexCount || stat('Mgr') === 0) {
  console.error(`FIXTURE BROKEN: Mgr must be non-vacuous and non-empty, got ${stat('Mgr')}`);
  process.exit(1);
}

/** One group: a name, and two or more spellings that MUST answer identically. */
type Group = readonly [string, readonly Plan[]];

const GROUPS: readonly Group[] = [
  // ── O(1) ELEMENT ACCESS BY ID. First because it is the property most easily lost: a seeded
  // `V(id)` is a `verticesById` hit, and any spelling that falls to a scan turns O(1) into O(V)
  // while answering identically. `hasId` is the other way to write the same lookup without
  // seeding.
  //
  // THERE IS NO TOKEN ARM, and the reason is worth stating: this surface's `has` is typed
  // `has(key: string, ...)`, so a `T` token there is a COMPILE error (FamilySymbol<Token> is not
  // assignable to string) rather than a silently wrong answer. TinkerPop accepts that spelling;
  // this builder API does not express it, and the type system is what stops a user writing one. A
  // spelling that cannot compile is not a spelling cliff.
  //
  // Both token arms WERE in the first cut, and the ANSWER CHECK caught them immediately: the
  // token form answered 0 where `hasLabel('Mgr')` answered 667, which reads exactly like a silent
  // wrong answer until the signature is checked. Answers first, then typecheck, then a verdict.
  [
    'id lookup: seeded V(id) vs hasId',
    [traversal(V('v137'), count()), traversal(V(), hasId('v137'), count())],
  ],
  [
    'id lookup, projected: seeded vs hasId',
    [traversal(V('v137'), values('age')), traversal(V(), hasId('v137'), values('age'))],
  ],
  // An EDGE by id, the same question on the other element type.
  [
    'edge id lookup: seeded E(id) vs hasId',
    [traversal(E('e137'), count()), traversal(E(), hasId('e137'), count())],
  ],

  // ── LABEL SPELLINGS.
  [
    'label + property: hasLabel().has() vs has(label, key, pred)',
    [
      traversal(V(), hasLabel('Mgr'), has('age', gte(45)), count()),
      traversal(V(), has('Mgr', 'age', gte(45)), count()),
    ],
  ],
  [
    'label, two of them: hasLabel(a,b) vs or(hasLabel, hasLabel)',
    [
      traversal(V(), hasLabel('Mgr', 'Univ'), count()),
      traversal(V(), or(hasLabel('Mgr'), hasLabel('Univ')), count()),
    ],
  ],
  // A VACUOUS label against no label at all — the group item 1304 got wrong on the GQL side, done
  // here on a fixture whose `Univ` really is on every vertex.
  [
    'label, VACUOUS: hasLabel(Univ) vs no label',
    [traversal(V(), hasLabel('Univ'), count()), traversal(V(), count())],
  ],
  [
    'label, VACUOUS, before a hop: hasLabel(Univ).out vs out',
    [traversal(V(), hasLabel('Univ'), out('T'), count()), traversal(V(), out('T'), count())],
  ],

  // ── PREDICATE SPELLINGS, the family the GQL probe found most of its gaps in.
  [
    'equality: has(k, v) vs has(k, eq(v))',
    [traversal(V(), has('k', 7), count()), traversal(V(), has('k', eq(7)), count())],
  ],
  [
    'membership: within vs an or-chain of equalities',
    [
      traversal(V(), has('k', within(7, 8, 9)), count()),
      traversal(V(), or(has('k', 7), has('k', 8), has('k', 9)), count()),
    ],
  ],
  [
    'conjunction: has().has() vs and(has, has)',
    [
      traversal(V(), has('age', gte(45)), has('k', lt(25)), count()),
      traversal(V(), and(has('age', gte(45)), has('k', lt(25))), count()),
    ],
  ],
  [
    'a filter wrapper: has() vs filter(has())',
    [
      traversal(V(), has('age', gte(45)), count()),
      traversal(V(), filter(has('age', gte(45))), count()),
    ],
  ],
  // PRESENCE. Item 1283 found a 3.0x here on the GQL side because every other row passed a VALUE
  // predicate and nothing exercised the one-argument form, which builds a different step.
  [
    'presence: has(k) vs hasKey(k) vs not(hasNot(k))',
    [
      traversal(V(), has('age'), count()),
      traversal(V(), hasKey('age'), count()),
      traversal(V(), not(hasNot('age')), count()),
    ],
  ],
  [
    'a value predicate reached through values(): has(k,p) vs values(k).is(p)',
    [
      traversal(V(), has('age', gte(45)), count()),
      traversal(V(), values('age'), is(gte(45)), count()),
    ],
  ],

  // ── HOP SPELLINGS. `out(T)` and `outE(T).inV()` are the same walk written two ways, and the
  // second is what a user writes when they also want the edge.
  [
    'hop: out(T) vs outE(T).inV()',
    [traversal(V(), out('T'), count()), traversal(V(), outE('T'), inV(), count())],
  ],
  [
    'hop, incoming: in(T) vs inE(T).outV()',
    [traversal(V(), in_('T'), count()), traversal(V(), inE('T'), count())],
  ],
  [
    'hop, both directions: both(T) vs union(out, in)',
    [traversal(V(), both('T'), count()), traversal(V(), union(out('T'), in_('T')), count())],
  ],
  [
    'hop, both as edges: bothE(T) vs union(outE, inE)',
    [traversal(V(), bothE('T'), count()), traversal(V(), union(outE('T'), inE('T')), count())],
  ],
  // A FAR-END FILTER, the shape item 1302 built the Gremlin rung for and item 1303 the GQL fold.
  [
    'far-end label after a hop: out().hasLabel() vs outE().inV().hasLabel()',
    [
      traversal(V(), out('T'), hasLabel('Mgr'), count()),
      traversal(V(), outE('T'), inV(), hasLabel('Mgr'), count()),
    ],
  ],
  [
    'far-end property after a hop: out().has() vs outE().inV().has()',
    [
      traversal(V(), out('T'), has('age', gte(45)), count()),
      traversal(V(), outE('T'), inV(), has('age', gte(45)), count()),
    ],
  ],

  // ── NULL CONTROLS. One spelling against itself: this is the instrument, not a result. Two of
  // them, at different costs, because a ratio means different things at 1ms and at 300ms.
  [
    'NULL CONTROL (scan): one traversal twice',
    [traversal(V(), has('age', gte(45)), count()), traversal(V(), has('age', gte(45)), count())],
  ],
  [
    'NULL CONTROL (hop): one traversal twice',
    [
      traversal(V(), out('T'), has('age', gte(45)), count()),
      traversal(V(), out('T'), has('age', gte(45)), count()),
    ],
  ],
];

const plain = (v: unknown): unknown => {
  if (v instanceof Map) {
    return [...v.entries()];
  }

  // An element (vertex/edge) renders as its id, not as `[object Object]`: the answer check
  // compares these strings, so a fallback that collapses every element to one token would make
  // two DIFFERENT answers compare equal — the check quietly passing is the failure to avoid.
  if (typeof v === 'object' && v !== null) {
    const { id } = v as { id?: string | number };

    return id === undefined ? JSON.stringify(v) : `#${id}`;
  }

  return v;
};

/** A stable, comparable rendering of a traversal's answer. */
const answerOf = (plan: Plan): string => {
  const rows = toArray(plan, graph);

  // Truncated deliberately: a 200,000-row projection is compared on its first rows and its LENGTH,
  // which is what distinguishes the spellings here. A group that needs deeper comparison belongs
  // in the differential fuzzer, not in a timing probe.
  return `${rows.length}:${JSON.stringify(rows.slice(0, 8).map(plain))}`;
};

const timeOf = (plan: Plan): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();

    toArray(plan, graph);
    series.push(performance.now() - t);
  }

  const warm = series.slice(3).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)] ?? 0;
};

const selected = GROUPS.filter(([name]) => name.includes(ONLY));

if (selected.length === 0) {
  console.error(`SPELL_ONLY=${ONLY} matched no group`);
  process.exit(2);
}

type Result = { name: string; times: number[]; answers: string[]; spread: number; max: number };
const results: Result[] = [];

for (const [name, plans] of selected) {
  const answers = plans.map(answerOf);
  const times = plans.map(timeOf);
  const lo = Math.min(...times);
  const hi = Math.max(...times);

  results.push({
    name,
    times,
    answers,
    spread: lo > 0 ? hi / lo : Number.POSITIVE_INFINITY,
    max: hi,
  });
}

console.log(`\ngremlin spelling probe — N=${N} vertices, ${N * 2} edges, ${REPS} reps\n`);

for (const r of results) {
  const agree = new Set(r.answers).size === 1;

  console.log(`  ${r.name}${agree ? '' : '   <-- ANSWERS DISAGREE'}`);

  for (let i = 0; i < r.times.length; i++) {
    console.log(
      `      ${r.times[i].toFixed(3).padStart(9)}ms   answer=${r.answers[i].slice(0, 44)}`,
    );
  }
}

const disagree = results.filter((r) => new Set(r.answers).size !== 1);

console.log(`\n${disagree.length} group(s) disagree on the ANSWER`);

for (const r of disagree) {
  console.log(`  - ${r.name}`);

  for (const a of new Set(r.answers)) {
    console.log(`      ${a.slice(0, 92)}`);
  }
}

const controls = results.filter((r) => r.name.startsWith('NULL CONTROL'));

console.log("\nNULL CONTROLS — one traversal against itself, so each is this run's own variance");
console.log('  at that cost. A group is judged against the one NEAREST its own duration.');

for (const c of controls) {
  console.log(`    ${c.spread.toFixed(2)}x at ${c.max.toFixed(1)}ms`);
}

const nearestControl = (ms: number): number => {
  let best = 1;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const c of controls) {
    const gap = Math.abs(Math.log(Math.max(c.max, 1e-6)) - Math.log(Math.max(ms, 1e-6)));

    if (gap < bestGap) {
      bestGap = gap;
      best = c.spread;
    }
  }

  return best;
};

const judged = results.filter((r) => !r.name.startsWith('NULL CONTROL'));
const tooFast = judged.filter((r) => r.max < FLOOR_MS);
const flagged = judged
  .filter((r) => r.max >= FLOOR_MS && r.spread > TOL && r.spread > nearestControl(r.max))
  .sort((a, b) => b.spread - a.spread);

console.log(`\n${flagged.length} group(s) over ${TOL}x AND clear of the nearest null control:`);

for (const r of flagged) {
  const net = r.spread / nearestControl(r.max);

  console.log(`  - ${r.name} (${r.spread.toFixed(2)}x, net ${net.toFixed(2)}x)`);
}

if (flagged.length > 0) {
  console.log('\n  CONFIRM EACH BEFORE TREATING IT AS A FINDING — a flag can still be this');
  console.log('  harness. Re-run the group ALONE, where no earlier group has polluted dispatch,');
  console.log('  THREE TIMES (item 1073: one isolated run is still one reading):');

  for (const r of flagged) {
    console.log(
      `    SPELL_N=${N} SPELL_REPS=9 SPELL_ONLY='${r.name.slice(0, 34)}' bun run spelling:gremlin`,
    );
  }
}

if (tooFast.length > 0) {
  console.log(
    `\n${tooFast.length} group(s) under ${FLOOR_MS}ms, not compared (raise SPELL_N): ${tooFast
      .map((r) => r.name)
      .join('; ')}`,
  );
}
