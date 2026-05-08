// Backward-compat shim. Existing `from './executor.js'` imports continue to
// work; new code should import from `./executor/index.js` (or the package
// barrel `./index.js`, which re-exports the same names).
export * from './executor/index.js';
