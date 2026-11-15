/**
 * CAN THE LEVEL-WISE COUNT EXPRESS `ACYCLIC` AS A CORRECTION? (item 2001)
 *
 * Item 2001's profile found that `MATCH ACYCLIC` is not a slow rung — it is DECLINED by
 * `degreeCountShape` (`var-length-count.ts:1040`, which admits `mode` of `undefined`/`trail`/`walk`
 * and nothing else) and falls to the general matcher, where ~86% of the window is
 * `generatorResume` + anonymous closures + `Array.from` + `Map` + `withBinding`: it enumerates all
 * 600,000 paths as bindings to count them.
 *
 * 🔑 **THE RUNG ALREADY HAS A MECHANISM FOR A PATH RESTRICTION, so the question is whether ACYCLIC
 * fits it.** TRAIL is admitted and corrected rather than enumerated: count all walks level-wise,
 * then SUBTRACT the walks that violate the restriction (`buildTrailMasks`, with depth-3/4 tables).
 * This probe asks whether ACYCLIC's violators are countable the same way at max <= 2.
 *
 * ⚠️⚠️ **IT PROVES THE ARITHMETIC BEFORE ANY RUNG IS BUILT, which is this repo's rule for a route
 * whose correctness is arithmetic** ([[perf-gate-needs-its-own-test]]: a route choice is
 * answer-equivalent, so extract the arithmetic as a pure function and test THAT). Building the rung
 * first and discovering the formula is wrong is how an optimizer wrong-answer ships.
 *
 * THE CLAIM, for a single-segment quantified pattern with max <= 2:
 *
 *     acyclic({1,1}) = walks({1,1}) - #self-loops
 *     acyclic({1,2}) = walks({1,2}) - #self-loop-1-paths - #2-walks a->b->a
 *                                   - #2-walks using a self-loop at either position
 *
 * A 2-walk `a->b->c` is non-acyclic iff a==b, b==c or a==c. The first two are self-loops; the third
 * is a return. ⚠️ THEY OVERLAP — `a->a->a` is all three at once — so this is inclusion-exclusion and
 * not a sum, which is exactly where an off-by-one in a correction lives.
 *
 *     bun acyclic-correction-2001.mjs
 *     NODES=2000 LOOPS=40 bun acyclic-correction-2001.mjs    # add deliberate self-loops
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 4000);
const FANOUT = Number(process.env.FANOUT ?? 5);
// ⚠️ SELF-LOOPS ARE ADDED DELIBERATELY. The screen's generator makes almost none, so a formula that
// mishandles them agrees with ground truth on that fixture and is wrong on a real graph. Item 1998's
// sink and item 1999's both-arms-live are the same lesson: the fixture must contain the case.
const LOOPS = Number(process.env.LOOPS ?? 25);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  for (let k = 0; k < LOOPS; k += 1) {
    const v = g.getVertexById(String(((k * 37) % NODES) + 1));

    g.addEdge({ id: `loop${String(k)}`, from: v, to: v, labels: ['E'], properties: {} });
  }

  return g;
};

const g = build();
const out = new Map(); // vertex id -> Map(target id -> multiplicity)

for (const v of g.vertices) {
  const box = v.adjFrom?.get('E');
  const m = new Map();

  if (box !== undefined) {
    for (const e of box) {
      m.set(e.to.id, (m.get(e.to.id) ?? 0) + 1);
    }
  }

  out.set(v.id, m);
}

/** Violator counts, from the adjacency alone — what a rung would compute. */
const selfLoops = [...out].reduce((a, [vid, m]) => a + (m.get(vid) ?? 0), 0);

let returns2 = 0; // 2-walks a->b->a  (a != b)
let loopThenAny = 0; // a->a->c
let anyThenLoop = 0; // a->b->b
let tripleLoop = 0; // a->a->a

for (const [a, ma] of out) {
  const selfA = ma.get(a) ?? 0;

  for (const [b, mult] of ma) {
    const mb = out.get(b);
    const selfB = mb.get(b) ?? 0;

    if (b === a) {
      loopThenAny += selfA * [...mb.values()].reduce((x, y) => x + y, 0);
      anyThenLoop += selfA * selfA;
      tripleLoop += selfA * selfA;
      continue;
    }

    returns2 += mult * (mb.get(a) ?? 0);
    anyThenLoop += mult * selfB;
  }
}

/*
 * INCLUSION-EXCLUSION over the three ways a 2-walk a->b->c fails to be acyclic:
 *   A: a==b   (self-loop first)    |A| = loopThenAny
 *   B: b==c   (self-loop second)   |B| = anyThenLoop
 *   C: a==c   (a return)           |C| = returns2 + (a==b==c counted inside loopThenAny)
 * A&B = A&C = B&C = A&B&C = a->a->a = tripleLoop.
 */
/*
 * ⚠️⚠️ **THE `- tripleLoop` IS A SINGLE-TERM OFF-BY-ONE THAT THREE OF FIVE FIXTURES DID NOT CATCH.**
 * The first version read `- 2 * tripleLoop`, which is the correct coefficient for the FULL |C| — but
 * `returns2` deliberately omits the `b === a` case, so the expression was carrying `|C| - S` and the
 * union came out `A + B + C - 3S` instead of `A + B + C - 2S`. The error is therefore exactly
 * `S = sum(L_a^2)` over self-loop multiplicities, which is 2 on a fixture with two self-loops and 318
 * on one with a loop at every vertex — i.e. INVISIBLE on a graph with almost no self-loops, which is
 * what the workload screen's generator produces.
 *
 * Inclusion-exclusion over the three ways a 2-walk a->b->c fails to be acyclic:
 *   A: a==b (self-loop first)   B: b==c (self-loop second)   C: a==c (a return)
 * All three pairwise intersections AND the triple intersection are the same set — `a->a->a`, two
 * self-loop edges at one vertex — of size S. So |A u B u C| = |A|+|B|+|C| - 3S + S = ... - 2S, and
 * with |C| spelled as `returns2 + tripleLoop` the coefficient here is -1.
 */
const bad2 = loopThenAny + anyThenLoop + returns2 - tripleLoop;

/*
 * ⚠️⚠️ **BRUTE-FORCE GROUND TRUTH FOR EVERY TERM, because the closed form above was WRONG and three
 * of five fixtures agreed with it anyway.** It was exact at |V|=4000/2000/8000 and off by -2 and -12
 * on the two fixtures with DENSE self-loops — so the fixtures that agreed were not discriminating,
 * and a formula validated only on them would have shipped an optimizer wrong answer. Enumerating the
 * 2-walks directly is O(|E| * degree) and only viable on a small fixture, which is exactly what a
 * correctness oracle should be: slow, obviously right, and not sharing an assumption with the thing
 * it checks.
 *
 * Each violator class is counted TWICE — once closed-form, once by enumeration — so a mismatch names
 * the term rather than just the total.
 */
let bfA = 0;
let bfB = 0;
let bfC = 0;
let bfUnion = 0;
let bfWalks2 = 0;

for (const [a, ma] of out) {
  for (const [b, m1] of ma) {
    const mb = out.get(b);

    for (const [c, m2] of mb) {
      const n = m1 * m2;

      bfWalks2 += n;

      const inA = a === b;
      const inB = b === c;
      const inC = a === c;

      if (inA) {
        bfA += n;
      }

      if (inB) {
        bfB += n;
      }

      if (inC) {
        bfC += n;
      }

      if (inA || inB || inC) {
        bfUnion += n;
      }
    }
  }
}

console.log(
  `\nterm-by-term (closed form vs brute force):\n` +
    `  |A| a==b   ${String(loopThenAny).padStart(8)} vs ${String(bfA).padStart(8)}  ${loopThenAny === bfA ? 'ok' : 'MISMATCH'}\n` +
    `  |B| b==c   ${String(anyThenLoop).padStart(8)} vs ${String(bfB).padStart(8)}  ${anyThenLoop === bfB ? 'ok' : 'MISMATCH'}\n` +
    `  |C| a==c   ${String(returns2 + tripleLoop).padStart(8)} vs ${String(bfC).padStart(8)}  ${returns2 + tripleLoop === bfC ? 'ok' : 'MISMATCH'}\n` +
    `  union      ${String(bad2).padStart(8)} vs ${String(bfUnion).padStart(8)}  ${bad2 === bfUnion ? 'ok' : `MISMATCH (closed form off by ${String(bad2 - bfUnion)})`}`,
);
const q = (text) => [...query(g, text, {})][0].x;

const WALKS1 = q('MATCH (a:T)-[:E]->{1,1}(b:T) RETURN count(*) AS x');
const WALKS12 = q('MATCH (a:T)-[:E]->{1,2}(b:T) RETURN count(*) AS x');
const ACY1 = q('MATCH ACYCLIC (a:T)-[:E]->{1,1}(b:T) RETURN count(*) AS x');
const ACY12 = q('MATCH ACYCLIC (a:T)-[:E]->{1,2}(b:T) RETURN count(*) AS x');

const pred1 = WALKS1 - selfLoops;
const pred12 = WALKS12 - selfLoops - bad2;

console.log(
  `|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)} self-loops=${String(selfLoops)}`,
);
console.log(
  `violators: returns2=${String(returns2)} loopThenAny=${String(loopThenAny)} anyThenLoop=${String(anyThenLoop)} tripleLoop=${String(tripleLoop)} bad2=${String(bad2)}\n`,
);
console.log(`bound      engine    predicted   agree`);
console.log(
  `{1,1}   ${String(ACY1).padStart(9)} ${String(pred1).padStart(12)}   ${ACY1 === pred1 ? 'YES' : `NO  (off by ${String(ACY1 - pred1)})`}`,
);
console.log(
  `{1,2}   ${String(ACY12).padStart(9)} ${String(pred12).padStart(12)}   ${ACY12 === pred12 ? 'YES' : `NO  (off by ${String(ACY12 - pred12)})`}`,
);
console.log(
  `\n# walks{1,1}=${String(WALKS1)} walks{1,2}=${String(WALKS12)} — the rung counts these today and corrects for TRAIL the same way`,
);
