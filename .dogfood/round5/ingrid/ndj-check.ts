import { deserialize } from '@lenke/serialization';
const g = deserialize(
  '{"type":"node","id":"a","labels":[],"properties":{}}\n{"type":"edge","from":"a","to":"ghost","labels":["E"],"properties":{}}',
  'ndjson',
);
console.log(
  'ghost auto-created?',
  !!g.getVertexById('ghost'),
  '(ndjson batch decode creates missing endpoints, no throw)',
);
