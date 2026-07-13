import {
  traversal,
  V,
  hasLabel,
  out,
  groupCount,
  group,
  by,
  count,
  pipe,
  label as labelStep,
  toArray,
} from '@lenke/gremlin';

import { g } from './util.ts';
const r1 = toArray(traversal(V(), groupCount().by(labelStep())), g);
console.log('groupCount by label:', r1, 'ctor:', r1[0]?.constructor?.name);
if (r1[0] instanceof Map) console.log('  as entries:', [...r1[0].entries()]);
const r2 = toArray(traversal(V(), out('CREATED'), groupCount().by('name')), g);
console.log('groupCount by name:', r2[0] instanceof Map ? [...r2[0].entries()] : r2);
const r3 = toArray(traversal(V(), hasLabel('SOFTWARE'), group().by('lang').by('name')), g);
console.log('group lang->name:', r3[0] instanceof Map ? [...r3[0].entries()] : r3);
const r4 = toArray(traversal(V(), hasLabel('SOFTWARE'), group().by('lang').by(pipe(count()))), g);
console.log('group lang->count():', r4[0] instanceof Map ? [...r4[0].entries()] : r4);
