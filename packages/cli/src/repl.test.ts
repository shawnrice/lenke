import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pid } from 'node:process';

import { openBackend } from './engine.js';
import { emptyGraph } from './io.js';
import { makeGlobals, render } from './repl.js';

const backend = await openBackend();

const withMarko = () => {
  const g = emptyGraph(backend);
  g.query("INSERT (:Person {name: 'marko'})");
  g.query("INSERT (:Person {name: 'josh'})");

  return g;
};

describe('render (the REPL result writer)', () => {
  test('a graph renders as a summary', () => {
    const g = withMarko();

    expect(render(g, false)).toContain('Graph —');
    g.free();
  });

  test('an array of rows renders as a bordered table', () => {
    const out = render([{ name: 'marko' }], false);

    expect(out).toContain('┌');
    expect(out).toContain('marko');
  });

  test('bare scalars get a value column', () => {
    expect(render([1, 2], false)).toContain('value');
  });

  test('a string passes through; anything else goes via util.inspect', () => {
    expect(render('saved x', false)).toBe('saved x');
    expect(render(42, false)).toContain('42');
  });
});

describe('makeGlobals', () => {
  test('query / gremlin / describe run against the current session graph', () => {
    const session = { graph: withMarko(), backend };
    const globals = makeGlobals(session, false) as {
      query: (t: string) => unknown[];
      gremlin: (t: string) => unknown[];
      describe: () => { vertices: number };
    };

    expect(globals.query('MATCH (p:Person) RETURN p.name')).toHaveLength(2);
    expect(globals.gremlin('g.V().count()')).toEqual([2]);
    expect(globals.describe().vertices).toBe(2);
    session.graph.free();
  });

  test('save() writes a file and load() swaps the session graph', () => {
    const session = { graph: withMarko(), backend };
    const globals = makeGlobals(session, false) as {
      save: (f: string, fmt?: string) => string;
      load: (f: string, fmt?: string) => { vertexCount: number };
    };
    const file = join(tmpdir(), `lenke-cli-${pid}.ndjson`);

    try {
      expect(globals.save(file, 'ndjson')).toContain('saved');

      const loaded = globals.load(file); // frees the old graph, installs the new one

      expect(loaded.vertexCount).toBe(2);
      expect(session.graph.vertexCount).toBe(2); // the getter sees the swap
    } finally {
      unlinkSync(file);
      session.graph.free();
    }
  });
});
