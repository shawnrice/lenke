/**
 * A CLIFF FINDER for Gremlin's shortcut families (item 1613).
 *
 * Items 1602 and 1612 were both found the same way, and it is worth having as an instrument rather
 * than a habit: take a family of shapes that differ by ONE step, ask the engine which of them a
 * closed-form rung answers, and time them all. A shape whose NEIGHBOUR is answered in closed form
 * and which is itself orders slower is a CLIFF — the defect class this engine is named after,
 * because two near-identical questions cost wildly different amounts.
 *
 * What this adds over `bench:gremlin`: that sweep times a fixed list of shapes against each other,
 * which answers "how fast is this engine". This asks "which NEIGHBOURING pair disagrees", which is
 * the question that finds holes. Item 1612's 214x sat next to a 464 us closed form and no absolute
 * reading would have flagged it.
 *
 * ⚠️ THE RUNG VERDICT IS READ FROM THE ENGINE, NOT INFERRED FROM THE TIMING. Item 1602's note is
 * the reason: a 157 ns/traverser row looked like a constant until `countShortcut` was called
 * directly and returned `undefined` for exactly one shape of five. Timing cannot tell "declined"
 * from "more work".
 *
 *     bun gremlin-cliff-finder.ts            # the whole family
 *     FAMILY=values bun gremlin-cliff-finder.ts
 */
import { Graph } from '@lenke/core';
import {
  V,
  count,
  dedupe,
  eq,
  has,
  hasLabel,
  id,
  limit,
  order,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { countShortcut } from '../gremlin/src/executor/count-shortcut.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { hopChainValuesShortcut } from '../gremlin/src/executor/hop-chain-values.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { hopValuesShortcut } from '../gremlin/src/executor/hop-values.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { effectivePlan } from '../gremlin/src/executor/index.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { startFilteredHopValues } from '../gremlin/src/executor/start-filtered-hop-values.js';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 100);
const FAMILY = process.env.FAMILY ?? 'all';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { team: `t${i % 50}`, score: i % 100, n: i },
  });
}

/**
 * ⚠️ SPLIT THE TARGET ON THE REPEAT INDEX. `to = (a * k + b) % N` is INVARIANT under `k -> k + N`,
 * so a loop over `k < NODES * FANOUT` gives every one of a vertex's FANOUT edges the SAME target:
 * degree counts look perfect while the graph is FUNCTIONAL (CLAUDE.md, items 1516/1518).
 */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const rep = Math.floor(k / NODES);
  const to = (from * 7 + rep * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`)!,
    to: g.getVertexById(`u${to}`)!,
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS before trusting any number off this fixture.
const targets = new Set<string>();
const degree = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
}

const branching = [...degree.values()].filter((d) => d > 1).length;

if (targets.size < NODES * 0.5 || branching < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed; see the comment above');
}

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${branching} branching\n`,
);

type Shape = { family: string; name: string; plan: Plan };

const V_ = () => V();
const shapes: Shape[] = [
  // --- counts: the family items 1602/1612 closed, kept as the CONTROL that cliffs are gone -------
  { family: 'count', name: 'hop', plan: traversal(V_(), hasLabel('User'), out('E'), count()) },
  {
    family: 'count',
    name: 'hop + far has',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), count()),
  },
  {
    family: 'count',
    name: 'hop hop',
    plan: traversal(V_(), hasLabel('User'), out('E'), out('E'), count()),
  },
  {
    family: 'count',
    name: 'hop hop + trailing has',
    plan: traversal(V_(), hasLabel('User'), out('E'), out('E'), has('team', eq('t1')), count()),
  },
  {
    family: 'count',
    name: 'hop + mid has + hop',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), out('E'), count()),
  },

  // --- values: the family this item is looking at ------------------------------------------------
  {
    family: 'values',
    name: 'hop values',
    plan: traversal(V_(), hasLabel('User'), out('E'), values('n')),
  },
  {
    family: 'values',
    name: 'hop + far has, values',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), values('n')),
  },
  {
    family: 'values',
    name: 'hop hop values',
    plan: traversal(V_(), hasLabel('User'), out('E'), out('E'), values('n')),
  },
  {
    family: 'values',
    name: 'hop hop + trailing has, values',
    plan: traversal(V_(), hasLabel('User'), out('E'), out('E'), has('team', eq('t1')), values('n')),
  },
  {
    family: 'values',
    name: 'hop + mid has + hop, values',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), out('E'), values('n')),
  },

  // --- id / dedupe / order, each a one-step change from a values shape --------------------------
  { family: 'other', name: 'hop id', plan: traversal(V_(), hasLabel('User'), out('E'), id()) },
  {
    family: 'other',
    name: 'hop + far has, id',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), id()),
  },
  {
    family: 'other',
    name: 'hop dedupe count',
    plan: traversal(V_(), hasLabel('User'), out('E'), dedupe(), count()),
  },
  {
    family: 'other',
    name: 'hop + far has, dedupe count',
    plan: traversal(V_(), hasLabel('User'), out('E'), has('team', eq('t1')), dedupe(), count()),
  },
  {
    family: 'other',
    name: 'hop + far has, values order limit',
    plan: traversal(
      V_(),
      hasLabel('User'),
      out('E'),
      has('team', eq('t1')),
      values('n'),
      order(),
      limit(10),
    ),
  },
];

const picked = FAMILY === 'all' ? shapes : shapes.filter((s) => s.family === FAMILY);

console.log(
  `${'family'.padEnd(7)} ${'shape'.padEnd(32)} ${'rung'.padEnd(8)} ${'ns/op'.padStart(10)}  rows`,
);

const timings = new Map<string, number>();

for (const s of picked) {
  /**
   * ⚠️ THE RUNG VERDICT COMES FROM THE ENGINE, NOT THE CLOCK — and it must be asked of the
   * EFFECTIVE plan, which is what `run` does.
   *
   * The first version of this probe called `countShortcut` on the RAW plan and so reported
   * `pipeline` for shapes that are in fact answered: `effectivePlan` runs `dropVacuousLabels`, and
   * `hasLabel('User')` on a graph where every vertex is a `User` is DELETED before any rung sees
   * the plan. A leading vacuous label therefore changed the verdict without changing the query —
   * the instrument would have invented a cliff wherever the fixture is single-label, which is most
   * of this repo's.
   *
   * ⚠️ AND IT MUST ASK EVERY RUNG `run` ASKS, NOT JUST `countShortcut` — the second way this probe
   * lied (item 1614). Its first version consulted the count rung alone, so every ROW-returning shape
   * read `pipeline` whatever answered it: `V().out(E).values(k)` has ridden a fused walk since item
   * 170 and was reported as pipeline here. A verdict column that is wrong for a whole family is
   * worse than none, because the `values` rows then look uniformly unanswered and the ratios beside
   * them cannot be read.
   *
   * `??` IN `run`'S OWN ORDER, so the verdict is the route actually taken.
   */
  const effective = effectivePlan(s.plan, g, false);
  const answered =
    countShortcut(effective, g) !== undefined ||
    (hopValuesShortcut(effective, g) ??
      startFilteredHopValues(effective, g) ??
      hopChainValuesShortcut(effective, g)) !== undefined;
  const rung = answered ? 'CLOSED' : 'pipeline';

  for (let i = 0; i < 5; i += 1) {
    toArray(s.plan, g);
  }

  const rows = toArray(s.plan, g).length;
  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    toArray(s.plan, g);
  }

  const ns = ((performance.now() - t0) * 1e6) / REPS;

  timings.set(`${s.family}/${s.name}`, ns);
  console.log(
    `${s.family.padEnd(7)} ${s.name.padEnd(32)} ${rung.padEnd(8)} ${ns.toFixed(0).padStart(10)}  ${rows}`,
  );
}

/**
 * NEIGHBOUR PAIRS: each differs by ONE step, so a large ratio is a cliff rather than a workload
 * difference. ⚠️ A ratio is a SUSPECT, not a verdict — the filtered member of a pair can legitimately
 * do more work (it walks the same traversers and then filters). What makes it a cliff is the
 * neighbour being CLOSED while it is `pipeline`, which the column above states.
 */
const PAIRS: readonly [string, string][] = [
  ['count/hop', 'count/hop + far has'],
  ['count/hop hop', 'count/hop hop + trailing has'],
  ['count/hop hop', 'count/hop + mid has + hop'],
  ['values/hop values', 'values/hop + far has, values'],
  ['values/hop hop values', 'values/hop hop + trailing has, values'],
  ['values/hop hop values', 'values/hop + mid has + hop, values'],
  ['other/hop id', 'other/hop + far has, id'],
  ['other/hop dedupe count', 'other/hop + far has, dedupe count'],
];

console.log(
  '\nNEIGHBOUR PAIRS (one step apart). A large ratio next to a CLOSED neighbour is a cliff.',
);

for (const [a, b] of PAIRS) {
  const x = timings.get(a);
  const y = timings.get(b);

  if (x === undefined || y === undefined) {
    continue;
  }

  const ratio = y / x;
  const flag = ratio > 5 ? '  <-- SUSPECT' : '';

  console.log(`  ${a.padEnd(34)} -> ${b.padEnd(38)} ${ratio.toFixed(2)}x${flag}`);
}
