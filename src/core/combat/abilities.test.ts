import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data';
import { seedRng } from '../rng';
import {
  addEffect,
  applyDamage,
  effectiveAttack,
  effectiveDefense,
  effectiveHp,
  effectiveSpeed,
  getEffect,
  healTopCreature,
  magicResistChance,
  resurrectStack,
  stackMorale,
} from './abilities';
import {
  activeCombatStack,
  combatAct,
  createCombat,
  reachableHexesFor,
  CombatRuleError,
  type CombatArmyStack,
  type CombatEvent,
} from './engine';
import {
  getCombatStack,
  noHero,
  type CombatHeroInfo,
  type CombatStack,
  type CombatState,
} from './state';
import type { Hex } from './grid';

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

function place(combat: CombatState, id: string, pos: Hex): CombatStack {
  const stack = getCombatStack(combat, id);
  stack.pos = pos;
  return stack;
}

function findSeed(predicate: (seed: number) => boolean, max = 300): number {
  for (let seed = 0; seed < max; seed++) {
    if (predicate(seed)) return seed;
  }
  throw new Error('no seed satisfies the predicate');
}

describe('HP pool primitives', () => {
  function stack(count: number, firstHp: number, initialCount = count): CombatStack {
    return {
      id: 'a0',
      side: 'attacker',
      slot: 0,
      creature: 'pikeman',
      count,
      initialCount,
      firstHp,
      pos: { x: 0, y: 0 },
      shots: 0,
      retaliationsLeft: 1,
      defending: false,
      waited: false,
      moraleSurged: false,
      usedResurrect: false,
      effects: [],
    };
  }

  it('applyDamage kills across the pool', () => {
    const s = stack(3, 10);
    expect(applyDamage(s, 10, 15)).toBe(1);
    expect(s.count).toBe(2);
    expect(s.firstHp).toBe(5);
  });

  it('resurrectStack revives up to the initial count', () => {
    const s = stack(1, 4, 5);
    expect(resurrectStack(s, 10, 26)).toBe(2);
    expect(s.count).toBe(3);
    expect(s.firstHp).toBe(10);
    // cannot exceed initial count even with huge healing
    expect(resurrectStack(s, 10, 9999)).toBe(2);
    expect(s.count).toBe(5);
    expect(s.firstHp).toBe(10);
  });

  it('resurrectStack revives a dead stack', () => {
    const s = stack(0, 0, 4);
    expect(resurrectStack(s, 10, 25)).toBe(3);
    expect(s.count).toBe(3);
    expect(s.firstHp).toBe(5);
  });

  it('healTopCreature heals only the top creature', () => {
    const s = stack(3, 2);
    expect(healTopCreature(s, 10, 100)).toBe(8);
    expect(s.firstHp).toBe(10);
    expect(s.count).toBe(3);
  });
});

describe('effective stats from effects', () => {
  it('applies bloodlust to melee attack only and weakness/disease to both', () => {
    const combat = makeCombat([{ creature: 'pikeman', count: 1 }], [{ creature: 'wolf', count: 1 }]);
    const stack = getCombatStack(combat, 'a0');
    const pikeman = requireCreature('pikeman');
    addEffect(stack, { kind: 'bloodlust', positive: true, rounds: 2, value: 6 });
    expect(effectiveAttack(stack, pikeman, true)).toBe(10);
    expect(effectiveAttack(stack, pikeman, false)).toBe(4);
    addEffect(stack, { kind: 'weakness', positive: false, rounds: 2, value: 3 });
    addEffect(stack, { kind: 'disease', positive: false, rounds: 2, value: 2 });
    expect(effectiveAttack(stack, pikeman, true)).toBe(5);
    expect(effectiveDefense(stack, pikeman)).toBe(3);
  });

  it('applies stone skin, haste, slow, and aging', () => {
    const combat = makeCombat([{ creature: 'pikeman', count: 1 }], [{ creature: 'wolf', count: 1 }]);
    const stack = getCombatStack(combat, 'a0');
    const pikeman = requireCreature('pikeman');
    addEffect(stack, { kind: 'stone_skin', positive: true, rounds: 2, value: 6 });
    expect(effectiveDefense(stack, pikeman)).toBe(11);
    addEffect(stack, { kind: 'haste', positive: true, rounds: 2, value: 5 });
    expect(effectiveSpeed(stack, pikeman)).toBe(9);
    addEffect(stack, { kind: 'slow', positive: false, rounds: 2, value: 50 });
    expect(effectiveSpeed(stack, pikeman)).toBe(4); // floor(9 * 0.5)
    expect(effectiveHp(stack, pikeman)).toBe(10);
    addEffect(stack, { kind: 'aging', positive: false, rounds: 2, value: 0 });
    expect(effectiveHp(stack, pikeman)).toBe(5);
  });
});

describe('double shot and double attack', () => {
  it('marksman shoots twice when the target survives', () => {
    const combat = makeCombat(
      [{ creature: 'marksman', count: 2 }],
      [{ creature: 'walking_dead', count: 30 }],
    );
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    expect(attackEvents(events)).toHaveLength(2);
    expect(events.some((e) => e.type === 'abilityTriggered' && e.ability === 'doubleShot')).toBe(
      true,
    );
    expect(getCombatStack(combat, 'a0').shots).toBe(22);
  });

  it('crusader strikes twice in melee with one retaliation in between', () => {
    const combat = makeCombat(
      [{ creature: 'crusader', count: 5 }],
      [{ creature: 'walking_dead', count: 30 }],
    );
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 6, y: 5 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    const attacks = attackEvents(events);
    expect(attacks.map((a) => a.retaliation)).toEqual([false, true, false]);
    expect(attacks.map((a) => a.attacker)).toEqual(['a0', 'd0', 'a0']);
  });
});

describe('life drain and regeneration', () => {
  it('vampire lord heals and resurrects from damage dealt', () => {
    const combat = makeCombat(
      [{ creature: 'vampire_lord', count: 5 }],
      [{ creature: 'wolf', count: 50 }],
    );
    const vampires = getCombatStack(combat, 'a0');
    vampires.count = 2;
    vampires.firstHp = 10;
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 6, y: 5 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    const damage = attackEvents(events)[0]?.damage ?? 0;
    expect(damage).toBeGreaterThan(0);
    expect(events).toContainEqual({
      type: 'abilityTriggered',
      stack: 'a0',
      ability: 'lifeDrain',
    });
    const poolBefore = 10 + 1 * 40;
    const poolAfter = vampires.firstHp + (vampires.count - 1) * 40;
    expect(poolAfter).toBe(Math.min(5 * 40, poolBefore + damage));
  });

  it('wight regenerates its top creature at the start of each round', () => {
    const combat = makeCombat(
      [{ creature: 'wight', count: 3 }],
      [{ creature: 'pikeman', count: 1 }],
    );
    const wights = getCombatStack(combat, 'a0');
    wights.firstHp = 2;
    combatAct(combat, { type: 'defend' }, data); // wight (speed 5) first
    const events = combatAct(combat, { type: 'defend' }, data); // pikeman ends round
    expect(events).toContainEqual({ type: 'stackHealed', stack: 'a0', amount: 16 });
    expect(wights.firstHp).toBe(18);
  });
});

describe('bind', () => {
  it('dendroid melee binds the target in place until the binder is gone', () => {
    const combat = makeCombat(
      [
        { creature: 'dendroid_guard', count: 5 },
        { creature: 'pikeman', count: 5 },
      ],
      [{ creature: 'wolf', count: 50 }],
    );
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'a1', { x: 0, y: 0 });
    const wolves = place(combat, 'd0', { x: 6, y: 5 });
    // queue order: wolves (6), dendroid... wolf is faster; let the wolf defend first
    expect(activeCombatStack(combat)?.id).toBe('d0');
    combatAct(combat, { type: 'defend' }, data);
    combatAct(combat, { type: 'defend' }, data); // a1 pikeman (speed 4 > 3)
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    expect(events).toContainEqual({
      type: 'effectApplied',
      stack: 'd0',
      kind: 'bind',
      rounds: 1,
      value: 0,
    });
    // the bind lands with the hit: this very attack is still retaliated
    expect(events.some((e) => e.type === 'stackAttacked' && e.retaliation)).toBe(true);
    expect(reachableHexesFor(combat, 'd0', data)).toEqual([]);
    expect(() => combatAct(combat, { type: 'move', to: { x: 9, y: 5 } }, data)).toThrow(
      CombatRuleError,
    );
    expect(getEffect(wolves, 'bind')).not.toBeNull();

    // kill the dendroid: bind is released at the next round start
    getCombatStack(combat, 'a0').count = 0;
    getCombatStack(combat, 'a0').firstHp = 0;
    combatAct(combat, { type: 'defend' }, data); // wolf acts (bound but can defend)
    const roundEvents = combatAct(combat, { type: 'defend' }, data); // a1 ends the round
    expect(roundEvents).toContainEqual({ type: 'effectExpired', stack: 'd0', kind: 'bind' });
    expect(getEffect(wolves, 'bind')).toBeNull();
  });

  it('bind is physical and works on undead targets too', () => {
    const combat = makeCombat(
      [{ creature: 'dendroid_guard', count: 5 }],
      [{ creature: 'skeleton', count: 50 }],
    );
    place(combat, 'a0', { x: 5, y: 5 });
    const skeletons = place(combat, 'd0', { x: 6, y: 5 });
    while (activeCombatStack(combat)?.id !== 'a0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    expect(events).toContainEqual({
      type: 'effectApplied',
      stack: 'd0',
      kind: 'bind',
      rounds: 1,
      value: 0,
    });
    expect(getEffect(skeletons, 'bind')).not.toBeNull();
  });

  it('an already bound defender does not retaliate (spec 7.3)', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 5 }],
      [{ creature: 'wolf', count: 5 }],
    );
    place(combat, 'a0', { x: 5, y: 5 });
    const wolves = place(combat, 'd0', { x: 6, y: 5 });
    addEffect(wolves, { kind: 'bind', positive: false, rounds: 1, value: 0 });
    expect(activeCombatStack(combat)?.id).toBe('d0'); // wolves are faster
    combatAct(combat, { type: 'defend' }, data);
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    const attacks = attackEvents(events);
    expect(attacks).toHaveLength(1);
    expect(attacks[0]?.retaliation).toBe(false);
    expect(wolves.retaliationsLeft).toBe(1);
  });
});

describe('on-hit effect chances', () => {
  it('black knight curses living targets (20% on hit)', () => {
    const fight = (seed: number): CombatEvent[] => {
      const combat = makeCombat(
        [{ creature: 'black_knight', count: 1 }],
        [{ creature: 'wolf', count: 80 }],
        { seed },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 7, y: 5 });
      return combatAct(combat, { type: 'melee', target: 'd0', from: { x: 6, y: 5 } }, data);
    };
    const seed = findSeed((s) =>
      fight(s).some((e) => e.type === 'effectApplied' && e.kind === 'curse'),
    );
    expect(
      fight(seed).some((e) => e.type === 'effectApplied' && e.kind === 'curse' && e.stack === 'd0'),
    ).toBe(true);
    // and the curse must not land on undead targets, ever
    for (let s = 0; s < 50; s++) {
      const combat = makeCombat(
        [{ creature: 'black_knight', count: 1 }],
        [{ creature: 'walking_dead', count: 80 }],
        { seed: s },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 7, y: 5 });
      const events = combatAct(
        combat,
        { type: 'melee', target: 'd0', from: { x: 6, y: 5 } },
        data,
      );
      expect(events.some((e) => e.type === 'effectApplied' && e.kind === 'curse')).toBe(false);
    }
  });

  it('a cursed stack deals minimum damage', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'walking_dead', count: 50 }],
    );
    const pikemen = getCombatStack(combat, 'a0');
    addEffect(pikemen, { kind: 'curse', positive: false, rounds: 3, value: 0 });
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 6, y: 5 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    // 10 pikemen at min damage 1 each, A4 vs D5 -> x(1 - 0.025), floor(9.75) = 9
    expect(attackEvents(events)[0]?.damage).toBe(9);
  });

  it('a blessed stack deals maximum damage (+bonus at higher tiers)', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'walking_dead', count: 50 }],
    );
    addEffect(getCombatStack(combat, 'a0'), {
      kind: 'bless',
      positive: true,
      rounds: 3,
      value: 1,
    });
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 6, y: 5 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    // 10 x (3 max + 1) = 40, x0.975 = 39
    expect(attackEvents(events)[0]?.damage).toBe(39);
  });

  it('zombie disease and ghost dragon aging land with their on-hit chance', () => {
    const diseaseSeed = findSeed((seed) => {
      const combat = makeCombat(
        [{ creature: 'zombie', count: 10 }],
        [{ creature: 'peasant', count: 80 }], // slower than the zombie, living
        { seed },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 6, y: 5 });
      const events = combatAct(
        combat,
        { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
        data,
      );
      return events.some((e) => e.type === 'effectApplied' && e.kind === 'disease');
    });
    expect(diseaseSeed).toBeGreaterThanOrEqual(0);

    const agingSeed = findSeed((seed) => {
      const combat = makeCombat(
        [{ creature: 'ghost_dragon', count: 1 }],
        [{ creature: 'wolf', count: 200 }],
        { seed },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 7, y: 5 });
      const events = combatAct(
        combat,
        { type: 'melee', target: 'd0', from: { x: 6, y: 5 } },
        data,
      );
      if (!events.some((e) => e.type === 'effectApplied' && e.kind === 'aging')) return false;
      const wolves = getCombatStack(combat, 'd0');
      return effectiveHp(wolves, requireCreature('wolf')) === 8; // ceil(15/2)
    });
    expect(agingSeed).toBeGreaterThanOrEqual(0);
  });

  it('dread knight double damage doubles the strike', () => {
    const seed = findSeed((s) => {
      const combat = makeCombat(
        [{ creature: 'dread_knight', count: 1 }],
        [{ creature: 'wolf', count: 200 }],
        { seed: s },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 7, y: 5 });
      const events = combatAct(
        combat,
        { type: 'melee', target: 'd0', from: { x: 6, y: 5 } },
        data,
      );
      return events.some((e) => e.type === 'abilityTriggered' && e.ability === 'doubleDamage');
    });
    const combat = makeCombat(
      [{ creature: 'dread_knight', count: 1 }],
      [{ creature: 'wolf', count: 200 }],
      { seed },
    );
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 7, y: 5 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 6, y: 5 } }, data);
    const damage = attackEvents(events)[0]?.damage ?? 0;
    // A18 vs D3 -> mult 1.75 capped at... 1 + 0.05*15 = 1.75; dmg 15..30 doubled
    expect(damage).toBeGreaterThanOrEqual(Math.floor(15 * 1.75 * 2));
    expect(damage % 2).toBe(0);
  });
});

describe('breath and death cloud', () => {
  it('dragon breath hits the hex directly behind the target', () => {
    const combat = makeCombat(
      [{ creature: 'green_dragon', count: 1 }],
      [
        { creature: 'walking_dead', count: 100 },
        { creature: 'walking_dead', count: 100 },
        { creature: 'walking_dead', count: 100 },
      ],
    );
    place(combat, 'a0', { x: 5, y: 4 });
    place(combat, 'd0', { x: 6, y: 4 });
    place(combat, 'd1', { x: 7, y: 4 }); // directly behind d0
    place(combat, 'd2', { x: 0, y: 10 });
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 4 } }, data);
    expect(events).toContainEqual({
      type: 'abilityTriggered',
      stack: 'a0',
      ability: 'breath',
      target: 'd1',
    });
    const targets = attackEvents(events)
      .filter((e) => e.attacker === 'a0')
      .map((e) => e.target);
    expect(targets).toEqual(['d0', 'd1']);
  });

  it('lich death cloud splashes only living stacks adjacent to the target', () => {
    const combat = makeCombat(
      [{ creature: 'lich', count: 5 }],
      [
        { creature: 'wolf', count: 30 },
        { creature: 'wolf', count: 30 },
        { creature: 'walking_dead', count: 30 },
      ],
    );
    place(combat, 'd0', { x: 10, y: 5 });
    place(combat, 'd1', { x: 11, y: 5 }); // living, adjacent: splashed
    place(combat, 'd2', { x: 10, y: 4 }); // undead, adjacent: immune to the cloud
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    const targets = attackEvents(events).map((e) => e.target);
    expect(targets).toContain('d0');
    expect(targets).toContain('d1');
    expect(targets).not.toContain('d2');
    expect(
      events.some(
        (e) => e.type === 'abilityTriggered' && e.ability === 'deathCloud' && e.target === 'd1',
      ),
    ).toBe(true);
  });
});

describe('mana drain', () => {
  it('wraiths drain enemy hero mana each round', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'wraith', count: 3 }],
      { attackerHero: { hero: 'h1', mana: 10 } },
    );
    // drained already at the start of round 1
    expect(combat.attackerHero.mana).toBe(8);
    combatAct(combat, { type: 'defend' }, data); // wraith speed 7 acts first
    const events = combatAct(combat, { type: 'defend' }, data);
    expect(events).toContainEqual({ type: 'manaDrained', side: 'attacker', amount: 2, by: 'd0' });
    expect(combat.attackerHero.mana).toBe(6);
  });

  it('drain floors hero mana at zero and stops once mana is empty', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'wraith', count: 3 }],
      { attackerHero: { hero: 'h1', mana: 1 } },
    );
    // partial drain at the start of round 1: only 1 mana available
    expect(combat.attackerHero.mana).toBe(0);
    combatAct(combat, { type: 'defend' }, data);
    const events = combatAct(combat, { type: 'defend' }, data);
    expect(events.filter((e) => e.type === 'manaDrained')).toEqual([]);
    expect(combat.attackerHero.mana).toBe(0);
  });
});

describe('morale', () => {
  it('computes faction bonus, undead penalty, auras, and clamping', () => {
    const same = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'archer', count: 1 },
      ],
      [{ creature: 'wolf', count: 1 }],
    );
    expect(stackMorale(same, getCombatStack(same, 'a0'), data)).toBe(1);

    const mixed = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'wolf', count: 1 },
      ],
      [{ creature: 'wolf', count: 1 }],
    );
    expect(stackMorale(mixed, getCombatStack(mixed, 'a0'), data)).toBe(0);

    const withUndead = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'skeleton', count: 1 },
      ],
      [{ creature: 'wolf', count: 1 }],
    );
    expect(stackMorale(withUndead, getCombatStack(withUndead, 'a0'), data)).toBe(-1);
    // undead stacks always have neutral morale
    expect(stackMorale(withUndead, getCombatStack(withUndead, 'a1'), data)).toBe(0);

    const aura = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'archangel', count: 1 },
      ],
      [{ creature: 'wolf', count: 1 }],
    );
    expect(stackMorale(aura, getCombatStack(aura, 'a0'), data)).toBe(2);

    const dragon = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'bone_dragon', count: 1 }],
    );
    expect(stackMorale(dragon, getCombatStack(dragon, 'a0'), data)).toBe(0); // +1 faction -1 dragon

    const clamped = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'wolf', count: 1 }],
      { attackerHero: { morale: 10 } },
    );
    expect(stackMorale(clamped, getCombatStack(clamped, 'a0'), data)).toBe(3);
  });

  it('positive morale grants extra actions at roughly morale/24', () => {
    const samples = 600;
    let surges = 0;
    for (let seed = 0; seed < samples; seed++) {
      const combat = makeCombat(
        [{ creature: 'pikeman', count: 1 }], // all-castle: morale +1
        [{ creature: 'walking_dead', count: 10 }],
        { seed },
      );
      const events = combatAct(combat, { type: 'move', to: { x: 1, y: 0 } }, data);
      if (events.some((e) => e.type === 'moraleSurge')) surges += 1;
    }
    const rate = surges / samples;
    expect(rate).toBeGreaterThan(1 / 24 - 0.025);
    expect(rate).toBeLessThan(1 / 24 + 0.035);
  });

  it('negative morale freezes the action at roughly |morale|/24', () => {
    const samples = 600;
    let freezes = 0;
    for (let seed = 0; seed < samples; seed++) {
      const combat = makeCombat(
        [
          { creature: 'pikeman', count: 1 },
          { creature: 'skeleton', count: 1 },
        ], // mixed living+undead: morale -1
        [{ creature: 'walking_dead', count: 10 }],
        { seed },
      );
      expect(activeCombatStack(combat)?.id).toBe('a0');
      const events = combatAct(combat, { type: 'move', to: { x: 1, y: 0 } }, data);
      if (events.some((e) => e.type === 'moraleFreeze')) freezes += 1;
    }
    const rate = freezes / samples;
    expect(rate).toBeGreaterThan(1 / 24 - 0.025);
    expect(rate).toBeLessThan(1 / 24 + 0.035);
  });

  it('a surged stack keeps the turn and acts again', () => {
    const seed = findSeed((s) => {
      const combat = makeCombat(
        [{ creature: 'pikeman', count: 1 }],
        [{ creature: 'walking_dead', count: 10 }],
        { seed: s },
      );
      const events = combatAct(combat, { type: 'move', to: { x: 1, y: 0 } }, data);
      return events.some((e) => e.type === 'moraleSurge');
    });
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'walking_dead', count: 10 }],
      { seed },
    );
    combatAct(combat, { type: 'move', to: { x: 1, y: 0 } }, data);
    expect(activeCombatStack(combat)?.id).toBe('a0');
    expect(getCombatStack(combat, 'a0').moraleSurged).toBe(true);
  });
});

describe('luck', () => {
  it('doubles damage at roughly luck/24', () => {
    const samples = 600;
    let lucky = 0;
    for (let seed = 0; seed < samples; seed++) {
      const combat = makeCombat(
        [{ creature: 'skeleton', count: 10 }], // undead: no morale rolls interfere
        [{ creature: 'walking_dead', count: 60 }],
        { seed, attackerHero: { luck: 1 } },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 6, y: 5 });
      const events = combatAct(
        combat,
        { type: 'melee', target: 'd0', from: { x: 5, y: 5 } },
        data,
      );
      if (events.some((e) => e.type === 'luck' && e.stack === 'a0')) lucky += 1;
    }
    const rate = lucky / samples;
    expect(rate).toBeGreaterThan(1 / 24 - 0.025);
    expect(rate).toBeLessThan(1 / 24 + 0.035);
  });
});

describe('magic resist aura', () => {
  it('unicorn grants +20% resistance to adjacent allies only', () => {
    const combat = makeCombat(
      [
        { creature: 'pikeman', count: 1 },
        { creature: 'unicorn', count: 1 },
        { creature: 'dwarf', count: 1 },
      ],
      [{ creature: 'wolf', count: 1 }],
    );
    const pikemen = place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'a1', { x: 7, y: 5 }); // wide unicorn occupies (7,5)+(6,5): adjacent to (5,5)
    const dwarfs = place(combat, 'a2', { x: 0, y: 0 });
    expect(magicResistChance(combat, pikemen, data)).toBe(20);
    expect(magicResistChance(combat, dwarfs, data)).toBe(20); // own 20, too far for the aura
    const unicorn = getCombatStack(combat, 'a1');
    expect(magicResistChance(combat, unicorn, data)).toBe(0); // aura does not affect itself
  });
});

describe('archangel resurrect', () => {
  it('resurrects a damaged friendly stack once per battle', () => {
    const combat = makeCombat(
      [
        { creature: 'archangel', count: 2 },
        { creature: 'pikeman', count: 10 },
      ],
      [{ creature: 'walking_dead', count: 10 }],
    );
    const pikemen = getCombatStack(combat, 'a1');
    pikemen.count = 3;
    pikemen.firstHp = 5;
    expect(activeCombatStack(combat)?.id).toBe('a0');
    const events = combatAct(combat, { type: 'resurrect', target: 'a1' }, data);
    // pool 25 + 200 capped at 100 -> count 10, firstHp 10
    expect(events).toContainEqual({ type: 'stackResurrected', stack: 'a1', revived: 7 });
    expect(pikemen.count).toBe(10);
    expect(pikemen.firstHp).toBe(10);

    // a second resurrect this battle is rejected
    pikemen.count = 3;
    pikemen.firstHp = 5;
    while (activeCombatStack(combat)?.id !== 'a0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    expect(() => combatAct(combat, { type: 'resurrect', target: 'a1' }, data)).toThrow(
      'already resurrected',
    );
  });

  it('rejects resurrecting a full stack or an enemy', () => {
    const combat = makeCombat(
      [
        { creature: 'archangel', count: 1 },
        { creature: 'pikeman', count: 10 },
      ],
      [{ creature: 'walking_dead', count: 10 }],
    );
    expect(() => combatAct(combat, { type: 'resurrect', target: 'a1' }, data)).toThrow(
      'no losses',
    );
    expect(() => combatAct(combat, { type: 'resurrect', target: 'd0' }, data)).toThrow(
      'friendly',
    );
    expect(() => combatAct(combat, { type: 'resurrect', target: 'a0' }, data)).toThrow(
      'friendly',
    );
  });
});

describe('blind behavior in combat', () => {
  it('blinded stacks lose their actions and wake when damaged', () => {
    const combat = makeCombat(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'wolf', count: 5 }],
    );
    const wolves = getCombatStack(combat, 'd0');
    addEffect(wolves, { kind: 'blind', positive: false, rounds: 5, value: 100 });
    place(combat, 'a0', { x: 5, y: 5 });
    place(combat, 'd0', { x: 6, y: 5 });
    // wolves (speed 6) are first in the queue, but they are blinded and get skipped
    expect(combat.queue[0]).toBe('d0');
    const events = combatAct(combat, { type: 'melee', target: 'd0', from: { x: 5, y: 5 } }, data);
    expect(events).toContainEqual({ type: 'stackSkipped', stack: 'd0', reason: 'blind' });
    // the wolves were skipped, the pikemen acted, the hit broke the blind: no retaliation
    expect(attackEvents(events).filter((e) => e.retaliation)).toHaveLength(0);
    expect(getEffect(wolves, 'blind')).toBeNull();
  });

  it('blind applied by the strike itself suppresses the retaliation (spec 7.3)', () => {
    const fight = (seed: number): CombatEvent[] => {
      const combat = makeCombat(
        [{ creature: 'unicorn', count: 1 }],
        [{ creature: 'wolf', count: 80 }],
        { seed },
      );
      place(combat, 'a0', { x: 5, y: 5 });
      place(combat, 'd0', { x: 7, y: 5 });
      while (activeCombatStack(combat)?.id !== 'a0') {
        combatAct(combat, { type: 'defend' }, data);
      }
      return combatAct(combat, { type: 'melee', target: 'd0', from: { x: 6, y: 5 } }, data);
    };
    const blindSeed = findSeed((seed) =>
      fight(seed).some((e) => e.type === 'effectApplied' && e.kind === 'blind'),
    );
    expect(fight(blindSeed).some((e) => e.type === 'stackAttacked' && e.retaliation)).toBe(false);
    const sightedSeed = findSeed(
      (seed) => !fight(seed).some((e) => e.type === 'effectApplied' && e.kind === 'blind'),
    );
    expect(fight(sightedSeed).some((e) => e.type === 'stackAttacked' && e.retaliation)).toBe(
      true,
    );
  });
});
