declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __DEV__: boolean | undefined;
}

/**
 * Timing is opt-in: set `globalThis.__DEV__ = true` (typically in your
 * dev/test entry point) to enable timer/sampleTimer logging.
 */
export const isTimingEnabled = (): boolean =>
  globalThis.__DEV__ === true && typeof performance?.now !== 'undefined';
