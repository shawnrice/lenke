// Minimal ANSI styling. Color is a dev nicety, so it's off unless we're writing
// to a real terminal — auto-detected from `process.stdout.isTTY` with `NO_COLOR`
// honored, and overridable per call. In a browser / wasm context there's no
// `process`, so it stays off. `Style` is a set of painters; when color is off
// every painter is the identity, so callers never branch on it.

export type Style = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
};

export type ColorOption = {
  /** Force color on/off. Default: on only when stdout is a TTY and NO_COLOR is unset. */
  color?: boolean;
};

const wrap =
  (code: number): ((s: string) => string) =>
  (s) =>
    `\x1b[${code}m${s}\x1b[0m`;

const identity = (s: string): string => s;

const PLAIN: Style = {
  bold: identity,
  dim: identity,
  cyan: identity,
  green: identity,
  yellow: identity,
};

const COLOR: Style = {
  bold: wrap(1),
  dim: wrap(2),
  cyan: wrap(36),
  green: wrap(32),
  yellow: wrap(33),
};

const autoColor = (): boolean => {
  const proc = (
    globalThis as {
      process?: { stdout?: { isTTY?: boolean }; env?: Record<string, string | undefined> };
    }
  ).process;

  return Boolean(proc?.stdout?.isTTY) && !proc?.env?.NO_COLOR;
};

export const styleFor = (color: boolean | undefined): Style =>
  (color ?? autoColor()) ? COLOR : PLAIN;
