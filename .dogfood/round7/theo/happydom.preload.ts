// Minimal happy-dom global registration for `bun test` (the repo has happy-dom
// but not @happy-dom/global-registrator). Registers the DOM globals that
// @testing-library/react needs before any test module loads.
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;

for (const key of [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'Element',
  'Node',
  'Text',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  if (g[key] === undefined) {
    // @ts-expect-error dynamic bridge
    g[key] = win[key];
  }
}
// React 18 checks this to pick the DOM renderer path.
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;
