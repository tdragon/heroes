import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { createCombat } from '../core/combat/engine';
import { FIELD_HEIGHT, FIELD_WIDTH } from '../core/combat/grid';
import { noHero, type CombatState } from '../core/combat/state';
import { seedRng } from '../core/rng';
import {
  combatEventText,
  COMBAT_CANVAS_H,
  COMBAT_CANVAS_W,
  COMBAT_FIT_MIN,
  combatFitScale,
  createReachableCache,
  damageRangeText,
  estimateAttack,
  HEX_R,
  hexAtCanvasPoint,
  hexAtPixel,
  hexCenter,
  sideColor,
} from './combatRenderer';

const data = loadGameData();

function makeCombat(
  attacker: { creature: string; count: number },
  defender: { creature: string; count: number },
): CombatState {
  const { combat } = createCombat(
    {
      attacker: { hero: noHero(), stacks: [attacker] },
      defender: { hero: noHero(), stacks: [defender] },
      rng: seedRng(1),
      obstacles: [],
    },
    data,
  );
  return combat;
}

describe('hex pixel math', () => {
  it('round-trips every hex center through hexAtPixel', () => {
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      for (let x = 0; x < FIELD_WIDTH; x++) {
        const c = hexCenter({ x, y });
        expect(hexAtPixel(c.x, c.y)).toEqual({ x, y });
      }
    }
  });

  it('resolves points slightly off-center to the same hex', () => {
    const c = hexCenter({ x: 7, y: 5 });
    expect(hexAtPixel(c.x + HEX_R * 0.4, c.y)).toEqual({ x: 7, y: 5 });
    expect(hexAtPixel(c.x, c.y - HEX_R * 0.5)).toEqual({ x: 7, y: 5 });
  });

  it('returns null outside the field', () => {
    expect(hexAtPixel(0, 0)).toBeNull();
    expect(hexAtPixel(-50, -50)).toBeNull();
    expect(hexAtPixel(COMBAT_CANVAS_W + 100, COMBAT_CANVAS_H + 100)).toBeNull();
  });

  it('keeps all hex centers inside the canvas', () => {
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      for (let x = 0; x < FIELD_WIDTH; x++) {
        const c = hexCenter({ x, y });
        expect(c.x).toBeGreaterThan(HEX_R / 2);
        expect(c.x).toBeLessThan(COMBAT_CANVAS_W - HEX_R / 2);
        expect(c.y).toBeGreaterThan(HEX_R / 2);
        expect(c.y).toBeLessThan(COMBAT_CANVAS_H - HEX_R / 2);
      }
    }
  });
});

describe('combatFitScale', () => {
  it('is 1 when the battlefield fits exactly', () => {
    expect(combatFitScale(COMBAT_CANVAS_W, COMBAT_CANVAS_H)).toBe(1);
  });

  it('never upscales past 1 on huge viewports', () => {
    expect(combatFitScale(10000, 10000)).toBe(1);
  });

  it('scales down by the constraining width', () => {
    expect(combatFitScale(COMBAT_CANVAS_W / 2, 10000)).toBeCloseTo(0.5);
  });

  it('scales down by the constraining height', () => {
    expect(combatFitScale(10000, COMBAT_CANVAS_H * 0.6)).toBeCloseTo(0.6);
  });

  it('takes the smaller of the two ratios', () => {
    expect(combatFitScale(COMBAT_CANVAS_W * 0.8, COMBAT_CANVAS_H * 0.5)).toBeCloseTo(0.5);
  });

  it('floors at COMBAT_FIT_MIN for tiny and degenerate inputs', () => {
    expect(combatFitScale(10, 10)).toBe(COMBAT_FIT_MIN);
    expect(combatFitScale(0, 0)).toBe(COMBAT_FIT_MIN);
    expect(combatFitScale(-100, 500)).toBe(COMBAT_FIT_MIN);
  });
});

describe('hexAtCanvasPoint', () => {
  it('matches hexAtPixel at fit 1', () => {
    const c = hexCenter({ x: 3, y: 4 });
    expect(hexAtCanvasPoint(c.x, c.y, 1)).toEqual(hexAtPixel(c.x, c.y));
    expect(hexAtCanvasPoint(c.x, c.y, 1)).toEqual({ x: 3, y: 4 });
  });

  it('maps CSS px through the fit scale', () => {
    for (const fit of [0.5, 2]) {
      const c = hexCenter({ x: 7, y: 5 });
      expect(hexAtCanvasPoint(c.x * fit, c.y * fit, fit)).toEqual({ x: 7, y: 5 });
    }
  });

  it('points off-center stay in the same hex at fit 0.5', () => {
    const c = hexCenter({ x: 7, y: 5 });
    expect(hexAtCanvasPoint((c.x + HEX_R * 0.4) * 0.5, c.y * 0.5, 0.5)).toEqual({ x: 7, y: 5 });
  });

  it('returns null outside the scaled field', () => {
    expect(hexAtCanvasPoint(0, 0, 0.5)).toBeNull();
    expect(hexAtCanvasPoint(COMBAT_CANVAS_W * 0.5 + 50, COMBAT_CANVAS_H * 0.5 + 50, 0.5)).toBeNull();
  });
});

describe('createReachableCache', () => {
  it('recomputes only when the stack or version changes', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 5 }, { creature: 'wolf', count: 2 });
    let calls = 0;
    const cache = createReachableCache((c, stackId, d) => {
      calls += 1;
      // delegate to a trivially checkable stub
      void c;
      void d;
      return [{ x: stackId === 'a0' ? 1 : 2, y: 0 }];
    });

    const first = cache(combat, 'a0', data, 1);
    expect(calls).toBe(1);
    expect(cache(combat, 'a0', data, 1)).toBe(first);
    expect(calls).toBe(1);

    cache(combat, 'a0', data, 2);
    expect(calls).toBe(2);
    cache(combat, 'd0', data, 2);
    expect(calls).toBe(3);
  });
});

describe('estimateAttack', () => {
  it('matches the damage formula for a plain melee attack', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 10 }, { creature: 'wolf', count: 4 });
    // pikeman A4 vs wolf D3: x1.05; base 10x(1..3)
    const estimate = estimateAttack(combat, 'a0', 'd0', false, data);
    expect(estimate.min).toBe(10); // floor(10 * 1.05)
    expect(estimate.max).toBe(31); // floor(30 * 1.05)
    // wolf pool 4x15=60: 10 dmg kills 0, 31 dmg kills 2
    expect(estimate.killsMin).toBe(0);
    expect(estimate.killsMax).toBe(2);
  });

  it('applies the ranged distance penalty beyond 10 hexes', () => {
    const combat = makeCombat({ creature: 'archer', count: 5 }, { creature: 'wolf', count: 4 });
    // archer A6 vs wolf D3: x1.15; deployed 14 hexes apart -> x0.5
    const estimate = estimateAttack(combat, 'a0', 'd0', true, data);
    expect(estimate.min).toBe(Math.floor(5 * 2 * 1.15 * 0.5));
    expect(estimate.max).toBe(Math.floor(5 * 3 * 1.15 * 0.5));
  });

  it('respects the defend bonus of the target', () => {
    const combat = makeCombat(
      { creature: 'pikeman', count: 10 },
      { creature: 'walking_dead', count: 4 },
    );
    const defender = combat.stacks.find((s) => s.id === 'd0');
    if (!defender) throw new Error('missing defender');
    const before = estimateAttack(combat, 'a0', 'd0', false, data);
    defender.defending = true;
    const after = estimateAttack(combat, 'a0', 'd0', false, data);
    // walking dead D5 -> defending floor(5*1.2)=6: A4 vs 6 = x0.95 vs x0.975
    expect(before.max).toBe(Math.floor(30 * (1 - 0.025)));
    expect(after.max).toBe(Math.floor(30 * (1 - 0.05)));
  });
});

describe('damageRangeText', () => {
  it('formats ranges', () => {
    expect(damageRangeText({ min: 10, max: 31, killsMin: 0, killsMax: 2 })).toBe(
      'Damage 10–31, kills 0–2',
    );
  });

  it('collapses equal bounds', () => {
    expect(damageRangeText({ min: 30, max: 30, killsMin: 2, killsMax: 2 })).toBe(
      'Damage 30, kills 2',
    );
  });
});

describe('combatEventText', () => {
  const combat = makeCombat({ creature: 'pikeman', count: 10 }, { creature: 'wolf', count: 4 });

  it('describes attacks with kills', () => {
    expect(
      combatEventText(
        {
          type: 'stackAttacked',
          attacker: 'a0',
          target: 'd0',
          damage: 17,
          kills: 1,
          ranged: false,
          retaliation: false,
        },
        combat,
        data,
      ),
    ).toBe('10 Pikeman attack 4 Wolf for 17 damage; 1 perish');
  });

  it('describes retaliations and shots', () => {
    expect(
      combatEventText(
        {
          type: 'stackAttacked',
          attacker: 'd0',
          target: 'a0',
          damage: 5,
          kills: 0,
          ranged: false,
          retaliation: true,
        },
        combat,
        data,
      ),
    ).toBe('4 Wolf retaliate against 10 Pikeman for 5 damage');
  });

  it('names spells from data', () => {
    expect(
      combatEventText(
        { type: 'spellCast', side: 'attacker', spell: 'magic_arrow', targets: ['d0'] },
        combat,
        data,
      ),
    ).toBe('The attacker casts Magic Arrow');
  });

  it('skips pure-visual events', () => {
    expect(
      combatEventText(
        { type: 'stackMoved', stack: 'a0', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
        combat,
        data,
      ),
    ).toBeNull();
  });
});

describe('sideColor', () => {
  it('maps player colors and falls back to neutral', () => {
    expect(sideColor('red')).toBe('#c53030');
    expect(sideColor(null)).toBe('#718096');
    expect(sideColor('not-a-player')).toBe('#718096');
  });
});
