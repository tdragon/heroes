import { expect, test, type Page } from '@playwright/test';

const TILE = 48;

test.use({ viewport: { width: 1280, height: 800 } });

async function canvasPoint(page: Page, tileX: number, tileY: number): Promise<[number, number]> {
  const canvas = page.getByTestId('adventure-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('adventure canvas not visible');
  return [box.x + (tileX + 0.5) * TILE, box.y + (tileY + 0.5) * TILE];
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?map=tutorial-valley&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
});

test('select hero and move with click-confirm-click', async ({ page }) => {
  await page.getByTestId('hero-item-edric').click();
  await expect(page.getByTestId('hero-pos')).toHaveText('4,5');

  // camera is clamped to the map origin, so tile coords map directly to pixels
  await expect(page.getByTestId('adventure-canvas')).toHaveAttribute('data-camera-x', '0');
  const [px, py] = await canvasPoint(page, 8, 5);
  await page.mouse.click(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');
  await page.mouse.click(px, py);
  await expect(page.getByTestId('hero-pos')).toHaveText('8,5');
});

test('end turn advances the day and pays income', async ({ page }) => {
  await expect(page.getByTestId('resource-gold')).toContainText('20000');
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 1, Week 1, Month 1');

  await page.getByTestId('end-turn-button').click();

  // village hall pays +500 gold at dawn; AI opponent passes automatically
  await expect(page.getByTestId('resource-gold')).toContainText('20500');
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');
});

test('minimap click jumps the viewport', async ({ page }) => {
  const canvas = page.getByTestId('adventure-canvas');
  await expect(canvas).toHaveAttribute('data-camera-x', '0');
  await expect(canvas).toHaveAttribute('data-camera-y', '0');

  const minimap = page.getByTestId('minimap');
  const box = await minimap.boundingBox();
  if (!box) throw new Error('minimap not visible');
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);

  // tile (32,32) centered: clamped to the world's bottom-right corner
  await expect(canvas).toHaveAttribute('data-camera-x', '728');
  await expect(canvas).toHaveAttribute('data-camera-y', '968');
});

test('keyboard shortcuts: E ends turn, H selects hero, Space visits, arrows pan', async ({
  page,
}) => {
  // E ends the turn (AI passes, day advances)
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 1, Week 1, Month 1');
  await page.keyboard.press('e');
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  // H selects the next hero
  await page.keyboard.press('h');
  await expect(page.getByTestId('hero-pos')).toHaveText('4,5');

  // Space on the own town tile opens the town screen, Escape closes it
  await page.keyboard.press('Space');
  await expect(page.getByTestId('town-screen')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('town-screen')).not.toBeVisible();

  // arrow keys pan the camera by one tile
  const canvas = page.getByTestId('adventure-canvas');
  await expect(canvas).toHaveAttribute('data-camera-x', '0');
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-camera-x', '48');
  await page.keyboard.press('ArrowDown');
  await expect(canvas).toHaveAttribute('data-camera-y', '48');
});

test('right-click shows an info popup for the hovered entity', async ({ page }) => {
  const [px, py] = await canvasPoint(page, 4, 5);
  await page.mouse.click(px, py, { button: 'right' });
  await expect(page.getByTestId('info-popup')).toBeVisible();
  await expect(page.getByTestId('info-popup')).toContainText('Edric');
});
