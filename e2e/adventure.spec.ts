import { expect, test } from '@playwright/test';
import { canvasPoint, moveHeroTo, TILE } from './helpers';

// light-patch fill of src/assets/themes/woodcut/terrain/grass.svg (#538935)
const GRASS_PATCH_RGB = [0x53, 0x89, 0x35] as const;

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/?map=tutorial-valley&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
});

test('woodcut sprites load and render without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    // sprite rasterization failures are warnings; treat them as failures here
    if (msg.type() === 'warning' && msg.text().includes('sprite rasterization failed')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });

  // beforeEach already navigated; reload with listeners attached to catch
  // errors from the initial render as well
  await page.goto('/?map=tutorial-valley&seed=42');
  const canvas = page.getByTestId('adventure-canvas');
  await expect(canvas).toBeVisible();

  // 'true' only when every sprite rasterized; any failure flags 'failed'
  await expect(canvas).toHaveAttribute('data-sprites-ready', 'true');

  // the ready handler must repaint on its own: with no input yet, the plain
  // visible grass tile at (4,4) already shows the woodcut texture (its light
  // patch green) instead of the flat fallback color
  await expect
    .poll(() =>
      page.evaluate(
        ({ tile, rgb }) => {
          const el = document.querySelector<HTMLCanvasElement>('[data-testid="adventure-canvas"]');
          const ctx = el?.getContext('2d');
          if (!ctx) return false;
          const pixels = ctx.getImageData(4 * tile, 4 * tile, tile, tile).data;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2]) {
              return true;
            }
          }
          return false;
        },
        { tile: TILE, rgb: GRASS_PATCH_RGB },
      ),
    )
    .toBe(true);

  // pan one tile right and down so the off-origin camera draw path repaints too
  await expect(canvas).toHaveAttribute('data-camera-x', '0');
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-camera-x', '48');
  await page.keyboard.press('ArrowDown');
  await expect(canvas).toHaveAttribute('data-camera-y', '48');

  expect(errors).toEqual([]);
});

test('creature and hero emblems render on the adventure map without console errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    // sprite rasterization failures are warnings; treat them as failures here
    if (msg.type() === 'warning' && msg.text().includes('sprite rasterization failed')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });

  // reload with listeners attached so the initial render — which paints the
  // starting hero's horseman marker via heroToken — is covered too
  await page.goto('/?map=tutorial-valley&seed=42');
  const canvas = page.getByTestId('adventure-canvas');
  await expect(canvas).toBeVisible();

  // every emblem/terrain bitmap rasterized: 'true' (any failure flags 'failed')
  await expect(canvas).toHaveAttribute('data-sprites-ready', 'true');

  // selecting the hero draws the selection ring + horseman banner over the
  // seal furniture, and moving repaints the marker each step — exercising the
  // heroToken emblem path without console errors (the standalone wandering
  // monster's creatureToken path is covered by the combat smoke, where stacks
  // are guaranteed on-screen rather than behind fog)
  await page.getByTestId('hero-item-edric').click();
  await expect(page.getByTestId('hero-pos')).toHaveText('4,5');
  await moveHeroTo(page, 8, 5);
  await expect(page.getByTestId('hero-pos')).toHaveText('8,5');

  // pan the camera so the off-origin emblem/terrain blit path runs as well
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-camera-x', '48');
  await page.keyboard.press('ArrowDown');
  await expect(canvas).toHaveAttribute('data-camera-y', '48');

  expect(errors).toEqual([]);
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

test('zoom wiring: keys and wheel change data-zoom, hit-testing and pan divide by zoom', async ({
  page,
}) => {
  const canvas = page.getByTestId('adventure-canvas');
  await expect(canvas).toHaveAttribute('data-zoom', '1');
  await expect(canvas).toHaveAttribute('data-camera-x', '0');

  // + zooms in about the viewport center
  await page.keyboard.press('+');
  await expect(canvas).toHaveAttribute('data-zoom', '1.25');

  // click-to-move at zoom 1.25: the canvasPoint helper multiplies by zoom and
  // tileAtClientPoint divides it back out, so the hero lands on the tile
  await page.getByTestId('hero-item-edric').click();
  const [px, py] = await canvasPoint(page, 8, 5);
  await page.mouse.click(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');
  await page.mouse.click(px, py);
  await expect(page.getByTestId('hero-pos')).toHaveText('8,5');

  // middle-drag pan: 100 css px left moves the camera +100/zoom = 80 world px
  const cameraX = Number(await canvas.getAttribute('data-camera-x'));
  const box = await canvas.boundingBox();
  if (!box) throw new Error('adventure canvas not visible');
  const [startX, startY] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'middle' });
  for (const step of [25, 50, 75, 100]) {
    await page.mouse.move(startX - step, startY);
  }
  await page.mouse.up({ button: 'middle' });
  await expect(canvas).toHaveAttribute('data-camera-x', String(cameraX + 80));

  // wheel zoom about the cursor
  await page.mouse.move(startX, startY);
  await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-zoom')))
    .toBeCloseTo(1.375, 5);
  await page.keyboard.press('-');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-zoom')))
    .toBeCloseTo(1.1, 5);
});

test.describe('high-dpr rendering (deviceScaleFactor 2)', () => {
  test.use({ deviceScaleFactor: 2 });

  test('backing store is css x 2 and clicks still hit tiles', async ({ page }) => {
    // the dataset appears after the first render, i.e. after syncViewport
    await expect(page.getByTestId('adventure-canvas')).toHaveAttribute('data-zoom', '1');
    const sizes = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="adventure-canvas"]');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('adventure canvas missing');
      const rect = canvas.getBoundingClientRect();
      return {
        dpr: window.devicePixelRatio,
        backingW: canvas.width,
        backingH: canvas.height,
        cssW: rect.width,
        cssH: rect.height,
      };
    });
    expect(sizes.dpr).toBe(2);
    expect(sizes.backingW).toBe(Math.round(sizes.cssW * 2));
    expect(sizes.backingH).toBe(Math.round(sizes.cssH * 2));

    // hit-testing works in css px regardless of the dpr backing scale
    await page.getByTestId('hero-item-edric').click();
    await moveHeroTo(page, 8, 5);
    await expect(page.getByTestId('hero-pos')).toHaveText('8,5');
  });
});

test('right-click shows an info popup for the hovered entity', async ({ page }) => {
  const [px, py] = await canvasPoint(page, 4, 5);
  await page.mouse.click(px, py, { button: 'right' });
  await expect(page.getByTestId('info-popup')).toBeVisible();
  await expect(page.getByTestId('info-popup')).toContainText('Edric');
});

test('spellbook button reports a hero without a spellbook', async ({ page }) => {
  await page.getByTestId('hero-item-edric').click();
  await page.getByTestId('spellbook-button').click();
  await expect(page.getByTestId('status-line')).toHaveText('Edric has no spellbook');
});

test('adventure spellbook opens for a caster and lists only adventure spells', async ({ page }) => {
  await page.goto('/?map=combat-arena&seed=5');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await page.getByTestId('hero-item-beatrice').click();
  await page.getByTestId('spellbook-button').click();
  await expect(page.getByTestId('spellbook-overlay')).toBeVisible();
  // Beatrice only knows combat spells, so the adventure book is empty;
  // Town Portal / Dimension Door appear here once learned from a guild
  await expect(page.getByTestId('spellbook-empty')).toHaveText('No spells match');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('spellbook-overlay')).toHaveCount(0);
});
