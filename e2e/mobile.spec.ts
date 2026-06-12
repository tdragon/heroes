import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const VIEW_W = 390;

async function bootAdventure(page: Page): Promise<void> {
  await page.goto('/?map=tiny&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
}

async function expectDrawerOpen(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar')).toHaveClass(/open/);
  // the drawer slides in with a CSS transition: poll until it settles on-screen
  await expect
    .poll(async () => {
      const box = await page.getByTestId('sidebar').boundingBox();
      return box ? box.x + box.width : Number.NaN;
    })
    .toBeLessThanOrEqual(VIEW_W);
}

async function expectDrawerClosed(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar')).not.toHaveClass(/open/);
  await expect
    .poll(async () => {
      const box = await page.getByTestId('sidebar').boundingBox();
      return box ? box.x : Number.NaN;
    })
    .toBeGreaterThanOrEqual(VIEW_W);
}

test('adventure screen fits the phone viewport and the canvas fills its width', async ({
  page,
}) => {
  await bootAdventure(page);
  await expectNoHorizontalOverflow(page);

  const box = await page.getByTestId('adventure-canvas').boundingBox();
  if (!box) throw new Error('adventure canvas not visible');
  expect(box.x).toBe(0);
  expect(box.width).toBeCloseTo(VIEW_W, 0);
});

test('drawer opens via the menu toggle and closes via the backdrop', async ({ page }) => {
  await bootAdventure(page);

  // closed by default, toggle visible in the bottom bar
  await expectDrawerClosed(page);
  const toggle = page.getByTestId('hud-menu-toggle');
  await expect(toggle).toBeVisible();

  await toggle.tap();
  await expectDrawerOpen(page);
  await expect(page.getByTestId('minimap')).toBeVisible();

  // tap the backdrop left of the 280px drawer to close
  await page.getByTestId('hud-backdrop').tap({ position: { x: 20, y: 200 } });
  await expectDrawerClosed(page);

  // toggle also closes an open drawer
  await toggle.tap();
  await expectDrawerOpen(page);
  await toggle.tap();
  await expectDrawerClosed(page);
});

test('selecting a hero from the drawer closes it', async ({ page }) => {
  await bootAdventure(page);
  await page.getByTestId('hud-menu-toggle').tap();
  await expectDrawerOpen(page);

  await page.getByTestId('hero-item-edric').tap();
  await expectDrawerClosed(page);
  await expect(page.getByTestId('hero-item-edric')).toHaveClass(/selected/);
});

test('End Turn works from the bottom bar without opening the drawer', async ({ page }) => {
  await bootAdventure(page);
  await expectDrawerClosed(page);

  const endTurn = page.getByTestId('end-turn-button');
  await expect(endTurn).toBeVisible();
  const box = await endTurn.boundingBox();
  if (!box) throw new Error('end turn button not visible');
  // lives in the 40px bottom bar, fully inside the viewport
  expect(box.y).toBeGreaterThanOrEqual(844 - 40);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEW_W);

  await endTurn.tap();
  // edric never left the town tile, so blue cannot capture it: no dialog,
  // the turn simply advances to day 2
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  // Next Hero is reachable from the bottom bar too
  await expect(page.getByTestId('next-hero-button')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
