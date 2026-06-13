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
  CombatRenderer,
  createReachableCache,
  damageRangeText,
  estimateAttack,
  HEX_R,
  HEX_W,
  hexAtPixel,
  hexCenter,
  sideColor,
} from './combatRenderer';
import { asCtx, RecordingContext, RecordingPainter } from './testSupport';

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

describe('drawStacks painter wiring', () => {
  it('draws each living stack through the injected painter with the creature id', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 7 }, { creature: 'wolf', count: 3 });
    const painter = new RecordingPainter();
    const renderer = new CombatRenderer(asCtx(new RecordingContext()), painter, data);
    renderer.render({ combat, reachable: [], hover: null, activeStack: null }, 0);

    const tokenCalls = painter.calls.filter((c) => c.method === 'creatureToken');
    expect(tokenCalls).toHaveLength(2);
    // args: [cx, cy, r, color, id, initials, tier]
    const ids = tokenCalls.map((c) => c.args[4]);
    expect(ids).toContain('pikeman');
    expect(ids).toContain('wolf');
  });

  it('keeps the count badge clear of the seal pips/notch (upper-right quadrant)', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 7 }, { creature: 'wolf', count: 3 });
    const ctx = new RecordingContext();
    const painter = new RecordingPainter();
    const renderer = new CombatRenderer(asCtx(ctx), painter, data);
    renderer.render({ combat, reachable: [], hover: null, activeStack: null }, 0);

    // the badge is the only roundRect drawn; the seal furniture (pips/notch)
    // lives in the painter, so any roundRect here is a count badge. Pair each
    // badge to its stack by token radius: bx = cx + 0.55r, by = cy - 0.55r, so
    // the badge sits above the center -> clear of the pip row (cy + 0.55r) and
    // the bottom banner notch.
    const badges = ctx.ops.filter((o) => o.op === 'roundRect');
    expect(badges.length).toBe(2);
    const tokenCalls = painter.calls.filter((c) => c.method === 'creatureToken');
    for (const badge of badges) {
      const bx = badge.args[0] ?? NaN;
      const by = badge.args[1] ?? NaN;
      const owner = tokenCalls.find((c) => {
        const r = c.args[2] as number;
        return Math.abs(bx - ((c.args[0] as number) + r * 0.55)) < 0.001;
      });
      expect(owner).toBeDefined();
      if (!owner) continue;
      const cy = owner.args[1] as number;
      const r = owner.args[2] as number;
      expect(by).toBeCloseTo(cy - r * 0.55);
      // independent check: the badge sits above the disc center, so it clears
      // the pip row (cy + 0.55r) and the bottom banner notch entirely
      expect(by).toBeLessThan(cy);
    }
  });
});

describe('wide-creature token placement', () => {
  // boar is wide (occupies two horizontally-adjacent hexes); pikeman is narrow
  function widePair(): {
    ctx: RecordingContext;
    painter: RecordingPainter;
    tokens: { args: unknown[] }[];
  } {
    const combat = makeCombat({ creature: 'pikeman', count: 7 }, { creature: 'boar', count: 10 });
    const ctx = new RecordingContext();
    const painter = new RecordingPainter();
    const renderer = new CombatRenderer(asCtx(ctx), painter, data);
    renderer.render({ combat, reachable: [], hover: null, activeStack: null }, 0);
    const tokens = painter.calls.filter((c) => c.method === 'creatureToken');
    return { ctx, painter, tokens };
  }

  it('centers the wide seal on the midpoint of its two hexes, narrow on its hex', () => {
    const { tokens } = widePair();
    const boar = tokens.find((c) => c.args[4] === 'boar');
    const pikeman = tokens.find((c) => c.args[4] === 'pikeman');
    expect(boar).toBeDefined();
    expect(pikeman).toBeDefined();
    if (!boar || !pikeman) return;

    // a single stack deploys in slot 0 (row 0). boar (defender) deploys head at
    // x=13, tail one hex to the right (x=14); its seal is centered half a
    // hex-width toward the tail of the head hex
    const head = hexCenter({ x: 13, y: 0 });
    expect(boar.args[0] as number).toBeCloseTo(head.x + HEX_W / 2);
    expect(boar.args[1] as number).toBeCloseTo(head.y);

    // narrow pikeman (attacker) sits squarely on its single hex (x=0)
    const pHead = hexCenter({ x: 0, y: 0 });
    expect(pikeman.args[0] as number).toBeCloseTo(pHead.x);
    expect(pikeman.args[1] as number).toBeCloseTo(pHead.y);
  });

  it('gives the wide seal a larger disc than a narrow one', () => {
    const { tokens } = widePair();
    const boarR = tokens.find((c) => c.args[4] === 'boar')?.args[2] as number;
    const pikeR = tokens.find((c) => c.args[4] === 'pikeman')?.args[2] as number;
    expect(boarR).toBeCloseTo(HEX_R * 0.85);
    expect(pikeR).toBeCloseTo(HEX_R * 0.68);
    expect(boarR).toBeGreaterThan(pikeR);
  });

  it('outlines both occupied hexes when hovering a wide stack, one for a narrow', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 7 }, { creature: 'boar', count: 10 });
    // hovering the boar's tail hex (x=14, row 0) must still outline both cells
    const wideCtx = new RecordingContext();
    const wideRenderer = new CombatRenderer(asCtx(wideCtx), new RecordingPainter(), data);
    wideRenderer.render(
      { combat, reachable: [], hover: { x: 14, y: 0 }, activeStack: null },
      0,
    );
    // the active-stack selection ring is the only circular furniture from the
    // renderer here; the hover outline is the hex stroke. Count the gold hover
    // strokes by the HOVER_STROKE color on a `stroke` following a hex path.
    const wideStrokes = wideCtx.ops.filter((o) => o.op === 'stroke' && o.strokeStyle === '#ecc94b');
    expect(wideStrokes.length).toBe(2);

    const narrowCtx = new RecordingContext();
    const narrowRenderer = new CombatRenderer(asCtx(narrowCtx), new RecordingPainter(), data);
    narrowRenderer.render(
      { combat, reachable: [], hover: { x: 0, y: 0 }, activeStack: null },
      0,
    );
    const narrowStrokes = narrowCtx.ops.filter(
      (o) => o.op === 'stroke' && o.strokeStyle === '#ecc94b',
    );
    expect(narrowStrokes.length).toBe(1);
  });
});

describe('drawSiege tower wiring', () => {
  // a castle siege deploys 3 arrow towers; each must reach the painter as a
  // label token (type 'tower', no atlas key, no pip) at its hex center
  function siegeCombat(level: 'fort' | 'citadel' | 'castle'): CombatState {
    const { combat } = createCombat(
      {
        attacker: { hero: noHero(), stacks: [{ creature: 'pikeman', count: 5 }] },
        defender: { hero: noHero(), stacks: [{ creature: 'archer', count: 5 }] },
        rng: seedRng(1),
        siege: level,
      },
      data,
    );
    return combat;
  }

  it('draws one tower token per siege tower with type "tower", null pip, and T<n> label', () => {
    const combat = siegeCombat('castle');
    expect(combat.siege?.towers.length).toBe(3);
    const painter = new RecordingPainter();
    const renderer = new CombatRenderer(asCtx(new RecordingContext()), painter, data);
    renderer.render({ combat, reachable: [], hover: null, activeStack: null }, 0);

    // args: [cx, cy, r, color, type, pip, label]
    const towers = painter.calls.filter((c) => c.method === 'objectToken' && c.args[4] === 'tower');
    expect(towers).toHaveLength(3);
    for (const t of towers) {
      expect(t.args[5]).toBeNull(); // pip
      expect(t.args[3]).toBe('#718096'); // tower color
      expect(t.args[2]).toBeCloseTo(HEX_R * 0.55); // radius
    }
    // labels are T1..T3 in tower order, positioned at each tower's hex center
    expect(towers.map((t) => t.args[6])).toEqual(['T1', 'T2', 'T3']);
    combat.siege?.towers.forEach((tower, i) => {
      const c = hexCenter(tower.pos);
      expect(towers[i]?.args[0] as number).toBeCloseTo(c.x);
      expect(towers[i]?.args[1] as number).toBeCloseTo(c.y);
    });
  });

  it('draws no tower tokens for a non-siege combat', () => {
    const combat = makeCombat({ creature: 'pikeman', count: 5 }, { creature: 'wolf', count: 3 });
    expect(combat.siege).toBeNull();
    const painter = new RecordingPainter();
    const renderer = new CombatRenderer(asCtx(new RecordingContext()), painter, data);
    renderer.render({ combat, reachable: [], hover: null, activeStack: null }, 0);
    expect(painter.calls.some((c) => c.method === 'objectToken')).toBe(false);
  });
});

describe('sideColor', () => {
  it('maps player colors and falls back to neutral', () => {
    expect(sideColor('red')).toBe('#c53030');
    expect(sideColor(null)).toBe('#718096');
    expect(sideColor('not-a-player')).toBe('#718096');
  });
});
