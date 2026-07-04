import { defineConfig, devices } from '@playwright/test';

// End-to-end harness for the vertical slice in a REAL browser — the paths the
// bun/node tests can't reach: the SharedWorker, the wasm engine, OPFS, and the
// worker↔tab MessagePort push. Boots the authoritative ws server AND vite, then
// drives the demo in Chromium. Run: bunx playwright test  (from this dir)
export default defineConfig({
  testDir: './e2e',
  // The worker has to boot, fetch+instantiate the wasm, and demand-fill the
  // first cluster from the server before anything renders — be patient.
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:5199', trace: 'retain-on-failure' },
  // Two servers: the embedded-lenke ws host (napi addon) and the vite dev
  // server on a dedicated port (5173 is a common collision). `port` readiness
  // just waits for the TCP listener to accept. The ws port stays 8787 — the
  // worker hardcodes ws://localhost:8787.
  webServer: [
    { command: 'node server.ts', port: 8787, reuseExistingServer: true, stdout: 'pipe' },
    {
      command: 'bun run dev -- --port 5199 --strictPort',
      port: 5199,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
