import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  values,
  repeat,
  count,
  branch,
  label as labelStep,
  constant,
  choose,
  is,
  gt,
  pipe,
  path,
} from '@lenke/gremlin';

import { res, raw, label } from './util.ts';

console.log('\n===== until() POST-PLACEMENT (do-while) DIVERGENCE =====');
// TinkerPop: repeat(body).until(cond) is do-while: body runs AT LEAST once,
// THEN cond is checked. When the START already satisfies cond, TinkerPop still
// runs the body once. lenke checks cond BEFORE the body (while-do), so it emits
// the start unmoved.

// marko IS a PERSON. Post-form should run out('KNOWS') once -> {vadas, josh}
// (both PERSON, satisfy until) -> emit them. TinkerPop = [vadas, josh].
label(
  'V(marko).repeat(out KNOWS).until(hasLabel PERSON)  [TP: vadas,josh]',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      repeat(out('KNOWS')).until(hasLabel('PERSON')),
      values('name'),
    ),
  ).sort(),
  ['josh', 'vadas'],
);

// times(1) equivalent for reference (1 body pass)
label(
  '  ...compare repeat(out KNOWS).times(1)',
  res(traversal(V(), has('name', 'marko'), repeat(out('KNOWS')).times(1), values('name'))).sort(),
  ['josh', 'vadas'],
);

console.log('\n===== BRANCH (correct routing form) =====');
// branch(label()).option('PERSON', values(name)).option('SOFTWARE', values(lang))
label(
  'branch(label).option(PERSON->name, SOFTWARE->lang)',
  res(
    traversal(
      V(),
      (branch as any)(labelStep())
        .option('PERSON', values('name'))
        .option('SOFTWARE', values('lang')),
    ),
  ).sort(),
  ['java', 'java', 'josh', 'marko', 'peter', 'vadas'],
);

console.log('\n===== CHOOSE with traversal-as-test (ternary) =====');
// choose(out(CREATED), constant('creator'), constant('noncreator')) over persons
label(
  'choose(out CREATED, creator, noncreator)',
  res(
    traversal(
      V(),
      hasLabel('PERSON'),
      choose(out('CREATED'), constant('creator'), constant('noncreator')),
    ),
  ),
  ['creator', 'noncreator', 'creator', 'creator'],
); // marko,vadas,josh,peter
