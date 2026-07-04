import { expect, test } from '@playwright/test';

// The slice, driven for real: React → createSyncClient → SharedWorker (wasm +
// createSyncEngine + OPFS) → WebSocket → the node server. If these pass, the
// browser-only paths that the headless bun/node suites can't touch actually work.

test('the map renders from the wasm engine, and SharedWorker + OPFS are live', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('service map');

  // A populated table proves: worker booted, wasm instantiated, the first
  // cluster demand-filled from the server, and the client rendered its rows.
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(1);

  // The browser-only capabilities the demo relies on are genuinely present.
  const caps = await page.evaluate(() => ({
    sharedWorker: typeof SharedWorker !== 'undefined',
    opfs: navigator.storage != null && 'getDirectory' in navigator.storage,
  }));
  expect(caps).toEqual({ sharedWorker: true, opfs: true });
});

test('live everywhere: a status flip in one tab appears in another', async ({ browser }) => {
  // One context = one origin = one SharedWorker store shared by both tabs.
  const ctx = await browser.newContext();
  const [a, b] = [await ctx.newPage(), await ctx.newPage()];
  await a.goto('/');
  await b.goto('/');

  const firstRow = a.locator('table tbody tr').first();
  await expect(firstRow.locator('select')).toBeVisible();
  const service = (await firstRow.locator('td').first().textContent())?.trim();
  expect(service).toBeTruthy();

  // Flip the first service to `down` in tab A (optimistic local write + queue).
  await firstRow.locator('select').selectOption('down');

  // Tab B, watching the same store, sees the epoch-routed push land on the
  // same-named row — no reload, no polling.
  const mirrored = b.locator('table tbody tr', { hasText: service! }).locator('select');
  await expect(mirrored).toHaveValue('down', { timeout: 15_000 });

  await ctx.close();
});
