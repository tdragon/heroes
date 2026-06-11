import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data';
import { seedRng } from '../rng';
import type { Hero } from '../state';
import { computeDamage, rollBaseDamage } from './damage';
import { hexDistance, type Hex } from './grid';
import {
  activeCombatStack,
  applyDamage,
  combatAct,
  CombatRuleError,
  createCombat,
  heroCombatInfo,
  reachableHexesFor,
  type CombatAction,
  type CombatArmyStack,
  type CombatEvent,
} from './engine';
import {
  getCombatStack,
  livingStacks,
  noHero,
  occupiedHexes,
  oppositeSide,
  type CombatHeroInfo,
  type CombatState,
} from './state';

const data = loadGameData();

interface MakeOptions {
  attackerHero?: Partial<CombatHeroInfo>;
  defenderHero?: Partial<CombatHeroInfo>;
  seed?: number;
  obstacles?: Hex[];
}

function makeCombat(
  attacker: CombatArmyStack[],
  defender: CombatArmyStack[],
  opts: MakeOptions = {},
): CombatState {
  return createCombat(
    {
      attacker: { hero: { ...noHero(), ...opts.attackerHero }, stacks: attacker },
      defender: { hero: { ...noHero(), ...opts.defenderHero }, stacks: defender },
      rng: seedRng(opts.seed ?? 42),
      obstacles: opts.obstacles ?? [],
    },
    data,
  ).combat;
}

function requireCreature(id: string) {
  const creature = data.creatures[id];
  if (!creature) throw new Error(`unknown creature: ${id}`);
  return creature;
}

function attackEvents(events: CombatEvent[]) {
  return events.filter((e) => e.type === 'stackAttacked');
}

// replicate the engine's rng usage to predict the next strike's damage
function expectedDamage(
  combat: CombatState,
  attackerId: string,
  overrides: Partial<Parameters<typeof computeDamage>[0]>,
): number {
  const attacker = getCombatStack(combat, attackerId);
  const creature = requireCreature(attacker.creature);
  const [base] = rollBaseDamage(combat.rngState, creature.dmgMin, creature.dmgMax, attacker.count);
  return computeDamage({ base, attack: 0, defense: 0, ranged: false, ...overrides }).total;
}

describe('combat setup', () => {
  it('deploys attacker in column 0 and defender in column 14 on slot rows', () => {
    const army: CombatArmyStack[] = Array.from({ length: 7 }, () => ({
      creature: 'pikeman',
      count: 1,
    }));
    const combat = makeCombat(army, [{ creature: 'skeleton', count: 1 }]);
    const rows = [0, 2, 4, 5, 6, 8, 10];
    for (let slot = 0; slot < 7; slot++) {
      const stack = getCombatStack(combat, `a${String(slot)}`);
      expect(stack.pos).toEqual({ x: 0, y: rows[slot] });
    }
    expect(getCombatStack(combat, 'd0').pos).toEqual({ x: 14, y: 0 });
  });

  it('deploys wide creatures one column in, occupying two hexes', () => {
    const combat = makeCombat(
      [{ creature: 'griffin', count: 1 }],
      [{ creature: 'cavalier', count: 1 }],
    );
    const griffin = getCombatStack(combat, 'a0');
    expect(griffin.pos).toEqual({ x: 1, y: 0 });
    expect(occupiedHexes(griffin, requireCreature('griffin'))).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
    const cavalier = getCombatStack(combat, 'd0');
    expect(cavalier.pos).toEqual({ x: 13, y: 0 });
    expect(occupiedHexes(cavalier, requireCreature('cavalier'))).toEqual([
      { x: 13, y: 0 },
      { x: 14, y: 0 },
    ]);
  });

  it('initializes shooter shots from creature data', () => {
    const combat = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 5 }],
    );
    expect(getCombatStack(combat, 'a0').shots).toBe(12);
    expect(getCombatStack(combat, 'd0').shots).toBe(0);
  });

  it('is deterministic per seed including generated obstacles', () => {
    const setup = () =>
      createCombat(
        {
          attacker: { hero: noHero(), stacks: [{ creature: 'pikeman', count: 3 }] },
          defender: { hero: noHero(), stacks: [{ creature: 'skeleton', count: 3 }] },
          rng: seedRng(7),
        },
        data,
      ).combat;
    expect(JSON.stringify(setup())).toBe(JSON.stringify(setup()));
  });

  it('rejects empty armies, invalid counts, and too many stacks', () => {
    expect(() => makeCombat([], [{ creature: 'skeleton', count: 1 }])).toThrow('1-7');
    expect(() =>
      makeCombat([{ creature: 'pikeman', count: 0 }], [{ creature: 'skeleton', count: 1 }]),
    ).toThrow('invalid count');
    const eight: CombatArmyStack[] = Array.from({ length: 8 }, () => ({
      creature: 'pikeman',
      count: 1,
    }));
    expect(() => makeCombat(eight, [{ creature: 'skeleton', count: 1 }])).toThrow('1-7');
  });
});

describe('initiative order', () => {
  it('orders by speed descending', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }], // speed 4
      [
        { creature: 'halberdier', count: 1 }, // speed 5
        { creature: 'skeleton', count: 1 }, // speed 4
      ],
    );
    expect(combat.queue).toEqual(['d0', 'a0', 'd1']);
  });

  it('alternates sides on speed ties, attacker first', () => {
    const combat = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'pikeman', count: 1 },
      ],
      [
        { creature: 'skeleton', count: 1 },
        { creature: 'skeleton', count: 1 },
      ],
    );
    expect(combat.queue).toEqual(['a0', 'd0', 'a1', 'd1']);
  });
});

describe('wait', () => {
  it('defers waiters to a slowest-first phase', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }], // speed 4
      [{ creature: 'halberdier', count: 1 }], // speed 5
    );
    expect(combat.queue).toEqual(['d0', 'a0']);
    combatAct(combat, { type: 'wait' }, data);
    combatAct(combat, { type: 'wait' }, data);
    // both waited: slowest acts first now
    expect(combat.queue).toEqual(['a0', 'd0']);
    combatAct(combat, { type: 'defend' }, data);
    const events = combatAct(combat, { type: 'defend' }, data);
    expect(events).toContainEqual({ type: 'roundStarted', round: 2 });
    expect(combat.queue).toEqual(['d0', 'a0']);
  });

  it('rejects waiting twice in the same round', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'halberdier', count: 1 }],
    );
    combatAct(combat, { type: 'wait' }, data);
    combatAct(combat, { type: 'wait' }, data);
    expect(activeCombatStack(combat)?.id).toBe('a0');
    expect(() => combatAct(combat, { type: 'wait' }, data)).toThrow('already waited');
  });
});

describe('movement', () => {
  it('moves a ground stack within speed and emits the event', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
    );
    const events = combatAct(combat, { type: 'move', to: { x: 2, y: 2 } }, data);
    expect(getCombatStack(combat, 'a0').pos).toEqual({ x: 2, y: 2 });
    expect(events).toContainEqual({
      type: 'stackMoved',
      stack: 'a0',
      from: { x: 0, y: 0 },
      to: { x: 2, y: 2 },
    });
  });

  it('rejects moves beyond speed and onto the same hex', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
    );
    expect(() => combatAct(combat, { type: 'move', to: { x: 10, y: 10 } }, data)).toThrow(
      CombatRuleError,
    );
    expect(() => combatAct(combat, { type: 'move', to: { x: 0, y: 0 } }, data)).toThrow(
      'already standing',
    );
  });

  it('keeps obstacles and occupied hexes out of the reachable set', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
      { obstacles: [{ x: 1, y: 0 }] },
    );
    const reachable = reachableHexesFor(combat, 'a0', data);
    expect(reachable.some((h) => h.x === 1 && h.y === 0)).toBe(false);
  });

  it('walls block walkers but not flyers', () => {
    const wall: Hex[] = Array.from({ length: 11 }, (_, y) => ({ x: 2, y }));
    const walker = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
      { obstacles: wall },
    );
    expect(reachableHexesFor(walker, 'a0', data).every((h) => h.x < 2)).toBe(true);

    const flyer = makeCombat(
      [{ creature: 'vampire', count: 1 }], // flying, speed 6
      [{ creature: 'skeleton', count: 1 }],
      { obstacles: wall },
    );
    const reachable = reachableHexesFor(flyer, 'a0', data);
    expect(reachable.some((h) => h.x === 5 && h.y === 0)).toBe(true);
    expect(reachable.some((h) => h.x === 2)).toBe(false);
    expect(reachable.every((h) => hexDistance({ x: 0, y: 0 }, h) <= 6)).toBe(true);
  });

  it('wide creatures cannot squeeze through a one-hex diagonal gap', () => {
    const obstacles: Hex[] = [];
    for (let y = 0; y < 11; y++) {
      if (y !== 5) obstacles.push({ x: 3, y });
      if (y !== 6) obstacles.push({ x: 4, y });
    }
    const narrow = makeCombat(
      [{ creature: 'pikeman', count: 1 }], // speed 4
      [{ creature: 'skeleton', count: 1 }],
      { obstacles },
    );
    getCombatStack(narrow, 'a0').pos = { x: 0, y: 5 };
    expect(
      reachableHexesFor(narrow, 'a0', data).some((h) => h.x === 4 && h.y === 6),
    ).toBe(true);

    const wide = makeCombat(
      [{ creature: 'cavalier', count: 1 }], // wide, speed 7
      [{ creature: 'skeleton', count: 1 }],
      { obstacles },
    );
    getCombatStack(wide, 'a0').pos = { x: 1, y: 5 };
    expect(reachableHexesFor(wide, 'a0', data).every((h) => h.x <= 3)).toBe(true);
  });
});

describe('melee and retaliation', () => {
  function adjacentFight(
    attacker: CombatArmyStack[],
    defender: CombatArmyStack[],
    opts: MakeOptions = {},
  ): CombatState {
    const combat = makeCombat(attacker, defender, opts);
    getCombatStack(combat, 'a0').pos = { x: 5, y: 5 };
    if (combat.stacks.some((s) => s.id === 'a1')) {
      getCombatStack(combat, 'a1').pos = { x: 6, y: 4 };
    }
    getCombatStack(combat, 'd0').pos = { x: 6, y: 5 };
    return combat;
  }

  it('strikes and receives exactly one retaliation', () => {
    const combat = adjacentFight(
      [{ creature: 'pikeman', count: 2 }],
      [{ creature: 'skeleton', count: 10 }],
    );
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    const attacks = attackEvents(events);
    expect(attacks).toHaveLength(2);
    expect(attacks[0]).toMatchObject({ attacker: 'a0', target: 'd0', retaliation: false });
    expect(attacks[1]).toMatchObject({ attacker: 'd0', target: 'a0', retaliation: true });
  });

  it('only retaliates once per round', () => {
    const combat = adjacentFight(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'pikeman', count: 1 },
      ],
      [{ creature: 'skeleton', count: 30 }],
    );
    // queue: a0, d0, a1 (all speed 4, attacker first)
    const first = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    expect(attackEvents(first).some((e) => e.retaliation)).toBe(true);
    combatAct(combat, { type: 'defend' }, data); // d0
    const second = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 6, y: 4 } },
      data,
    );
    expect(attackEvents(second).some((e) => e.retaliation)).toBe(false);
  });

  it('royal griffin retaliates without limit', () => {
    const combat = adjacentFight(
      [
        { creature: 'pikeman', count: 2 },
        { creature: 'pikeman', count: 2 },
      ],
      [{ creature: 'royal_griffin', count: 5 }],
    );
    // royal griffin (speed 9) acts first
    combatAct(combat, { type: 'defend' }, data);
    const first = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    const second = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 6, y: 4 } }, data);
    expect(attackEvents(first).some((e) => e.retaliation)).toBe(true);
    expect(attackEvents(second).some((e) => e.retaliation)).toBe(true);
  });

  it('no-retaliation attackers are never struck back', () => {
    const combat = adjacentFight(
      [{ creature: 'vampire', count: 3 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    const attacks = attackEvents(events);
    expect(attacks).toHaveLength(1);
    expect(attacks[0]).toMatchObject({ attacker: 'a0', retaliation: false });
  });

  it('rejects melee against a non-adjacent target or a friend', () => {
    const combat = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'pikeman', count: 1 },
      ],
      [{ creature: 'skeleton', count: 1 }],
    );
    expect(() =>
      combatAct(combat, { type: 'melee', target: 'd0', from: { x: 0, y: 0 } }, data),
    ).toThrow('not adjacent');
    expect(() =>
      combatAct(combat, { type: 'melee', target: 'a1', from: { x: 0, y: 0 } }, data),
    ).toThrow('is friendly');
  });

  it('moves to the attack hex before striking', () => {
    const combat = makeCombat(
      [{ creature: 'halberdier', count: 5 }], // speed 5
      [{ creature: 'skeleton', count: 10 }],
    );
    getCombatStack(combat, 'd0').pos = { x: 4, y: 2 };
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 3, y: 2 } },
      data,
    );
    expect(events[0]).toMatchObject({ type: 'stackMoved', stack: 'a0', to: { x: 3, y: 2 } });
    expect(getCombatStack(combat, 'a0').pos).toEqual({ x: 3, y: 2 });
    expect(attackEvents(events).length).toBeGreaterThan(0);
  });

  it('applies hero attack, offense, and armorer to melee damage', () => {
    const combat = adjacentFight(
      [{ creature: 'pikeman', count: 4 }],
      [{ creature: 'skeleton', count: 30 }],
      {
        attackerHero: { attack: 3, offenseBonus: 0.2 },
        defenderHero: { defense: 1, armorerReduction: 0.1 },
      },
    );
    const expected = expectedDamage(combat, 'a0', {
      attack: 4 + 3,
      defense: 4 + 1,
      offenseBonus: 0.2,
      armorerReduction: 0.1,
    });
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    expect(attackEvents(events)[0]?.damage).toBe(expected);
  });

  it('jousting gains 5% damage per hex traveled', () => {
    const combat = makeCombat(
      [{ creature: 'cavalier', count: 1 }], // wide, jousting, speed 7
      [{ creature: 'skeleton', count: 50 }],
    );
    getCombatStack(combat, 'd0').pos = { x: 7, y: 0 };
    const from: Hex = { x: 6, y: 0 };
    const hexes = hexDistance({ x: 1, y: 0 }, from);
    expect(hexes).toBe(5);
    const expected = expectedDamage(combat, 'a0', {
      attack: 15,
      defense: 4,
      joustingHexes: hexes,
    });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from }, data);
    expect(attackEvents(events)[0]?.damage).toBe(expected);
  });
});

describe('ranged attacks', () => {
  it('shoots, spends a shot, and halves damage beyond 10 hexes', () => {
    const combat = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    expect(hexDistance({ x: 0, y: 0 }, { x: 14, y: 0 })).toBe(14);
    const expected = expectedDamage(combat, 'a0', {
      attack: 6,
      defense: 4,
      ranged: true,
      distancePenalty: true,
    });
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    const attack = attackEvents(events)[0];
    expect(attack).toMatchObject({ attacker: 'a0', target: 'd0', ranged: true });
    expect(attack?.damage).toBe(expected);
    expect(getCombatStack(combat, 'a0').shots).toBe(11);
  });

  it('deals full damage within 10 hexes', () => {
    const combat = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    getCombatStack(combat, 'd0').pos = { x: 8, y: 0 };
    const expected = expectedDamage(combat, 'a0', { attack: 6, defense: 4, ranged: true });
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    expect(attackEvents(events)[0]?.damage).toBe(expected);
  });

  it('cannot shoot with an adjacent enemy or without shots', () => {
    const combat = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    getCombatStack(combat, 'd0').pos = { x: 1, y: 0 };
    expect(() => combatAct(combat, { type: 'shoot', target: 'd0' }, data)).toThrow(
      'adjacent enemy',
    );

    const dry = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    getCombatStack(dry, 'a0').shots = 0;
    expect(() => combatAct(dry, { type: 'shoot', target: 'd0' }, data)).toThrow('no shots left');
  });

  it('rejects shooting from a non-shooter', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
    );
    expect(() => combatAct(combat, { type: 'shoot', target: 'd0' }, data)).toThrow(
      'not a shooter',
    );
  });

  it('shooters melee at half damage unless they have no melee penalty', () => {
    const archers = makeCombat(
      [{ creature: 'archer', count: 5 }],
      [{ creature: 'skeleton', count: 30 }],
    );
    getCombatStack(archers, 'a0').pos = { x: 5, y: 5 };
    getCombatStack(archers, 'd0').pos = { x: 6, y: 5 };
    const expectedHalved = expectedDamage(archers, 'a0', {
      attack: 6,
      defense: 4,
      meleePenalty: true,
    });
    const archerEvents = combatAct(
      archers,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    expect(attackEvents(archerEvents)[0]?.damage).toBe(expectedHalved);

    const zealots = makeCombat(
      [{ creature: 'zealot', count: 5 }], // noMeleePenalty, speed 7
      [{ creature: 'skeleton', count: 50 }],
    );
    getCombatStack(zealots, 'a0').pos = { x: 5, y: 5 };
    getCombatStack(zealots, 'd0').pos = { x: 6, y: 5 };
    const expectedFull = expectedDamage(zealots, 'a0', { attack: 12, defense: 4 });
    const zealotEvents = combatAct(
      zealots,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    expect(attackEvents(zealotEvents)[0]?.damage).toBe(expectedFull);
  });
});

describe('defend', () => {
  it('raises effective defense by 20% until the stack acts again', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 4 }], // speed 4
      [{ creature: 'halberdier', count: 10 }], // speed 5, acts first
    );
    getCombatStack(combat, 'a0').pos = { x: 5, y: 5 };
    getCombatStack(combat, 'd0').pos = { x: 6, y: 5 };
    combatAct(combat, { type: 'defend' }, data);
    expect(getCombatStack(combat, 'd0').defending).toBe(true);

    const expected = expectedDamage(combat, 'a0', {
      attack: 4,
      defense: Math.floor(5 * 1.2),
    });
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    expect(attackEvents(events)[0]?.damage).toBe(expected);
  });
});

describe('damage application to HP pools', () => {
  it('kills whole creatures and leaves the remainder on the top one', () => {
    const stack = {
      id: 'a0',
      side: 'attacker' as const,
      slot: 0,
      creature: 'pikeman',
      count: 3,
      initialCount: 3,
      firstHp: 10,
      pos: { x: 0, y: 0 },
      shots: 0,
      retaliationsLeft: 1,
      defending: false,
      waited: false,
      moraleSurged: false,
      usedResurrect: false,
      effects: [],
    };
    const pikemanHp = requireCreature('pikeman').hp;
    expect(applyDamage(stack, pikemanHp, 25)).toBe(2);
    expect(stack.count).toBe(1);
    expect(stack.firstHp).toBe(5);

    expect(applyDamage(stack, pikemanHp, 4)).toBe(0);
    expect(stack.firstHp).toBe(1);

    expect(applyDamage(stack, pikemanHp, 99)).toBe(1);
    expect(stack.count).toBe(0);
    expect(stack.firstHp).toBe(0);
  });
});

describe('combat end', () => {
  it('declares a winner when one side is wiped out and rejects further actions', () => {
    const combat = makeCombat(
      [{ creature: 'angel', count: 10 }], // 50 dmg each, speed 12
      [{ creature: 'peasant', count: 1 }],
    );
    getCombatStack(combat, 'a0').pos = { x: 5, y: 5 };
    getCombatStack(combat, 'd0').pos = { x: 6, y: 5 };
    const events = combatAct(
      combat,
      { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
      data,
    );
    expect(events).toContainEqual({ type: 'stackDied', stack: 'd0' });
    expect(events).toContainEqual({ type: 'combatEnded', winner: 'attacker' });
    expect(combat.winner).toBe('attacker');
    expect(combat.queue).toEqual([]);
    expect(() => combatAct(combat, { type: 'defend' }, data)).toThrow('combat is over');
  });
});

describe('heroCombatInfo', () => {
  it('derives stats and skill fractions from the hero', () => {
    const hero: Hero = {
      id: 'h1',
      template: 'edric',
      name: 'Edric',
      class: 'knight',
      owner: 'red',
      pos: [0, 0],
      attack: 2,
      defense: 3,
      spellPower: 1,
      knowledge: 1,
      level: 1,
      xp: 0,
      skills: [
        { skill: 'offense', rank: 'advanced' },
        { skill: 'archery', rank: 'basic' },
        { skill: 'armorer', rank: 'expert' },
      ],
      army: [null, null, null, null, null, null, null],
      artifacts: [],
      backpack: [],
      hasSpellbook: false,
      spells: [],
      mana: 10,
      movementPoints: 1500,
      tempLuck: 0,
      tempMorale: 0,
    };
    expect(heroCombatInfo(hero, data)).toEqual({
      hero: 'h1',
      player: 'red',
      attack: 2,
      defense: 3,
      spellPower: 1,
      knowledge: 1,
      offenseBonus: 0.2,
      archeryBonus: 0.1,
      armorerReduction: 0.15,
      morale: 0,
      luck: 0,
      mana: 10,
      hasSpellbook: false,
      spells: [],
      schoolTiers: { air: 0, earth: 0, fire: 0, water: 0 },
    });
  });
});

describe('full scripted battle', () => {
  function autoPlay(combat: CombatState): CombatEvent[] {
    const all: CombatEvent[] = [];
    let guard = 0;
    while (combat.winner === null) {
      guard += 1;
      if (guard > 500) throw new Error('battle did not terminate');
      const stack = activeCombatStack(combat);
      if (!stack) throw new Error('no active stack');
      const creature = requireCreature(stack.creature);
      const enemies = livingStacks(combat, oppositeSide(stack.side));
      const nearest = enemies.reduce((best, e) =>
        hexDistance(stack.pos, e.pos) < hexDistance(stack.pos, best.pos) ? e : best,
      );
      const adjacent = enemies.find((e) => hexDistance(stack.pos, e.pos) === 1);
      let action: CombatAction;
      if (creature.shots !== undefined && stack.shots > 0 && !adjacent) {
        action = { type: 'shoot', target: nearest.id };
      } else if (adjacent) {
        action = { type: 'melee', target: adjacent.id, from: stack.pos };
      } else {
        const reachable = reachableHexesFor(combat, stack.id, data);
        const attackFrom = reachable.find((h) => hexDistance(h, nearest.pos) === 1);
        if (attackFrom) {
          action = { type: 'melee', target: nearest.id, from: attackFrom };
        } else {
          let best: Hex | null = null;
          let bestDistance = hexDistance(stack.pos, nearest.pos);
          for (const hex of reachable) {
            const d = hexDistance(hex, nearest.pos);
            if (d < bestDistance) {
              bestDistance = d;
              best = hex;
            }
          }
          action = best ? { type: 'move', to: best } : { type: 'defend' };
        }
      }
      all.push(...combatAct(combat, action, data));
    }
    return all;
  }

  function battle(): CombatState {
    return makeCombat(
      [
        { creature: 'halberdier', count: 10 },
        { creature: 'archer', count: 5 },
      ],
      [
        { creature: 'skeleton', count: 12 },
        { creature: 'walking_dead', count: 4 },
      ],
      { seed: 99 },
    );
  }

  it('plays to the end with a deterministic result', () => {
    const a = battle();
    const b = battle();
    autoPlay(a);
    autoPlay(b);
    expect(a.winner).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('matches the replay snapshot', () => {
    const combat = battle();
    const events = autoPlay(combat);
    expect(combat.winner).toBe('attacker');
    const summary = {
      winner: combat.winner,
      rounds: combat.round,
      attacks: attackEvents(events).length,
      survivors: combat.stacks
        .filter((s) => s.count > 0)
        .map((s) => ({ id: s.id, creature: s.creature, count: s.count, firstHp: s.firstHp })),
    };
    expect(summary).toMatchSnapshot();
  });
});
