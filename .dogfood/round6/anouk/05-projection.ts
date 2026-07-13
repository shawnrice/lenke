import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  in_,
  outE,
  inV,
  values,
  valueMap,
  elementMap,
  propertyMap,
  project,
  select,
  as_,
  by,
  where,
  count,
  fold,
  path,
  match,
  pipe,
  id,
  label as labelStep,
  Order,
  order,
  T,
  local,
  constant,
} from '@lenke/gremlin';

import { res, raw, label, g } from './util.ts';

console.log('\n===== PROJECTION / SELECT =====');

// valueMap
label('valueMap() on marko', raw(traversal(V(), has('name', 'marko'), valueMap())), [
  { name: 'marko', age: 29 },
]);
label('valueMap(name) on marko', raw(traversal(V(), has('name', 'marko'), valueMap('name'))), [
  { name: 'marko' },
]);

// elementMap includes id + label
label(
  'elementMap() on marko (raw)',
  raw(traversal(V(), has('name', 'marko'), elementMap())),
  undefined,
);

// propertyMap
label(
  'propertyMap() on marko (raw)',
  raw(traversal(V(), has('name', 'marko'), propertyMap())),
  undefined,
);

// project array-arg form (correct usage)
label(
  'project([a,b]).by(name).by(out(created).count())',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      project(['a', 'b'])
        .by('name')
        .by(pipe(out('CREATED'), count())),
    ),
  ),
  [{ a: 'marko', b: 1 }],
);

// project with a BARE STRING (known char-split bug per charter) -- record
label(
  'project("ab").by(...) [known char-split]',
  raw(traversal(V(), has('name', 'marko'), (project as any)('ab').by('name').by('name'))),
  undefined,
);

// select multi-label with by
label(
  'as(a).out.as(b).select(a,b).by(name)',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      as_('a'),
      out('KNOWS'),
      as_('b'),
      select('a', 'b').by('name'),
    ),
  ),
  [
    { a: 'marko', b: 'vadas' },
    { a: 'marko', b: 'josh' },
  ],
);

// select single label
label(
  'select single a',
  res(traversal(V(), has('name', 'marko'), as_('a'), out('KNOWS'), select('a'), values('name'))),
  ['marko', 'marko'],
);

// match()
label(
  'match(as a out created as b)',
  res(
    traversal(V(), match(pipe(as_('a'), out('CREATED'), as_('b'))), select('a', 'b').by('name')),
  ).sort((x: any, y: any) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  undefined,
);

// valueMap with by-order on multiple
label(
  'order.by(name).valueMap(name)',
  raw(traversal(V(), hasLabel('SOFTWARE'), order().by('name', Order.asc), valueMap('name'))),
  [{ name: 'lop' }, { name: 'ripple' }],
);
