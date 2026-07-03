// Vite asset-URL imports: `import wasmUrl from '….wasm?url'` resolves to the
// served/bundled asset URL string.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
