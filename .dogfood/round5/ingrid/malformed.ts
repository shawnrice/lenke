// Feed deliberately malformed input to each codec and record the error quality.
import { Graph } from '@lenke/core';
import { deserialize, decodeEdges, decodeNodes, type FormatName } from '@lenke/serialization';

const attempt = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  [NO THROW] ${label}  <-- accepted silently`);
  } catch (e) {
    const err = e as any;
    console.log(`  [throw] ${label}`);
    console.log(`      code=${err.code ?? '(none)'}  msg=${err.message}`);
  }
};

console.log('=== pg-json ===');
attempt('truncated JSON', () => deserialize('{"nodes":[{"id":"a"', 'pg-json'));
attempt('valid JSON wrong shape', () => deserialize('{"foo":1}', 'pg-json'));
attempt('node missing labels', () =>
  deserialize('{"nodes":[{"id":"a","properties":{}}]}', 'pg-json'),
);
attempt('edge to missing vertex', () =>
  deserialize(
    '{"nodes":[{"id":"a","labels":[],"properties":{}}],"edges":[{"from":"a","to":"zzz","labels":["E"],"properties":{}}]}',
    'pg-json',
  ),
);
attempt('properties is array not object', () =>
  deserialize('{"nodes":[{"id":"a","labels":[],"properties":[]}]}', 'pg-json'),
);

console.log('\n=== ndjson ===');
attempt('truncated line', () => deserialize('{"type":"vertex","id":"a"', 'ndjson'));
attempt('bad type tag', () => deserialize('{"type":"banana","id":"a"}', 'ndjson'));
attempt('missing type field', () => deserialize('{"id":"a","labels":[]}', 'ndjson'));
attempt('edge missing endpoint', () =>
  deserialize(
    '{"type":"vertex","id":"a","labels":[],"properties":{}}\n{"type":"edge","from":"a","to":"nope","labels":["E"],"properties":{}}',
    'ndjson',
  ),
);

console.log('\n=== graphson ===');
attempt('truncated JSON', () => deserialize('{"vertices":[', 'graphson'));
attempt('vertices not array', () => deserialize('{"vertices":{}}', 'graphson'));
attempt('bad @type tag', () =>
  deserialize(
    '{"vertices":[{"@value":{"id":"a","label":"T","properties":{"p":[{"@type":"g:VertexProperty","@value":{"value":{"@type":"g:Nonsense","@value":1},"label":"p"}}]}}}]}',
    'graphson',
  ),
);
attempt('temporal @value not string', () =>
  deserialize(
    '{"vertices":[{"@value":{"id":"a","label":"T","properties":{"p":[{"@type":"g:VertexProperty","@value":{"value":{"@type":"gx:LocalDate","@value":123},"label":"p"}}]}}}]}',
    'graphson',
  ),
);

console.log('\n=== pg-text ===');
attempt('unbalanced quote', () => deserialize('a :T name:"unterminated', 'pg-text'));
attempt('garbage line', () => deserialize('!!!$$$ %%%', 'pg-text'));

console.log('\n=== csv (combined) ===');
attempt('missing required :LABEL column', () =>
  deserialize('id,name:string\nv,Al\n=== EDGES ===\nid,:START_ID,:END_ID,:TYPE', 'csv'),
);
attempt('unbalanced quote in cell', () =>
  deserialize(
    'id,:LABEL,name:string\nv,T,"unterminated\n=== EDGES ===\nid,:START_ID,:END_ID,:TYPE',
    'csv',
  ),
);
attempt('edge to missing vertex (batch decodeEdges)', () => {
  const g = new Graph();
  decodeNodes('id,:LABEL\na,T', g);
  decodeEdges('id,:START_ID,:END_ID,:TYPE\ne,a,zzz,E', g);
});
attempt('bad type in header (name:banana)', () =>
  deserialize('id,:LABEL,age:banana\nv,T,5\n=== EDGES ===\nid,:START_ID,:END_ID,:TYPE', 'csv'),
);
attempt('wrong column count in row', () =>
  deserialize('id,:LABEL,name:string\nv\n=== EDGES ===\nid,:START_ID,:END_ID,:TYPE', 'csv'),
);

console.log('\n=== dispatch ===');
attempt('unknown format', () => deserialize('x', 'not-a-format' as unknown as FormatName));
