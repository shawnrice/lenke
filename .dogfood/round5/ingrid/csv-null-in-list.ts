// Airtight standalone repro: CSV codec turns a null ELEMENT of a list into the
// literal string "null" on round-trip. null is supposed to be first-class in all
// 5 codecs (null-first-class-policy), but only the SCALAR null survives CSV; a
// null inside a list is silently mistyped to a string.
import { Graph } from '@lenke/core';
import { serialize, deserialize } from '@lenke/serialization';

const runOne = (label: string, value: unknown) => {
  const g = new Graph();
  g.addVertex({ id: 'v', labels: ['T'], properties: { p: value as any } });
  const csv = serialize(g, 'csv');
  const back = (deserialize(csv, 'csv').getVertexById('v')!.properties as any).p;
  console.log(`\n--- ${label} ---`);
  console.log('BEFORE:', JSON.stringify(value));
  console.log('CSV bytes:\n' + csv);
  console.log('AFTER :', JSON.stringify(back));
  console.log(
    'typeof each after:',
    Array.isArray(back) ? back.map((x: any) => typeof x) : typeof back,
  );
  console.log('LOSS?', JSON.stringify(value) !== JSON.stringify(back));
};

runOne('[null]', [null]);
runOne('[1, null, 2]', [1, null, 2]);
runOne('["a", null, "b"]', ['a', null, 'b']);

// contrast: scalar null DOES survive CSV
runOne('scalar null', null);

// contrast: same value survives pg-json
{
  const g = new Graph();
  g.addVertex({ id: 'v', labels: ['T'], properties: { p: [1, null, 2] as any } });
  const back = (
    deserialize(serialize(g, 'pg-json'), 'pg-json').getVertexById('v')!.properties as any
  ).p;
  console.log('\n--- pg-json control for [1, null, 2] ---');
  console.log('AFTER:', JSON.stringify(back), '(survives)');
}
