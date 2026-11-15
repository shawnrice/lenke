/**
 * DOES `ACYCLIC` REJECT A 1-EDGE SELF-LOOP AT EVERY BOUND? (item 2001)
 *
 * ⚠️⚠️ **THIS STARTED AS PERF WORK AND TURNED INTO A CORRECTNESS QUESTION.**
 * `acyclic-correction-2001.mjs` was proving the arithmetic for an ACYCLIC counting rung. Once its
 * inclusion-exclusion term was right (verified against brute force on six fixtures), the engine's
 * `{1,2}` answer was consistently **exactly `selfLoops` HIGHER** than "acyclic 1-paths + acyclic
 * 2-walks" — 29, 306, 208, 2, 7 and 1004 across the six, each equal to that fixture's self-loop
 * count. Working back, the engine appears to reject the 1-edge self-loop at `{1,1}` and NOT at
 * `{1,2}`.
 *
 * `CLOSED.md` states the `{1,1}` behaviour as settled and MEASURED: "On one node with one self-loop,
 * `MATCH ACYCLIC (x)-[:R]->+(y)` is **0** — a self-loop repeats a node — while TRAIL and WALK answer
 * 1". If `{1,2}` answers 1 for the same graph, the two bounds disagree about the same path.
 *
 * ⚠️⚠️ **THIS PROBE IS TYPESCRIPT-ONLY, AND ITS FIRST VERSION CLAIMED OTHERWISE.** It advertised
 * `LENKE_ENGINE=1` as routing the same text through the Rust engine over `bun:ffi`. It does not:
 * `LENKE_ENGINE` is read ONLY by `package.json`'s `test:engine` script, and `query` from
 * `@lenke/gql` never consults it — so the "Rust" run was TypeScript a second time and its identical
 * output proved nothing about the byte-identity invariant. **A `.mjs` probe cannot reach the Rust
 * engine at all**; that needs `conformance-harness.ts`'s `nativeBackend()`, which is TypeScript. The
 * cross-engine check for these shapes therefore lives in `src/acyclic-selfloop-parity.test.ts`,
 * where it is run by the suite rather than by hand.
 *
 *     bun acyclic-selfloop-2001.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/** One vertex, one self-loop — `CLOSED.md`'s own fixture for this question. */
const oneLoop = () => {
  const g = new Graph();
  const v = { id: 'a', labels: ['T'], properties: { n: 1 } };

  g.addVertex(v);
  g.addEdge({
    id: 'l',
    from: g.getVertexById('a'),
    to: g.getVertexById('a'),
    labels: ['E'],
    properties: {},
  });

  return g;
};

/** `a -> a` (loop) plus `a -> b`, so a 2-walk `a->a->b` exists and is non-acyclic via a==b. */
const loopPlusEdge = () => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { n: 2 } });
  g.addEdge({
    id: 'l',
    from: g.getVertexById('a'),
    to: g.getVertexById('a'),
    labels: ['E'],
    properties: {},
  });
  g.addEdge({
    id: 'e',
    from: g.getVertexById('a'),
    to: g.getVertexById('b'),
    labels: ['E'],
    properties: {},
  });

  return g;
};

const BOUNDS = ['{1,1}', '{1,2}', '{1,3}', '{2,2}', '+'];
const MODES = { WALK: 'MATCH', TRAIL: 'MATCH TRAIL', ACYCLIC: 'MATCH ACYCLIC' };

const ask = (g, mode, bound) => {
  const text = `${mode} (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`;

  try {
    return String([...query(g, text, {})][0].x);
  } catch (err) {
    return `ERR ${String(err.code ?? err.message ?? 'unknown').slice(0, 18)}`;
  }
};

for (const [fixName, make] of [
  ['one vertex, one self-loop', oneLoop],
  ['a->a loop plus a->b', loopPlusEdge],
]) {
  const g = make();

  console.log(
    `\n=== ${String(fixName)}  (|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)}) ===`,
  );
  console.log(`mode     ${BOUNDS.map((b) => b.padStart(9)).join('')}`);

  for (const [mn, mt] of Object.entries(MODES)) {
    console.log(`${mn.padEnd(8)} ${BOUNDS.map((b) => ask(g, mt, b).padStart(9)).join('')}`);
  }
}

console.log(
  `\n# engine: TypeScript ONLY — see the header; a .mjs probe cannot reach the Rust side\n` +
    `# ⚠️ ACYCLIC must be 0 at EVERY bound on the first fixture: the only path is a self-loop, which\n` +
    `#    repeats a node. A non-zero cell at a bound where another bound says 0 is the two bounds\n` +
    `#    disagreeing about one path.`,
);
