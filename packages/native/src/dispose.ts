/**
 * Guarantee the well-known `Symbol.dispose` (TC39 Explicit Resource Management)
 * exists before it is used as a computed key. Runtimes predating the proposal
 * (older browsers) don't define it, so fall back to the global-registry symbol
 * `Symbol.for('Symbol.dispose')` and assign it to the `Symbol.dispose` slot — the
 * same slot a consumer's `using` reads, whether native or down-levelled by
 * TS/esbuild to a `try/finally`.
 *
 * Exposed as a function (a used value, so a bundler keeps it under
 * `sideEffects: false`, unlike a bare side-effect import) and called before any
 * `[Symbol.dispose]` object is built.
 */
export const ensureDisposeSymbol = (): void => {
  if (typeof (Symbol as { dispose?: symbol }).dispose !== 'symbol') {
    (Symbol as { dispose: symbol }).dispose = Symbol.for('Symbol.dispose');
  }
};
