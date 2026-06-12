import { expect, test, type Locator } from '@playwright/test';
import {
  clickCombatHex,
  expectDrawerClosed,
  expectDrawerOpen,
  expectNoHorizontalOverflow,
  expectWithinViewport,
  moveHeroTo,
} from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

async function stackHex(stack: Locator): Promise<[number, number]> {
  const x = Number(await stack.getAttribute('data-x'));
  const y = Number(await stack.getAttribute('data-y'));
  return [x, y];
}

test('guard fight on the tutorial map: win via attacks, result shows XP', async ({ page }) => {
  await page.goto('/?map=tutorial-valley&seed=42');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await page.getByTestId('hero-item-edric').click();

  // the ore pit at (3,10) is guarded by wolves
  await moveHeroTo(page, 3, 10);
  await expect(page.getByTestId('modal-message')).toContainText('would you like to attack?');
  await page.getByTestId('choice-option-0').click();
  await expect(page.getByTestId('combat-screen')).toBeVisible();

  const screen = page.getByTestId('combat-screen');
  const wolves = page.getByTestId('combat-stack-d0');
  const result = page.getByTestId('modal-overlay');

  // click the wolf stack every turn (shoot or melee); when the active stack
  // cannot reach it, fall back to Defend so the battle always progresses
  for (let i = 0; i < 60; i++) {
    if (await result.isVisible()) break;
    const version = await screen.getAttribute('data-version');
    const [wx, wy] = await stackHex(wolves);
    await clickCombatHex(page, wx, wy);
    await page.waitForTimeout(60);
    if (await result.isVisible()) break;
    if ((await screen.getAttribute('data-version')) === version) {
      await page.getByTestId('combat-defend-button').click();
      await page.waitForTimeout(60);
    }
  }

  await expect(page.getByTestId('modal-message')).toContainText('Edric is victorious!');
  await expect(page.getByTestId('modal-message')).toContainText('XP');
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('combat-screen')).not.toBeVisible();
});

test('cast Magic Arrow from the spellbook', async ({ page }) => {
  await page.goto('/?map=combat-arena&seed=5');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await page.getByTestId('hero-item-beatrice').click();

  await moveHeroTo(page, 5, 2);
  await page.getByTestId('choice-option-0').click();
  await expect(page.getByTestId('combat-screen')).toBeVisible();

  // the wolf (speed 6) has already taken its AI turn; the pikemen are active
  await expect(page.getByTestId('combat-screen')).toHaveAttribute('data-active-side', 'attacker');
  await expect(page.getByTestId('combat-hero-attacker')).toHaveAttribute('data-mana', '20');

  await page.getByTestId('combat-spellbook-button').click();
  await expect(page.getByTestId('spellbook-overlay')).toBeVisible();
  await expect(page.getByTestId('spell-row-magic_arrow')).toContainText('Magic Arrow');
  await page.getByTestId('spell-cast-magic_arrow').click();
  await expect(page.getByTestId('combat-status')).toContainText('Select a target');

  const [wx, wy] = await stackHex(page.getByTestId('combat-stack-d0'));
  await clickCombatHex(page, wx, wy);

  await expect(page.getByTestId('combat-log')).toContainText('casts Magic Arrow');
  await expect(page.getByTestId('combat-log')).toContainText('Magic Arrow hits');
  await expect(page.getByTestId('combat-hero-attacker')).toHaveAttribute('data-mana', '15');
  // 30 damage kills 2 of the 4 wolves
  await expect(page.getByTestId('combat-stack-d0')).toHaveAttribute('data-count', '2');
});

test('flee button works on the player turn and withdraws the hero', async ({ page }) => {
  await page.goto('/?map=combat-arena&seed=5');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await page.getByTestId('hero-item-beatrice').click();

  await moveHeroTo(page, 5, 2);
  await page.getByTestId('choice-option-0').click();
  const screen = page.getByTestId('combat-screen');
  await expect(screen).toBeVisible();

  // the wolf (speed 6) already took its AI turn; the player's stack is active
  await expect(screen).toHaveAttribute('data-active-side', 'attacker');
  await expect(page.getByTestId('combat-flee-button')).toBeEnabled();
  await page.getByTestId('combat-flee-button').click();

  await expect(page.getByTestId('modal-message')).toContainText('fled from the battle');
  await page.getByTestId('dialog-ok').click();
  await expect(screen).not.toBeVisible();
});

test('wait and defend buttons advance the turn queue', async ({ page }) => {
  await page.goto('/?map=combat-arena&seed=5');
  await expect(page.getByTestId('adventure-canvas')).toBeVisible();
  await page.getByTestId('hero-item-beatrice').click();

  await moveHeroTo(page, 5, 2);
  await page.getByTestId('choice-option-0').click();
  const screen = page.getByTestId('combat-screen');
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute('data-round', '1');
  await expect(screen).toHaveAttribute('data-active-stack', 'a0');

  // waiting re-queues the only friendly stack at the end of the round
  await page.getByTestId('combat-wait-button').click();
  await expect(page.getByTestId('combat-log')).toContainText('wait');
  await expect(page.getByTestId('combat-wait-button')).toBeDisabled();
  await expect(screen).toHaveAttribute('data-round', '1');

  // defending ends the round: the wolf acts and round 2 begins
  await page.getByTestId('combat-defend-button').click();
  await expect(page.getByTestId('combat-log')).toContainText('defend');
  await expect(screen).toHaveAttribute('data-round', '2');
  await expect(screen).toHaveAttribute('data-active-side', 'attacker');
});

test.describe('narrow viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('combat scales to fit below 1 and fit-scaled clicks land', async ({ page }) => {
    await page.goto('/?map=combat-arena&seed=5');
    await expect(page.getByTestId('adventure-canvas')).toBeVisible();
    // the sidebar is a drawer at this width: open it to select the hero
    await page.getByTestId('hud-menu-toggle').click();
    await expectDrawerOpen(page);
    await page.getByTestId('hero-item-beatrice').click();
    // wait for the closing drawer to slide off-screen before canvas clicks
    await expectDrawerClosed(page);

    await moveHeroTo(page, 5, 2);
    await page.getByTestId('choice-option-0').click();
    await expect(page.getByTestId('combat-screen')).toBeVisible();

    // the battlefield is wider than 390 css px: fit < 1, nothing overflows
    const canvas = page.getByTestId('combat-canvas');
    await expect(canvas).toHaveAttribute('data-fit', /.+/);
    const fit = Number(await canvas.getAttribute('data-fit'));
    expect(fit).toBeLessThan(1);
    expect(fit).toBeGreaterThanOrEqual(0.35);
    await expectWithinViewport(page, '[data-testid="combat-canvas"]');
    await expectNoHorizontalOverflow(page);

    // a fit-scaled click lands on the intended hex: Magic Arrow the wolves
    await expect(page.getByTestId('combat-screen')).toHaveAttribute(
      'data-active-side',
      'attacker',
    );
    await page.getByTestId('combat-spellbook-button').click();
    await page.getByTestId('spell-cast-magic_arrow').click();
    await expect(page.getByTestId('combat-status')).toContainText('Select a target');
    const [wx, wy] = await stackHex(page.getByTestId('combat-stack-d0'));
    await clickCombatHex(page, wx, wy);
    await expect(page.getByTestId('combat-stack-d0')).toHaveAttribute('data-count', '2');

    // widening the viewport mid-combat re-fits back to 1
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(canvas).toHaveAttribute('data-fit', '1');
  });
});
