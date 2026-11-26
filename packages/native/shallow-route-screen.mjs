/**
 * WHICH SHALLOW SHAPES REACH NO RUNG AT ALL? (item 1854)
 *
 * ITEM 1853 IS WHY THIS EXISTS. Five consecutive items hunted modifier cliffs on the DEEP rungs
 * (two hops, three, the OPTIONAL hop) and found six. The seventh was a multi-column `DISTINCT`
 * over a plain node scan — **depth ZERO**, 27.7x its own one-column spelling — and none of those
 * screens could see it, because they all started at a hop. The shallowest shapes are also the
 * commonest, so a gap there costs the most and hides the best.
 *
 * IT SCREENS BY *ROUTE*, NOT BY TIME, and that is the point rather than a shortcut. A rung gap
 * IS the absence of a rung: there is no hot frame to profile and no anomalous cell to notice,
 * because the general matcher answers correctly and merely slowly. `compileLinear` can be asked
 * directly which detectors claim a shape, so a query that reaches NOTHING is the signal. Timing
 * then prices the ones worth pricing — in that order, because a route check costs milliseconds and
 * a timing sweep costs minutes.
 *
 * DECLINING IS NOT AUTOMATICALLY A DEFECT, and the output says so per row rather than leaving
 * the reader to assume. Several shapes decline for recorded reasons: a window over a DISTINCT
 * (item 1853 — the dedupe and the window would be applied in the wrong order), an order-SENSITIVE
 * fold over a chain (sum/collect — byte-identity with the Rust engine), an `ACYCLIC` var-length
 * walk (it diverges from set reachability). Those are listed as KNOWN so a real find stands out.
 *
 * ITS FIRST RUN FOUND FIVE UNEXPLAINED DECLINES AND ALL FIVE WERE BENIGN — the bare `LIMIT`
 * with no `ORDER BY`, across every base. That is the screen's own caveat earning itself on the
 * first use: a route difference is not always a cost difference (item 1850). The general path
 * streams and stops at the limit, so it is already the right answer and a rung could only match
 * it. The row is now in `KNOWN` with its numbers, so the next run does not re-derive it.
 *
 *     bun shallow-route-screen.mjs
 */
import { execFileSync } from 'node:child_process';

const ROOT = '/home/shawn/projects/pl-graph';

/** Each base shape, and the modifiers layered onto it. */
const BASES = {
  // THE SECOND BASE WAS A DUPLICATE OF THE FIRST in this file's first version — both
  // `MATCH (n:T)` — so 25 of its 125 cells measured the same shapes twice and the coverage was
  // overstated by a fifth. An UNLABELLED scan is a genuinely different seed (no label bucket to
  // start from), which is what that row was meant to be.
  'node scan': { match: 'MATCH (n:T)', v: 'n' },
  'node scan, unlabelled': { match: 'MATCH (n)', v: 'n' },
  'one hop': { match: 'MATCH (a:T)-[:E]->(b:T)', v: 'b' },
  'one hop in': { match: 'MATCH (a:T)<-[:E]-(b:T)', v: 'b' },
  'one hop union': { match: 'MATCH (a:T)-[:E|F]->(b:T)', v: 'b' },
};

/** `@far` is the far (or only) variable of the base. A plain token, not `${…}`: the lint
 * gate rightly reads that as a template literal written by mistake inside a normal string. */
const MODIFIERS = {
  'plain 1col': 'RETURN @far.n AS x',
  'plain 2col': 'RETURN @far.n AS x, @far.k AS y',
  'distinct 1col': 'RETURN DISTINCT @far.n AS x',
  'distinct 2col': 'RETURN DISTINCT @far.n AS x, @far.k AS y',
  'distinct 3col': 'RETURN DISTINCT @far.n AS x, @far.k AS y, @far.s AS z',
  'order 1col': 'RETURN @far.n AS x ORDER BY x',
  'order 2col': 'RETURN @far.n AS x, @far.k AS y ORDER BY x, y',
  'order + limit': 'RETURN @far.n AS x ORDER BY x LIMIT 10',
  'order + skip': 'RETURN @far.n AS x ORDER BY x SKIP 5',
  'limit only': 'RETURN @far.n AS x LIMIT 10',
  'skip only': 'RETURN @far.n AS x SKIP 5',
  'distinct + order': 'RETURN DISTINCT @far.n AS x ORDER BY x',
  'distinct2 + order': 'RETURN DISTINCT @far.n AS x, @far.k AS y ORDER BY x',
  'distinct + limit': 'RETURN DISTINCT @far.n AS x LIMIT 10',
  count: 'RETURN count(*) AS c',
  'count distinct': 'RETURN count(DISTINCT @far) AS c',
  'min/max': 'RETURN max(@far.n) AS m',
  sum: 'RETURN sum(@far.n) AS m',
  collect: 'RETURN collect(@far.n) AS m',
  'two aggs': 'RETURN sum(@far.n) AS m, count(*) AS c',
  grouped: 'RETURN @far.n AS k, count(*) AS c',
  'grouped max': 'RETURN @far.n AS k, max(@far.k) AS m',
  'grouped + order': 'RETURN @far.n AS k, count(*) AS c ORDER BY k',
  'expr column': 'RETURN @far.n + 1 AS x',
  'element column': 'RETURN @far AS x',
};

/**
 * Shapes that decline for a RECORDED reason. Keyed `base|modifier`; the value is the reason, which
 * is printed so a reader does not have to take the exclusion on trust.
 */
const KNOWN = {
  sum: 'order-SENSITIVE fold (f64 summation order); byte-identity — items 1830/1831',
  collect: 'order IS the answer — items 1830/1831',
  'two aggs': 'includes sum — same order-sensitivity',
  'distinct2 + order': 'window/sort over a multi-column DISTINCT — item 1853, recorded open',
  'distinct + limit': 'window over a DISTINCT — dedupe and window order — item 1853',
  'limit only':
    'BENIGN, measured at item 1854: the general path STREAMS and stops at the limit, so ' +
    'declining costs nothing — 0.22 ms against 6.41 for the whole scan, and 0.36 against 43.76 ' +
    'over a hop. A rung here could not beat stopping early.',
};

const routesOf = (texts) => {
  const src = `
import { compileLinear } from './src/executor/rewrites.ts';
import { parse } from './src/parser.ts';
const out = {};
for (const t of ${JSON.stringify(texts)}) {
  try {
    const cl = compileLinear(parse(t).parts[0]);
    out[t] = Object.entries(cl).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
  } catch (e) {
    out[t] = ['ERR:' + String(e.message).slice(0, 40)];
  }
}
process.stdout.write(JSON.stringify(out));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: `${ROOT}/packages/gql`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

const texts = [];
const index = [];

for (const [bname, base] of Object.entries(BASES)) {
  for (const [mname, tail] of Object.entries(MODIFIERS)) {
    const text = `${base.match} ${tail.replaceAll('@far', base.v)}`;

    texts.push(text);
    index.push([bname, mname, text]);
  }
}

const routes = routesOf(texts);

console.log('# shallow-route-screen — a shape reaching NO rung is the signal\n');
console.log(
  `# ${texts.length} shapes: ${Object.keys(BASES).length} bases x ${Object.keys(MODIFIERS).length} modifiers\n`,
);

const unclaimed = [];

for (const [bname, mname, text] of index) {
  const r = routes[text];

  if (r.length === 0) {
    unclaimed.push([bname, mname, text]);
  }
}

if (unclaimed.length === 0) {
  console.log('every shape reaches a rung');
} else {
  console.log(`${unclaimed.length} shape(s) reach NO rung:\n`);

  for (const [bname, mname, text] of unclaimed) {
    const why = KNOWN[mname];

    console.log(`  ${why === undefined ? 'UNEXPLAINED' : 'known        '}  ${bname} / ${mname}`);
    console.log(`      ${text}`);

    if (why !== undefined) {
      console.log(`      reason: ${why}`);
    }
  }

  const news = unclaimed.filter(([, m]) => KNOWN[m] === undefined);

  console.log(
    `\n# ${news.length} UNEXPLAINED. Each is a candidate, not yet a finding — price it against ` +
      'its own base before believing it (a route difference is not always a cost difference, ' +
      'item 1850).',
  );
}
