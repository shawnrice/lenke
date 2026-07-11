// Minimal happy-dom global registrator.
//
// The repo has `happy-dom` but NOT the `@happy-dom/global-registrator` helper
// package, so we register a DOM onto `globalThis` by hand: React 18's
// react-dom/client and @testing-library/react read `window`, `document`,
// `navigator`, and the DOM element constructors off the global scope.
import { GlobalWindow } from 'happy-dom';

let registered = false;

export function registerDom(): void {
  if (registered) return;
  registered = true;

  const win = new GlobalWindow();
  const g = globalThis as unknown as Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g) continue;
    const desc = Object.getOwnPropertyDescriptor(win, key);
    if (!desc) continue;
    try {
      Object.defineProperty(g, key, desc);
    } catch {
      // some props are non-configurable on the window; skip them
    }
  }

  // `window` must resolve to the global object itself so identity checks pass.
  g.window = g;
  if (!('self' in g)) g.self = g;
}

// Register on import so that placing this module FIRST in an import list sets up
// the DOM before @testing-library/react / react-dom module bodies evaluate.
registerDom();
