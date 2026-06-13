import { expect, test, type Page } from '@playwright/test';
import {
  canvasPoint,
  expectDrawerClosed,
  expectDrawerOpen,
  expectNoHorizontalOverflow,
  expectWithinViewport,
  longPressAt,
} from './helpers';

const VIEW_W = 390;
const VIEW_H = 844;
const BOTTOM_BAR_H = 40;

test.use({ viewport: { width: VIEW_W, height: VIEW_H }, hasTouch: true, isMobile: true });

async function bootAdventure(page: Page): Promise<void> {
  await page.goto('/?map=tiny&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
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
  // lives in the bottom bar, fully inside the viewport
  expect(box.y).toBeGreaterThanOrEqual(VIEW_H - BOTTOM_BAR_H);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEW_W);

  await endTurn.tap();
  // edric never left the town tile, so blue cannot capture it: no dialog,
  // the turn simply advances to day 2
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  // Next Hero is reachable from the bottom bar too
  await expect(page.getByTestId('next-hero-button')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('crossing the 768px breakpoint relocates buttons and closes the drawer', async ({
  page,
}) => {
  await bootAdventure(page);
  // narrow boot: action buttons live in the bottom bar, toggle visible
  await expect(
    page.locator('[data-testid="resource-bar"] [data-testid="end-turn-button"]'),
  ).toHaveCount(1);
  await page.getByTestId('hud-menu-toggle').tap();
  await expectDrawerOpen(page);

  // widening past the breakpoint closes the drawer and moves the buttons back
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId('sidebar')).not.toHaveClass(/open/);
  await expect(page.getByTestId('hud-backdrop')).not.toHaveClass(/open/);
  await expect(
    page.locator('[data-testid="sidebar"] [data-testid="end-turn-button"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="sidebar"] [data-testid="next-hero-button"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('hud-menu-toggle')).toBeHidden();
  // the canvas grew with the viewport mid-game
  await expect
    .poll(async () => (await page.getByTestId('adventure-canvas').boundingBox())?.width ?? 0)
    .toBeGreaterThan(800);

  // narrowing again moves the buttons back to the bottom bar, still working
  await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  await expect(
    page.locator('[data-testid="resource-bar"] [data-testid="end-turn-button"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('hud-menu-toggle')).toBeVisible();
  await page.getByTestId('end-turn-button').tap();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');
});

// --- touch gameplay ---

test('touch tap reaches tiles and selects the own hero', async ({ page }) => {
  await bootAdventure(page);

  // tap an empty tile: the tap pipeline hits the map (move preview starts)
  const [ex, ey] = await canvasPoint(page, 6, 4);
  await page.touchscreen.tap(ex, ey);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');

  // tap the hero's tile (edric starts on the town tile at 2,2): the hero is
  // selected in the HUD and the pending move is discarded
  const [hx, hy] = await canvasPoint(page, 2, 2);
  await page.touchscreen.tap(hx, hy);
  await expect(page.getByTestId('hero-item-edric')).toHaveClass(/selected/);
  await expect(page.getByTestId('hero-pos')).toHaveText('2,2');
});

test('two-tap move: first tap previews, second tap moves the hero', async ({ page }) => {
  await bootAdventure(page);
  await expect(page.getByTestId('hero-pos')).toHaveText('2,2');

  const [px, py] = await canvasPoint(page, 4, 2);
  await page.touchscreen.tap(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');

  await page.touchscreen.tap(px, py);
  await expect(page.getByTestId('hero-pos')).toHaveText('4,2');
});

test('one-finger drag pans the camera', async ({ page }) => {
  await bootAdventure(page);
  const canvas = page.getByTestId('adventure-canvas');
  // camera clamps to the map origin at boot (hero near the top-left corner)
  await expect(canvas).toHaveAttribute('data-camera-x', '0');

  // synthetic pointer events from page.evaluate are untrusted and bypass
  // setPointerCapture, so drive a trusted touch sequence via CDP
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 300, y: 400, id: 1 }],
  });
  for (const x of [280, 250, 220, 200, 180]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 400, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();

  // 120 css px dragged left at zoom 1 → camera moved +120 world px
  await expect(canvas).toHaveAttribute('data-camera-x', '120');
});

test('long-press shows tile info and the next tap dismisses it', async ({ page }) => {
  await bootAdventure(page);
  const [hx, hy] = await canvasPoint(page, 2, 2);

  // hold a single touch past LONG_PRESS_MS without moving
  await longPressAt(page, hx, hy);

  const popup = page.getByTestId('info-popup');
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('Edric');

  // the release after a long-press is not a tap; the NEXT tap dismisses
  await page.touchscreen.tap(300, 400);
  await expect(popup).not.toBeVisible();
});

test('long-press near the right edge keeps the info popup on-screen', async ({ page }) => {
  await bootAdventure(page);

  // hold a touch 8 css px from the right edge: the naive popup position
  // (x + 8) would start past the viewport and must flip/clamp inside it
  await longPressAt(page, VIEW_W - 8, 300);

  const popup = page.getByTestId('info-popup');
  await expect(popup).toBeVisible();
  await expectWithinViewport(page, '[data-testid="info-popup"]');
  await expectNoHorizontalOverflow(page);
});

test('browser page zoom is suppressed so the map never gets stuck behind it', async ({ page }) => {
  await bootAdventure(page);

  // the viewport meta locks scale for Android/desktop browsers
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('user-scalable=no');
  expect(viewport).toContain('maximum-scale=1');

  // iOS Safari ignores the meta and pinch-zooms the page via WebKit gesture
  // events; the app-wide guard must cancel them (defaultPrevented === true)
  const gesturesBlocked = await page.evaluate(() =>
    ['gesturestart', 'gesturechange', 'gestureend'].every((type) => {
      const ev = new Event(type, { cancelable: true, bubbles: true });
      document.dispatchEvent(ev);
      return ev.defaultPrevented;
    }),
  );
  expect(gesturesBlocked).toBe(true);
});
