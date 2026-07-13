// Pin down exactly which element breaks the CSV round-trip in the pipeline.
import { Graph } from '@lenke/core';
import { serialize, deserialize } from '@lenke/serialization';

// Rebuild a minimal graph: the product with null-in-list, plus a customer with
// a single-element tags list (to check CSV preserves singletons, unlike pg-text).
const g = new Graph();
g.addVertex({ id: 'p1', labels: ['Product'], properties: { dims: [10, null, 5], sku: 'SKU-1' } });
g.addVertex({ id: 'c2', labels: ['Customer'], properties: { tags: ['bronze'], vip: false } });

const back = deserialize(serialize(g, 'csv'), 'csv');
for (const id of ['p1', 'c2']) {
  const a = g.getVertexById(id)!.properties;
  const b = back.getVertexById(id)!.properties;
  const eq = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${id} equal=${eq}`);
  if (!eq) {
    console.log('  before:', JSON.stringify(a));
    console.log('  after :', JSON.stringify(b));
  }
}
