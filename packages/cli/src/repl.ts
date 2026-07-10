import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { formatGraph } from '@lenke/inspect';
import type { RustGraph } from '@lenke/native';

import { type Backend, emptyGraph, formatFor, loadGraph, saveGraph } from './io.js';
import { type Lang, runQuery } from './query.js';

export type ReplContext = {
  graph: RustGraph;
  backend: Backend;
  color: boolean;
};

const HELP = `Commands:
  <query>             run a query — GQL, or Gremlin when it starts with "g."
  .gql <query>        run the query as GQL
  .gremlin <query>    run the query as Gremlin
  .describe           summarize the graph (labels, counts, indexes)
  .load <file> [fmt]  load a graph from a file (replaces the current one)
  .save <file> [fmt]  serialize the graph to a file
  .clear              start over with an empty graph
  .help               show this
  .exit               quit (or Ctrl-D)`;

const emit = (s: string): void => void stdout.write(`${s}\n`);

const paint = (ctx: ReplContext, code: number, s: string): string =>
  ctx.color ? `\x1b[${code}m${s}\x1b[0m` : s;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const freeGraph = (graph: RustGraph): void => {
  try {
    graph.free();
  } catch {
    // already freed / backend gone — nothing to reclaim
  }
};

const swapGraph = (ctx: ReplContext, next: RustGraph): void => {
  const previous = ctx.graph;
  ctx.graph = next;
  freeGraph(previous);
};

const runInto = (ctx: ReplContext, out: (s: string) => void, text: string, lang?: Lang): void => {
  try {
    out(runQuery(ctx.graph, text, lang ?? undefined, ctx.color).output);
  } catch (err) {
    out(paint(ctx, 31, errorMessage(err)));
  }
};

// Handle a `.command`. Returns 'exit' to end the session.
const handleMeta = async (
  line: string,
  ctx: ReplContext,
  out: (s: string) => void,
): Promise<'exit' | undefined> => {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case 'help':
    case 'h':
      out(HELP);

      return undefined;
    case 'describe':
    case 'd':
      out(formatGraph(ctx.graph, { color: ctx.color }));

      return undefined;
    case 'gql':
      runInto(ctx, out, arg, 'gql');

      return undefined;
    case 'gremlin':
    case 'g':
      runInto(ctx, out, arg, 'gremlin');

      return undefined;
    case 'load': {
      const [file, fmt] = rest;

      if (!file) {
        out('usage: .load <file> [format]');

        return undefined;
      }

      swapGraph(
        ctx,
        loadGraph(ctx.backend, new Uint8Array(await readFile(file)), formatFor(file, fmt)),
      );
      out(
        paint(
          ctx,
          2,
          `loaded ${file} — ${ctx.graph.vertexCount} vertices, ${ctx.graph.edgeCount} edges`,
        ),
      );

      return undefined;
    }
    case 'save': {
      const [file, fmt] = rest;

      if (!file) {
        out('usage: .save <file> [format]');

        return undefined;
      }

      const format = formatFor(file, fmt);
      await writeFile(file, saveGraph(ctx.graph, format));
      out(paint(ctx, 2, `saved ${file} (${format})`));

      return undefined;
    }
    case 'clear':
      swapGraph(ctx, emptyGraph(ctx.backend));
      out(paint(ctx, 2, 'cleared'));

      return undefined;
    case 'exit':
    case 'quit':
    case 'q':
      return 'exit';
    default:
      out(paint(ctx, 31, `unknown command '.${cmd}' — try .help`));

      return undefined;
  }
};

/** The interactive read-eval-print loop. Resolves when the user exits. */
export const runRepl = async (ctx: ReplContext): Promise<void> => {
  const rl = createInterface({ input: stdin, output: stdout });

  emit(paint(ctx, 2, 'lenke — GQL/Gremlin REPL. .help for commands, .exit to quit.'));

  try {
    for (;;) {
      let line: string;

      try {
        line = await rl.question('lenke> ');
      } catch {
        break; // stream closed (Ctrl-D / piped EOF)
      }

      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('.')) {
        if ((await handleMeta(trimmed, ctx, emit)) === 'exit') {
          break;
        }

        continue;
      }

      runInto(ctx, emit, trimmed);
    }
  } finally {
    rl.close();
    freeGraph(ctx.graph);
  }
};
