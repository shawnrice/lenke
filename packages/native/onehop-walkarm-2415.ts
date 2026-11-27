/**
 * WHICH WALK ARM actually answers each of item 2414's four one-hop cells, and does it change when
 * the start label stops being vacuous?
 *
 * The claim this probe exists to stop me inferring: `rows` takes `farDrivenHopWalk` while a
 * modifier carrying an `ORDER BY` or a `SKIP` is forced onto `startDriven` by `hopOrderPlan`, and
 * the far-driven arm is reachable at all only because the fixture is label-homogeneous
 * (`startLabel === undefined || vacuousLabel(graph, startLabel)`).
 *
 * That is read off the source, and reading the source has been wrong twice in a row on this exact
 * file - item 2402's entry: *"Two items in a row located this blocker by argument; both were wrong,
 * and an ablation costs one build."* The same entry's closing instruction is literally this probe:
 * *"The next person to arrive at 'the deferred hop should ride the far-driven walk' should start by
 * instrumenting whether that walk is reached - one throw, one build."*
 *
 * It imports `../gql/src/index.ts` rather than `@lenke/gql`, so it reads SOURCE and the throw under test
 * needs no dist rebuild ([[fuzzers-read-built-dists]]).
 *
 *     ARM=far  bun onehop-walkarm-2415.ts     # with a throw in the far-driven dispatch
 *
 * An arm that THROWS took the instrumented walk; an arm that ANSWERS did not. Both label modes are
 * run in one process, which is fine here because this is a route question and not a timing one.
 */
import { Graph, type Vertex } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: a SOURCE import that avoids the build step, which is the whole point. This probe ablates hop-projection.ts by patching src; through `@lenke/gql` it would read dist and the patch would be invisible ([[fuzzers-read-built-dists]]).
import { query } from '../gql/src/index.ts';

const NODES = Number(process.env.NODES ?? 2000);

const build = (mixed: boolean): Graph => {
  const g = new Graph();

  // Kept in an array rather than looked up: `getVertexById` is `Vertex | null`, and a probe that
  // asserts the null away would hide a fixture that silently built no edges.
  const vs: Vertex[] = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let e = 0; e < NODES; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[e],
      to: vs[(e * 7 + 3) % NODES],
      labels: ['E'],
      properties: {},
    });
  }

  if (mixed) {
    // One ISOLATED off-label vertex - item 1943's design. No edges, so every ANSWER is unchanged.
    g.addVertex({ id: 'off', labels: ['Z'], properties: {} });
  }

  return g;
};

const P = 'MATCH (a:P)-[:E]->(x1:P)';

const SHAPES: Record<string, string> = {
  rows: `${P} RETURN x1.k AS k`,
  topk: `${P} RETURN x1.k AS k ORDER BY k LIMIT 10`,
  skiponly: `${P} RETURN x1.k AS k SKIP 5`,
  grouped: `${P} RETURN x1.k AS k, count(*) AS c`,
  collect: `${P} RETURN collect(x1.k) AS ks`,
  orderby: `${P} RETURN x1.k AS k ORDER BY k`,
  sum: `${P} RETURN sum(x1.k) AS s`,
  maxagg: `${P} RETURN max(x1.k) AS m`,
  distinct: `${P} RETURN DISTINCT x1.k AS k`,
  countdist: `${P} RETURN count(DISTINCT x1.k) AS c`,
};

for (const mixed of [false, true]) {
  console.log(`\n# ${mixed ? 'MIXED (one isolated off-label vertex)' : 'HOMOGENEOUS (vacuous)'}`);

  const g = build(mixed);

  for (const [name, src] of Object.entries(SHAPES)) {
    let verdict: string;

    try {
      const out = query(g, src, {});

      verdict = `answered (${String(out.length)} rows) - did NOT take the instrumented arm`;
    } catch (err) {
      verdict = `THREW - took the instrumented arm  [${(err as Error).message.slice(0, 60)}]`;
    }

    console.log(`  ${name.padEnd(10)} ${verdict}`);
  }
}
