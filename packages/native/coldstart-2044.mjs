/*
 * Item 2044 — WHAT IS IN THE ~7-11 ms A FIRST QUERY COSTS?
 *
 * ⚠️ Item 2043 priced a WARM single call at 1.4-1.8x the hot-loop figure. This is the other end: a
 * FRESH process, one query ever. Across seven GQL shapes the hot per-op cost spans 96x (0.0055 to
 * 0.53 ms) while the single-call cost spans only 1.7x (6.8 to 11.4 ms) — so the cold cost is almost
 * entirely SHAPE-INDEPENDENT, and worth decomposing rather than attributing to any query.
 *
 * ⚠️ ONE PHASE PER PROCESS IS NOT POSSIBLE HERE — the phases are sequential by nature — so each is
 * timed in order and the LAST line reports them together. A second query is timed too, because the
 * gap between the first and second is the part caches and JIT remove.
 *
 *     bun coldstart-2044.mjs
 */
const t0 = performance.now();
const { Graph } = await import('@lenke/core');
const tCore = performance.now();
const { query } = await import('@lenke/gql');
const tGql = performance.now();

const g = new Graph();

for (let i = 0; i < 100; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 7 } });
}

const tBuild = performance.now();

// ⚠️ A TRIVIAL QUERY ON A TINY GRAPH, so execution is as close to zero as it can be and whatever is
// left is fixed cost.
const first = query(g, 'MATCH (n:P) RETURN count(*) AS c');
const tFirst = performance.now();
const second = query(g, 'MATCH (n:P) RETURN count(*) AS c');
const tSecond = performance.now();
// A DIFFERENT text, so the parse/plan cache misses but the engine is otherwise warm.
const third = query(g, 'MATCH (n:P) RETURN count(*) AS d');
const tThird = performance.now();

/*
 * ⚠️ A LONG, COMPLEX TEXT ON A WARM ENGINE, so the parse/plan claim rests on more than a trivial
 * query: if the first query's 5 ms were PARSE, this would be dearer still, since it is several times
 * the text and carries a WHERE, an ORDER BY and a LIMIT.
 */
const tBig0 = performance.now();
const big = query(
  g,
  'MATCH (n:P) WHERE n.k >= 0 AND n.k < 99 RETURN n.k AS k, count(*) AS c ORDER BY k DESC LIMIT 5',
);
const tBig = performance.now();

/*
 * 🔑 THE SAME TEXT AGAIN, WHICH IS THE ONLY WAY TO SEPARATE PARSE/PLAN FROM EXECUTION. The 2.2 ms
 * above is a cache MISS plus a harder query's execution; this run is a cache HIT on identical work,
 * so the DELTA is what parse+plan cost. My first reading of this probe claimed "parse/plan is
 * negligible" from the TRIVIAL query alone — too weak a basis, and the complex arm is what showed it.
 */
const bigAgain = query(
  g,
  'MATCH (n:P) WHERE n.k >= 0 AND n.k < 99 RETURN n.k AS k, count(*) AS c ORDER BY k DESC LIMIT 5',
);
const tBigAgain = performance.now();

if (bigAgain.length !== big.length) {
  throw new Error('the two runs of the complex text disagree');
}

if (Number(first[0].c) !== 100 || Number(second[0].c) !== 100 || Number(third[0].d) !== 100) {
  throw new Error('answers disagree — the phases below would be meaningless');
}

console.log(
  JSON.stringify({
    importCore: +(tCore - t0).toFixed(2),
    importGql: +(tGql - tCore).toFixed(2),
    build100: +(tBuild - tGql).toFixed(2),
    firstQuery: +(tFirst - tBuild).toFixed(2),
    sameTextAgain: +(tSecond - tFirst).toFixed(3),
    newTextWarm: +(tThird - tSecond).toFixed(3),
    bigNewTextWarm: +(tBig - tBig0).toFixed(3),
    bigSameTextAgain: +(tBigAgain - tBig).toFixed(3),
    bigRows: big.length,
  }),
);
