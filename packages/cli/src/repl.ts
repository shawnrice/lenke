import { readFileSync, writeFileSync } from 'node:fs';
import { stdout } from 'node:process';
import repl from 'node:repl';
import { inspect } from 'node:util';

import { describe as inspectDescribe, formatGraph, formatRows, type Row } from '@lenke/inspect';
import type { RustGraph } from '@lenke/native';

import { type Backend, FORMATS, formatFor, loadGraph, saveGraph } from './io.js';

export type ReplContext = {
  graph: RustGraph;
  backend: Backend;
  color: boolean;
};

// The current graph lives in a mutable session so `load()` can swap it and every
// helper (and the `g` getter) sees the new one.
type Session = { graph: RustGraph; backend: Backend };

const freeGraph = (graph: RustGraph): void => {
  try {
    graph.free();
  } catch {
    // already freed / backend gone — nothing to reclaim
  }
};

const isGraph = (value: unknown): value is RustGraph =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { query?: unknown }).query === 'function' &&
  typeof (value as { vertexCount?: unknown }).vertexCount === 'number';

// Wrap bare scalars (Gremlin returns a heterogeneous stream) so any array renders
// as a table while the raw array stays the value the user can keep slicing.
const asRows = (items: readonly unknown[]): Row[] =>
  items.map((item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Row)
      : { value: item },
  );

/** The REPL's result renderer: graphs → summary, arrays → table, else util.inspect. */
export const render = (value: unknown, color: boolean): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (isGraph(value)) {
    return formatGraph(value, { color });
  }

  if (Array.isArray(value)) {
    return formatRows(asRows(value), { color });
  }

  return inspect(value, { colors: color });
};

/**
 * The lenke helpers injected into the REPL context. Extracted (and exported) so
 * the wiring can be unit-tested without standing up a live REPL.
 */
export const makeGlobals = (session: Session, color: boolean): Record<string, unknown> => ({
  query: (text: string, params?: Record<string, unknown>) => session.graph.query(text, params),
  gremlin: (text: string) => session.graph.gremlin(text),
  load: (file: string, format?: string): RustGraph => {
    const next = loadGraph(
      session.backend,
      new Uint8Array(readFileSync(file)),
      formatFor(file, format),
    );

    freeGraph(session.graph);
    session.graph = next;

    return next;
  },
  save: (file: string, format?: string): string => {
    const fmt = formatFor(file, format);

    writeFileSync(file, saveGraph(session.graph, fmt));

    return `saved ${file} (${fmt})`;
  },
  describe: (graph: RustGraph = session.graph) => inspectDescribe(graph),
  table: (rows: readonly Row[]) => formatRows(rows, { color }),
  formats: FORMATS,
});

const BANNER = `lenke — a GQL/Gremlin REPL on Node's REPL, so full JavaScript is available too.
Helpers:
  g                    the current graph            query('…')  run GQL → rows
  gremlin('…')         run a Gremlin traversal      table(rows) render rows as a table
  load('file'[,fmt])   load a graph (replaces g)    save('file'[,fmt])  serialize it
  describe([graph])    graph summary object
Type g for a summary; .exit or Ctrl-D to quit.`;

/**
 * Start an interactive session: Node's REPL with the lenke helpers preloaded, so
 * you get the whole language (multiline, await, history, tab-complete) plus
 * auto-rendered tables. Node-only — Bun's `node:repl` has no `start()`.
 */
export const runRepl = (ctx: ReplContext): Promise<void> => {
  if (typeof repl.start !== 'function') {
    throw new Error(
      "The interactive REPL needs Node (this runtime's node:repl has no start()). " +
        'Run it under `node`, or use one-shot mode: lenke <file> -q "<query>".',
    );
  }

  const session: Session = { graph: ctx.graph, backend: ctx.backend };

  stdout.write(`${BANNER}\n`);

  const server = repl.start({
    prompt: 'lenke> ',
    useColors: ctx.color,
    ignoreUndefined: true,
    writer: (value: unknown) => render(value, ctx.color),
  });

  Object.assign(server.context, makeGlobals(session, ctx.color));
  Object.defineProperty(server.context, 'g', {
    get: () => session.graph,
    enumerable: true,
    configurable: true,
  });

  return new Promise((resolve) => {
    server.on('exit', () => {
      freeGraph(session.graph);
      resolve();
    });
  });
};
