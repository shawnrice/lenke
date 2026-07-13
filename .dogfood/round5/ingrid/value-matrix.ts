// Per-value round-trip harness: store each tricky value as a property on a
// single vertex, run it through every codec, read it back, and deep-compare.
// This isolates value-level round-trip loss precisely (which codec, which value).
import { Graph, LocalDate, LocalDateTime, Duration, isTemporal } from '@lenke/core';
import { serialize, deserialize, FORMATS, type FormatName } from '@lenke/serialization';

type Case = { name: string; value: unknown };

const cases: Case[] = [
  { name: 'string-plain', value: 'hello' },
  { name: 'empty-string', value: '' },
  { name: 'string-comma', value: 'a,b,c' },
  { name: 'string-quote', value: 'she said "hi"' },
  { name: 'string-newline', value: 'line1\nline2' },
  { name: 'string-crlf', value: 'a\r\nb' },
  { name: 'string-tab', value: 'a\tb' },
  { name: 'string-backslash', value: 'a\\b\\c' },
  { name: 'string-leading-backslash', value: '\\N' },
  { name: 'string-semicolon', value: 'a;b;c' },
  { name: 'string-formula-eq', value: '=1+2' },
  { name: 'string-formula-plus', value: '+41' },
  { name: 'string-formula-minus', value: '-cmd' },
  { name: 'string-formula-at', value: '@handle' },
  { name: 'string-unicode', value: 'héllo wörld café' },
  { name: 'string-emoji', value: '👩‍💻🚀日本語' },
  { name: 'string-looks-null', value: 'null' },
  { name: 'string-looks-true', value: 'true' },
  { name: 'string-looks-number', value: '123' },
  { name: 'string-looks-float', value: '1.5' },
  { name: 'string-sentinel-N', value: '\\N' },
  { name: 'string-override-sigil', value: '\\Ti:5' },

  { name: 'bool-true', value: true },
  { name: 'bool-false', value: false },

  { name: 'null', value: null },

  { name: 'int-small', value: 42 },
  { name: 'int-zero', value: 0 },
  { name: 'int-neg', value: -7 },
  { name: 'int-max-safe', value: Number.MAX_SAFE_INTEGER },
  { name: 'int-min-safe', value: Number.MIN_SAFE_INTEGER },
  { name: 'float-simple', value: 3.5 },
  { name: 'float-01-02', value: 0.1 + 0.2 },
  { name: 'float-whole', value: 2.0 },
  { name: 'float-tiny', value: 5e-324 },
  { name: 'float-huge', value: 1e308 },
  { name: 'float-1e21', value: 1e21 },
  { name: 'float-neg-zero', value: -0 },
  { name: 'float-pi', value: Math.PI },

  { name: 'list-int', value: [1, 2, 3] },
  { name: 'list-str', value: ['a', 'b'] },
  { name: 'list-empty', value: [] },
  { name: 'list-single-int', value: [7] },
  { name: 'list-single-str', value: ['x'] },
  { name: 'list-single-empty-str', value: [''] },
  { name: 'list-with-null', value: [null] },
  { name: 'list-int-null-int', value: [1, null, 2] },
  { name: 'list-str-null', value: ['a', null, 'b'] },
  { name: 'list-bool', value: [true, false] },
  { name: 'list-float', value: [1.5, 2.5] },
  { name: 'list-mixed-num', value: [1, 2.5] },
  { name: 'list-mixed-type', value: [1, 'two', true] },

  { name: 'date', value: new LocalDate(18000) },
  { name: 'datetime', value: new LocalDateTime(1600000000, 123456789) },
  { name: 'duration', value: new Duration(14, 3, 4 * 3600 + 5 * 60 + 6, 0) },
  { name: 'list-date', value: [new LocalDate(0), new LocalDate(100)] },
];

const valEqual = (a: unknown, b: unknown): boolean => {
  if (isTemporal(a) || isTemporal(b)) {
    if (!isTemporal(a) || !isTemporal(b)) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => valEqual(x, b[i]));
  }
  // distinguish -0 from 0
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) || a === b; // a===b true for -0/0; use display below
  }
  return a === b;
};

const show = (v: unknown): string => {
  if (isTemporal(v)) return `Temporal(${JSON.stringify(v)})`;
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (Object.is(v, -0)) return '-0';
  return String(v);
};

const results: Record<string, string[]> = {};
for (const fmt of FORMATS) results[fmt] = [];

for (const fmt of FORMATS as FormatName[]) {
  for (const c of cases) {
    const g = new Graph();
    g.addVertex({ id: 'v', labels: ['T'], properties: { p: c.value as any } });
    let back: unknown;
    let err: string | null = null;
    try {
      const text = serialize(g, fmt);
      const g2 = deserialize(text, fmt);
      const v2 = g2.getVertexById('v');
      back = v2 ? (v2.properties as any).p : '<<no vertex>>';
    } catch (e) {
      err = (e as Error).message;
    }
    if (err) {
      results[fmt].push(`  THROW  ${c.name}: ${err.slice(0, 90)}`);
      continue;
    }
    const present = back !== undefined || c.value === undefined;
    if (c.value === null) {
      // null must survive as null (present), not become undefined/absent
      if (back === null) continue;
      results[fmt].push(`  LOSS   ${c.name}: ${show(c.value)} -> ${show(back)}`);
      continue;
    }
    if (!present) {
      results[fmt].push(`  LOSS   ${c.name}: ${show(c.value)} -> <<absent>>`);
      continue;
    }
    const eq = valEqual(c.value, back);
    const negZero = Object.is(c.value, -0) !== Object.is(back, -0);
    if (!eq || negZero) {
      results[fmt].push(`  LOSS   ${c.name}: ${show(c.value)} -> ${show(back)}`);
    }
  }
}

for (const fmt of FORMATS) {
  console.log(`\n===== ${fmt} =====`);
  if (results[fmt].length === 0) {
    console.log('  (all values round-tripped)');
  } else {
    for (const line of results[fmt]) console.log(line);
  }
}
