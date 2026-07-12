/**
 * Graph format-migration CLI (dogfooding @lenke/serialization + @lenke/core).
 *
 * Usage:
 *   bun migrate.ts                         # run the full self-proving demo
 *   bun migrate.ts <in> <from> <to> [out]  # migrate a file between formats
 *
 * Formats: pg-json | pg-text | ndjson | graphson | csv
 */
import { Graph } from '@lenke/core';
import {
  serialize,
  deserialize,
  parse,
  serializeStream,
  deserializeStream,
  serializeAsync,
  deserializeAsync,
  collect,
  chunked,
  codecs,
  type FormatName,
} from '@lenke/serialization';

const FORMATS = Object.keys(codecs) as FormatName[];

// ---------------------------------------------------------------------------
// Order-independent structural equality (my own — testkit is NOT public API).
// Two graphs are equal iff same vertex ids (labels as sets + props) and same
// edge ids (endpoints + labels as sets + props).
// ---------------------------------------------------------------------------
const canonVal = (v: unknown): string => JSON.stringify(v);
const canonProps = (p: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(p)
      .sort()
      .map((k) => [k, canonVal(p[k])]),
  );
const canonLabels = (l: Iterable<string>): string => JSON.stringify([...l].sort());

const graphEqual = (a: Graph, b: Graph): { equal: boolean; why?: string } => {
  const vsig = (g: Graph) =>
    new Map(
      [...g.vertices].map((v) => [
        String(v.id),
        `${canonLabels(v.labels)}|${canonProps(v.properties)}`,
      ]),
    );
  const esig = (g: Graph) =>
    new Map(
      [...g.edges].map((e) => [
        String(e.id),
        `${e.from.id}->${e.to.id}|${canonLabels(e.labels)}|${canonProps(e.properties)}`,
      ]),
    );
  const [va, vb, ea, eb] = [vsig(a), vsig(b), esig(a), esig(b)];
  if (va.size !== vb.size) return { equal: false, why: `vertex count ${va.size} != ${vb.size}` };
  for (const [id, sig] of va)
    if (vb.get(id) !== sig) return { equal: false, why: `vertex '${id}': ${sig} != ${vb.get(id)}` };
  if (ea.size !== eb.size) return { equal: false, why: `edge count ${ea.size} != ${eb.size}` };
  for (const [id, sig] of ea)
    if (eb.get(id) !== sig) return { equal: false, why: `edge '${id}': ${sig} != ${eb.get(id)}` };
  return { equal: true };
};

// Content equality: match edges by (endpoints + labels + props) as a multiset,
// IGNORING edge id — pg-text does not round-trip synthetic edge ids, so this
// checks that no actual DATA was lost.
const graphContentEqual = (a: Graph, b: Graph): { equal: boolean; why?: string } => {
  const vsig = (g: Graph) =>
    new Map(
      [...g.vertices].map((v) => [
        String(v.id),
        `${canonLabels(v.labels)}|${canonProps(v.properties)}`,
      ]),
    );
  const ebag = (g: Graph): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of g.edges) {
      const k = `${e.from.id}->${e.to.id}|${canonLabels(e.labels)}|${canonProps(e.properties)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const [va, vb] = [vsig(a), vsig(b)];
  if (va.size !== vb.size) return { equal: false, why: `vertex count ${va.size} != ${vb.size}` };
  for (const [id, sig] of va)
    if (vb.get(id) !== sig) return { equal: false, why: `vertex '${id}' differs` };
  const [ma, mb] = [ebag(a), ebag(b)];
  if (ma.size !== mb.size)
    return { equal: false, why: `distinct edge shapes ${ma.size} != ${mb.size}` };
  for (const [k, n] of ma)
    if (mb.get(k) !== n) return { equal: false, why: `edge shape count differs: ${k}` };
  return { equal: true };
};

// ---------------------------------------------------------------------------
// A rich sample graph exercising every edge of the LPG value model.
// ---------------------------------------------------------------------------
const sampleGraph = (): Graph => {
  const g = new Graph();
  const alice = g.addVertex({
    id: 'a',
    labels: ['Person'],
    properties: { name: 'Alice', age: 34, score: 9.5, active: true, nick: null, tags: ['x', 'y'] },
  });
  const bob = g.addVertex({
    id: 'b',
    labels: ['Person', 'Admin'], // multiple labels
    // NOTE: tags has 2+ elements on purpose — see section 6, pg-text cannot
    // faithfully represent 0- or 1-element lists.
    properties: { name: 'Bob', age: 28, active: false, tags: ['admin', 'ops'] },
  });
  const carol = g.addVertex({
    id: 'c',
    labels: ['Person'],
    properties: {}, // no properties at all
  });
  g.addEdge({
    id: 'e1',
    from: alice,
    to: bob,
    labels: ['KNOWS'],
    properties: { since: 2020, weight: 0.7 },
  });
  g.addEdge({
    id: 'e2',
    from: bob,
    to: carol,
    labels: ['KNOWS'],
    properties: { since: 2021, note: null },
  });
  g.addEdge({ id: 'e3', from: alice, to: carol, labels: ['MENTORS'], properties: {} }); // no props
  return g;
};

const line = (s = '') => console.log(s);
const rule = (t: string) => line(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);

// ---------------------------------------------------------------------------
// CLI mode: bun migrate.ts <in> <from> <to> [out]
// ---------------------------------------------------------------------------
const runCli = async (inPath: string, from: string, to: string, outPath?: string) => {
  if (!FORMATS.includes(from as FormatName))
    throw new Error(`unknown --from '${from}' (have: ${FORMATS.join(', ')})`);
  if (!FORMATS.includes(to as FormatName))
    throw new Error(`unknown --to '${to}' (have: ${FORMATS.join(', ')})`);
  const text = await Bun.file(inPath).text();
  const graph = deserialize(text, from as FormatName); // into a fresh graph
  const out = serialize(graph, to as FormatName);
  if (outPath) {
    await Bun.write(outPath, out);
    line(
      `migrated ${inPath} (${from}) -> ${outPath} (${to}): ${graph.vertexCount} nodes, ${graph.edgeCount} edges`,
    );
  } else {
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  }
};

// ---------------------------------------------------------------------------
// Demo mode: full self-proving run.
// ---------------------------------------------------------------------------
const runDemo = async () => {
  const outDir = new URL('./out/', import.meta.url).pathname;

  rule('1. Serialize the sample graph to every format (written to ./out/)');
  const encoded: Record<FormatName, string> = {} as any;
  for (const f of FORMATS) {
    const s = serialize(sampleGraph(), f);
    encoded[f] = s;
    await Bun.write(`${outDir}${f}.txt`, s);
    line(`\n--- ${f} (${s.length} bytes) ---`);
    line(s.length > 320 ? s.slice(0, 320) + ' …[truncated]' : s);
  }

  rule('2. Cross-format migration matrix: A -> graph -> B -> graph, assert equal');
  const src = sampleGraph();
  let strictPass = 0;
  let contentPass = 0;
  let contentFail = 0;
  const strictFails: string[] = [];
  const contentFails: string[] = [];
  for (const from of FORMATS) {
    for (const to of FORMATS) {
      const gA = parse(encoded[from], from); // A-text -> graph
      const gB = parse(serialize(gA, to), to); // graph -> B-text -> graph
      const strict = graphEqual(src, gB); // ids must match exactly
      const content = graphContentEqual(src, gB); // ignore synthetic edge id
      if (strict.equal) strictPass++;
      else strictFails.push(`  ${from.padEnd(9)} -> ${to.padEnd(9)}: ${strict.why}`);
      if (content.equal) contentPass++;
      else {
        contentFail++;
        contentFails.push(`  ${from} -> ${to}: ${content.why}`);
      }
    }
  }
  const total = FORMATS.length * FORMATS.length;
  line(`Ran ${total} migrations across ${FORMATS.length} formats.`);
  line(`\nStrict equality (element ids must match): PASS=${strictPass}/${total}`);
  line(strictFails.length ? strictFails.join('\n') : '  all hold ✔');
  line(`  ^ the ${strictFails.length} misses are exactly the pg-text pairings: pg-text does not`);
  line('    round-trip synthetic EDGE ids (assigns a fresh UUID on decode). Node ids survive.');
  line(
    `\nContent equality (edges matched by endpoints+labels+props, ignoring edge id): PASS=${contentPass}/${total}`,
  );
  line(
    contentFails.length
      ? contentFails.join('\n')
      : '  ALL 25 hold — no property/topology data is lost by any format ✔',
  );
  const fail = contentFail; // only genuine data loss counts as a demo failure

  rule('3. Null / edge-case fidelity spot-check (pg-json canonical)');
  const g = parse(encoded['pg-json'], 'pg-json');
  const a = g.getVertexById('a')!;
  const b = g.getVertexById('b')!;
  const c = g.getVertexById('c')!;
  line(
    `a.nick is present-and-null? key present=${'nick' in a.properties}, value=${JSON.stringify(a.properties.nick)}`,
  );
  line(`a.tags (list) = ${JSON.stringify(a.properties.tags)}`);
  line(`b.tags (multi list) = ${JSON.stringify(b.properties.tags)}`);
  line(`b has 2 labels = ${JSON.stringify([...b.labels])}`);
  line(`c has 0 properties = ${JSON.stringify(c.properties)}`);
  line(`edge e2.note present-and-null = ${g.getEdgeById('e2')!.properties.note === null}`);

  rule('4. Streaming path: encode a big graph -> chunks -> decode, without slurping');
  const big = new Graph();
  const N = 20_000;
  let prev = big.addVertex({ id: 'v0', labels: ['N'], properties: { i: 0 } });
  for (let i = 1; i < N; i++) {
    const v = big.addVertex({ id: `v${i}`, labels: ['N'], properties: { i, half: i % 2 === 0 } });
    big.addEdge({ id: `e${i}`, from: prev, to: v, labels: ['NEXT'], properties: {} });
    prev = v;
  }
  line(`built graph: ${big.vertexCount} nodes, ${big.edgeCount} edges`);
  // encodeStream -> re-chunk at adversarial 7-byte boundaries -> decodeStream
  const whole = await collect(serializeStream(big, 'ndjson'));
  const restored = await deserializeStream(chunked(whole, 7), 'ndjson', new Graph());
  const streamEq = graphEqual(big, restored);
  line(`streamed ndjson bytes: ${whole.length}`);
  line(`decodeStream restored: ${restored.vertexCount} nodes, ${restored.edgeCount} edges`);
  line(`stream round-trip equal to original? ${streamEq.equal ? '✔' : 'FAIL: ' + streamEq.why}`);

  // Non-blocking async variants (yield the event loop) — prove the loop breathes.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const asyncText = await serializeAsync(big, 'ndjson');
  const asyncGraph = await deserializeAsync(asyncText, 'ndjson');
  clearInterval(timer);
  line(
    `serializeAsync/deserializeAsync round-trip nodes=${asyncGraph.vertexCount}; event-loop ticks observed while working=${ticks}`,
  );

  rule('5. Malformed-input error handling (must fail loudly, caught here)');
  const bads: Array<[FormatName, string]> = [
    ['pg-json', '{ this is not json'],
    ['ndjson', '{"type":"banana","id":"x"}'],
    ['graphson', '{"vertices": 42}'],
  ];
  for (const [fmt, bad] of bads) {
    try {
      deserialize(bad, fmt);
      line(`  ${fmt}: UNEXPECTED no-throw`);
    } catch (e) {
      const err = e as Error;
      line(`  ${fmt}: ${err.name}: ${err.message}`);
    }
  }
  // Out-of-model property value must throw at the boundary.
  try {
    const bg = new Graph();
    bg.addVertex({ id: 'z', labels: ['X'], properties: { when: new Date() } });
    serialize(bg, 'pg-json');
    line('  out-of-model value: UNEXPECTED no-throw');
  } catch (e) {
    line(`  out-of-model value: ${(e as Error).name}: ${(e as Error).message}`);
  }

  rule(
    '6. Known fidelity limit: pg-text repeated-key list encoding is lossy for 0/1-element lists',
  );
  let ptLossy = 0;
  for (const val of [[], ['x'], ['x', 'y'], [1, 2, 3]] as unknown[]) {
    const one = new Graph();
    one.addVertex({ id: 'x', labels: ['L'], properties: { tags: val } });
    const back = parse(serialize(one, 'pg-text'), 'pg-text').getVertexById('x')!.properties.tags;
    const ok = JSON.stringify(back) === JSON.stringify(val);
    if (!ok) ptLossy++;
    line(
      `  tags=${JSON.stringify(val).padEnd(12)} -> pg-text -> ${JSON.stringify(back ?? '(absent)')}  ${ok ? 'ok' : 'LOSSY'}`,
    );
  }
  line(
    `  (empty + singleton lists do not survive pg-text; the JSON/ndjson/graphson/csv codecs preserve them.)`,
  );

  rule('DONE');
  line(
    fail === 0 && streamEq.equal ? 'ALL MATRIX ROUND-TRIPS HOLD ✔' : 'THERE WERE MATRIX FAILURES ✘',
  );
  line(`(pg-text lossy cases characterized separately in section 6: ${ptLossy}/4)`);
};

const [, , inPath, from, to, outPath] = process.argv;
if (inPath) {
  await runCli(inPath, from, to, outPath);
} else {
  await runDemo();
}
