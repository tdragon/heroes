import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { addEffect, effectiveSpeed, getEffect } from './combat/abilities';
import {
  combatAct,
  createCombat,
  CombatRuleError,
  type CombatArmyStack,
  type CombatEvent,
} from './combat/engine';
import {
  getCombatStack,
  noHero,
  type CombatHeroInfo,
  type CombatState,
} from './combat/state';
import {
  buySpellbook,
  canLearnSpell,
  castCombatSpell,
  enemySpellCostAura,
  learnGuildSpells,
  maxLearnableSpellLevel,
  schoolTier,
  SPELLBOOK_COST,
  spellCost,
} from './magic';
import { seedRng } from './rng';
import {
  ARMY_SLOTS,
  emptyResources,
  type GameState,
  type Hero,
  type Town,
} from './state';

const data = loadGameData();

function requireSpell(id: string) {
  const spell = data.spells[id];
  if (!spell) throw new Error(`unknown spell ${id}`);
  return spell;
}

function requireCreature(id: string) {
  const creature = data.creatures[id];
  if (!creature) throw new Error(`unknown creature ${id}`);
  return creature;
}

function makeHero(overrides: Partial<Hero> = {}): Hero {
  return {
    id: 'h1',
    template: 'beatrice',
    name: 'Beatrice',
    class: 'cleric',
    owner: 'red',
    pos: [0, 0],
    attack: 1,
    defense: 0,
    spellPower: 2,
    knowledge: 2,
    level: 1,
    xp: 0,
    skills: [],
    army: Array.from({ length: ARMY_SLOTS }, () => null),
    artifacts: [],
    backpack: [],
    hasSpellbook: true,
    spells: [],
    mana: 20,
    movementPoints: 1500,
    tempLuck: 0,
    tempMorale: 0,
    ...overrides,
  };
}

function makeTown(overrides: Partial<Town> = {}): Town {
  return {
    id: 'town-1',
    name: 'Test Town',
    faction: 'castle',
    owner: 'red',
    pos: [0, 0],
    buildings: ['village_hall', 'mage_guild_1'],
    builtToday: false,
    garrison: Array.from({ length: ARMY_SLOTS }, () => null),
    visitingHero: null,
    availableCreatures: {},
    guildSpells: ['magic_arrow', 'haste', 'fireball', 'chain_lightning', 'implosion'],
    ...overrides,
  };
}

describe('spell learning', () => {
  it('gates learnable level by Wisdom', () => {
    const plain = makeHero();
    expect(maxLearnableSpellLevel(plain, data)).toBe(2);
    expect(canLearnSpell(plain, requireSpell('haste'), data)).toBe(true);
    expect(canLearnSpell(plain, requireSpell('fireball'), data)).toBe(false);

    const wise = makeHero({ skills: [{ skill: 'wisdom', rank: 'basic' }] });
    expect(maxLearnableSpellLevel(wise, data)).toBe(3);
    expect(canLearnSpell(wise, requireSpell('fireball'), data)).toBe(true);
    expect(canLearnSpell(wise, requireSpell('chain_lightning'), data)).toBe(false);

    const expert = makeHero({ skills: [{ skill: 'wisdom', rank: 'expert' }] });
    expect(canLearnSpell(expert, requireSpell('implosion'), data)).toBe(true);
  });

  it('requires a spellbook to learn anything', () => {
    const hero = makeHero({ hasSpellbook: false });
    expect(canLearnSpell(hero, requireSpell('haste'), data)).toBe(false);
    expect(learnGuildSpells(hero, makeTown(), data)).toEqual([]);
  });

  it('guild visit teaches all learnable spells without duplicates', () => {
    const hero = makeHero({
      spells: ['magic_arrow'],
      skills: [{ skill: 'wisdom', rank: 'basic' }],
    });
    const learned = learnGuildSpells(hero, makeTown(), data);
    expect(learned).toEqual(['haste', 'fireball']);
    expect(hero.spells).toEqual(['magic_arrow', 'haste', 'fireball']);
    // a second visit changes nothing
    expect(learnGuildSpells(hero, makeTown(), data)).toEqual([]);
  });

  it('buySpellbook validates ownership, guild, and gold', () => {
    const town = makeTown();
    const player = {
      id: 'red',
      color: 'red',
      faction: 'castle',
      isHuman: true,
      resources: { ...emptyResources(), gold: 1000 },
      heroes: ['h1'],
      towns: [town.id],
      explored: [],
      daysWithoutTown: 0,
      defeated: false,
    };
    const state = { players: [player] } as unknown as GameState;

    const hero = makeHero({ hasSpellbook: false });
    buySpellbook(state, hero, town, data);
    expect(hero.hasSpellbook).toBe(true);
    expect(player.resources.gold).toBe(1000 - SPELLBOOK_COST);
    expect(hero.spells).toEqual(['magic_arrow', 'haste']); // no wisdom: level <= 2

    expect(() => { buySpellbook(state, hero, town, data); }).toThrow('already owns');
    const poorHero = makeHero({ id: 'h2', hasSpellbook: false });
    player.resources.gold = 100;
    expect(() => { buySpellbook(state, poorHero, town, data); }).toThrow('gold');
    expect(() =>
      { buySpellbook(state, poorHero, makeTown({ owner: 'blue' }), data); },
    ).toThrow('own town');
    expect(() =>
      { buySpellbook(state, poorHero, makeTown({ buildings: ['village_hall'] }), data); },
    ).toThrow('mage guild');
  });
});

interface CasterOptions {
  spells?: string[];
  mana?: number;
  spellPower?: number;
  schoolTiers?: Partial<CombatHeroInfo['schoolTiers']>;
}

function caster(opts: CasterOptions = {}): CombatHeroInfo {
  return {
    ...noHero(),
    hero: 'h1',
    player: 'red',
    hasSpellbook: true,
    spells: opts.spells ?? Object.keys(data.spells),
    mana: opts.mana ?? 99,
    spellPower: opts.spellPower ?? 2,
    schoolTiers: { air: 0, earth: 0, fire: 0, water: 0, ...opts.schoolTiers },
  };
}

interface CastSetup {
  attacker: CombatArmyStack[];
  defender: CombatArmyStack[];
  hero?: CombatHeroInfo;
  defenderHero?: CombatHeroInfo;
  seed?: number;
}

function makeCastCombat(setup: CastSetup): CombatState {
  return createCombat(
    {
      attacker: { hero: setup.hero ?? caster(), stacks: setup.attacker },
      defender: { hero: setup.defenderHero ?? noHero(), stacks: setup.defender },
      rng: seedRng(setup.seed ?? 42),
      obstacles: [],
    },
    data,
  ).combat;
}

function cast(
  combat: CombatState,
  spell: string,
  target?: string,
  hex?: { x: number; y: number },
): CombatEvent[] {
  const events: CombatEvent[] = [];
  castCombatSpell(
    combat,
    'attacker',
    { spell, ...(target !== undefined ? { target } : {}), ...(hex ? { hex } : {}) },
    data,
    events,
  );
  return events;
}

function spellDamageOf(events: CombatEvent[], stack: string): number {
  const event = events.find((e) => e.type === 'spellDamage' && e.stack === stack);
  if (event?.type !== 'spellDamage') throw new Error(`no spell damage on ${stack}`);
  return event.damage;
}

describe('cast validation', () => {
  it('rejects casting without hero, book, knowledge, mana, or twice per round', () => {
    const noHeroCombat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 1 }],
      hero: noHero(),
    });
    expect(() => cast(noHeroCombat, 'magic_arrow', 'd0')).toThrow('no hero');

    const noBook = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 1 }],
      hero: { ...caster(), hasSpellbook: false },
    });
    expect(() => cast(noBook, 'magic_arrow', 'd0')).toThrow('spellbook');

    const unknown = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 1 }],
      hero: caster({ spells: ['haste'] }),
    });
    expect(() => cast(unknown, 'magic_arrow', 'd0')).toThrow('does not know');

    const broke = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 1 }],
      hero: caster({ mana: 4 }),
    });
    expect(() => cast(broke, 'magic_arrow', 'd0')).toThrow('mana');

    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 30 }],
    });
    cast(combat, 'magic_arrow', 'd0');
    expect(() => cast(combat, 'haste', 'a0')).toThrow('already cast');
  });

  it('rejects adventure spells in combat', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'wolf', count: 1 }],
    });
    expect(() => cast(combat, 'town_portal')).toThrow(CombatRuleError);
    expect(() => cast(combat, 'dimension_door')).toThrow(CombatRuleError);
  });

  it('a cast does not consume the active stack action', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'walking_dead', count: 30 }],
    });
    const events = combatAct(
      combat,
      { type: 'cast', spell: 'magic_arrow', target: 'd0' },
      data,
    );
    expect(events.some((e) => e.type === 'spellCast')).toBe(true);
    expect(combat.queue[0]).toBe('a0'); // still the pikemen's turn
  });
});

describe('damage spells', () => {
  it('magic arrow scales with the best school tier', () => {
    const base = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'walking_dead', count: 30 }],
    });
    expect(spellDamageOf(cast(base, 'magic_arrow', 'd0'), 'd0')).toBe(10 + 10 * 2);

    const expertFire = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'walking_dead', count: 30 }],
      hero: caster({ schoolTiers: { fire: 3 } }),
    });
    expect(spellDamageOf(cast(expertFire, 'magic_arrow', 'd0'), 'd0')).toBe(30 + 10 * 2);
  });

  it('lightning bolt, ice bolt, and implosion deal their formula damage', () => {
    const make = () =>
      makeCastCombat({
        attacker: [{ creature: 'pikeman', count: 1 }],
        defender: [{ creature: 'bone_dragon', count: 10 }],
        hero: caster({ spellPower: 3 }),
      });
    expect(spellDamageOf(cast(make(), 'lightning_bolt', 'd0'), 'd0')).toBe(10 + 25 * 3);
    expect(spellDamageOf(cast(make(), 'ice_bolt', 'd0'), 'd0')).toBe(10 + 20 * 3);
    expect(spellDamageOf(cast(make(), 'implosion', 'd0'), 'd0')).toBe(100 + 75 * 3);
  });

  it('death ripple hits living stacks on both sides and spares the undead', () => {
    const combat = makeCastCombat({
      attacker: [
        { creature: 'pikeman', count: 10 },
        { creature: 'skeleton', count: 10 },
      ],
      defender: [
        { creature: 'wolf', count: 10 },
        { creature: 'walking_dead', count: 10 },
      ],
      hero: caster({ spellPower: 2 }),
    });
    const events = cast(combat, 'death_ripple');
    const damaged = events.filter((e) => e.type === 'spellDamage').map((e) => e.stack);
    expect(damaged).toContain('a0');
    expect(damaged).toContain('d0');
    expect(damaged).not.toContain('a1');
    expect(damaged).not.toContain('d1');
    expect(spellDamageOf(events, 'a0')).toBe(10 + 5 * 2);
  });

  it('fireball hits the target hex and its neighbors', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [
        { creature: 'walking_dead', count: 30 },
        { creature: 'walking_dead', count: 30 },
        { creature: 'walking_dead', count: 30 },
      ],
      hero: caster(),
    });
    getCombatStack(combat, 'd0').pos = { x: 8, y: 4 };
    getCombatStack(combat, 'd1').pos = { x: 9, y: 4 }; // adjacent to (8,4)
    getCombatStack(combat, 'd2').pos = { x: 12, y: 10 }; // far away
    const events = cast(combat, 'fireball', undefined, { x: 8, y: 4 });
    const damaged = events.filter((e) => e.type === 'spellDamage').map((e) => e.stack);
    expect(damaged.sort()).toEqual(['d0', 'd1']);
  });

  it('chain lightning jumps to nearest stacks halving damage', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [
        { creature: 'bone_dragon', count: 20 },
        { creature: 'bone_dragon', count: 20 },
        { creature: 'bone_dragon', count: 20 },
      ],
      hero: caster({ spellPower: 1 }),
    });
    getCombatStack(combat, 'a0').pos = { x: 0, y: 0 };
    getCombatStack(combat, 'd0').pos = { x: 8, y: 5 };
    getCombatStack(combat, 'd1').pos = { x: 10, y: 5 };
    getCombatStack(combat, 'd2').pos = { x: 13, y: 5 };
    const events = cast(combat, 'chain_lightning', 'd0');
    // 25 + 40*1 = 65 -> 32 -> 16, hitting d0, then nearest unhit (d1), then a0/d2...
    expect(spellDamageOf(events, 'd0')).toBe(65);
    expect(spellDamageOf(events, 'd1')).toBe(32);
    const hits = events.filter((e) => e.type === 'spellDamage');
    expect(hits).toHaveLength(4); // basic tier: target + 3 jumps
  });

  it('meteor shower damages a hex area', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 1 }],
      defender: [{ creature: 'bone_dragon', count: 20 }],
      hero: caster({ spellPower: 2 }),
    });
    getCombatStack(combat, 'd0').pos = { x: 8, y: 4 };
    const events = cast(combat, 'meteor_shower', undefined, { x: 8, y: 4 });
    expect(spellDamageOf(events, 'd0')).toBe(25 + 25 * 2);
  });
});

describe('buffs, debuffs, and disables', () => {
  it('haste and slow change effective speed and respect mass tiers', () => {
    const combat = makeCastCombat({
      attacker: [
        { creature: 'pikeman', count: 5 },
        { creature: 'archer', count: 5 },
      ],
      defender: [{ creature: 'wolf', count: 5 }],
      hero: caster({ schoolTiers: { air: 3, earth: 2 } }),
    });
    const events = cast(combat, 'haste'); // expert air: mass, +5
    expect(events.filter((e) => e.type === 'effectApplied')).toHaveLength(2);
    const pikemen = getCombatStack(combat, 'a0');
    expect(effectiveSpeed(pikemen, requireCreature('pikeman'))).toBe(9);
    expect(getEffect(pikemen, 'haste')?.rounds).toBe(2); // duration = spell power

    combat.castThisRound.attacker = false;
    cast(combat, 'slow', 'd0'); // advanced earth: single target, -50%
    const wolves = getCombatStack(combat, 'd0');
    expect(effectiveSpeed(wolves, requireCreature('wolf'))).toBe(3);
  });

  it('buff durations expire after spell power rounds', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'walking_dead', count: 5 }],
      hero: caster({ spellPower: 1 }),
    });
    cast(combat, 'stone_skin', 'a0');
    expect(getEffect(getCombatStack(combat, 'a0'), 'stone_skin')).not.toBeNull();
    // finish the round: effect expires at the start of round 2
    const all: CombatEvent[] = [];
    all.push(...combatAct(combat, { type: 'defend' }, data));
    all.push(...combatAct(combat, { type: 'defend' }, data));
    expect(all).toContainEqual({ type: 'effectExpired', stack: 'a0', kind: 'stone_skin' });
    expect(getEffect(getCombatStack(combat, 'a0'), 'stone_skin')).toBeNull();
  });

  it('cure heals the top creature and removes debuffs', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'wolf', count: 5 }],
      hero: caster({ spellPower: 2 }),
    });
    const pikemen = getCombatStack(combat, 'a0');
    pikemen.firstHp = 1;
    addEffect(pikemen, { kind: 'slow', positive: false, rounds: 3, value: 25 });
    addEffect(pikemen, { kind: 'haste', positive: true, rounds: 3, value: 3 });
    const events = cast(combat, 'cure', 'a0');
    expect(pikemen.firstHp).toBe(10); // heal 10+5*2 capped at full
    expect(events).toContainEqual({ type: 'effectExpired', stack: 'a0', kind: 'slow' });
    expect(getEffect(pikemen, 'haste')).not.toBeNull(); // buffs stay
  });

  it('dispel removes all effects from the target', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'wolf', count: 5 }],
    });
    const pikemen = getCombatStack(combat, 'a0');
    addEffect(pikemen, { kind: 'slow', positive: false, rounds: 3, value: 25 });
    addEffect(pikemen, { kind: 'haste', positive: true, rounds: 3, value: 3 });
    cast(combat, 'dispel', 'a0');
    expect(pikemen.effects).toEqual([]);
  });

  it('blind disables the target until damaged', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'wolf', count: 5 }],
      hero: caster({ spellPower: 3 }),
    });
    cast(combat, 'blind', 'd0');
    const wolves = getCombatStack(combat, 'd0');
    expect(getEffect(wolves, 'blind')).toMatchObject({ value: 50, rounds: 3 });
  });

  it('forgetfulness blocks shooters at advanced tier and rejects non-shooters', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [
        { creature: 'lich', count: 5 },
        { creature: 'wolf', count: 5 },
      ],
      hero: caster({ schoolTiers: { water: 2 } }),
    });
    expect(() => cast(combat, 'forgetfulness', 'd1')).toThrow('shooters');
    cast(combat, 'forgetfulness', 'd0');
    // drive to the lich's turn: it cannot shoot
    while (combat.queue[0] !== 'd0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    expect(() => combatAct(combat, { type: 'shoot', target: 'a0' }, data)).toThrow('forgot');
  });
});

describe('resurrection spells', () => {
  it('animate dead restores undead stacks and rejects the living', () => {
    const combat = makeCastCombat({
      attacker: [
        { creature: 'skeleton', count: 20 },
        { creature: 'pikeman', count: 10 },
      ],
      defender: [{ creature: 'wolf', count: 5 }],
      hero: caster({ spellPower: 2 }),
    });
    const skeletons = getCombatStack(combat, 'a0');
    skeletons.count = 5;
    skeletons.firstHp = 6;
    const events = cast(combat, 'animate_dead', 'a0');
    // 30 + 50*2 = 130 HP -> 21.6 skeletons, capped at initial 20 -> revived 15
    expect(events).toContainEqual({ type: 'stackResurrected', stack: 'a0', revived: 15 });
    expect(skeletons.count).toBe(20);

    combat.castThisRound.attacker = false;
    const onLiving = cast(combat, 'animate_dead', 'a1');
    expect(onLiving).toContainEqual({
      type: 'spellResisted',
      stack: 'a1',
      spell: 'animate_dead',
      reason: 'immune',
    });
  });

  it('resurrection restores the living and rejects the undead', () => {
    const combat = makeCastCombat({
      attacker: [
        { creature: 'pikeman', count: 10 },
        { creature: 'skeleton', count: 10 },
      ],
      defender: [{ creature: 'wolf', count: 5 }],
      hero: caster({ spellPower: 1 }),
    });
    const pikemen = getCombatStack(combat, 'a0');
    pikemen.count = 2;
    pikemen.firstHp = 10;
    const events = cast(combat, 'resurrection', 'a0');
    // 40 + 50 = 90 HP -> pool 110 -> 11 pikemen? capped at initial 10
    expect(events).toContainEqual({ type: 'stackResurrected', stack: 'a0', revived: 8 });
    expect(pikemen.count).toBe(10);

    combat.castThisRound.attacker = false;
    const onUndead = cast(combat, 'resurrection', 'a1');
    expect(onUndead).toContainEqual({
      type: 'spellResisted',
      stack: 'a1',
      spell: 'resurrection',
      reason: 'immune',
    });
  });
});

describe('immunities and resistances', () => {
  it('undead are immune to bless, curse, and blind', () => {
    for (const spell of ['curse', 'blind']) {
      const combat = makeCastCombat({
        attacker: [{ creature: 'pikeman', count: 5 }],
        defender: [{ creature: 'skeleton', count: 5 }],
      });
      const events = cast(combat, spell, 'd0');
      expect(events).toContainEqual({
        type: 'spellResisted',
        stack: 'd0',
        spell,
        reason: 'immune',
      });
    }
    // bless targets friendlies: cast on own skeletons
    const combat = makeCastCombat({
      attacker: [{ creature: 'skeleton', count: 5 }],
      defender: [{ creature: 'wolf', count: 5 }],
    });
    const events = cast(combat, 'bless', 'a0');
    expect(events).toContainEqual({
      type: 'spellResisted',
      stack: 'a0',
      spell: 'bless',
      reason: 'immune',
    });
  });

  it('dragons ignore spells up to their immunity level', () => {
    const green = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'green_dragon', count: 2 }],
    });
    const fireball = cast(green, 'fireball', undefined, getCombatStack(green, 'd0').pos);
    expect(fireball).toContainEqual({
      type: 'spellResisted',
      stack: 'd0',
      spell: 'fireball',
      reason: 'immune',
    });
    green.castThisRound.attacker = false;
    const implosion = cast(green, 'implosion', 'd0'); // level 5 > immunity 3
    expect(implosion.some((e) => e.type === 'spellDamage' && e.stack === 'd0')).toBe(true);

    const gold = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'gold_dragon', count: 2 }],
    });
    const meteor = cast(gold, 'meteor_shower', undefined, getCombatStack(gold, 'd0').pos);
    expect(meteor).toContainEqual({
      type: 'spellResisted',
      stack: 'd0',
      spell: 'meteor_shower',
      reason: 'immune',
    });
  });

  it('dwarves resist hostile spells with their resistance chance', () => {
    let resisted = 0;
    let landed = 0;
    const samples = 400;
    for (let seed = 0; seed < samples; seed++) {
      const combat = makeCastCombat({
        attacker: [{ creature: 'pikeman', count: 5 }],
        defender: [{ creature: 'battle_dwarf', count: 5 }], // 40% resistance
        seed,
      });
      const events = cast(combat, 'slow', 'd0');
      if (events.some((e) => e.type === 'spellResisted' && e.reason === 'resisted'))

        resisted += 1;
      else if (events.some((e) => e.type === 'effectApplied' && e.kind === 'slow')) landed += 1;
    }
    expect(resisted + landed).toBe(samples);
    const rate = resisted / samples;
    expect(rate).toBeGreaterThan(0.3);
    expect(rate).toBeLessThan(0.5);
  });

  it('resistance does not protect from friendly buffs', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'dwarf', count: 5 }],
      defender: [{ creature: 'wolf', count: 5 }],
    });
    const events = cast(combat, 'stone_skin', 'a0');
    expect(events.some((e) => e.type === 'effectApplied' && e.kind === 'stone_skin')).toBe(true);
  });
});

describe('mana costs and the pegasus aura', () => {
  it('pegasus raises enemy casting costs by 2', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'pegasus', count: 1 }],
      hero: caster({ mana: 6 }),
    });
    expect(enemySpellCostAura(combat, 'attacker', data)).toBe(2);
    expect(spellCost(combat, 'attacker', requireSpell('magic_arrow'), data)).toBe(7);
    expect(() => cast(combat, 'magic_arrow', 'd0')).toThrow('mana');

    const richer = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'pegasus', count: 1 }],
      hero: caster({ mana: 7 }),
    });
    cast(richer, 'magic_arrow', 'd0');
    expect(richer.attackerHero.mana).toBe(0);
  });

  it('deducts mana and marks the side as having cast', () => {
    const combat = makeCastCombat({
      attacker: [{ creature: 'pikeman', count: 5 }],
      defender: [{ creature: 'walking_dead', count: 30 }],
      hero: caster({ mana: 20 }),
    });
    cast(combat, 'magic_arrow', 'd0');
    expect(combat.attackerHero.mana).toBe(15);
    expect(combat.castThisRound.attacker).toBe(true);
    expect(combat.castThisRound.defender).toBe(false);
  });
});

describe('school tiers', () => {
  it('uses the matching school skill, best for "all"-school spells', () => {
    const hero = caster({ schoolTiers: { air: 1, earth: 3, fire: 0, water: 2 } });
    expect(schoolTier(hero, requireSpell('haste'))).toBe(1);
    expect(schoolTier(hero, requireSpell('slow'))).toBe(3);
    expect(schoolTier(hero, requireSpell('curse'))).toBe(0);
    expect(schoolTier(hero, requireSpell('magic_arrow'))).toBe(3);
  });
});
