import { nativeGraph, tsGraph, tsQuery, classify } from './harness.ts';

// 1. Empty string native crash — full error
console.log('--- empty string native ---');
try {
  console.log('native ok', JSON.stringify(nativeGraph.query('')));
} catch (e: any) {
  console.log('native threw:', e.constructor.name, '| code=', e.code, '| msg=', e.message);
  console.log(e.stack?.split('\n').slice(0, 4).join('\n'));
}
try {
  console.log('ts ok', JSON.stringify(tsQuery(tsGraph, '')));
} catch (e: any) {
  console.log('ts threw:', e.constructor.name, '| code=', e.code, '| msg=', e.message);
}

// Whitespace-only variants on native
for (const q of [' ', '\n', '\t', '   ', '/* c */', '// x']) {
  const r = classify(() => nativeGraph.query(q));
  console.log('native', JSON.stringify(q), '->', r.kind, (r as any).code || (r as any).name || '');
}

// 2. Deep nesting thresholds
console.log('\n--- deep nesting thresholds ---');
for (const n of [10, 50, 60, 64, 100, 128, 200, 500, 1000, 5000, 20000, 100000]) {
  const q = `RETURN ${'('.repeat(n)}1${')'.repeat(n)} AS x`;
  const t = classify(() => tsQuery(tsGraph, q));
  const nat = classify(() => nativeGraph.query(q));
  console.log(
    `paren n=${n}: ts=${t.kind}/${(t as any).code || (t as any).name || ''} native=${nat.kind}/${(nat as any).code || (nat as any).name || ''}`,
  );
}
