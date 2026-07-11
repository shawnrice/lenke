// Minimal happy-dom global registrator so @testing-library/react can render
// headlessly under `bun run-react.tsx` (no @happy-dom/global-registrator dep at
// the repo root). Mirrors what that package does: copy the Window's own
// properties onto globalThis.
import { Window } from 'happy-dom';

export function registerDom(): void {
  if ((globalThis as { document?: unknown }).document) return;
  const win = new Window({ url: 'http://localhost/' });
  const g = globalThis as Record<string, unknown>;
  const proto = Object.getPrototypeOf(win);
  for (const key of [...Object.getOwnPropertyNames(win), ...Object.getOwnPropertyNames(proto)]) {
    if (key in g && key !== 'undefined') continue;
    try {
      const v = (win as unknown as Record<string, unknown>)[key];
      g[key] = typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(win) : v;
    } catch {
      /* some accessors throw off-window; skip */
    }
  }
  g.window = win;
  g.self = win;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}
