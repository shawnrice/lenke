/**
 * IS THE GQL FIXED-DEPTH HOP COUNT'S COST ITS ITERATION SUBSTRATE? Four bench rows sit at ~340-475 ms
 * (`count 3-hop`, `count 4-hop`, and their filtered variants), untouched by item 1676's cache, which
 * covers `{m,n}` quantified paths rather than a literal chain.
 *
 * ⚠️ THIS IS NOT THE LEVER ITEMS 1416 AND 1637 REFUTED, and the distinction is the whole reason this
 * probe exists. A profile of `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN
 * count(*)` puts **65.1% in `bucketSize`** and 11.7% in `side` — and `bucketSize`'s own doc comment
 * records that share as MISATTRIBUTION, proven by counting: exactly |V| + |E| calls, all on the O(1)
 * branch, so a per-vertex degree MEMO has nothing to save because no vertex's degree is read twice.
 * Item 1416 found it for `chain3`, item 1637 reproduced it for `count3`, and the note is parked on
 * the function where the next profile would send someone. This is the third arrival.
 *
 * The refuted lever is "read each degree once instead of many times". The lever here is "make each
 * single read cheaper": a `Map.get(label)?.size` plus a generator frame per edge, against two
 * `Int32Array` reads. Those are different claims, and the second has direct evidence — the gremlin
 * twin of this shape went 7x-10x at items 1678/1681 on exactly that substitution.
 *
 * Three arms, each asserted to produce the SAME count so an arm cannot read fast by doing less:
 *
 *   bucketPerEdge   the current shape: walk each level's Sets, `Map.get(t)?.size` per edge
 *   csrLevels       flat `off`/`len` arrays, the level recurrence over indices
 *   csrPlusBuild    the same, with the CSR BUILD inside the timed region — the cold-cache bound
 *
 * ⚠️ THE THIRD ARM IS THE ONE THAT DECIDES IT. A cached CSR makes repeated identical queries cheap,
 * but a hop count is often asked once per graph; `csrPlusBuild` is what a first call would pay, and
 * if that is not also a win then the lever only helps a repeat workload and must be sold as such.
 *
 *   node gql-hopcount-substrate-probe.mjs
 *   N=200000 FANOUT=5 DEPTH=3 node gql-hopcount-substrate-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const DEPTH = Number(process.env.DEPTH ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

let e = 0;

/**
 * ⚠️ A THIRD VARIANT OF THE FIXTURE TRAP, AND IT PASSES BOTH EXISTING CHECKS.
 *
 * This generator's first form used `to = (i * 7919 + r * 104729 + 13) % N`, which is LINEAR in `i`
 * and therefore a BIJECTION per layer — so every vertex ended up with in-degree exactly 3 while
 * out-degree varied 1..5. That passes item 1516/1518's distinct-endpoint check (not functional) AND
 * item 1677's distinct-out-degree check (five of them), and the 3-walk count was STILL exactly
 * `N * F^3` — 2,700,000 at 100,000 x 3, verified against a brute-force enumeration.
 *
 * The reason is that a 3-walk count is `sum over b of indeg(b) * sum over (b->c) of outdeg(c)`, so
 * the arithmetic collapses on the IN-degree distribution, not the out-degree. A check on
 * out-degrees cannot see it.
 *
 * The mix below is nonlinear in `i`: 14 distinct in-degrees, 4.9% of vertices with no in-edge
 * (realistic rather than degenerate), and a count that is not `N * F^k`. A quadratic form was tried
 * first and rejected the other way — it left 46% of vertices unreachable.
 */
for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[mix % N],
      labels: ['KNOWS'],
      properties: {},
    });
    e += 1;
  }
}

const order = [...g.verticesById.values()];

const Q = 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c';
const Q2 = 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c';
const Q4 =
  'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d)-[:KNOWS]->(x) RETURN count(*) AS c';
const BY_DEPTH = { 2: Q2, 3: Q, 4: Q4 };
const QD = BY_DEPTH[DEPTH] ?? Q;

/**
 * ⚠️ THE ONLY ARM THAT CANNOT BE A STRAWMAN, AND THE FIRST VERSION OF THIS PROBE DID NOT HAVE IT.
 *
 * `bucketPerEdge` below was written as "the current shape" and is nothing of the kind: it enumerates
 * every PATH, calling `.size` once per path at the last level, where the engine does LEVEL-WISE work
 * — item 1637 counted exactly |V| + |E| calls into `bucketSize` for this query, not one per path. So
 * the hand-rolled arm is 2.4x SLOWER than the route it stood in for (1043.7 ms against the engine's
 * 427.1), and every ratio measured against it was inflated.
 *
 * Timing the engine is the fix. It carries parse, plan and dispatch that the CSR arms do not, so it
 * is not a clean lower bound either — but it is the number a change would actually have to beat.
 */
const engineRoute = () => Number(query(g, QD)[0].c);

/** ⚠️ NOT the current shape — see `engineRoute`. Kept as the naive path enumeration it is. */
const bucketPerEdge = () => {
  let total = 0;

  for (const a of order) {
    const b0 = a.adjFrom?.get('KNOWS');

    if (b0 === undefined) {
      continue;
    }

    for (const e0 of b0) {
      const b = e0.to;

      if (DEPTH === 2) {
        total += b.adjFrom?.get('KNOWS')?.size ?? 0;
        continue;
      }

      const b1 = b.adjFrom?.get('KNOWS');

      if (b1 === undefined) {
        continue;
      }

      for (const e1 of b1) {
        const c = e1.to;

        if (DEPTH === 3) {
          total += c.adjFrom?.get('KNOWS')?.size ?? 0;
          continue;
        }

        const b2 = c.adjFrom?.get('KNOWS');

        if (b2 === undefined) {
          continue;
        }

        for (const e2 of b2) {
          total += e2.to.adjFrom?.get('KNOWS')?.size ?? 0;
        }
      }
    }
  }

  return total;
};

const buildCsr = () => {
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const len = new Int32Array(order.length);
  const nbr = new Int32Array(g.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;
    let d = 0;

    for (const edge of order[i].adjFrom?.get('KNOWS') ?? []) {
      nbr[at] = idx.get(edge.to) ?? 0;
      at += 1;
      d += 1;
    }

    len[i] = d;
  }

  off[order.length] = at;

  return { off, len, nbr };
};

const CSR = buildCsr();

/** Flat runs, indexed — the last level's degree IS `len[slot]`, so no lookup at all. */
const countOverCsr = ({ off, len, nbr }) => {
  let total = 0;

  for (let s = 0; s < order.length; s += 1) {
    for (let i = off[s]; i < off[s] + len[s]; i += 1) {
      const b = nbr[i];

      if (DEPTH === 2) {
        total += len[b];
        continue;
      }

      for (let j = off[b]; j < off[b] + len[b]; j += 1) {
        const c = nbr[j];

        if (DEPTH === 3) {
          total += len[c];
          continue;
        }

        for (let k = off[c]; k < off[c] + len[c]; k += 1) {
          total += len[nbr[k]];
        }
      }
    }
  }

  return total;
};

const csrLevels = () => countOverCsr(CSR);

/**
 * ⚠️ THE ARM THE FIRST SWEEP WAS MISSING, AND THE ONE THAT MATCHES THE ENGINE'S ASYMPTOTICS.
 *
 * `csrLevels` COUNTS PATHS, so it is O(E * F) where the engine's route is a DEGREE PRODUCT at
 * O(V + E). That is why its ratio decays with fanout — 23.80x at F=3, 13.94x at F=8, 7.28x at
 * F=15 — and why it would eventually LOSE. The decay is the arm's complexity, not the lever's.
 *
 * The engine computes, for a 3-hop `a->b->c->d`:
 *
 *     count = sum over b of  indeg(b) * sum over (b->c) of outdeg(c)
 *
 * paying a string-keyed `edgesFromByLabel.get(id)` for each of those degrees — one per VERTEX for
 * `indeg(b)` and one per EDGE for `outdeg(c)`. The same arithmetic over flat arrays replaces both
 * with an index read while keeping O(V + E), so its ratio should hold at any fanout.
 */
const degreeProductOverCsr = ({ off, len, nbr }, indeg) => {
  let total = 0;

  for (let b = 0; b < order.length; b += 1) {
    const ways = indeg[b];

    if (ways === 0) {
      continue;
    }

    let inner = 0;
    const end = off[b] + len[b];

    for (let i = off[b]; i < end; i += 1) {
      inner += len[nbr[i]];
    }

    total += ways * inner;
  }

  return total;
};

const buildIndeg = () => {
  const indeg = new Int32Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    for (let i = CSR.off[s]; i < CSR.off[s] + CSR.len[s]; i += 1) {
      indeg[CSR.nbr[i]] += 1;
    }
  }

  return indeg;
};

const INDEG = buildIndeg();

const csrDegreeProduct = () => degreeProductOverCsr(CSR, INDEG);
const csrDegProdPlusBuild = () => {
  const csr = buildCsr();
  const indeg = new Int32Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    for (let i = csr.off[s]; i < csr.off[s] + csr.len[s]; i += 1) {
      indeg[csr.nbr[i]] += 1;
    }
  }

  return degreeProductOverCsr(csr, indeg);
};
const csrPlusBuild = () => countOverCsr(buildCsr());

const ARMS =
  DEPTH === 3
    ? { engineRoute, csrLevels, csrPlusBuild, csrDegreeProduct, csrDegProdPlusBuild }
    : { engineRoute, bucketPerEdge, csrLevels, csrPlusBuild };

const expected = engineRoute();

for (const [name, fn] of Object.entries(ARMS)) {
  const got = fn();

  if (got !== expected) {
    throw new Error(`ARM ${name} COUNTED ${got}, EXPECTED ${expected} — not the same question`);
  }
}

{
  // ⚠️ THE IN-DEGREE SPREAD IS THE ONE A DEGREE PRODUCT COLLAPSES ON — see the generator note.
  const ind = new Int32Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    for (let i = CSR.off[s]; i < CSR.off[s] + CSR.len[s]; i += 1) {
      ind[CSR.nbr[i]] += 1;
    }
  }

  let isolated = 0;

  for (const d of ind) {
    if (d === 0) {
      isolated += 1;
    }
  }

  const distinctIn = new Set(ind).size;

  console.log(
    `fixture: ${new Set(CSR.len).size} distinct out-degrees, ${distinctIn} distinct in-degrees, ` +
      `${isolated} vertices with no in-edge`,
  );

  if (distinctIn < 3) {
    throw new Error(
      `FIXTURE IS IN-REGULAR (${distinctIn} distinct in-degrees): a 3-walk count is ` +
        `sum_b indeg(b) * sum_{b->c} outdeg(c), so it collapses to N*F^k by arithmetic and cannot ` +
        `validate the traversal`,
    );
  }

  if (expected === N * FANOUT ** DEPTH) {
    console.log(`⚠️ count is EXACTLY N*F^${DEPTH} — fixture still determined`);
  }
}

const timed = (fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return { median: warm[Math.floor(warm.length / 2)], series };
};

const names = Object.keys(ARMS);
const best = {};
const seriesOf = {};

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    const { median, series } = timed(ARMS[nm]);

    if (median < (best[nm] ?? Infinity)) {
      best[nm] = median;
      seriesOf[nm] = series;
    }
  }
}

console.log(
  `\nGQL HOP-COUNT SUBSTRATE — ${N}v / ${g.edgeCount}e, depth ${DEPTH}, count ${expected}\n`,
);
console.log('arm                   ms    vs engineRoute');

for (const nm of names) {
  console.log(
    `${nm.padEnd(16)} ${best[nm].toFixed(1).padStart(7)}  ${(best.engineRoute / best[nm]).toFixed(2).padStart(12)}x`,
  );
}

console.log('\nper-rep series:');

for (const nm of names) {
  console.log(`  ${nm.padEnd(16)} ${seriesOf[nm].map((x) => x.toFixed(0)).join(' ')}`);
}
