import { Graph } from '@lenke/core';
import { serialize, deserialize } from '@lenke/serialization';

const g = new Graph();
g.addVertex({
  labels: ['T'],
  properties: { dims: [1, null, 2], scalarNull: null, emptyList: [], oneNull: [null] },
});

for (const fmt of ['ndjson', 'pg-json', 'graphson', 'pg-text', 'csv'] as const) {
  const text = serialize(g, fmt as never);
  const g2 = deserialize(text as never, fmt as never, new Graph());
  const v2 = [...g2.vertices][0];
  console.log(
    fmt.padEnd(9),
    'dims=',
    JSON.stringify(v2.getProperty('dims')),
    'oneNull=',
    JSON.stringify(v2.getProperty('oneNull')),
    'scalarNull=',
    JSON.stringify(v2.getProperty('scalarNull')),
  );
}
