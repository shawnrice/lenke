/**
 * WHAT DOES A HOST LAMBDA STEP COST? `filter(fn)` / `map(fn)` against their declarative twins.
 *
 * ⚠️ THE FIRST GENUINELY UNCOVERED SHAPE IN THE GREMLIN SURFACE (item 1668). A coverage screen over
 * all 104 step kinds found 30 with no probe in `packages/native`; cross-checking those against
 * CLOSED.md showed most were measured elsewhere (`simplePath` at items 1464-1466) or are niche
 * (`sack`, `subgraph`, the OLAP trio). Five were neither: `filterFn`, `mapFn`, `flatMapFn`,
 * `foldFn`, `sideEffectFn` — the host-lambda family, which is the escape hatch a user reaches for
 * when no declarative step fits, and which has never been priced.
 *
 * The mechanism to look for: a lambda is an opaque call per traverser. The declarative twin can be
 * fused, specialized or routed to a shortcut rung; a lambda cannot. So the question is not whether
 * the lambda is slower — it must be — but whether the gap is the CALL (a constant, tens of ns) or
 * the LOST ROUTE (a different complexity class, because the whole pipeline falls off its rungs).
 * Those have very different consequences for a user, and only a measurement separates them.
 *
 * Arms, each pair computing the SAME answer and asserted equal before any time is read:
 *
 *   hasDecl / filterLambda    a property equality, declarative vs `filter(v => ...)`
 *   valuesDecl / mapLambda    a property read, `values(k)` vs `map(v => ...)`
 *   countDecl / countLambda   the same under a `count()`, where the declarative side has a rung
 */
import { Graph } from '@lenke/core';
import { count, filter, has, map, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } });
}

const ARMS = {
  // A property read over every vertex.
  valuesDecl: () => toArray(traversal(V(), values('k')), g).length,
  mapLambda: () =>
    toArray(
      traversal(
        V(),
        map((v) => v.properties.k),
      ),
      g,
    ).length,

  // A filter keeping ~1/97 of the vertices — declarative `has` against a host lambda.
  // ⚠️ The first version of this probe named the LAMBDA arm `filterDecl` and had no declarative
  // twin at all, so its 27.59 ns was compared against nothing.
  hasDecl: () => toArray(traversal(V(), has('k', 5)), g).length,
  filterLambda: () =>
    toArray(
      traversal(
        V(),
        filter((v) => v.properties.k === 5),
      ),
      g,
    ).length,

  // The same under a count(), where the declarative side has a shortcut rung and the lambda cannot.
  countDecl: () => toArray(traversal(V(), has('k', 5), count()), g)[0],
  countLambda: () =>
    toArray(
      traversal(
        V(),
        filter((v) => v.properties.k === 5),
        count(),
      ),
      g,
    )[0],
};

const answers = {};

for (const [name, fn] of Object.entries(ARMS)) {
  answers[name] = fn();
}

for (const [a, b] of [
  ['valuesDecl', 'mapLambda'],
  ['hasDecl', 'filterLambda'],
  ['countDecl', 'countLambda'],
]) {
  if (answers[a] !== answers[b]) {
    throw new Error(
      `${a}/${b} are not an equivalent pair: ${JSON.stringify(answers)} — the ratio would be meaningless`,
    );
  }
}

const timed = (fn) => {
  for (let i = 0; i < 3; i += 1) {
    fn();
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();

    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const names = Object.keys(ARMS);
const best = {};

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    best[nm] = Math.min(best[nm] ?? Infinity, timed(ARMS[nm]));
  }
}

console.log(`\nHOST LAMBDA STEPS — N=${N}, ${REPS} reps, 3 order-alternated rounds\n`);
console.log('arm              ms      ns/vertex   answer');

for (const nm of names) {
  console.log(
    `${nm.padEnd(16)} ${best[nm].toFixed(2).padStart(6)}  ${((best[nm] * 1e6) / N).toFixed(2).padStart(9)}   ${answers[nm]}`,
  );
}

console.log('\nlambda vs declarative, same answer:');

for (const [a, b] of [
  ['valuesDecl', 'mapLambda'],
  ['hasDecl', 'filterLambda'],
  ['countDecl', 'countLambda'],
]) {
  console.log(`  ${b} / ${a} = ${(best[b] / best[a]).toFixed(2)}x`);
}

console.log('\nA few ns is the CALL. Much more is the LOST ROUTE — the pipeline off its rungs.');
