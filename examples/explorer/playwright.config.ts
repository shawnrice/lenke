import { defineConfig, devices } from '@playwright/test';

// Boots vite and drives the explorer in a real Chromium. Assertions are chosen
// to be robust to the live force simulation: element counts and opacity, never a
// click on a moving node. Run: bunx playwright test  (from this dir).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:5200', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'bun run dev -- --port 5200 --strictPort',
      port: 5200,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
