// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see above
import { compileLinear } from '../gql/src/executor.ts';
/**
 * WHICH SHAPES HAVE TWO WILLING RUNGS, and does the chain pick the better one? (item 1584)
 *
 * Item 1583 found `count(DISTINCT …)` over a hop accepted by BOTH `detectHopAggregate` and
 * `detectDistinctCount`, with `hopAggregate` listed first in `runLinear`'s lazy chain — so the
 * narrower, faster rung never ran, at up to 6.00x. Nothing about that was specific to those two
 * detectors: `runLinear` is a 19-branch lazy chain, every detector is an independent probe, and
 * ANY pair that overlaps is decided by listing order alone.
 *
 * So this enumerates the contention rather than waiting to trip over it again. For a corpus of
 * shapes it reports every one that more than one rung will answer, and names the rung the chain
 * actually picks (the earliest) against the ones it starves (the later ones).
 *
 * ⚠️ CONTENTION IS NOT BY ITSELF A DEFECT. Several pairs overlap deliberately and the earlier rung
 * is the right one — the chain's comments say so case by case, and item 418 measured that moving a
 * branch costs the shape it does not claim 1.12x. A later rung is a SUSPECT, to be timed, not a
 * bug. The output is a worklist.
 *
 *     bun rung-contention-probe.mjs              # every shape
 *     bun rung-contention-probe.mjs contended    # only the contended ones
 */
// WHY THE REACH-IN BELOW IS DELIBERATE. `parse` and `compileLinear` are INTERNAL planner entry
// points with no public export, and widening the package's API to satisfy a diagnostic would be the
// wrong trade. The probe also has to read SRC rather than dist, so it can be run while a rung
// change is being iterated on, which is before a build has happened.
//
// ⚠️ The directive has to be ONE line. Written across several, `eslint-disable-next-line` applies to
// the next COMMENT line instead of the import and the rule still fires.
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see above
import { parse } from '../gql/src/parser.ts';

/**
 * `runLinear`'s branch order, which is what DECIDES the route — the chain is lazy, so the earliest
 * willing rung answers.
 *
 * ⚠️ Kept in sync with `packages/gql/src/executor/clauses.ts` BY HAND, and asserted below against
 * `compileLinear`'s own field set so a rung added to one and not the other is a loud failure rather
 * than a silently mis-ordered report.
 */
const CHAIN = [
  'varLengthCount',
  'countShortcut',
  'optionalHopCount',
  'forCount',
  'forProjection',
  'optionalHopProjection',
  'groupCountShortcut',
  'groupHopShortcut',
  'reachShortcut',
  'hopProjection',
  'hopAggregate',
  'multiHopAggregate',
  'distinctProjection',
  'distinctCount',
  'nodeProjection',
  'nodeAggregate',
  'multiNodeAggregate',
  'groupedNodeAggregate',
  'groupedHopAggregate',
];

const QUERIES = [
  // --- node scans ---
  'MATCH (n:P) RETURN count(*) AS c',
  'MATCH (n:P) WHERE n.k > 4 RETURN count(*) AS c',
  'MATCH (n:P) RETURN n.k AS k',
  'MATCH (n:P) WHERE n.k > 4 RETURN n.k AS k',
  'MATCH (n:P) RETURN max(n.k) AS m',
  'MATCH (n:P) RETURN min(n.k) AS m',
  'MATCH (n:P) RETURN sum(n.k) AS s',
  'MATCH (n:P) RETURN count(*) AS c, max(n.k) AS m',
  'MATCH (n:P) RETURN count(DISTINCT n.k) AS c',
  'MATCH (n:P) RETURN count(DISTINCT n) AS c',
  'MATCH (n:P) RETURN DISTINCT n.k',
  'MATCH (n:P) RETURN DISTINCT n',
  'MATCH (n:P) RETURN n.k AS k, count(*) AS c GROUP BY n.k',
  'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k',
  'MATCH (n:P) RETURN n.k AS k, max(n.n) AS m GROUP BY n.k',
  'MATCH (n:P) RETURN count(*) AS c ORDER BY c',
  'MATCH (n:P) RETURN n.k AS k ORDER BY k LIMIT 10',
  // --- one hop ---
  'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
  'MATCH (a:P)-[:E]->(b) WHERE b.k > 4 RETURN count(*) AS c',
  'MATCH (a:P)-[:E]->(b) RETURN b.k AS k',
  'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m',
  'MATCH (a:P)-[:E]->(b) RETURN min(b.k) AS m',
  'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS s',
  'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c, max(b.k) AS m',
  'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
  'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
  'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k',
  'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b',
  'MATCH (a:P)-[:E]->(b) RETURN b.k AS k, count(*) AS c GROUP BY b.k',
  'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c GROUP BY b.k',
  'MATCH (a:P)-[:E]->(b) RETURN b.k AS k, max(b.n) AS m GROUP BY b.k',
  'MATCH (a:P)<-[:E]-(b) RETURN count(DISTINCT b.k) AS c',
  'MATCH (a:P)-[:E]->(b:Q) RETURN count(DISTINCT b.k) AS c',
  // --- optional ---
  'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c',
  'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k AS k',
  // --- two hops and variable length ---
  'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c',
  'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c.k) AS c',
  'MATCH (a:P)-[:E]->{1,2}(b) RETURN count(*) AS c',
  // --- FOR ---
  'FOR v IN [1, 2, 3] RETURN count(*) AS c',
  'FOR v IN [1, 2, 3] RETURN v AS v',
];

// The hand-kept CHAIN must name exactly the rung fields `compileLinear` produces.
{
  const probe = compileLinear(parse('MATCH (n:P) RETURN count(*) AS c').parts[0]);
  const fields = Object.keys(probe).filter((k) => k !== 'clauses' && k !== 'writes');
  const missing = fields.filter((f) => !CHAIN.includes(f));
  const extra = CHAIN.filter((c) => !fields.includes(c));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `CHAIN is out of sync with compileLinear — not in CHAIN: [${missing.join(', ')}], ` +
        `not a field: [${extra.join(', ')}]. Re-read runLinear in executor/clauses.ts.`,
    );
  }
}

const rungsOf = (q) => {
  const compiled = compileLinear(parse(q).parts[0]);

  return CHAIN.filter((name) => compiled[name] !== null && compiled[name] !== undefined);
};

const onlyContended = process.argv[2] === 'contended';
const contended = [];

for (const q of QUERIES) {
  let rungs;

  try {
    rungs = rungsOf(q);
  } catch (e) {
    console.log(`  !! ${q}\n     THREW ${e.message}`);
    continue;
  }

  if (rungs.length > 1) {
    contended.push({ q, rungs });
  }

  if (!onlyContended) {
    console.log(`${(rungs[0] ?? '— general path —').padEnd(22)} ${q}`);

    if (rungs.length > 1) {
      console.log(`${' '.repeat(22)}   starved: ${rungs.slice(1).join(', ')}`);
    }
  }
}

console.log(`\n${contended.length} contended shapes of ${QUERIES.length}:`);

// An object rather than a tuple: a mixed tuple is union-typed, so `q` reads as `string | string[]`
// and the template rejects it. Item 1581 hit the same thing with its question list.
for (const { q, rungs } of contended) {
  console.log(`  ${String(rungs[0])} WINS over ${rungs.slice(1).join(', ')}\n    ${q}`);
}
