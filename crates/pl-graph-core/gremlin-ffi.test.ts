// Proves the textual Gremlin query language crosses the FFI boundary: ship a
// Gremlin string, parse + execute in Rust, get a JSON result array back. This is
// the Gremlin analogue of plg_query_rows / plg_query_arrow for GQL.
//
// Run: bun test ./crates/pl-graph-core/gremlin-ffi.test.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';
import { describe, expect, test } from 'bun:test';

const lib = dlopen(new URL('./target/release/libpl_graph_core.dylib', import.meta.url).pathname, {
  plg_graph_from_ndjson: {
    args: [FFIType.ptr, FFIType.u64_fast, FFIType.u32],
    returns: FFIType.ptr,
  },
  plg_graph_free: { args: [FFIType.ptr], returns: FFIType.void },
  plg_gremlin_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
    returns: FFIType.ptr,
  },
  plg_free_buf: { args: [FFIType.ptr, FFIType.u64_fast], returns: FFIType.void },
});

const modern = [
  '{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}',
  '{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java"}}',
  '{"type":"edge","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}',
  '{"type":"edge","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}',
  '{"type":"edge","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}',
  '{"type":"edge","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}',
  '{"type":"edge","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}',
].join('\n');

function gremlin(g: number, query: string): unknown {
  const q = new TextEncoder().encode(query);
  const outLen = new BigUint64Array(1);
  const p = lib.symbols.plg_gremlin_json(g, ptr(q), q.byteLength, ptr(outLen));
  if (!p) {
    throw new Error(`gremlin query failed: ${query}`);
  }
  const len = Number(outLen[0]);
  const json = new TextDecoder().decode(toArrayBuffer(p as number, 0, len));
  lib.symbols.plg_free_buf(p, len);
  return JSON.parse(json);
}

describe('textual Gremlin over bun:ffi', () => {
  const ndBuf = new TextEncoder().encode(modern);
  const g = lib.symbols.plg_graph_from_ndjson(ptr(ndBuf), ndBuf.byteLength, 0) as number;

  test("marko's friends' names", () => {
    const r = gremlin(g, "g.V().has('name','marko').out('KNOWS').values('name')") as string[];
    expect(r.sort()).toEqual(['josh', 'vadas']);
  });

  test('count persons', () => {
    expect(gremlin(g, "g.V().hasLabel('PERSON').count()")).toEqual([4]);
  });

  test('groupCount by label → one map', () => {
    expect(gremlin(g, 'g.V().groupCount().by(T.label)')).toEqual([{ PERSON: 4, SOFTWARE: 2 }]);
  });

  test('vertex serializes with id and label', () => {
    expect(gremlin(g, "g.V('1')")).toEqual([{ id: '1', label: 'PERSON' }]);
  });

  test('predicate + order', () => {
    const r = gremlin(g, "g.V().hasLabel('PERSON').order().by('age', desc).values('name')");
    expect(r).toEqual(['peter', 'josh', 'marko', 'vadas']);
  });
});
