import {
  traversal,
  V,
  has,
  hasLabel,
  hasNot,
  out,
  in_,
  values,
  count,
  is,
  gt,
  gte,
  lt,
  lte,
  eq,
  neq,
  between,
  inside,
  outside,
  within,
  without,
  startsWith,
  endingWith,
  containing,
  notContaining,
  regex,
  not as pnot,
  choose,
  branch,
  constant,
  project,
  pipe,
  sum,
  mean,
  min,
  max,
  math,
  by,
  as_,
  select,
  where,
  dedupe,
  order,
  Order,
  T,
  local,
  fold,
  sample,
  tail,
  range,
  coalesce,
} from '@lenke/gremlin';

import { res, raw, label, g } from './util.ts';

console.log('\n===== PREDICATES =====');
label(
  'has(age, gt(30))',
  res(traversal(V(), hasLabel('PERSON'), has('age', gt(30)), values('name'))).sort(),
  ['josh', 'peter'],
);
label(
  'has(age, between(27,32))',
  res(traversal(V(), hasLabel('PERSON'), has('age', between(27, 32)), values('name'))).sort(),
  ['marko', 'vadas'],
); // [27,32) => 27,29
label(
  'has(age, within(27,35))',
  res(traversal(V(), hasLabel('PERSON'), has('age', within(27, 35)), values('name'))).sort(),
  ['peter', 'vadas'],
);
label(
  'has(age, without(27,35))',
  res(traversal(V(), hasLabel('PERSON'), has('age', without(27, 35)), values('name'))).sort(),
  ['josh', 'marko'],
);
label(
  'has(age, inside(27,35))',
  res(traversal(V(), hasLabel('PERSON'), has('age', inside(27, 35)), values('name'))).sort(),
  ['josh', 'marko'],
);
label(
  'has(age, outside(28,34))',
  res(traversal(V(), hasLabel('PERSON'), has('age', outside(28, 34)), values('name'))).sort(),
  ['peter', 'vadas'],
);
label(
  'has(name, startsWith("m"))',
  res(traversal(V(), has('name', startsWith('m')), values('name'))),
  ['marko'],
);
label(
  'has(name, containing("o"))',
  res(traversal(V(), has('name', containing('o')), values('name'))).sort(),
  ['josh', 'lop', 'marko'],
);
label('has(name, regex "^r")', res(traversal(V(), has('name', regex('^r')), values('name'))), [
  'ripple',
]);
label('hasNot(lang) persons', res(traversal(V(), hasNot('lang'), values('name'))).sort(), [
  'josh',
  'marko',
  'peter',
  'vadas',
]);
label(
  'has(age, not(gt(30)))',
  res(traversal(V(), hasLabel('PERSON'), has('age', pnot(gt(30))), values('name'))).sort(),
  ['marko', 'vadas'],
);

console.log('\n===== MATH =====');
// math on a projected value
label(
  'math("_ * 2") on age via by',
  raw(traversal(V(), has('name', 'marko'), values('age'), math('_ * 2'))),
  [58],
);
// math with as-bound operands
label(
  'math("a + b")',
  raw(
    traversal(
      V(),
      has('name', 'marko'),
      values('age'),
      as_('a'),
      constant(1),
      as_('b'),
      math('a + b'),
    ),
  ),
  undefined,
);

console.log('\n===== CHOOSE (option map) / BRANCH =====');
// choose with option map (choose(traversal).option(val, sub)...)
try {
  const r = res(
    traversal(
      V(),
      hasLabel('PERSON'),
      (choose as any)(pipe(values('age'), is(gt(30))))
        .option(true, constant('senior'))
        .option(false, constant('junior')),
    ),
  );
  label('choose(pred).option(true/false)', r, undefined);
} catch (e: any) {
  label('choose(pred).option threw', e.message, undefined);
}

// choose 3-arg by value token: choose(values(lang)) route by lang
try {
  const r = res(
    traversal(
      V(),
      hasLabel('SOFTWARE'),
      (choose as any)(values('lang'))
        .option('java', constant('JVM'))
        .option('rust', constant('native')),
    ),
  );
  label('choose(values(lang)).option(...)', r, undefined);
} catch (e: any) {
  label('choose(values).option threw', e.message, undefined);
}

// branch
try {
  const r = res(
    traversal(
      V(),
      hasLabel('PERSON'),
      (branch as any)(pipe(values('age'), is(gt(30))))
        .option(true, values('name'))
        .option(false, constant('young')),
    ),
  );
  label('branch(pred).option(...)', r, undefined);
} catch (e: any) {
  label('branch threw', e.message, undefined);
}

console.log('\n===== CARDINALITY =====');
label(
  'tail(2) of ordered persons',
  res(traversal(V(), hasLabel('PERSON'), order().by('age', Order.asc), tail(2), values('name'))),
  ['josh', 'peter'],
);
label(
  'range(1,3) of ordered persons',
  res(
    traversal(V(), hasLabel('PERSON'), order().by('age', Order.asc), range(1, 3), values('name')),
  ),
  ['marko', 'josh'],
);
