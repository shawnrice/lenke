import { run } from './src/executor.ts';
import { createTestTinkerGraph } from './src/fixtures/createTestTinkerGraph.ts';
import {
  Order,
  T,
  V,
  dedupe,
  groupCount,
  has,
  hasLabel,
  order,
  out,
  path,
  project,
  sample,
  select,
  tree,
  values,
} from './src/index.ts';
import { as_ } from './src/index.ts';
import { traversal } from './src/traversal.ts';

/*
 * Item 2485: the `by()` modulator family, checked against TinkerPop's SIGNATURE LIST rather than by
 * sentinel survival — the oracle item 2484 identified after a sentinel detector found none of the
 * three real dropped-argument bugs.
 *
 * `by` is not a standalone export here; it is a method on the seven byable builders (`order`,
 * `group`, `groupCount`, `project`, `select`, `path`, `tree`, `dedupe`, `sample`), so a missing form
 * is wide.
 *
 * THE FIXTURE IS THE MODERN GRAPH, chosen because each form's presence CHANGES the answer on it
 * (item 2483's lesson — an arm whose expected value coincides with the control's is not evidence):
 * TWO labels, DUPLICATE `lang` values (`java` twice), and four vertices MISSING `age`/`lang`
 * entirely. Every `TP` value below came from `gremlin-console:3.7.3` on this same graph.
 */
const g = createTestTinkerGraph();
const arr = (r: Iterable<unknown>): unknown[] => [...r];
/*
 * MAPS MUST BE SERIALIZED BY HAND. `group` and `groupCount` return a real `Map`, and
 * `JSON.stringify(new Map([['java', 2]]))` is **`{}`** — so the first run of this probe reported
 * `groupCount().by('lang')` as `[{}]` against TinkerPop's `[[java:2]]` and looked like a wrong
 * answer. It was the instrument: the Map held exactly `[["java", 2]]`. Fourth time this session that
 * a reading which was wrong for a case I already knew turned out to indict the probe rather than the
 * engine.
 */
const show = (x: unknown): string =>
  JSON.stringify(x, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v));

const rows: Array<[string, () => unknown, string]> = [
  [
    'B01 order.by()',
    () => traversal(V(), hasLabel('PERSON'), values('age'), order().by()),
    '[27,29,32,35]',
  ],
  [
    'B02 order.by(desc)',
    () => traversal(V(), hasLabel('PERSON'), values('age'), order().by(Order.desc)),
    '[35,32,29,27]',
  ],
  [
    'B03 order.by(age)',
    () => traversal(V(), hasLabel('PERSON'), order().by('age'), values('name')),
    '["vadas","marko","josh","peter"]',
  ],
  [
    'B04 order.by(age,desc)',
    () => traversal(V(), hasLabel('PERSON'), order().by('age', Order.desc), values('name')),
    '["peter","josh","marko","vadas"]',
  ],
  [
    'B05 order.by(trav)',
    () => traversal(V(), hasLabel('PERSON'), order().by(traversal(values('age'))), values('name')),
    '["vadas","marko","josh","peter"]',
  ],
  [
    'B06 order.by(trav,desc)',
    () =>
      traversal(
        V(),
        hasLabel('PERSON'),
        order().by(traversal(values('age')), Order.desc),
        values('name'),
      ),
    '["peter","josh","marko","vadas"]',
  ],
  [
    'B07 order.by(T.label)',
    () => traversal(V(), order().by(T.label), values('name')),
    '["marko","vadas","josh","peter","lop","ripple"]',
  ],
  ['B10 groupCount.by(lang)', () => traversal(V(), groupCount().by('lang')), '[{"java":2}]'],
  ['B11 dedupe.by(lang)', () => traversal(V(), dedupe().by('lang'), values('name')), '["lop"]'],
  [
    'B12 dedupe.by(T.label)',
    () => traversal(V(), dedupe().by(T.label), values('name')),
    '["marko","lop"]',
  ],
  [
    'B13 path.by(name)',
    () => traversal(V(), has('name', 'marko'), out(), path().by('name')),
    'path[marko,*]',
  ],
  [
    'B15 tree.by(name)',
    () => traversal(V(), has('name', 'marko'), out(), tree().by('name')),
    'marko->{vadas,josh,lop}',
  ],
  [
    'B16 project.by(trav)',
    () =>
      traversal(
        V(),
        has('name', 'marko'),
        project('n', 'a')
          .by(traversal(values('name')))
          .by(traversal(values('age'))),
      ),
    '{"n":"marko","a":29}',
  ],
  [
    'B17 select.by(name)',
    () =>
      traversal(V(), has('name', 'marko'), as_('x'), out(), as_('y'), select('x', 'y').by('name')),
    '{"x":"marko","y":*}',
  ],
  [
    'B18 sample.by(age)',
    () => traversal(V(), hasLabel('PERSON'), sample(2), values('name')),
    'TP: sample(2).by(age) -> 2 names',
  ],
];

let expressed = 0;
let rejected = 0;

for (const [label, build, tp] of rows) {
  let got: string;

  try {
    got = show(arr(run(build() as never, g)));
  } catch (e) {
    got = `CANNOT EXPRESS / THROWS: ${String((e as Error)?.message ?? e).slice(0, 48)}`;
    rejected += 1;
    console.log(`  ${label.padEnd(24)} ${got}`);
    continue;
  }

  expressed += 1;
  console.log(`  ${label.padEnd(24)} lenke=${got.slice(0, 54).padEnd(54)} TP=${tp.slice(0, 46)}`);
}

console.log(`\n  ${expressed} expressed, ${rejected} CANNOT EXPRESS, of ${rows.length}`);
