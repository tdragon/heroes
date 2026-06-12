import { expect, test } from '@playwright/test';

test('page loads and title is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Heroes Clone');
  await expect(page.getByTestId('game-title')).toBeVisible();
  await expect(page.getByTestId('game-title')).toHaveText('Heroes Clone');
});
