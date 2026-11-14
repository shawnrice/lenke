/**
 * IS A FORK THE SAME QUESTION AS A REVERSED CHAIN? (item 1864)
 *
 * The fork's ROW shape has no rung and every projection rung requires `patterns.length === 1`, so
 * the obvious move is a new rung. There may be a better one: a fork is a chain with its first leg
 * reversed, and item 1844's `spliceChainedPatterns` already exists as the place to rewrite one
 * pattern shape into another.
 *
 *     MATCH (a)-[:E]->(b), (a)-[:E]->(c)      ==?     MATCH (b)<-[:E]-(a)-[:E]->(c)
 *
 * A rewrite would inherit TWENTY rungs instead of adding a twenty-first.
 *
 * ⚠️ BUT THE EQUIVALENCE TURNS ENTIRELY ON ONE CASE: may the two legs be the SAME EDGE? In the
 * comma form the patterns are independent, so an `a` with a single out-edge still matches once,
 * with `b` and `c` both bound to that edge's target — item 1863's test pins that diagonal
 * explicitly. In the single-path form the answer depends on the path MODE: `walk` admits a
 * repeated edge and `trail` does not, and this repo's memory records that the parser writes
 * `mode: 'trail'` on some shapes by default. If the chain spelling excludes the diagonal, the
 * rewrite is a WRONG ANSWER and the whole design is dead.
 *
 * ⚠️ SO THIS IS A CORRECTNESS EXPERIMENT RUN BEFORE ANY DESIGN, not a benchmark. It asks both
 * spellings on fixtures chosen to make the diagonal the WHOLE difference, and prints the answers
 * side by side. One disagreement is enough to settle it.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const countOf = (g, text) => {
  const [row] = query(g, text);

  return row === undefined ? '(no row)' : row.c;
};

/** A single edge: the ONLY fork match is the diagonal, so the two spellings cannot both be right. */
const oneEdge = () => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 'a' } });
  g.addVertex({ id: 'x', labels: ['T'], properties: { n: 'x' } });
  g.addEdge({
    id: 'e0',
    from: g.getVertexById('a'),
    to: g.getVertexById('x'),
    labels: ['E'],
  });

  return g;
};

/** Two out-edges: 4 fork matches, of which 2 are diagonal — so the gap is visible but not total. */
const twoEdges = () => {
  const g = oneEdge();

  g.addVertex({ id: 'y', labels: ['T'], properties: { n: 'y' } });
  g.addEdge({
    id: 'e1',
    from: g.getVertexById('a'),
    to: g.getVertexById('y'),
    labels: ['E'],
  });

  return g;
};

/** Three out-edges: 9 against 6, so a wrong formula cannot coincide by arithmetic accident. */
const threeEdges = () => {
  const g = twoEdges();

  g.addVertex({ id: 'z', labels: ['T'], properties: { n: 'z' } });
  g.addEdge({
    id: 'e2',
    from: g.getVertexById('a'),
    to: g.getVertexById('z'),
    labels: ['E'],
  });

  return g;
};

const FORK = 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS c';
const CHAIN = 'MATCH (b:T)<-[:E]-(a:T)-[:E]->(c:T) RETURN count(*) AS c';

console.log('fixture        fork   reversed-chain   agree?');
console.log('-----------------------------------------------');

for (const [name, build, expectFork] of [
  ['one edge', oneEdge, 1],
  ['two edges', twoEdges, 4],
  ['three edges', threeEdges, 9],
]) {
  const g = build();
  const f = countOf(g, FORK);
  const c = countOf(g, CHAIN);

  console.log(
    `${name.padEnd(14)} ${String(f).padStart(4)}   ${String(c).padStart(14)}   ${
      f === c ? 'yes' : '⚠️  NO'
    }${f === expectFork ? '' : `   ⚠️ fork expected ${String(expectFork)}`}`,
  );
}

console.log('');
console.log('The ROWS matter too, not just the count — a chain spelling that drops the diagonal');
console.log('returns FEWER rows, and one that reorders them is a different question again.');

const g = threeEdges();
const rowsOf = (text) =>
  JSON.stringify(
    query(g, text)
      .map((r) => `${String(r.x)}/${String(r.y)}`)
      .sort(),
  );

const forkRows = rowsOf('MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y');
const chainRows = rowsOf('MATCH (b:T)<-[:E]-(a:T)-[:E]->(c:T) RETURN b.n AS x, c.n AS y');

// ⚠️ THE FIRST VERSION OF THIS PRINTED `null/null` NINE TIMES and read as agreement. It projected
// `b.id`, and `id` is the ELEMENT id, not a property — so both sides emitted nulls and the
// comparison was vacuous. A column that is null everywhere cannot distinguish two routes.
if (forkRows.includes('null')) {
  throw new Error(`the projected column is null — this comparison would be vacuous: ${forkRows}`);
}

console.log(`  fork rows : ${forkRows}`);
console.log(`  chain rows: ${chainRows}`);
console.log(
  `  multisets ${forkRows === chainRows ? 'AGREE' : '⚠️  DIFFER'} (sorted; GQL row order is unspecified)`,
);
