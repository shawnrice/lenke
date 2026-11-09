/**
 * WHAT IS `copyProps` COSTING `valueMap()`, AND DOES `Object.assign` BEAT ITS LOOP? (item 1736)
 *
 * Item 1735's windowed profile put `copyProps` at **42.0%** of `V().valueMap().count()` -- the
 * largest share on any real Gremlin step it measured, and unpriced.
 *
 * `copyProps`' no-keys arm is `for (const k of Object.keys(props)) out[k] = props[k]`: an array
 * allocation per element, plus one-at-a-time property addition into a fresh `{}`.
 *
 * ⚠️ A SPREAD IS NOT A CANDIDATE and the source says why: `out[k] = v` and `{ ...props }` differ for
 * the key `__proto__` (assignment sets the prototype, spread defines an own property), and that
 * behaviour is SETTLED in this repo (`prototype-key-class-not-a-bug`). `Object.assign` is a
 * candidate precisely because it does NOT have that problem -- it reads with [[Get]] and writes with
 * [[Set]], i.e. assignment semantics, the same as the loop -- while being one builtin call with no
 * `Object.keys` array.
 *
 * ⚠️ WIDTH IS A SWEEP, NOT A CONSTANT. A per-property cost scales with the bag width and a
 * per-element cost does not, so the arms are compared at three widths. The repo has drawn a wrong
 * conclusion from a single width before (CLAUDE.md's "match the fixture to the claim").
 *
 * The CONTROL shape (`V().count()`) never calls `copyProps` at all, so it must not move between
 * arms; if it does, the reading is the build or the machine and not the change.
 *
 *     ARM=base WIDTH=3 node valuemap-copy-probe.mjs
 */
import { Graph } from '@lenke/core';
import { count, toArray, traversal, V, valueMap, values } from '@lenke/gremlin';

const VERTS = Number(process.env.VERTS ?? 200_000);
const WIDTH = Number(process.env.WIDTH ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'base';
const SHAPE = process.env.SHAPE ?? 'valuemap';

const g = new Graph();

for (let i = 0; i < VERTS; i += 1) {
  const properties = {};

  for (let w = 0; w < WIDTH; w += 1) {
    properties[`p${w}`] = w % 2 === 0 ? i + w : `s${(i + w) % 1000}`;
  }

  g.addVertex({ id: `v${i}`, labels: ['P'], properties });
}

// Built ONCE, outside the measured loop: Gremlin has no parameter binding, so a plan built per rep
// would mix construction into the reading (item 1578).
const plans = {
  valuemap: traversal(V(), valueMap()),
  // ⚠️ `control` IS DEGENERATE -- KEPT ONLY SO THE RECORDED RUN IS REPRODUCIBLE. `V().count()` hits
  // the count shortcut and returns in 0.0 ms, so it cannot detect a build or machine drift between
  // arms, which is the entire job of a control. Item 1736 ran it before noticing. Use `values`.
  control: traversal(V(), count()),
  // The REAL control: it walks every vertex and reads a property, so it is sensitive to a bad build
  // and to machine noise, and it never reaches `copyProps`.
  values: traversal(V(), values('p0'), count()),
};

const plan = plans[SHAPE];

if (plan === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(plans).join(',')}`);
}

const series = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  const out = toArray(plan, g);

  series.push(performance.now() - t);
  // Touch the result so neither arm can be optimized away, and print it: the valueMap arm must
  // return one map per vertex, each with WIDTH keys.
  // ⚠️ PER-SHAPE, because a scalar-terminal shape has no keys to count. The first version applied
  // the map arithmetic to every shape, so the `values` control printed `answer: 0` -- a vacuous
  // assertion on the one row whose job is to be trustworthy. A shape that counts yields its count;
  // a shape that yields maps reports total keys copied.
  const [first] = out;

  answer =
    typeof first === 'object' && first !== null ? out.length * Object.keys(first).length : first;
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  JSON.stringify({
    arm: ARM,
    shape: SHAPE,
    width: WIDTH,
    verts: VERTS,
    answer,
    medianMs: Number(median.toFixed(1)),
    nsPerElem: Number(((median * 1e6) / VERTS).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
