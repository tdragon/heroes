import { expect, test, type Page } from '@playwright/test';

const TILE = 48;
const RED_TOWN = 'town-4-5';

test.use({ viewport: { width: 1280, height: 800 } });

async function cameraOffset(page: Page): Promise<[number, number]> {
  const canvas = page.getByTestId('adventure-canvas');
  const cx = Number(await canvas.getAttribute('data-camera-x'));
  const cy = Number(await canvas.getAttribute('data-camera-y'));
  return [cx, cy];
}

async function canvasPoint(page: Page, tileX: number, tileY: number): Promise<[number, number]> {
  const canvas = page.getByTestId('adventure-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('adventure canvas not visible');
  const [cx, cy] = await cameraOffset(page);
  return [box.x + (tileX + 0.5) * TILE - cx, box.y + (tileY + 0.5) * TILE - cy];
}

async function moveHeroTo(page: Page, tileX: number, tileY: number): Promise<void> {
  const [px, py] = await canvasPoint(page, tileX, tileY);
  await page.mouse.click(px, py);
  await expect(page.getByTestId('status-line')).toHaveText('Click again to move');
  await page.mouse.click(px, py);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
});

test('build tavern then town hall; income reflects next day', async ({ page }) => {
  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await expect(page.getByTestId('town-screen')).toBeVisible();
  await expect(page.getByTestId('town-name')).toContainText('Castle Town');

  // town hall is locked behind the tavern
  await expect(page.getByTestId('building-town_hall')).toContainText('requires Tavern');

  await page.getByTestId('building-tavern').click();
  await expect(page.getByTestId('resource-gold')).toContainText('19500');
  await expect(page.getByTestId('building-tavern')).toContainText('Built');
  // one build per town per day
  await expect(page.getByTestId('building-town_hall')).toContainText('already built today');

  await page.getByTestId('town-close').click();
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-town_hall').click();
  await expect(page.getByTestId('resource-gold')).toContainText('17500');
  await page.getByTestId('town-close').click();

  // town hall pays 1000 gold at dawn instead of the village hall's 500
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('resource-gold')).toContainText('18500');
});

test('recruit max pikemen into the garrison', async ({ page }) => {
  // grab the wood pile so the dwelling stays affordable after the fort
  await page.getByTestId('hero-item-edric').click();
  await moveHeroTo(page, 6, 8);
  await expect(page.getByTestId('resource-wood')).toContainText('26');

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-fort').click();
  await expect(page.getByTestId('resource-gold')).toContainText('15000');
  await page.getByTestId('town-close').click();
  await page.getByTestId('end-turn-button').click();

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-castle_dwelling_1').click();
  await expect(page.getByTestId('recruit-pool-pikeman')).toContainText('14 available');

  await page.getByTestId('recruit-pikeman').click();
  await expect(page.getByTestId('count-dialog')).toBeVisible();
  await page.getByTestId('count-max').click();
  await expect(page.getByTestId('count-input')).toHaveValue('14');
  await expect(page.getByTestId('count-detail')).toContainText('840 gold');
  await page.getByTestId('count-confirm').click();

  await expect(page.getByTestId('garrison-slot-0')).toHaveText('14 Pikeman');
  await expect(page.getByTestId('recruit-pool-pikeman')).toContainText('0 available');
});

test('hero screen splits a stack via the split dialog', async ({ page }) => {
  await page.getByTestId('hero-item-edric').click();
  await page.getByTestId('open-hero-screen').click();
  await expect(page.getByTestId('hero-screen')).toBeVisible();

  const slot0 = page.getByTestId('army-slot-edric-0');
  await expect(slot0).toContainText('Pikeman');
  const before = Number((await slot0.textContent())?.split(' ')[0]);
  expect(before).toBeGreaterThan(1);

  await slot0.click();
  await page.getByTestId('army-slot-edric-3').click();
  await expect(page.getByTestId('count-dialog')).toBeVisible();
  await page.getByTestId('count-input').fill('4');
  await page.getByTestId('count-confirm').click();

  await expect(page.getByTestId('army-slot-edric-3')).toHaveText('4 Pikeman');
  await expect(page.getByTestId('army-slot-edric-0')).toHaveText(`${String(before - 4)} Pikeman`);
});

test('learning stone triggers the level-up dialog and the choice persists', async ({ page }) => {
  await page.getByTestId('hero-item-edric').click();
  // scroll south so the learning stone at (7,18) is on screen
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('adventure-canvas')).toHaveAttribute('data-camera-y', '240');

  await moveHeroTo(page, 7, 18);

  await expect(page.getByTestId('modal-overlay')).toBeVisible();
  await expect(page.getByTestId('modal-message')).toContainText('Edric reaches level 2');
  const optionLabel = (await page.getByTestId('choice-option-0').textContent()) ?? '';
  expect(optionLabel.length).toBeGreaterThan(0);
  await page.getByTestId('choice-option-0').click();
  await expect(page.getByTestId('modal-overlay')).toBeHidden();

  // the picked skill shows up on the hero screen at its new rank
  const [rank, ...rest] = optionLabel.split(' ');
  const skillName = rest.join(' ');
  await page.getByTestId('open-hero-screen').click();
  await expect(page.getByTestId('hero-title-edric')).toContainText('level 2');
  await expect(page.getByTestId('hero-skills-edric')).toContainText(
    `${skillName} (${(rank ?? '').toLowerCase()})`,
  );
});
