/**
 * DOES THE CHAIN RUNG EMIT ROWS IN THE SAME ORDER AS THE GENERAL MATCHER? (item 1831)
 *
 * ⚠️ THIS IS THE BLOCKER, NOT A CURIOSITY. Item 1829 found the whole aggregate family losing its
 * route past one hop; item 1830 took the half that is ORDER-INVARIANT (`min`, `max`, `count`) and
 * left `sum`, `avg` and `collect` explicitly refused, because:
 *
 *   - `sum`/`avg` over f64 are order-sensitive IN THE LAST ULP, and byte-identity with the Rust
 *     engine is a hard invariant here, so a different summation order is a different answer;
 *   - `collect`'s ORDER IS ITS ANSWER.
 *
 * Items 419 and 551 settled this question for the ONE-HOP rung (`forceStartDriven`'s doc records
 * the measurement: the far-driven walk and the general path visit rows in different orders, so only
 * an order-independent aggregate may ride the far-driven one). **Nobody has asked it of the two-hop
 * or chain rungs.** Admitting `sum` without asking would be a wrong answer invisible to every
 * integer fixture.
 *
 * ⚠️ THE ORACLE IS A SPELLING VERIFIED TO DECLINE, not one assumed to (item 1827's lesson).
 * `compileLinear` was asked directly: `RETURN d.k AS k` fires `chainProjection`, and the same query
 * with `LIMIT 100000000` fires NOTHING — a limit larger than the row count returns every row in the
 * GENERAL path's order. So the two spellings are the same question down two different routes.
 *
 * ⚠️ AND IT CHECKS BOTH OF THE RUNG'S INTERNAL BRANCHES. `farEndOnly` picks a blocked SWEEP when the
 * projection and carried `WHERE` read only the far end, and a recursive WALK otherwise — two
 * different traversal orders inside one rung. A probe that only projected the far end would test
 * half of it and report a clean result for the other half.
 *
 * ⚠️ A MATCH PROVES NOTHING UNIVERSAL. One fixture agreeing says the orders agree THERE; it cannot
 * say they agree for every graph. A MISMATCH, though, settles it immediately — which is why this is
 * run across several fixture shapes before any conclusion is drawn either way.
 *
 *     bun chain-walk-order-probe.mjs
 *     NODES=5000 bun chain-walk-order-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 2_000);
const HUGE = 100_000_000;

/**
 * Several fixture SHAPES, because walk order is a property of the graph's structure. Fanout changes
 * how many edges a vertex contributes per level; the stride changes whether consecutive sources
 * reach consecutive targets; a label split changes which vertices seed the walk at all.
 */
const FIXTURES = {
  'fanout 1, sequential': { fanout: 1, stride: (i, _h, n) => (i + 1) % n, labelEvery: 1 },
  'fanout 1, scattered': { fanout: 1, stride: (i, _h, n) => (i * 7919) % n, labelEvery: 1 },
  'fanout 3, scattered': {
    fanout: 3,
    stride: (i, h, n) => (i * 7 + 3 + h * 2_654_435_761) % n,
    labelEvery: 1,
  },
  'fanout 3, half-labelled': {
    fanout: 3,
    stride: (i, h, n) => (i * 7 + 3 + h * 2_654_435_761) % n,
    labelEvery: 2,
  },
  'fanout 5, dense': {
    fanout: 5,
    stride: (i, h, n) => (i * 13 + h * 977) % n,
    labelEvery: 1,
  },
};

const build = ({ fanout, stride, labelEvery }) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    // ⚠️ A SPLIT LABEL SET matters: `L` seeds the walk, `M` does not. With every vertex labelled the
    // same, "which vertices seed" and "every vertex" are indistinguishable.
    const labels = i % labelEvery === 0 ? ['L', 'M'] : ['M'];

    g.addVertex({ id: `v${i}`, labels, properties: { k: i % 97, s: `s${i % 7}`, n: i } });
  }

  let e = 0;

  for (let h = 0; h < fanout; h += 1) {
    for (let i = 0; i < NODES; i += 1) {
      const from = g.getVertexById(`v${i}`);
      const to = g.getVertexById(`v${stride(i, h, NODES)}`);

      if (from === null || to === null) {
        throw new Error('fixture is broken: a vertex is missing after insertion');
      }

      g.addEdge({ id: `e${e}`, from, to, labels: ['R'] });
      e += 1;
    }
  }

  return g;
};

/** Each case is one question; `rung` takes a rung and `general` is the verified-declining twin. */
const CASES = {
  'hop2 far-end only (SWEEP)': {
    rung: 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M) RETURN c.k AS k',
    general: `MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M) RETURN c.k AS k LIMIT ${HUGE}`,
  },
  'hop2 reads the START (WALK)': {
    rung: 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M) RETURN a.k AS a, c.k AS k',
    general: `MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M) RETURN a.k AS a, c.k AS k LIMIT ${HUGE}`,
  },
  'hop3 far-end only (SWEEP)': {
    rung: 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) RETURN d.k AS k',
    general: `MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) RETURN d.k AS k LIMIT ${HUGE}`,
  },
  'hop3 reads the START (WALK)': {
    rung: 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) RETURN a.k AS a, d.k AS k',
    general: `MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) RETURN a.k AS a, d.k AS k LIMIT ${HUGE}`,
  },
  'hop3 with a far WHERE': {
    rung: 'MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) WHERE d.k > 40 RETURN d.k AS k',
    general: `MATCH (a:L)-[:R]->(b:M)-[:R]->(c:M)-[:R]->(d:M) WHERE d.k > 40 RETURN d.k AS k LIMIT ${HUGE}`,
  },
};

const render = (rows) => rows.map((r) => JSON.stringify(r));

console.log(`# chain-walk-order-probe NODES=${NODES}`);
console.log(
  '# "same order" = the two routes emit an IDENTICAL row SEQUENCE, not merely the same set\n',
);

let anyMismatch = false;

for (const [fixName, spec] of Object.entries(FIXTURES)) {
  const g = build(spec);

  console.log(`## ${fixName}  (vertices=${g.vertexCount} edges=${g.edgeCount})`);

  for (const [caseName, { rung, general }] of Object.entries(CASES)) {
    const a = render(query(g, rung));
    const b = render(query(g, general));

    if (a.length === 0 || b.length === 0) {
      console.log(
        `   ${caseName.padEnd(28)} ⚠️ VACUOUS — ${a.length}/${b.length} rows, proves nothing`,
      );
      continue;
    }

    if (a.length !== b.length) {
      anyMismatch = true;
      console.log(`   ${caseName.padEnd(28)} ⚠️ DIFFERENT ROW COUNTS ${a.length} vs ${b.length}`);
      continue;
    }

    let first = -1;

    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        first = i;
        break;
      }
    }

    // ⚠️ The multiset check separates "different ORDER" from "different ROWS" — only the first is
    // the question here, and the second would be a far worse finding.
    const sameSet =
      [...a].sort((x, y) => x.localeCompare(y)).join('|') ===
      [...b].sort((x, y) => x.localeCompare(y)).join('|');

    if (first === -1) {
      console.log(`   ${caseName.padEnd(28)} same order (${a.length} rows)`);
    } else {
      anyMismatch = true;
      console.log(
        `   ${caseName.padEnd(28)} ⚠️ ORDER DIFFERS at row ${first} ` +
          `(${a[first]} vs ${b[first]}), same multiset: ${sameSet}`,
      );
    }
  }

  console.log('');
}

console.log(
  anyMismatch
    ? '# VERDICT: the orders DIFFER. sum/avg/collect must NOT ride these rungs.'
    : '# VERDICT: no mismatch found on these fixtures. That is evidence, NOT a proof — see the header.',
);
