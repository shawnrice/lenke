export { main } from './cli.js';
export { classify, runQuery, type Lang, type QueryResult } from './query.js';
export {
  detectFormat,
  emptyGraph,
  FORMATS,
  formatFor,
  isFormat,
  loadGraph,
  saveGraph,
  type Backend,
  type Format,
} from './io.js';
export { openBackend, resolveWasmPath } from './engine.js';
export { runRepl, type ReplContext } from './repl.js';
