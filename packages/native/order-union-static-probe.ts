/**
 * `order()` over a non-comparable stream: TS rejects it STATICALLY, native raises it PER ROW
 * (item 1173).
 *
 * This is the reduction of the gremlin-fuzz residual item 1172 identified.
 *
 * `FUZZ_SEED=2150407949` fails DETERMINISTICALLY — three replays, three failures — which
 * contradicts the standing note that this residual's seed "replays clean". The failing traversal:
 *
 *     g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE'))
 *          .order().skip(1).inE('KNOWS').values('weight')
 *       ts: ERR E_SYNTAX     native: []
 *
 * The fuzzer drives the engines DIFFERENTLY — `toArray(plan, tsGraph)` runs the fluent plan with
 * no parsing, `nativeRun(text)` parses the rendered text — so a reduction must use the same fluent
 * builder, and must replicate the fixture adjustments the fuzzer makes AFTER
 * `createTestTinkerGraph()` (two stored nulls, a two-label vertex, a two-label edge). Getting
 * either wrong would compare two different graphs and prove nothing.
 *
 * WHAT THE REDUCTION SHOWS. Everything but `union(...)` and `order()` is scaffolding:
 *
 * ```text
 *   union only                       both ok [marko]                    AGREE
 *   no order                         both ok []                         AGREE
 *   no union: V().order().skip(1)..  both ERR E_SYNTAX                  AGREE
 *   union + order only               ts E_SYNTAX / nat E_INVALID_VALUE  both err -> not reported
 *   FULL                             ts E_SYNTAX / nat ok []            <- THE divergence
 * ```
 *
 * So `order()` over a stream it cannot compare is rejected by BOTH engines — at different TIMES.
 * TS rejects the PLAN, so no appended step can save it. Native raises PER ROW, so appending
 * `.skip(1).inE('KNOWS').values('weight')` empties the stream before anything is compared and the
 * query answers `[]`. The fuzzer only reports the second shape, because its rule is that both
 * failing is acceptable — which is why this surfaced as a rare traversal rather than as the general
 * disagreement it is.
 *
 * NOT FIXED HERE: which engine is right is a Gremlin SEMANTICS question, and the house rule is to
 * settle those against a real TinkerPop console rather than by argument. Item 574 is the precedent
 * (`repeat().times(k)`), and `tinkerpop-ground-truth-harness` has the invocation.
 */
import {
  createTestTinkerGraph,
  gt,
  has,
  inE,
  order,
  out,
  skip,
  toArray,
  traversal,
  union,
  V,
  values,
} from '@lenke/gremlin';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const MODERN = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27,"lang":null}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java","age":null}}',
  '{"type":"node","id":"13","labels":["PERSON","SOFTWARE"],"properties":{"name":"hybrid","age":40,"lang":"rust"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"10","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}',
  '{"type":"edge","id":"11","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","id":"12","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}',
  '{"type":"edge","id":"14","from":"6","to":"1","labels":["KNOWS","CREATED"],"properties":{"weight":0.7}}',
].join('\n');

const tsGraph = createTestTinkerGraph();

tsGraph.getVertexById('5')!.setProperty('age', null);
tsGraph.getVertexById('2')!.setProperty('lang', null);
tsGraph.addVertex({
  id: '13',
  labels: ['PERSON', 'SOFTWARE'],
  properties: { name: 'hybrid', age: 40, lang: 'rust' },
});
tsGraph.addEdge({
  id: '14',
  from: tsGraph.getVertexById('6')!,
  to: tsGraph.getVertexById('1')!,
  labels: ['KNOWS', 'CREATED'],
  properties: { weight: 0.7 },
});

const LIB = new URL('../../crates/lenke-engine/target/release/liblenke_engine.so', import.meta.url)
  .pathname;
const nat = graphFromNdjson(createFfiEngineBackend(LIB), MODERN);

const run = (label: string, plan: unknown, text: string): void => {
  let ts: string;

  try {
    ts = `ok ${JSON.stringify(toArray(plan as never, tsGraph))}`;
  } catch (e) {
    ts = `ERR ${String((e as { code?: string }).code ?? (e as Error).message).slice(0, 50)}`;
  }

  let n: string;

  try {
    n = `ok ${JSON.stringify(nat.gremlin(text))}`;
  } catch (e) {
    n = `ERR ${String((e as { code?: string }).code ?? (e as Error).message).slice(0, 50)}`;
  }

  console.log(`${ts === n ? '  ' : '!!'} ${label}\n       ts  ${ts}\n       nat ${n}`);
};

const T = (...steps: unknown[]): unknown => traversal(...(steps as never[]));

const ARM1 = () => traversal(has('name', gt('nope')), out('KNOWS', 'NOPE'));
const ARM2 = () => traversal(out('NOPE'));
const U = () => union(ARM1(), ARM2());

run(
  "FULL (the fuzzer's)",
  T(V(), U(), order(), skip(1), inE('KNOWS'), values('weight')),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).order().skip(1).inE('KNOWS').values('weight')",
);
run(
  'simpler union arms',
  T(
    V(),
    union(traversal(out('KNOWS')), traversal(out('NOPE'))),
    order(),
    skip(1),
    inE('KNOWS'),
    values('weight'),
  ),
  "g.V().union(out('KNOWS'), out('NOPE')).order().skip(1).inE('KNOWS').values('weight')",
);
run(
  'no values',
  T(V(), U(), order(), skip(1), inE('KNOWS')),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).order().skip(1).inE('KNOWS')",
);
run(
  'no inE/values',
  T(V(), U(), order(), skip(1)),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).order().skip(1)",
);
run(
  'no skip',
  T(V(), U(), order(), inE('KNOWS'), values('weight')),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).order().inE('KNOWS').values('weight')",
);
run(
  'no order',
  T(V(), U(), skip(1), inE('KNOWS'), values('weight')),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).skip(1).inE('KNOWS').values('weight')",
);
run(
  'no union',
  T(V(), order(), skip(1), inE('KNOWS'), values('weight')),
  "g.V().order().skip(1).inE('KNOWS').values('weight')",
);
run(
  'union + order only',
  T(V(), U(), order()),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE')).order()",
);
run(
  'union only',
  T(V(), U()),
  "g.V().union(has('name', gt('nope')).out('KNOWS', 'NOPE'), out('NOPE'))",
);
run(
  'ARM1 alone',
  T(V(), has('name', gt('nope')), out('KNOWS', 'NOPE')),
  "g.V().has('name', gt('nope')).out('KNOWS', 'NOPE')",
);

// THE TINKERPOP CASES (item 1174). Ground truth from `gremlin-console:3.7.3` on the modern graph,
// which settles what the reduction above could not:
//
//   V().order()                              [v1..v6]      TinkerPop ORDERS VERTICES
//   V().out('nope').order()                  []            an empty stream orders to empty
//   union(..).order()                        []
//   FULL (union, order, skip, inE, values)   []            <- native's answer, not TS's error
//   V().order().skip(1).inE.values           [0.5, 1.0]    <- BOTH lenke engines say E_SYNTAX
//   V().limit(1).union(identity, values)     [29, v[1]]    orders ACROSS TYPES without faulting
//
// So `order()` never faults in TinkerPop for any of these. The question stops being which lenke
// engine is right about an error and becomes: neither supports ordering ELEMENTS at all.
run('TP1 order() over vertices', T(V(), order()), 'g.V().order()');
run('TP2 order() over an empty stream', T(V(), out('NOPE'), order()), "g.V().out('NOPE').order()");
run(
  'TP5 order().skip(1).inE.values',
  T(V(), order(), skip(1), inE('KNOWS'), values('weight')),
  "g.V().order().skip(1).inE('KNOWS').values('weight')",
);
