import { describe, expect, test } from 'bun:test';

import type { Graph } from '@lenke/core';
import {
  V,
  count,
  createTestTinkerGraph,
  dedupe,
  has,
  neq,
  order,
  path,
  planToGremlin,
  Scope,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

import { nativeBackend, nativeReady } from './conformance-harness.js';

/*
 * Item 2493: bisecting item 2492's captured divergence.
 *
 *   g.V().has('lang', neq('lop')).order(local).dedup().path().count()   ts [7]  native [6]
 *
 * 2492 ruled out `neq` ALONE (it returns all six on the plain modern graph, same as the control) and
 * left `order(local)`, `dedup()` and `path()` as suspects. Reading the FUZZER'S fixture sharpens it:
 * it patches `getVertexById('2').setProperty('lang', null)` — a **STORED NULL**, which per this
 * repo's `null-first-class-policy` is a PRESENT value, not a missing key. With the extra `hybrid`
 * vertex the graph holds SEVEN vertices, and the divergence is exactly one row. So the real question
 * is what `neq` does against a stored null, which is a different question from the missing key of
 * items 2488-2490.
 *
 * Each row below is run through BOTH engines from one `Plan`, as the conformance suite does, with the
 * emitted Gremlin text printed so the text Rust actually parses is never in doubt.
 */
const suite = nativeReady ? describe : describe.skip;

suite('item 2493: bisecting the 2492 divergence', () => {
  const backend = nativeBackend();

  /** The fuzzer's fixture, patched the same way — the stored nulls are the point. */
  const buildTs = (): Graph => {
    const g = createTestTinkerGraph();

    g.getVertexById('5')!.setProperty('age', null);
    g.getVertexById('2')!.setProperty('lang', null);
    g.addVertex({
      id: '13',
      labels: ['PERSON', 'SOFTWARE'],
      properties: { name: 'hybrid', age: 40, lang: 'rust' },
    });
    g.addEdge({
      id: '14',
      from: g.getVertexById('6')!,
      to: g.getVertexById('1')!,
      labels: ['KNOWS', 'CREATED'],
      properties: { weight: 0.7 },
    });

    return g;
  };

  const tsGraph = buildTs();

  /*
   * The NDJSON the native side decodes has to carry the SAME stored nulls, or the fixtures drift and
   * the drift itself reads as a divergence — the trap the fuzzer's own comment warns about.
   */
  const MODERN = [
    '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
    '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27,"lang":null}}',
    '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
    '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
    '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java","age":null}}',
    '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
    '{"type":"node","id":"13","labels":["PERSON","SOFTWARE"],"properties":{"name":"hybrid","age":40,"lang":"rust"}}',
    '{"type":"edge","id":"7","labels":["KNOWS"],"from":"1","to":"2","properties":{"weight":0.5}}',
    '{"type":"edge","id":"8","labels":["KNOWS"],"from":"1","to":"4","properties":{"weight":1}}',
    '{"type":"edge","id":"9","labels":["CREATED"],"from":"1","to":"3","properties":{"weight":0.4}}',
    '{"type":"edge","id":"10","labels":["CREATED"],"from":"4","to":"5","properties":{"weight":1}}',
    '{"type":"edge","id":"11","labels":["CREATED"],"from":"4","to":"3","properties":{"weight":0.4}}',
    '{"type":"edge","id":"12","labels":["CREATED"],"from":"6","to":"3","properties":{"weight":0.2}}',
    '{"type":"edge","id":"14","labels":["KNOWS","CREATED"],"from":"6","to":"1","properties":{"weight":0.7}}',
  ].join('\n');

  const decoder = new TextDecoder();
  const nativeRun = (text: string): unknown => {
    const handle = backend.graphFromNdjson(new TextEncoder().encode(MODERN));

    try {
      return JSON.parse(decoder.decode(backend.gremlinJson(handle, text))) as unknown;
    } finally {
      backend.graphFree(handle);
    }
  };

  const bisect: Array<[string, unknown]> = [
    ['B0 V().count() CONTROL', traversal(V(), count())],
    ['B1 has(lang,neq lop) + count', traversal(V(), has('lang', neq('lop')), count())],
    ['B2 has(lang,neq lop) + names', traversal(V(), has('lang', neq('lop')), values('name'))],
    ['B3 + order(local)', traversal(V(), has('lang', neq('lop')), order(Scope.local), count())],
    [
      'B4 + order(local).dedup()',
      traversal(V(), has('lang', neq('lop')), order(Scope.local), dedupe(), count()),
    ],
    [
      'B5 FULL (the 2492 plan)',
      traversal(V(), has('lang', neq('lop')), order(Scope.local), dedupe(), path(), count()),
    ],
    // CONTROLS that isolate the stored null from the predicate.
    ['C1 has(lang) presence only', traversal(V(), has('lang'), values('name'))],
    ['C2 has(lang,neq java)', traversal(V(), has('lang', neq('java')), values('name'))],
  ];

  /*
   * THE TWO DIVERGING ROWS ARE `test.failing`, THE REST ARE ORDINARY TESTS. `test.failing` is the
   * right idiom here and not a dodge: a VALUE divergence may never go in `divergence-registry.ts`,
   * these are FIXED minimal cases rather than a random seed, CI stays green while the defect
   * stands, and the moment the TS engine is corrected these flip red and must be promoted to
   * ordinary tests. The agreeing rows around them are what keep the failure attributable.
   */
  const FAILING = new Set([
    'B1 has(lang,neq lop) + count',
    'B2 has(lang,neq lop) + names',
    'B3 + order(local)',
    'B4 + order(local).dedup()',
    'B5 FULL (the 2492 plan)',
    // C2 WAS MEANT AS A CONTROL AND IT DIVERGES TOO — same cause, another value: `vadas` carries
    // the stored null, so `neq('java')` hits it exactly as `neq('lop')` does. Six rows diverge and
    // only the PRESENCE control (C1) agrees, which is what pins the defect to the comparison rather
    // than to key lookup.
    'C2 has(lang,neq java)',
  ]);

  for (const [label, plan] of bisect) {
    const run = FAILING.has(label) ? test.failing : test;

    run(label, () => {
      const text = planToGremlin(plan as never);
      const ts = JSON.stringify(toArray(plan as never, tsGraph));
      const nat = JSON.stringify(nativeRun(text));

      expect(ts).toBe(nat);
    });
  }
});
