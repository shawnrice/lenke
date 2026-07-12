/**
 * Graph format-migration slice — Elena (round2), first-time lenke user.
 *
 * Exercises the @lenke/serialization public API end to end:
 *   - serialize / deserialize / parse across ALL five FORMATS
 *   - a full round-trip matrix (A -> graph -> B -> graph, assert equal)
 *   - the FORMATS runtime list
 *   - the streaming path (serializeStream / deserializeStream + chunked source)
 *   - a malformed-input error case (LenkeError)
 *   - null property values + empty/singleton list edge cases
 *
 * Run:  bun migrate.ts
 */
import { Graph, type Vertex, type Edge } from '@lenke/core';
import { LenkeError } from '@lenke/errors';
import {
  serialize,
  deserialize,
  parse,
  serializeStream,
  deserializeStream,
  FORMATS,
  codecs,
  chunked,
  collect,
  type FormatName,
} from '@lenke/serialization';

// ---------------------------------------------------------------------------
// A fixture graph that stresses the interesting corners of the LPG value model.
// ---------------------------------------------------------------------------
function buildFixture(): Graph {
  const g = new Graph();
  const alice = g.addVertex({
    id: 'a',
    labels: ['Person', 'Admin'], // multi-label
    properties: {
      name: 'Alice',
      age: 34,
      active: true,
      nickname: null, // null property value (first-class, present)
      tags: ['x', 'y', 'z'], // multi-element list
      aliases: ['solo'], // singleton list
      prior: [], // empty list
    },
  });
  const bob = g.addVertex({
    id: 'b',
    labels: ['Person'],
    properties: { name: 'Bob', age: 28, active: false, nickname: 'Bobby' },
  });
  g.addEdge({
    id: 'e1',
    from: alice,
    to: bob,
    labels: ['KNOWS'],
    properties: { since: 2020, weight: 0.5, note: null },
  });
  return g;
}

// ---------------------------------------------------------------------------
// Structural comparison. Reduce a graph to a canonical, order-independent shape
// so we can assert two graphs are equal regardless of iteration order.
// ---------------------------------------------------------------------------
type Canon = {
  vertices: Record<string, { labels: string[]; properties: Record<string, unknown> }>;
  // edge key -> summary. Keyed by id when present.
  edges: Record<
    string,
    { from: string; to: string; labels: string[]; properties: Record<string, unknown> }
  >;
};

function sortedProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(props).sort()) out[k] = props[k];
  return out;
}

function canonicalize(g: Graph, opts: { edgeIds: boolean } = { edgeIds: true }): Canon {
  const vertices: Canon['vertices'] = {};
  for (const v of g.vertices as Iterable<Vertex>) {
    vertices[v.id] = { labels: [...v.labels].sort(), properties: sortedProps(v.properties) };
  }
  const edges: Canon['edges'] = {};
  let n = 0;
  for (const e of g.edges as Iterable<Edge>) {
    // When edge ids are unreliable (pg-text mints fresh ones), key on the
    // (from,to,labels,props) tuple instead so order doesn't matter.
    const summary = {
      from: e.from.id,
      to: e.to.id,
      labels: [...e.labels].sort(),
      properties: sortedProps(e.properties),
    };
    const key = opts.edgeIds ? e.id : `${JSON.stringify(summary)}#${n++}`;
    edges[key] = summary;
  }
  return { vertices, edges };
}

function graphsEqual(a: Graph, b: Graph, opts: { edgeIds: boolean }): boolean {
  return JSON.stringify(canonicalize(a, opts)) === JSON.stringify(canonicalize(b, opts));
}

// pg-text is documented lossy: no edge-id slot, and []/[x] collapse to
// absent/scalar. Apply that exact transform to BOTH sides so we compare only
// what the format promises to preserve. `[]` -> absent (remove key);
// `[x]` -> scalar x. Multi-element lists and scalars are left untouched.
function lossyMask(g: Graph): Graph {
  const c = g.clone(); // mutate freely
  for (const v of c.vertices as Iterable<Vertex>) {
    for (const k of Object.keys(v.properties)) {
      const val = v.getProperty(k);
      if (Array.isArray(val)) {
        if (val.length === 0)
          v.removeProperty(k); // [] -> absent
        else if (val.length === 1) v.setProperty(k, val[0]); // [x] -> scalar x
      }
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Reporting helpers.
// ---------------------------------------------------------------------------
function summarize(g: Graph): string {
  const vs = [...(g.vertices as Iterable<Vertex>)].length;
  const es = [...(g.edges as Iterable<Edge>)].length;
  return `${vs} vertices, ${es} edges`;
}

const line = (s = '') => console.log(s);
const PASS = '✓';
const FAIL = '✗';

// ===========================================================================
async function main() {
  const fixture = buildFixture();
  line('=== Fixture ===');
  line(`  ${summarize(fixture)}`);
  line(`  FORMATS from the library: ${FORMATS.join(', ')}`);
  line(`  codecs record keys:       ${Object.keys(codecs).join(', ')}`);
  line();

  // -- 1. serialize / deserialize / parse across every format ---------------
  line('=== Per-format serialize -> parse (self round-trip) ===');
  const lossy = new Set<FormatName>(['pg-text']);
  for (const fmt of FORMATS) {
    const text = serialize(fixture, fmt);
    const back = parse(text, fmt); // parse = deserialize into fresh graph
    const edgeIds = !lossy.has(fmt);
    const expected = lossy.has(fmt) ? lossyMask(fixture) : fixture;
    const actual = lossy.has(fmt) ? lossyMask(back) : back;
    const ok = graphsEqual(expected, actual, { edgeIds });
    const tag = lossy.has(fmt) ? ' (lossy-masked: edge-ids + []/[x] ignored)' : '';
    line(`  ${ok ? PASS : FAIL} ${fmt.padEnd(9)} ${text.length} bytes -> ${summarize(back)}${tag}`);
    if (!ok)
      line(
        `      DIVERGENCE\n      exp ${JSON.stringify(canonicalize(expected, { edgeIds }))}\n      got ${JSON.stringify(canonicalize(actual, { edgeIds }))}`,
      );
  }
  line();

  // -- 2. round-trip matrix: format A -> graph -> format B -> graph ---------
  // For each ordered pair (A,B): parse from A into a graph, re-emit as B,
  // parse B back, and assert the two graphs agree. Any pair touching pg-text
  // is compared under the lossy mask.
  line('=== Round-trip matrix (A -> graph -> B -> graph, assert equal) ===');
  line(`      to:  ${FORMATS.map((f) => f.slice(0, 4).padEnd(5)).join('')}`);
  let matrixOk = true;
  for (const a of FORMATS) {
    const cells: string[] = [];
    const viaA = parse(serialize(fixture, a), a);
    for (const b of FORMATS) {
      const isLossy = lossy.has(a) || lossy.has(b);
      const viaB = parse(serialize(viaA, b), b);
      const edgeIds = !isLossy;
      const exp = isLossy ? lossyMask(viaA) : viaA;
      const got = isLossy ? lossyMask(viaB) : viaB;
      const ok = graphsEqual(exp, got, { edgeIds });
      if (!ok) matrixOk = false;
      cells.push(`${ok ? PASS : FAIL}${isLossy ? '~' : ' '}`.padEnd(5));
    }
    line(`  ${a.padEnd(9)}${cells.join('')}`);
  }
  line(`  legend: ${PASS}=exact  ${PASS}~=equal under pg-text lossy mask  ${FAIL}=diverged`);
  line(`  matrix result: ${matrixOk ? PASS + ' all pairs hold' : FAIL + ' divergence detected'}`);
  line();

  // -- 3. streaming path ----------------------------------------------------
  line('=== Streaming (serializeStream -> chunked source -> deserializeStream) ===');
  for (const fmt of FORMATS) {
    const streams = !!codecs[fmt].encodeStream;
    if (!streams) {
      line(`  -  ${fmt.padEnd(9)} no streaming support (single-document format)`);
      continue;
    }
    // Encode via streaming, count chunks, reassemble.
    let chunkCount = 0;
    const parts: string[] = [];
    for await (const chunk of serializeStream(fixture, fmt)) {
      chunkCount++;
      parts.push(chunk);
    }
    const text = parts.join('');
    // Decode via streaming from an adversarially small chunk source (7 bytes).
    const restored = await deserializeStream(chunked(text, 7), fmt, new Graph());
    const edgeIds = !lossy.has(fmt);
    const exp = lossy.has(fmt) ? lossyMask(fixture) : fixture;
    const got = lossy.has(fmt) ? lossyMask(restored) : restored;
    const ok = graphsEqual(exp, got, { edgeIds });
    line(
      `  ${ok ? PASS : FAIL} ${fmt.padEnd(9)} ${chunkCount} chunk(s) out, decoded from 7-byte slices -> ${summarize(restored)}`,
    );
  }

  // A genuinely large graph to prove streaming batches (>1 chunk, per README).
  const big = new Graph();
  for (let i = 0; i < 3000; i++) big.addVertex({ id: `n${i}`, labels: ['N'], properties: { i } });
  let bigChunks = 0;
  for await (const _ of serializeStream(big, 'ndjson')) bigChunks++;
  const bigText = await collect(serializeStream(big, 'ndjson'));
  const bigBack = await deserializeStream(chunked(bigText, 4096), 'ndjson');
  line(
    `  ${graphsEqual(big, bigBack, { edgeIds: true }) ? PASS : FAIL} ndjson large graph: 3000 vertices -> ${bigChunks} batched chunk(s) -> ${summarize(bigBack)}`,
  );
  line();

  // -- 4. malformed-input error case ---------------------------------------
  line('=== Malformed input (expect a thrown LenkeError) ===');
  // 4a. bad payload for a real format.
  try {
    deserialize('{ this is not valid pg-json ]]', 'pg-json');
    line(`  ${FAIL} pg-json: malformed input did NOT throw`);
  } catch (err) {
    const isLenke = err instanceof LenkeError;
    line(
      `  ${PASS} pg-json malformed: threw ${(err as Error).constructor.name}${isLenke ? ` (code=${(err as LenkeError).code})` : ''}`,
    );
  }
  // 4b. unknown format name (runtime guard).
  try {
    // @ts-expect-error deliberately passing an invalid format name
    serialize(fixture, 'ndsjon');
    line(`  ${FAIL} unknown format did NOT throw`);
  } catch (err) {
    line(
      `  ${PASS} unknown format: threw ${(err as Error).constructor.name} - "${(err as Error).message}"`,
    );
  }
  // 4c. streaming request on a non-streaming format.
  try {
    for await (const _ of serializeStream(fixture, 'pg-json')) {
      /* drain */
    }
    line(`  ${FAIL} streaming pg-json did NOT throw`);
  } catch (err) {
    line(
      `  ${PASS} stream on non-streaming format (pg-json): threw ${(err as Error).constructor.name} - "${(err as Error).message}"`,
    );
  }
  line();

  // -- 5. edge-case / null-fidelity per-format audit -----------------------
  line('=== Null + empty/singleton-list fidelity per format ===');
  for (const fmt of FORMATS) {
    const back = parse(serialize(fixture, fmt), fmt);
    const a = back.getVertexById('a');
    const nick = a?.hasProperty('nickname')
      ? JSON.stringify(a.getProperty('nickname'))
      : '<absent>';
    const empty = a?.hasProperty('prior') ? JSON.stringify(a.getProperty('prior')) : '<absent>';
    const single = a?.hasProperty('aliases')
      ? JSON.stringify(a.getProperty('aliases'))
      : '<absent>';
    const multi = a?.hasProperty('tags') ? JSON.stringify(a.getProperty('tags')) : '<absent>';
    line(
      `  ${fmt.padEnd(9)} null=${String(nick).padEnd(7)} empty[]=${String(empty).padEnd(10)} single[x]=${String(single).padEnd(9)} multi=${multi}`,
    );
  }
  line();
  line('Fixture original for reference:');
  line(`  a.nickname=null  a.prior=[]  a.aliases=["solo"]  a.tags=["x","y","z"]`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
