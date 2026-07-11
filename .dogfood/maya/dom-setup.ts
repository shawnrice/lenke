/**
 * Minimal happy-dom registration so @testing-library/react can render headlessly
 * under `bun test`. The repo has `happy-dom` but NOT `@happy-dom/global-registrator`
 * (Bun's usual DOM shim), so we register the handful of globals react-dom needs by
 * hand. Preloaded via `bun test --preload ./dom-setup.ts`, so these exist before
 * react-dom is imported.
 */
import { Window } from 'happy-dom';

const w = new Window({ url: 'http://localhost' });
const g = globalThis as unknown as Record<string, unknown>;

g.window = w;
g.document = w.document;
g.navigator = w.navigator;
for (const k of [
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Text',
  'DocumentFragment',
  'MutationObserver',
]) {
  if ((w as unknown as Record<string, unknown>)[k] !== undefined) {
    g[k] = (w as unknown as Record<string, unknown>)[k];
  }
}

// React 18 wants this flag set for `act()` to work without warnings.
g.IS_REACT_ACT_ENVIRONMENT = true;
