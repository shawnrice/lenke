// Same malformed condition (edge references a vertex id not in the doc) across
// all whole-graph batch decoders. Are they consistent?
import { Graph } from '@lenke/core';
import { deserialize, decodeNodes, decodeEdges } from '@lenke/serialization';
const probe = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ${label.padEnd(9)} SILENT (created phantom endpoint)`);
  } catch (e) {
    console.log(`  ${label.padEnd(9)} THROW  code=${(e as any).code}`);
  }
};
probe('pg-json', () =>
  deserialize(
    '{"nodes":[{"id":"a","labels":[],"properties":{}}],"edges":[{"from":"a","to":"ghost","labels":["E"],"properties":{}}]}',
    'pg-json',
  ),
);
probe('ndjson', () =>
  deserialize(
    '{"type":"node","id":"a","labels":[],"properties":{}}\n{"type":"edge","from":"a","to":"ghost","labels":["E"],"properties":{}}',
    'ndjson',
  ),
);
probe('graphson', () =>
  deserialize(
    '{"vertices":[{"@value":{"id":"a","label":"N","properties":{}}}],"edges":[{"@value":{"id":"e","label":"E","outV":"a","inV":"ghost","properties":{}}}]}',
    'graphson',
  ),
);
probe('csv', () => {
  const g = new Graph();
  decodeNodes('id,:LABEL\na,N', g);
  decodeEdges('id,:START_ID,:END_ID,:TYPE\ne,a,ghost,E', g);
});
