import {
  createTestTinkerGraph,
  run,
  toArray,
  traversal,
  V,
  has,
  out,
  values,
  gt,
} from '@lenke/gremlin';
const g = createTestTinkerGraph();
console.log(
  'created-by-30+:',
  toArray(traversal(V(), has('age', gt(30)), out('CREATED'), values('name')), g),
);
