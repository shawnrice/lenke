import { expect, test } from '@playwright/test';

// The sample is the TinkerPop "Modern" graph: 6 vertices, 6 edges.

test('renders the sample graph as a node-link diagram', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('6 vertices · 6 edges')).toBeVisible();
  await expect(page.locator('svg circle')).toHaveCount(6);
  await expect(page.locator('svg line')).toHaveCount(6);
});

test('a GQL query dims the non-matching vertices', async ({ page }) => {
  await page.goto('/');

  await page.getByPlaceholder(/GQL/).fill('MATCH (p:PERSON) WHERE p.age > 30 RETURN p');
  await page.getByRole('button', { name: 'Highlight' }).click();

  // Two people (josh 32, peter 35) are over 30 → the other four vertices dim.
  await expect(page.locator('svg g[opacity="0.2"]')).toHaveCount(4);

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('svg g[opacity="0.2"]')).toHaveCount(0);
});
