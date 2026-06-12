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
