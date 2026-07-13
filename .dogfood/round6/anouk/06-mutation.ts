import type { Graph } from '@lenke/core';
import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  addV,
  addE,
  property,
  drop,
  values,
  valueMap,
  count,
  properties,
  propertyMap,
  as_,
  select,
  from as _from, // maybe no 'from'
} from '@lenke/gremlin';
import { toArray } from '@lenke/gremlin';

import { createTestTinkerGraph, res, raw, label } from './util.ts';

console.log('\n===== MUTATION =====');

function fresh(): Graph {
  return createTestTinkerGraph();
}

// addV
{
  const g = fresh();
  toArray(traversal(addV('PERSON'), property('name', 'stephen'), property('age', 40)), g);
  label('addV then count PERSON', raw(traversal(V(), hasLabel('PERSON'), count()), g), [5]);
  label('new vertex readable', raw(traversal(V(), has('name', 'stephen'), values('age')), g), [40]);
}

// property() updates existing
{
  const g = fresh();
  toArray(traversal(V(), has('name', 'marko'), property('age', 30)), g);
  label(
    'property() updates marko age',
    raw(traversal(V(), has('name', 'marko'), values('age')), g),
    [30],
  );
}

// null-first-class: property(k, null) stores present null
{
  const g = fresh();
  toArray(traversal(V(), has('name', 'marko'), property('nickname', null)), g);
  label(
    'property(k,null) stored & readable as null',
    raw(traversal(V(), has('name', 'marko'), values('nickname')), g),
    [null],
  );
  label(
    'has(nickname) true after null set',
    raw(traversal(V(), has('name', 'marko'), has('nickname'), count()), g),
    [1],
  );
  label(
    'valueMap includes null nickname',
    raw(traversal(V(), has('name', 'marko'), valueMap('nickname')), g),
    [{ nickname: null }],
  );
}

// .properties(k).drop() removes the property (null-first-class idiom)
{
  const g = fresh();
  toArray(traversal(V(), has('name', 'marko'), properties('age'), drop()), g);
  label(
    'properties(age).drop() removes age (has false)',
    raw(traversal(V(), has('name', 'marko'), has('age'), count()), g),
    [0],
  );
  label(
    'values(age) empty after drop',
    raw(traversal(V(), has('name', 'marko'), values('age')), g),
    [],
  );
}

// drop() a vertex
{
  const g = fresh();
  toArray(traversal(V(), has('name', 'vadas'), drop()), g);
  label(
    'drop vertex vadas -> PERSON count 3',
    raw(traversal(V(), hasLabel('PERSON'), count()), g),
    [3],
  );
}

// addE between existing
{
  const g = fresh();
  // marko knows peter (new edge)
  toArray(
    traversal(
      V(),
      has('name', 'peter'),
      as_('p'),
      V(),
      has('name', 'marko'),
      addE('KNOWS').to('p'),
    ),
    g,
  );
  label(
    'addE marko->peter, marko out KNOWS count',
    raw(traversal(V(), has('name', 'marko'), out('KNOWS'), count()), g),
    [3],
  );
}
