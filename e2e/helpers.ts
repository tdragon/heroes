import { expect, type Page } from '@playwright/test';

export const TILE = 48;

// tile center → page CSS px, derived from the live canvas box and the
// transform the renderer exposes on the canvas dataset:
// cssX = (worldX - cameraX) * zoom
export async function canvasPoint(
  page: Page,
  tileX: number,
  tileY: number,
): Promise<[number, number]> {
  const canvas = page.getByTestId('adventure-canvas');
  // dataset attrs appear after the first render frame
  await expect(canvas).toHaveAttribute('data-zoom', /.+/);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('adventure canvas not visible');
  const cameraX = Number(await canvas.getAttribute('data-camera-x'));
  const cameraY = Number(await canvas.getAttribute('data-camera-y'));
  const zoom = Number(await canvas.getAttribute('data-zoom'));
  return [
    box.x + ((tileX + 0.5) * TILE - cameraX) * zoom,
    box.y + ((tileY + 0.5) * TILE - cameraY) * zoom,
  ];
}

export async function moveHeroTo(page: Page, tileX: number, tileY: number): Promise<void> {
  const [px, py] = await canvasPoint(page, tileX, tileY);
  await page.mouse.click(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');
  await page.mouse.click(px, py);
}

// combat battlefield hex layout — mirrors src/render/combatRenderer.ts
const HEX_R = 30;
const HEX_W = Math.sqrt(3) * HEX_R;
const FIELD_MARGIN_X = 36;
const FIELD_MARGIN_Y = 28;

// logical battlefield px of a hex center
export function combatHexCenter(x: number, y: number): [number, number] {
  return [
    FIELD_MARGIN_X + HEX_W * (x + 0.5 * (y % 2)) + HEX_W / 2,
    FIELD_MARGIN_Y + HEX_R * (1 + 1.5 * y),
  ];
}

// the combat canvas is scale-to-fit: logical hex coordinates map to CSS px
// through the live `data-fit` factor exposed by the screen
export async function clickCombatHex(page: Page, hexX: number, hexY: number): Promise<void> {
  const canvas = page.getByTestId('combat-canvas');
  await expect(canvas).toHaveAttribute('data-fit', /.+/);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('combat canvas not visible');
  const fit = Number(await canvas.getAttribute('data-fit'));
  const [cx, cy] = combatHexCenter(hexX, hexY);
  await page.mouse.click(box.x + cx * fit, box.y + cy * fit);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
}

export async function expectWithinViewport(page: Page, selector: string): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unavailable');
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} not visible`);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

// the sidebar drawer slides with a CSS transition; interacting with its
// contents mid-slide is racy (mousedown/mouseup may land on different
// elements), so poll until it settles fully on-screen (open) or off-screen
export async function expectDrawerOpen(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unavailable');
  await expect(page.getByTestId('sidebar')).toHaveClass(/open/);
  await expect
    .poll(async () => {
      const box = await page.getByTestId('sidebar').boundingBox();
      return box ? box.x + box.width : Number.NaN;
    })
    .toBeLessThanOrEqual(viewport.width);
}

export async function expectDrawerClosed(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unavailable');
  await expect(page.getByTestId('sidebar')).not.toHaveClass(/open/);
  await expect
    .poll(async () => {
      const box = await page.getByTestId('sidebar').boundingBox();
      return box ? box.x : Number.NaN;
    })
    .toBeGreaterThanOrEqual(viewport.width);
}

// trusted long-press via CDP (page.evaluate-synthesized pointer events are
// untrusted and bypass setPointerCapture); 700ms hold = LONG_PRESS_MS (500)
// plus margin for the long-press timer to fire
export async function longPressAt(page: Page, x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }],
  });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
