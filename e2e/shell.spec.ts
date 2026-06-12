import { expect, test, type Page } from '@playwright/test';
import { canvasPoint } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

async function startTinyGame(page: Page, opts: { hotseat?: boolean } = {}): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await page.getByTestId('menu-new-game').click();
  await expect(page.getByTestId('new-game-setup')).toBeVisible();
  await page.getByTestId('map-option-tiny').click();
  if (opts.hotseat === true) {
    await page.getByTestId('hotseat-toggle').check();
    await expect(page.getByTestId('player-control-blue')).toHaveText('Human');
  }
  await page.getByTestId('seed-input').fill('42');
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
}

test('menu shows new game setup with map list and player config', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await expect(page.getByTestId('menu-settings')).toBeDisabled();

  await page.getByTestId('menu-new-game').click();
  await expect(page.getByTestId('map-option-tutorial-valley')).toContainText('2 players');
  await expect(page.getByTestId('map-option-contested-river')).toContainText('3 players');

  await page.getByTestId('map-option-tiny').click();
  await expect(page.getByTestId('player-control-red')).toHaveText('Human');
  await expect(page.getByTestId('player-control-blue')).toHaveText('AI');
  await expect(page.getByTestId('faction-select-red')).toHaveValue('castle');
  await expect(page.getByTestId('difficulty-select')).toHaveValue('normal');

  await page.getByTestId('setup-back').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('an empty ?map= boot param falls back to the main menu', async ({ page }) => {
  await page.goto('/?map=');
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('full happy path: new game, play 2 days, save, reload, load — state intact', async ({
  page,
}) => {
  await startTinyGame(page);
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 1, Week 1, Month 1');

  // move the hero so the restored position is distinguishable from the start
  await page.getByTestId('hero-item-edric').click();
  await expect(page.getByTestId('hero-pos')).toHaveText('2,2');
  const [px, py] = await canvasPoint(page, 4, 2);
  await page.mouse.click(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');
  await page.mouse.click(px, py);
  await expect(page.getByTestId('hero-pos')).toHaveText('4,2');

  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');
  // the blue AI walks into the undefended red town: the loss is surfaced
  await expect(page.getByTestId('modal-message')).toContainText('captured by blue');
  await page.getByTestId('dialog-ok').click();
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 3, Week 1, Month 1');

  await page.getByTestId('system-button').click();
  await expect(page.getByTestId('system-panel')).toBeVisible();
  await page.getByTestId('save-slot-1').click();
  await expect(page.getByTestId('slot-info-1')).toContainText('tiny — Day 3');

  await page.reload();
  await expect(page.getByTestId('main-menu')).toBeVisible();
  await page.getByTestId('menu-load-game').click();
  await expect(page.getByTestId('slot-info-1')).toContainText('tiny — Day 3');
  await page.getByTestId('load-slot-1').click();

  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 3, Week 1, Month 1');
  await page.getByTestId('hero-item-edric').click();
  await expect(page.getByTestId('hero-pos')).toHaveText('4,2');
});

test('autosave appears in the load list after a day passes', async ({ page }) => {
  await startTinyGame(page);
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  await page.getByTestId('system-button').click();
  await expect(page.getByTestId('system-panel')).toContainText('Autosave: tiny — Day 2');
  await page.getByTestId('system-close').click();
  await expect(page.getByTestId('system-panel')).not.toBeVisible();
});

test('quit to menu returns to the main menu', async ({ page }) => {
  await startTinyGame(page);
  await page.getByTestId('system-button').click();
  await page.getByTestId('quit-to-menu').click();
  await expect(page.getByTestId('main-menu')).toBeVisible();
});

test('hotseat: pass-device screen appears and switches the viewed player', async ({ page }) => {
  await startTinyGame(page, { hotseat: true });

  // red's turn first
  await expect(page.getByTestId('hero-item-edric')).toBeVisible();
  await page.getByTestId('end-turn-button').click();

  // device passes to blue (still day 1)
  await expect(page.getByTestId('pass-device')).toBeVisible();
  await expect(page.getByTestId('pass-device-message')).toContainText('blue');
  await page.getByTestId('pass-device-confirm').click();
  await expect(page.getByTestId('pass-device')).not.toBeVisible();
  await expect(page.getByTestId('hero-item-mortus')).toBeVisible();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 1, Week 1, Month 1');

  // blue ends the turn: day advances and the device passes back to red
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('pass-device')).toBeVisible();
  await expect(page.getByTestId('pass-device-message')).toContainText('red');
  await page.getByTestId('pass-device-confirm').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');
  await expect(page.getByTestId('hero-item-edric')).toBeVisible();
});

test.describe('narrow viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
  }

  test('main menu renders without horizontal page overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('main-menu')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const box = await page.locator('.menu-box').boundingBox();
    if (!box) throw new Error('menu box not visible');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });

  test('new-game setup is usable and starts a game', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('menu-new-game').click();
    await expect(page.getByTestId('new-game-setup')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByTestId('map-option-tiny').click();
    await page.getByTestId('seed-input').fill('42');
    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('adventure-canvas')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('town panel opens within the viewport bounds', async ({ page }) => {
    await page.goto('/?map=tiny&seed=42');
    await expect(page.getByTestId('adventure-canvas')).toBeVisible();
    await page.getByTestId('town-item-town-2-2').click();
    await expect(page.getByTestId('town-screen')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const box = await page.locator('.town-panel').boundingBox();
    if (!box) throw new Error('town panel not visible');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  });
});
