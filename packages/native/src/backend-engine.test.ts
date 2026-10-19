import { describe, expect, test } from 'bun:test';
// Exercises the engine backends (FFI + wasm) through the shared Backend contract.
// Build the artifacts first:
//   bun run engine:build:rust && bun run engine:build:wasm
import { existsSync, readFileSync } from 'node:fs';

import { hasErrorCode, ErrorCode } from '@lenke/errors';

import { buildEngineBackend, type EngineAbi } from './backend-engine.js';
import { createFfiEngineBackend } from './backend-ffi-engine.js';
import { createWasmEngineBackend } from './backend-wasm-engine.js';
import type { Backend, GraphHandle } from './backend.js';

const SO = new URL(
  '../../../crates/lenke-engine/target/release/liblenke_engine.so',
  import.meta.url,
).pathname;
const WASM = new URL(
  '../../../crates/lenke-engine/target-wasm/wasm32-unknown-unknown/release/lenke_engine.wasm',
  import.meta.url,
).pathname;

const enc = new TextEncoder();
const dec = new TextDecoder();
const NDJSON = enc.encode(
  '{"id":"1","labels":["P"],"props":{"name":"alice","age":30}}\n' +
    '{"id":"2","labels":["P"],"props":{"name":"bob","age":25}}\n' +
    '{"from":"1","to":"2","id":"e0","type":"KNOWS","props":{}}\n',
);
const rows = (b: Uint8Array) =>
  JSON.parse(dec.decode(b)) as { columns: string[]; rows: unknown[][] };

// The behaviour every engine backend must satisfy, run against both transports.
const suite = (name: string, make: () => Promise<Backend> | Backend) => {
  describe(name, () => {
    test('load + counts + query', async () => {
      const be = await make();
      expect(be.abiVersion).toBe(19);
      const g = be.graphFromNdjson(NDJSON);
      expect(be.vertexCount(g)).toBe(2);
      expect(be.edgeCount(g)).toBe(1);
      expect(rows(be.queryRows(g, 'MATCH (n:P) RETURN count(*) AS c')).rows).toEqual([[2]]);
      be.graphFree(g);
    });

    test('params + gremlin', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const r = rows(
        be.queryRows(g, 'MATCH (n:P) WHERE n.name = $nm RETURN n.age AS a', '{"nm":"alice"}'),
      );
      expect(r.rows).toEqual([[30]]);
      // Gremlin path routes through the same lnk_query(lang=1).
      const gr = JSON.parse(dec.decode(be.gremlinJson(g, 'g.V().count()')));
      expect(gr).toEqual([2]);
      be.graphFree(g);
    });

    // `queryJson`/`gremlinText` are the TEXT twins of the byte forms (item 597). Over bun:ffi they
    // read the crate's buffer with a `CString` and an EXPLICIT LENGTH instead of
    // `toArrayBuffer` + `.slice()` + `TextDecoder.decode`; over wasm they fall back to decoding the
    // bytes. Two things need pinning, and neither is visible on an ASCII payload:
    //
    //   - the length. The crate's buffer is NOT NUL-terminated, so a zero-terminated read would
    //     scan past the payload into whatever the allocator left there.
    //   - the DECODING. A read that treated the bytes as latin1 would pass every ASCII test in
    //     this file and corrupt any string property that is not ASCII.
    //
    // The assertion is equality with the byte form, so the two transports are held to each other
    // as well as to the expected value.
    test('the text carrier matches the byte carrier, including multi-byte UTF-8', async () => {
      const be = await make();
      const g = be.graphFromNdjson(
        enc.encode(
          '{"id":"1","labels":["P"],"props":{"name":"café ☕","note":"日本語"}}\n' +
            '{"id":"2","labels":["P"],"props":{"name":"a\u{1d11e}b","note":"plain"}}\n',
        ),
      );

      const q = 'MATCH (n:P) RETURN n.name AS name, n.note AS note';
      const text = be.queryJson(g, q);

      expect(text).toBe(dec.decode(be.queryRows(g, q)));

      const doc = JSON.parse(text) as { columns: string[]; rows: unknown[][] };

      expect(doc.columns).toEqual(['name', 'note']);
      expect(doc.rows.map((r) => r[0]).sort()).toEqual(['a\u{1d11e}b', 'café ☕'].sort());
      expect(doc.rows.map((r) => r[1]).sort()).toEqual(['plain', '日本語'].sort());

      // A parameter whose VALUE is multi-byte, so the encode side is covered too.
      const withParam = be.queryJson(
        g,
        'MATCH (n:P) WHERE n.note = $t RETURN n.name AS name',
        JSON.stringify({ t: '日本語' }),
      );

      expect(withParam).toBe(
        dec.decode(
          be.queryRows(
            g,
            'MATCH (n:P) WHERE n.note = $t RETURN n.name AS name',
            JSON.stringify({ t: '日本語' }),
          ),
        ),
      );
      expect((JSON.parse(withParam) as { rows: unknown[][] }).rows).toEqual([['café ☕']]);

      // The Gremlin twin, over the same lnk_query(lang=1).
      const gText = be.gremlinText(g, "g.V().values('note')");

      expect(gText).toBe(dec.decode(be.gremlinJson(g, "g.V().values('note')")));
      expect((JSON.parse(gText) as string[]).sort()).toEqual(['plain', '日本語'].sort());

      // An EMPTY result: length 0, where a zero-terminated read has nothing to stop it.
      expect(be.queryJson(g, "MATCH (n:P) WHERE n.name = 'nobody' RETURN n.name AS name")).toBe(
        dec.decode(be.queryRows(g, "MATCH (n:P) WHERE n.name = 'nobody' RETURN n.name AS name")),
      );

      // A LONG carrier, past any small-string optimization in either route.
      const long = be.queryJson(g, 'MATCH (n:P), (m:P) RETURN n.name AS a, m.note AS b');

      expect(long).toBe(
        dec.decode(be.queryRows(g, 'MATCH (n:P), (m:P) RETURN n.name AS a, m.note AS b')),
      );
      be.graphFree(g);
    });

    test('version + index round-trip', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const v0 = be.version(g);
      be.queryRows(g, "MATCH (n:P) WHERE n.name = 'alice' SET n.age = 31");
      expect(be.version(g)).toBeGreaterThan(v0);
      be.createIndex(g, 'vertex', 'hash', ['age']);
      expect(be.vertexIndexes(g)).toContain('age');
      be.graphFree(g);
    });

    test('unique constraint: clean ok, violation throws', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      be.createUniqueConstraint(g, 'P', 'name'); // distinct names → ok
      const dup = be.graphFromNdjson(
        enc.encode(
          '{"id":"1","labels":["P"],"props":{"e":"x"}}\n{"id":"2","labels":["P"],"props":{"e":"x"}}\n',
        ),
      );
      let threw = false;

      try {
        be.createUniqueConstraint(dup, 'P', 'e');
      } catch (err) {
        threw = true;
        expect(hasErrorCode(err, ErrorCode.ConstraintViolation)).toBe(true);
      }

      expect(threw).toBe(true);
      be.graphFree(g);
      be.graphFree(dup);
    });

    test('lastWriteScope reports scopes AND the open fail-open flag', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);

      // A scoped node write: one distinct scope, fully classifiable → not open.
      be.queryRows(g, "INSERT (:Msg {room: '42'})");
      expect(be.lastWriteScope(g, 'room')).toEqual({ scopes: ['42'], open: false });

      // A node missing the scope key is unclassifiable → open (fail-open), no scope.
      be.queryRows(g, "INSERT (:Note {body: 'x'})");
      expect(be.lastWriteScope(g, 'room')).toEqual({ scopes: [], open: true });

      // An edge change has no node scope → open as well.
      be.queryRows(g, "MATCH (a:P {name: 'alice'}), (b:P {name: 'bob'}) INSERT (a)-[:R]->(b)");
      expect(be.lastWriteScope(g, 'room').open).toBe(true);

      be.graphFree(g);
    });

    test('prepared statement: reuse, then use-after-free is a clean error', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const p = be.prepare('MATCH (n:P) WHERE n.name = $nm RETURN n.age AS a');
      expect(rows(be.preparedQueryRows(p, g, '{"nm":"alice"}')).rows).toEqual([[30]]);
      expect(rows(be.preparedQueryRows(p, g, '{"nm":"bob"}')).rows).toEqual([[25]]);
      be.preparedFree(p);
      expect(() => be.preparedQueryRows(p, g, '{"nm":"alice"}')).toThrow();
      be.graphFree(g);
    });

    test('a prepared WRITE applies, not a silent no-op', async () => {
      // Regression: prepared_run went straight to the read executor, so a prepared
      // INSERT/SET returned [] and mutated nothing. It now routes through run_query.
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const ins = be.prepare('INSERT (:Q {v: $x})');
      be.preparedQueryRows(ins, g, '{"x": 7}');
      expect(rows(be.queryRows(g, 'MATCH (q:Q) RETURN count(*) AS c')).rows).toEqual([[1]]);
      expect(rows(be.queryRows(g, 'MATCH (q:Q) RETURN q.v AS v')).rows).toEqual([[7]]);
      const upd = be.prepare('MATCH (q:Q) SET q.v = $y');
      be.preparedQueryRows(upd, g, '{"y": 99}');
      expect(rows(be.queryRows(g, 'MATCH (q:Q) RETURN q.v AS v')).rows).toEqual([[99]]);
      be.preparedFree(ins);
      be.preparedFree(upd);
      be.graphFree(g);
    });

    test('auto-commit mergeNdjson enforces constraints (rejects + rolls back)', async () => {
      // Regression: a bare mergeNdjson skipped the deferred constraint recheck an
      // auto-commit INSERT runs, so a bulk append could load data violating a live
      // constraint (two rows under one unique key). It is now a checked transaction.
      const be = await make();
      const g = be.graphFromNdjson(NDJSON); // alice, bob (distinct names)
      be.createUniqueConstraint(g, 'P', 'name');
      const before = rows(be.queryRows(g, 'MATCH (n:P) RETURN count(*) AS c')).rows[0][0] as number;
      // Two nodes sharing a name violate UNIQUE(P.name) → the whole merge rolls back.
      expect(() =>
        be.mergeNdjson(
          g,
          enc.encode(
            '{"id":"7","labels":["P"],"props":{"name":"zed"}}\n' +
              '{"id":"8","labels":["P"],"props":{"name":"zed"}}\n',
          ),
        ),
      ).toThrow();
      expect(rows(be.queryRows(g, 'MATCH (n:P) RETURN count(*) AS c')).rows).toEqual([[before]]);
      // A valid merge still applies.
      be.mergeNdjson(g, enc.encode('{"id":"9","labels":["P"],"props":{"name":"quinn"}}\n'));
      expect(rows(be.queryRows(g, 'MATCH (n:P) RETURN count(*) AS c')).rows).toEqual([
        [before + 1],
      ]);
      be.graphFree(g);
    });

    test('snapshot round-trips (ndjson + binary)', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const asNdjson = be.encodeNdjson(g);
      const g2 = be.graphFromNdjson(asNdjson);
      expect(be.vertexCount(g2)).toBe(2);
      const asBinary = be.serialize(g, 'binary');
      const g3 = be.deserialize(asBinary, 'binary');
      expect(be.vertexCount(g3)).toBe(2);
      expect(be.edgeCount(g3)).toBe(1);
      [g, g2, g3].forEach((h) => be.graphFree(h));
    });

    test('textual codecs round-trip (pg-json, pg-text, graphson, csv)', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);

      for (const fmt of ['pg-json', 'pg-text', 'graphson', 'csv']) {
        const blob = be.serialize(g, fmt);
        const back = be.deserialize(blob, fmt);
        expect(be.vertexCount(back)).toBe(2);
        expect(be.edgeCount(back)).toBe(1);
        be.graphFree(back);
      }

      be.graphFree(g);
    });

    test('mergeNdjson is first-wins and reports skips + phantoms', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON); // nodes "1","2"
      const report = be.mergeNdjson(
        g,
        enc.encode(
          // a fresh node, a colliding id (skipped), and an edge to an undeclared node
          '{"id":"3","labels":["P"],"props":{"name":"cara"}}\n' +
            '{"id":"1","labels":["P"],"props":{"name":"OVERWRITE?"}}\n' +
            '{"from":"3","to":"ghost","type":"KNOWS","props":{}}\n',
        ),
      );
      expect(report.nodesAdded).toBe(1); // node 3
      expect(report.nodesSkipped).toEqual(['1']); // first-wins: existing kept
      expect(report.phantomVertices).toEqual(['ghost']);
      // The colliding node was NOT overwritten (first-wins).
      const name = rows(
        be.queryRows(g, "MATCH (n:P) WHERE n.name = 'alice' RETURN count(*) AS c"),
      ).rows;
      expect(name).toEqual([[1]]);
      be.graphFree(g);
    });

    test('an unknown serialization format is reported', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      expect(() => be.serialize(g, 'nope')).toThrow();
      be.graphFree(g);
    });

    test('constraints enforce and reject on write (type / cardinality / validator / invariant)', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      // Each declaration succeeds against the conforming seed data.
      be.createTypeConstraint(g, 'P', 'age', 'number');
      be.createValidator(g, 'P', 'p', 'p.age >= 0');
      be.createInvariant(g, 'nonneg', 'MATCH (p:P) RETURN p.age >= 0');
      // A conforming insert passes; a violating one throws ConstraintViolation.
      be.queryRows(g, "INSERT (:P {name: 'c', age: 40})");
      const bad = () => be.queryRows(g, "INSERT (:P {name: 'd', age: -1})");
      expect(bad).toThrow();

      try {
        bad();
      } catch (e) {
        expect(hasErrorCode(e, ErrorCode.ConstraintViolation)).toBe(true);
      }

      // A wrong-typed value is a ConstraintViolation too.
      expect(() => be.queryRows(g, "INSERT (:P {name: 'e', age: 'old'})")).toThrow();
      be.graphFree(g);
    });

    test('dropIndex, edge constraints, and dumpSchema round-trip', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      be.createIndex(g, 'vertex', 'hash', ['age']);
      expect(be.vertexIndexes(g)).toContain('age');
      be.dropVertexIndex(g, 'age');
      expect(be.vertexIndexes(g)).not.toContain('age');
      // Edge unique exempts null, so it declares cleanly over the propless seed edge.
      be.createEdgeUniqueConstraint(g, 'KNOWS', 'w');
      be.createCardinalityConstraint(g, 'P', 'KNOWS', 'out', 0, null);
      // The declared schema round-trips through dumpSchema.
      const ops = be.dumpSchema(g).map((o) => o.op);
      expect(ops).toContain('createEdgeUniqueConstraint');
      expect(ops).toContain('createCardinalityConstraint');
      be.graphFree(g);
    });

    test('direct algorithm run returns a node/result rowset', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const out = JSON.parse(dec.decode(be.algo(g, 'degree', '{"direction":"out"}'))) as {
        columns: string[];
        rows: unknown[][];
      };
      expect(out.columns[0]).toBe('node');
      expect(out.rows.length).toBe(2);
      be.graphFree(g);
    });

    test('prepared statement can return an Arrow carrier', async () => {
      const be = await make();
      const g = be.graphFromNdjson(NDJSON);
      const p = be.prepare('MATCH (n:P) RETURN n.age AS a');
      const arrow = be.preparedQueryArrow(p, g);
      expect(arrow.byteLength).toBeGreaterThan(0);
      be.preparedFree(p);
      be.graphFree(g);
    });
  });
};

if (existsSync(SO)) {
  suite('engine FFI backend', () => createFfiEngineBackend(SO));
} else {
  test.skip(`engine FFI backend (missing ${SO} — run \`bun run engine:build:rust\`)`, () => {});
}

if (existsSync(WASM)) {
  suite('engine wasm backend', () => createWasmEngineBackend(readFileSync(WASM)));
} else {
  test.skip(`engine wasm backend (missing ${WASM} — run \`bun run engine:build:wasm\`)`, () => {});
}

// `buildEngineBackend`'s ROUTE CHOICE for a text carrier, tested over a fake ABI rather than a
// real transport (item 597).
//
// WHY THIS TEST EXISTS. `queryJson` prefers `abi.queryText` and falls back to decoding
// `abi.query`'s bytes. Both routes return the same string, so a mutant that makes it always take
// the fallback is ANSWER-EQUIVALENT and survived the entire 925-test suite — the same shape as the
// route-choice mutants that have survived here before. Nothing about the result can catch it, so
// the test has to observe WHICH route ran.
describe('buildEngineBackend route choice for a text carrier', () => {
  const fakeAbi = (withText: boolean) => {
    const calls = { query: 0, queryText: 0 };
    const abi = {
      abiVersion: 19,
      open: () => 1 as unknown as GraphHandle,
      close: () => {},
      clone: () => 1 as unknown as GraphHandle,
      config: () => 1,
      stat: () => 0,
      query: () => {
        calls.query += 1;

        return enc.encode('{"columns":[],"rows":[]}');
      },
      ...(withText
        ? {
            queryText: () => {
              calls.queryText += 1;

              return '{"columns":[],"rows":[]}';
            },
          }
        : {}),
      tx: () => {},
      schemaApply: () => {},
      schemaDump: () => new Uint8Array(),
      encode: () => new Uint8Array(),
      command: () => enc.encode('{}'),
    } as unknown as EngineAbi;

    return { be: buildEngineBackend(abi), calls };
  };

  test('queryJson takes the queryText route when the ABI has one', () => {
    const { be, calls } = fakeAbi(true);
    const h = 1 as unknown as GraphHandle;

    expect(be.queryJson(h, 'RETURN 1 AS n')).toBe('{"columns":[],"rows":[]}');
    expect(calls).toEqual({ query: 0, queryText: 1 });

    expect(be.gremlinText(h, 'g.V().count()')).toBe('{"columns":[],"rows":[]}');
    expect(calls).toEqual({ query: 0, queryText: 2 });

    // The BYTE forms must stay on `abi.query` — they are what the consumers wanting bytes use.
    be.queryRows(h, 'RETURN 1 AS n');
    expect(calls).toEqual({ query: 1, queryText: 2 });
  });

  test('queryJson falls back to decoding bytes when the ABI has no queryText', () => {
    const { be, calls } = fakeAbi(false);
    const h = 1 as unknown as GraphHandle;

    // Same answer by the other route — which is exactly why the result cannot catch a mutant here.
    expect(be.queryJson(h, 'RETURN 1 AS n')).toBe('{"columns":[],"rows":[]}');
    expect(be.gremlinText(h, 'g.V().count()')).toBe('{"columns":[],"rows":[]}');
    expect(calls).toEqual({ query: 2, queryText: 0 });
  });
});
