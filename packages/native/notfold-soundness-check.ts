/**
 * Is `not(hasNot(k))` really NOT equivalent to `hasKey(k)` once the stream stops carrying
 * ELEMENTS? Item 1331 wants to fold the first into the second, worth a measured 17x; this decides
 * whether that fold needs a gate or can be unconditional.
 *
 * `hasKey` is `keys.some(k => k in bag)` and `hasNot` is `keys.every(k => !(k in bag))`, so on
 * elements they are exact duals at ANY key count. But `hasNot` returns false for a non-element,
 * so `not(hasNot(k))` PASSES what `hasKey(k)` would filter. That is the whole soundness question
 * and it is checked here rather than reasoned about, because the fold is a wrong answer if it
 * holds and the gate is dead weight if it does not.
 */
import { Graph } from '@lenke/core';
import {
  count,
  hasKey,
  hasLabel,
  hasNot,
  not,
  or,
  properties,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const graph = new Graph();

graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, other: 'x' } });
graph.addVertex({ id: 'b', labels: ['P'], properties: { other: 'y' } });

const run2 = (label: string, make: () => unknown): void => {
  show(label, make);
};

const show = (label: string, make: () => unknown): void => {
  try {
    console.log(`  ${label.padEnd(46)} ${JSON.stringify(make())}`);
  } catch (e) {
    console.log(`  ${label.padEnd(46)} THREW ${(e as Error).message.slice(0, 70)}`);
  }
};

console.log('ELEMENT stream — these MUST agree, and the fold relies on it:');
show('V().hasKey(k).count()', () => toArray(traversal(V(), hasKey('k'), count()), graph));
show('V().not(hasNot(k)).count()', () =>
  toArray(traversal(V(), not(traversal(hasNot('k'))), count()), graph),
);

console.log('\nPROPERTY-OBJECT stream — the suspect:');
show('V().properties().hasKey(k).count()', () =>
  toArray(traversal(V(), properties(), hasKey('k'), count()), graph),
);
show('V().properties().not(hasNot(k)).count()', () =>
  toArray(traversal(V(), properties(), not(traversal(hasNot('k'))), count()), graph),
);

console.log('\nOR-OF-ANY-OF folds (item 1332) — does `or` need the element gate too?');
console.log("  `not` INVERTS, so a non-element's false became a pass. `or` does not, so both");
console.log('  spellings should agree even off an element stream. Measured, not assumed:');
run2('V().hasLabel(P,Q).count()', () =>
  toArray(traversal(V(), hasLabel('P', 'Q'), count()), graph),
);
run2('V().or(hasLabel(P),hasLabel(Q)).count()', () =>
  toArray(traversal(V(), or(traversal(hasLabel('P')), traversal(hasLabel('Q'))), count()), graph),
);
run2('V().properties().hasLabel(P,Q).count()', () =>
  toArray(traversal(V(), properties(), hasLabel('P', 'Q'), count()), graph),
);
run2('V().properties().or(hasLabel..).count()', () =>
  toArray(
    traversal(V(), properties(), or(traversal(hasLabel('P')), traversal(hasLabel('Q'))), count()),
    graph,
  ),
);
run2('V().values(other).hasKey(k,other).count()', () =>
  toArray(traversal(V(), values('other'), hasKey('k', 'other'), count()), graph),
);
run2('V().values(other).or(hasKey(k),hasKey(other))', () =>
  toArray(
    traversal(
      V(),
      values('other'),
      or(traversal(hasKey('k')), traversal(hasKey('other'))),
      count(),
    ),
    graph,
  ),
);

console.log('\nSCALAR stream:');
show('V().values(other).hasKey(k).count()', () =>
  toArray(traversal(V(), values('other'), hasKey('k'), count()), graph),
);
show('V().values(other).not(hasNot(k)).count()', () =>
  toArray(traversal(V(), values('other'), not(traversal(hasNot('k'))), count()), graph),
);
