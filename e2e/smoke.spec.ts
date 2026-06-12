import { expect, test } from '@playwright/test';

test('page loads and title is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Open Heroes');
  const logo = page.getByTestId('game-title');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', 'Open Heroes');
});
