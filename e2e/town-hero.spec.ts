import { expect, test } from '@playwright/test';
import { moveHeroTo } from './helpers';

const RED_TOWN = 'town-4-5';

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/?map=tutorial-valley&seed=42');
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

test('building cards show resource icons and help tooltips', async ({ page }) => {
  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await expect(page.getByTestId('town-screen')).toBeVisible();

  // an affordable building advertises its cost as resource icons with amounts
  const tavern = page.getByTestId('building-tavern');
  const tavernCost = tavern.locator('.building-cost');
  await expect(tavernCost.locator('svg.res-icon-gold')).toBeVisible();
  await expect(tavernCost.locator('svg.res-icon-wood')).toBeVisible();
  await expect(tavernCost.getByTestId('cost-gold')).toContainText('500');
  await expect(tavernCost.getByTestId('cost-wood')).toContainText('5');

  // hovering the info icon reveals a help tooltip describing the building
  const tooltip = page.getByTestId('building-tooltip');
  await tavern.getByTestId('building-help-tavern').hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('hire heroes');

  // the tooltip must also work over a built card (these are not disabled buttons)
  await page.getByTestId('building-help-village_hall').hover();
  await expect(tooltip).toContainText('Town hall');

  // a locked building keeps its cost icons alongside the lock reason
  const townHall = page.getByTestId('building-town_hall');
  await expect(townHall.locator('.building-cost')).toContainText('2500');
  await expect(townHall).toContainText('requires Tavern');

  // the prebuilt village hall reports its daily income instead of "Built"
  await expect(page.getByTestId('building-village_hall')).toContainText('+500 gold per day');
});

test('town-screen building grid shows woodcut icons without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning' && msg.text().includes('sprite rasterization failed')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });

  // reload with listeners attached to catch initial-render errors too
  await page.goto('/?map=tutorial-valley&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await expect(page.getByTestId('town-screen')).toBeVisible();
  await expect(page.getByTestId('town-name')).toContainText('Castle Town');

  // the Castle town grid renders a bespoke woodcut icon on each building card:
  // shared structures, the mage guild, and a faction dwelling all carry one
  for (const id of ['fort', 'tavern', 'mage_guild_1', 'castle_dwelling_1']) {
    await expect(page.getByTestId(`building-${id}`).locator('svg.building-icon')).toBeVisible();
  }

  expect(errors).toEqual([]);
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
  // a built dwelling shows its weekly production
  await expect(page.getByTestId('building-castle_dwelling_1')).toContainText('14 Pikeman per week');

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

test('upgrade a recruited stack for the cost difference', async ({ page }) => {
  // wood pile + sawmill keep the dwellings affordable after the fort
  await page.getByTestId('hero-item-edric').click();
  await moveHeroTo(page, 6, 8);
  await expect(page.getByTestId('resource-wood')).toContainText('26');
  await moveHeroTo(page, 8, 3);

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-fort').click();
  await expect(page.getByTestId('building-fort')).toContainText('Built');
  await page.getByTestId('town-close').click();
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 2, Week 1, Month 1');

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-castle_dwelling_1').click();
  await page.getByTestId('recruit-pikeman').click();
  await page.getByTestId('count-max').click();
  await page.getByTestId('count-confirm').click();
  await expect(page.getByTestId('garrison-slot-0')).toHaveText('14 Pikeman');
  // the upgraded dwelling is not built yet: no upgrade affordance
  await expect(page.getByTestId('upgrade-garrison-0')).toHaveCount(0);
  await page.getByTestId('town-close').click();
  await page.getByTestId('end-turn-button').click();
  await expect(page.getByTestId('date-indicator')).toHaveText('Day 3, Week 1, Month 1');

  await page.getByTestId(`town-item-${RED_TOWN}`).click();
  await page.getByTestId('building-castle_dwelling_1u').click();
  const upgrade = page.getByTestId('upgrade-garrison-0');
  await expect(upgrade).toContainText('Halberdier');
  await expect(upgrade).toContainText('210 gold');
  await upgrade.click();
  await expect(page.getByTestId('garrison-slot-0')).toHaveText('14 Halberdier');
  await expect(page.getByTestId('upgrade-garrison-0')).toHaveCount(0);
});

test('dismiss hero needs a confirming second click and removes the hero', async ({ page }) => {
  await page.getByTestId('hero-item-edric').click();
  await page.getByTestId('open-hero-screen').click();
  await expect(page.getByTestId('hero-screen')).toBeVisible();

  const dismiss = page.getByTestId('dismiss-hero-edric');
  await expect(dismiss).toHaveText('Dismiss hero');
  await dismiss.click();
  await expect(dismiss).toContainText('Confirm dismiss');
  await dismiss.click();

  await expect(page.getByTestId('hero-screen')).toHaveCount(0);
  await expect(page.getByTestId('hero-item-edric')).toHaveCount(0);
  await expect(page.getByTestId('hero-panel')).toContainText('No hero selected');
});
