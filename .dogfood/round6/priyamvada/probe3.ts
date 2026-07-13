import { tsDeserialize, Graph, classify } from './harness.ts';
console.log('--- TS deserialize empty ---');
for (const fmt of ['ndjson', 'csv', 'pg-json', 'pg-text', 'graphson'] as const) {
  const r = classify(() => {
    const g = tsDeserialize('', fmt, new Graph());
    return { v: g.vertexCount?.(), e: g.edgeCount?.() };
  });
  console.log(
    `ts deserialize '' ${fmt}: ${r.kind} ${(r as any).code || (r as any).name || ''} ${JSON.stringify((r as any).value || '')}`,
  );
}
// whitespace-only file
for (const fmt of ['ndjson', 'csv'] as const) {
  const r = classify(() => {
    const g = tsDeserialize('\n\n', fmt, new Graph());
    return 'ok';
  });
  console.log(
    `ts deserialize '\\n\\n' ${fmt}: ${r.kind} ${(r as any).code || (r as any).name || ''}`,
  );
}
