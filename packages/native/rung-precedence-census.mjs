// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see below
import { compileLinear } from '../gql/src/executor/rewrites.ts';
/**
 * WHICH RUNG ANSWERS EACH SHAPE, AND WHICH WILLING RUNGS ARE STARVED? (item 1775)
 *
 * Item 1583 found a rung that was WRITTEN, CORRECT AND WILLING and never ran, because a broader
 * rung sat ahead of it in `runLinear`'s chain: `hopAggregate` took every `count(DISTINCT …)` over a
 * hop and `distinctCount` never fired. Worth **up to 6.00x**, and decided by nothing but listing
 * order. It was found by hand, on one query family, after a cross-surface probe flagged a 52x ratio.
 *
 * There are now TWENTY rungs. Nothing has ever enumerated the precedence decisions between them, so
 * item 1583's instance is the one that happened to be noticed — not the only one. This census is the
 * general form of that diagnostic.
 *
 * ## Why `compileLinear` is a sound oracle for this, and timing is not
 *
 * `compileLinear` runs EVERY detector and returns the set (`rewrites.ts`, "EVERY detector RUNS —
 * this is twenty independent compile-time probes, not a ladder"). Precedence lives in exactly one
 * place: `runLinear`'s lazy `if (linear.<rung>)` chain in `executor/clauses.ts`. The returned
 * literal's FIELD ORDER is kept identical to that chain deliberately, and the chain is lazy —
 * therefore:
 *
 *     the FIRST non-null field, in declaration order, is the rung that FIRES
 *     every LATER non-null field is a rung that was WILLING and did not run
 *
 * ⚠️ THAT IDENTITY IS AN ASSUMPTION ABOUT TWO FILES AGREEING, so this probe ASSERTS IT rather than
 * trusting it: `CHAIN` below is transcribed from `runLinear` and checked against the key order
 * `compileLinear` actually returns. If someone reorders one file and not the other, this probe fails
 * loudly instead of reporting a confident census of the wrong order. That is the whole reason the
 * two files are kept in sync, and `rewrites.ts` records that they once drifted in their first five
 * entries while matching in the last fourteen.
 *
 * ⚠️ AND A STARVED RUNG IS A CANDIDATE, NOT A FINDING. A broader rung firing first may genuinely be
 * the better route — item 418 measured a branch moved ahead of a hot dispatch costing the shape it
 * does not claim 1.12x, and `rewrites.ts` says each position is for correctness, for cost, or only
 * for reading. What this probe produces is the LIST OF PRECEDENCE DECISIONS THAT ARE LOAD-BEARING,
 * each of which then needs item 1583's treatment: gate the broader rung off at compile time, A/B the
 * shape, keep a control the change cannot reach. The probe's value is that the list was previously
 * unknown, not that its rows are wins.
 *
 * ## Reading the output
 *
 *   FIRES        the rung that answers the shape (— GENERAL PATH — if none is willing)
 *   STARVED      willing rungs below it in the chain, in chain order
 *   pairs table   each (fires, starved) pair and how many corpus shapes exhibit it — the
 *                 candidate list, most-covered first
 */
// WHY THE REACH-IN ABOVE IS DELIBERATE, copied from `hop-distinct-route-probe.mjs`: `parse` and
// `compileLinear` are INTERNAL planner entry points with no public export, and widening the
// package's API to satisfy a diagnostic would be the wrong trade. The probe also has to read SRC
// rather than dist, because its job is to answer "which rung would answer this" while a rung change
// is being iterated on, which is before a build has happened.
//
// ⚠️ The directive has to be ONE line. Written across several, `eslint-disable-next-line` applies to
// the next COMMENT line instead of the import and the rule still fires.
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see above
import { parse } from '../gql/src/parser.ts';

/**
 * `runLinear`'s precedence chain, transcribed from `executor/clauses.ts` in order. Checked against
 * `compileLinear`'s returned key order below — this is the probe's load-bearing assumption and it is
 * asserted, not assumed.
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
  'hop2Projection',
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

const NON_RUNG = new Set(['clauses', 'writes']);

/**
 * The corpus. Spread across the dimensions the twenty detectors actually discriminate on — pattern
 * depth (node / 1-hop / 2-hop / var-length), tail kind (count / count(DISTINCT) / projection /
 * aggregate / DISTINCT rows), grouping, OPTIONAL, a WHERE, a page, and which END a tail reads.
 *
 * ⚠️ These are SHAPES, not a benchmark: `compileLinear` is purely syntactic and touches no graph, so
 * no fixture is needed and no fixture defect can bias the census. What a shape must do is PARSE —
 * and a shape that fails to parse is reported rather than skipped, because a silently dropped row
 * would understate the census exactly where the grammar is least familiar.
 */
const SHAPES = [
  // --- node only -------------------------------------------------------------
  ['node.count', 'MATCH (n:P) RETURN count(*) AS c'],
  ['node.countprop', 'MATCH (n:P) RETURN count(n.k) AS c'],
  ['node.distinctcount', 'MATCH (n:P) RETURN count(DISTINCT n) AS c'],
  ['node.distinctcountprop', 'MATCH (n:P) RETURN count(DISTINCT n.k) AS c'],
  ['node.proj', 'MATCH (n:P) RETURN n.k'],
  ['node.proj2', 'MATCH (n:P) RETURN n.k, n.n'],
  ['node.projelem', 'MATCH (n:P) RETURN n'],
  ['node.sum', 'MATCH (n:P) RETURN sum(n.k) AS s'],
  ['node.minmax', 'MATCH (n:P) RETURN min(n.k) AS a, max(n.k) AS b'],
  ['node.avg', 'MATCH (n:P) RETURN avg(n.k) AS s'],
  ['node.distinctrows', 'MATCH (n:P) RETURN DISTINCT n.k'],
  ['node.where.count', 'MATCH (n:P) WHERE n.k > 5 RETURN count(*) AS c'],
  ['node.where.proj', 'MATCH (n:P) WHERE n.k > 5 RETURN n.k'],
  ['node.inline.count', 'MATCH (n:P {k: 5}) RETURN count(*) AS c'],
  ['node.inline.proj', 'MATCH (n:P {k: 5}) RETURN n.k'],
  ['node.group', 'MATCH (n:P) RETURN n.k AS g, count(*) AS c'],
  ['node.group.sum', 'MATCH (n:P) RETURN n.k AS g, sum(n.n) AS s'],
  ['node.order.limit', 'MATCH (n:P) RETURN n.k ORDER BY n.k LIMIT 10'],
  ['node.limit', 'MATCH (n:P) RETURN n.k LIMIT 10'],
  ['node.nolabel.count', 'MATCH (n) RETURN count(*) AS c'],

  // --- one hop ---------------------------------------------------------------
  ['hop.count', 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c'],
  ['hop.countprop', 'MATCH (a:P)-[:E]->(b) RETURN count(b.k) AS c'],
  ['hop.distinctcount.far', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c'],
  ['hop.distinctcount.farprop', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c'],
  ['hop.distinctcount.start', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c'],
  ['hop.distinctcount.startprop', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a.k) AS c'],
  ['hop.proj.far', 'MATCH (a:P)-[:E]->(b) RETURN b.k'],
  ['hop.proj.start', 'MATCH (a:P)-[:E]->(b) RETURN a.k'],
  ['hop.proj.both', 'MATCH (a:P)-[:E]->(b) RETURN a.k, b.k'],
  ['hop.proj.elem', 'MATCH (a:P)-[:E]->(b) RETURN b'],
  ['hop.sum.far', 'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS s'],
  ['hop.sum.start', 'MATCH (a:P)-[:E]->(b) RETURN sum(a.k) AS s'],
  ['hop.minmax.far', 'MATCH (a:P)-[:E]->(b) RETURN min(b.k) AS a, max(b.k) AS z'],
  ['hop.distinctrows.far', 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k'],
  ['hop.distinctrows.elem', 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b'],
  ['hop.where.start.count', 'MATCH (a:P)-[:E]->(b) WHERE a.k > 5 RETURN count(*) AS c'],
  ['hop.where.far.count', 'MATCH (a:P)-[:E]->(b) WHERE b.k > 5 RETURN count(*) AS c'],
  ['hop.where.cross.count', 'MATCH (a:P)-[:E]->(b) WHERE a.k > b.k RETURN count(*) AS c'],
  ['hop.where.far.proj', 'MATCH (a:P)-[:E]->(b) WHERE b.k > 5 RETURN b.k'],
  ['hop.inline.start.count', 'MATCH (a:P {k: 5})-[:E]->(b) RETURN count(*) AS c'],
  ['hop.inline.far.count', 'MATCH (a:P)-[:E]->(b:Q {k: 5}) RETURN count(*) AS c'],
  ['hop.labelled.far.count', 'MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c'],
  // ⚠️ `->`, NOT `-->`. The abbreviated edge pattern was first written here as `-->`, which is
  // CYPHER, not ISO-GQL — CLAUDE.md's standing warning, arriving as a parse failure. ISO-GQL
  // spells an untyped edge `->` or `-[]->`, and both route identically to the typed form.
  ['hop.abbrev.count', 'MATCH (a:P)->(b) RETURN count(*) AS c'],
  ['hop.emptybracket.count', 'MATCH (a:P)-[]->(b) RETURN count(*) AS c'],
  ['hop.in.count', 'MATCH (a:P)<-[:E]->(b) RETURN count(*) AS c'],
  ['hop.group.far', 'MATCH (a:P)-[:E]->(b) RETURN b.k AS g, count(*) AS c'],
  ['hop.group.start', 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c'],
  ['hop.group.sum.crossend', 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, sum(b.k) AS s'],
  // ⚠️ THESE TWO EXIST BECAUSE THEIR ABSENCE FAKED A STARVATION. Without them
  // `groupedHopAggregate` was willing only on the grouped-COUNT shapes, where the count-specific
  // `groupHopShortcut` correctly beats it, so the census reported it as "willing somewhere but
  // ALWAYS starved" — item 1583's exact signature, and wrong. Its own shape is the key and the
  // aggregate on the SAME end; the cross-end spelling above reaches nothing at all.
  ['hop.group.sum.sameend', 'MATCH (a:P)-[:E]->(b) RETURN b.k AS g, sum(b.n) AS s'],
  ['hop.group.max.sameend', 'MATCH (a:P)-[:E]->(b) RETURN b.k AS g, max(b.n) AS z'],
  ['hop.order.limit', 'MATCH (a:P)-[:E]->(b) RETURN b.k ORDER BY b.k LIMIT 10'],
  ['hop.limit', 'MATCH (a:P)-[:E]->(b) RETURN b.k LIMIT 10'],
  ['hop.edgevar.count', 'MATCH (a:P)-[r:E]->(b) RETURN count(*) AS c'],
  ['hop.edgeprop.proj', 'MATCH (a:P)-[r:E]->(b) RETURN r.w'],

  // --- optional --------------------------------------------------------------
  ['opt.count', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  ['opt.countfar', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(b) AS c'],
  ['opt.proj', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k'],
  ['opt.projboth', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k, b.k'],
  ['opt.sum', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN sum(b.k) AS s'],
  ['opt.distinctcount', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(DISTINCT b) AS c'],
  ['opt.group', 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c'],

  // --- two hops --------------------------------------------------------------
  ['hop2.count', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c'],
  ['hop2.proj.end', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN c.k'],
  ['hop2.proj.mid', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN b.k'],
  ['hop2.sum.end', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN sum(c.k) AS s'],
  ['hop2.distinctcount', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c) AS c'],
  ['hop2.distinctrows', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.k'],
  ['hop2.where.end', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE c.k > 5 RETURN count(*) AS c'],
  ['hop2.group.end', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN c.k AS g, count(*) AS n'],
  ['hop3.count', 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS n'],

  // --- variable length -------------------------------------------------------
  ['varlen.count', 'MATCH (a:P)-[:E]->{1,3}(b) RETURN count(*) AS c'],
  ['varlen.count12', 'MATCH (a:P)-[:E]->{1,2}(b) RETURN count(*) AS c'],
  ['varlen.proj', 'MATCH (a:P)-[:E]->{1,3}(b) RETURN b.k'],
  ['varlen.distinctcount', 'MATCH (a:P)-[:E]->{1,3}(b) RETURN count(DISTINCT b) AS c'],
  ['varlen.where.count', 'MATCH (a:P)-[:E]->{1,3}(b) WHERE b.k > 5 RETURN count(*) AS c'],

  // --- two separate MATCH clauses (the fused-anchor shape) -------------------
  ['two.count', 'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  ['two.proj', 'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN b.k'],
  ['two.sum', 'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN sum(b.k) AS s'],
  ['two.distinctcount', 'MATCH (a:P) MATCH (a)-[:E]->(b) RETURN count(DISTINCT b) AS c'],

  // --- LET / FILTER, the clause shapes the rewrites fold away ----------------
  ['let.sum', 'MATCH (a:P)-[:E]->(b) LET v = b.k RETURN sum(v) AS s'],
  ['let.count', 'MATCH (a:P)-[:E]->(b) LET v = b.k RETURN count(v) AS c'],
  ['filter.count', 'MATCH (a:P)-[:E]->(b) FILTER b.k > 5 RETURN count(*) AS c'],
  ['filter.node.count', 'MATCH (n:P) FILTER n.k > 5 RETURN count(*) AS c'],
];

const shapesOf = (q) => {
  const stmt = parse(q);
  const [part] = stmt.parts;

  return compileLinear(part);
};

// ---------------------------------------------------------------------------
// The load-bearing assertion: `compileLinear`'s key order IS `runLinear`'s chain order.
// ---------------------------------------------------------------------------
const probeKeys = Object.keys(shapesOf(SHAPES[0][1])).filter((k) => !NON_RUNG.has(k));

if (probeKeys.length !== CHAIN.length || probeKeys.some((k, i) => k !== CHAIN[i])) {
  console.error('⚠️  compileLinear key order does NOT match the transcribed runLinear chain.');
  console.error('    compileLinear:', probeKeys.join(', '));
  console.error('    CHAIN:        ', CHAIN.join(', '));
  console.error('');
  console.error('    Every FIRES/STARVED reading below would be against the wrong order, so this');
  console.error('    probe refuses to report. Re-transcribe CHAIN from runLinear in clauses.ts.');
  process.exit(1);
}

const rows = [];
const failed = [];

for (const [name, q] of SHAPES) {
  let c;

  try {
    c = shapesOf(q);
  } catch (err) {
    failed.push([name, q, String(err?.message ?? err)]);
    continue;
  }

  const willing = CHAIN.filter((k) => c[k] !== null && c[k] !== undefined);

  rows.push({ name, q, fires: willing[0] ?? null, starved: willing.slice(1) });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const W = Math.max(...rows.map((r) => r.name.length), 10);

console.log(`\n=== ${rows.length} shapes, ${CHAIN.length} rungs ===\n`);

for (const r of rows) {
  const fires = r.fires ?? '— GENERAL PATH —';
  const tail = r.starved.length > 0 ? `   STARVED: ${r.starved.join(', ')}` : '';

  console.log(`${r.name.padEnd(W)}  ${fires.padEnd(22)}${tail}`);
}

const contested = rows.filter((r) => r.starved.length > 0);
const general = rows.filter((r) => r.fires === null);

console.log(`\n=== summary ===`);
console.log(`  shapes with a willing rung      ${rows.length - general.length}/${rows.length}`);
console.log(`  shapes on the GENERAL PATH      ${general.length}`);
console.log(`  shapes with a CONTESTED choice  ${contested.length}  (>=2 willing rungs)`);

// Each (fires, starved) pair is one precedence decision. Ranked by how many shapes it covers,
// because a pair covering many shapes is a decision that was never deliberately made for most of
// them. ⚠️ A pair is a CANDIDATE: the broader rung firing first may be correct. See the header.
const pairs = new Map();

for (const r of contested) {
  for (const s of r.starved) {
    const key = `${r.fires}  >  ${s}`;

    if (!pairs.has(key)) {
      pairs.set(key, []);
    }

    pairs.get(key).push(r.name);
  }
}

console.log(`\n=== precedence decisions, most-covered first (${pairs.size} distinct pairs) ===`);
console.log(`    "A  >  B" = A fires, B was willing and starved\n`);

for (const [key, names] of [...pairs.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(names.length).padStart(2)}x  ${key.padEnd(48)} ${names.join(' ')}`);
}

// Rungs that NEVER fire anywhere in the corpus are the strongest signal available here: either the
// corpus misses their shape, or they are unreachable in practice the way `distinctCount` was.
const firedEver = new Set(rows.map((r) => r.fires).filter(Boolean));
const starvedEver = new Set(contested.flatMap((r) => r.starved));
const never = CHAIN.filter((k) => !firedEver.has(k));

console.log(`\n=== rungs that NEVER fire on this corpus (${never.length}/${CHAIN.length}) ===`);

// ⚠️ "WILLING SOMEWHERE BUT NEVER FIRES" IS AMBIGUOUS, and reading it as starvation is a mistake
// this census made on its own first run. It means one of two things, and they need opposite work:
//
//   STARVED      a broader rung precedes it on every shape it claims    -> item 1583's gate
//   CORPUS GAP   its own shape is simply not in SHAPES, and the shapes   -> add the shape
//                where it IS willing are ones a narrower rung should win
//
// `groupedHopAggregate` printed the first and was the second: `groupHopShortcut` is count-specific
// and correctly beats it, while its own shape (key and aggregate on the SAME end) was missing.
// So the line says which reading needs ruling out rather than asserting either.
for (const k of never) {
  console.log(
    `  ${k.padEnd(24)} ${
      starvedEver.has(k)
        ? '⚠️  willing somewhere, never fires — STARVED or a CORPUS GAP, rule out the gap first'
        : 'no corpus shape reaches it'
    }`,
  );
}

if (failed.length > 0) {
  console.log(`\n=== ${failed.length} shapes FAILED TO PARSE (reported, not skipped) ===`);

  for (const [name, q, msg] of failed) {
    console.log(`  ${name.padEnd(W)}  ${msg}`);
    console.log(`  ${' '.repeat(W)}  ${q}`);
  }
}

console.log('');
