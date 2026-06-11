import { describe, expect, it } from 'vitest';
import { loadGameData, validateCrossReferences, type GameData } from './index';
import { CreatureSchema } from './schema';

const data = loadGameData();

function clone(input: GameData): GameData {
  return structuredClone(input);
}

describe('loadGameData', () => {
  it('loads and cross-validates all data files without errors', () => {
    expect(() => loadGameData()).not.toThrow();
  });

  it('contains 42 faction creatures (7 tiers x 2 forms x 3 factions)', () => {
    const factionCreatures = Object.values(data.creatures).filter((c) => c.faction !== 'neutral');
    expect(factionCreatures).toHaveLength(42);
  });

  it('contains at least 8 neutral creatures', () => {
    const neutrals = Object.values(data.creatures).filter((c) => c.faction === 'neutral');
    expect(neutrals.length).toBeGreaterThanOrEqual(8);
  });

  it('contains the full MVP content counts', () => {
    expect(Object.keys(data.skills)).toHaveLength(16);
    expect(Object.keys(data.spells)).toHaveLength(24);
    expect(Object.keys(data.artifacts).length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(data.objectTypes)).toHaveLength(20);
    expect(Object.keys(data.factions)).toHaveLength(3);
    expect(Object.keys(data.heroClasses)).toHaveLength(6);
    expect(Object.keys(data.heroes)).toHaveLength(24);
    expect(data.xpThresholds).toHaveLength(29);
  });

  it('every faction has 7 base + 7 upgraded dwellings and 4 heroes per class', () => {
    for (const faction of Object.values(data.factions)) {
      expect(faction.dwellings).toHaveLength(14);
      expect(faction.dwellings.filter((d) => d.upgradeOf !== undefined)).toHaveLength(7);
      for (const classId of faction.heroClasses) {
        const named = Object.values(data.heroes).filter((h) => h.class === classId);
        expect(named).toHaveLength(4);
      }
    }
  });

  it('has all artifact rarity classes represented', () => {
    const rarities = new Set(Object.values(data.artifacts).map((a) => a.rarity));
    expect(rarities).toEqual(new Set(['treasure', 'minor', 'major', 'relic']));
  });
});

describe('spot-checked values', () => {
  it('Archangel costs 5000 gold + 3 gems and upgrades Angel', () => {
    const archangel = data.creatures.archangel;
    expect(archangel).toBeDefined();
    expect(archangel?.cost).toEqual({ gold: 5000, gems: 3 });
    expect(archangel?.attack).toBe(30);
    expect(archangel?.upgradeOf).toBe('angel');
    expect(archangel?.flags).toContain('flying');
  });

  it('Slow is an earth level-1 spell costing 6 mana', () => {
    const slow = data.spells.slow;
    expect(slow?.school).toBe('earth');
    expect(slow?.level).toBe(1);
    expect(slow?.manaCost).toBe(6);
    expect(slow?.tiers[3].mass).toBe(true);
  });

  it('all Necropolis creatures are undead', () => {
    const necro = Object.values(data.creatures).filter((c) => c.faction === 'necropolis');
    expect(necro).toHaveLength(14);
    for (const creature of necro) {
      expect(creature.flags).toContain('undead');
    }
  });

  it('terrain costs match the spec and water is impassable', () => {
    expect(data.terrains.swamp?.moveCost).toBe(175);
    expect(data.terrains.grass?.moveCost).toBe(100);
    expect(data.terrains.rough?.moveCost).toBe(125);
    expect(data.terrains.water?.moveCost).toBeNull();
    expect(data.roads.cobblestone_road?.moveCost).toBe(50);
  });

  it('Capitol gives 4000 gold/day, requires City Hall + Castle, unique per player', () => {
    const capitol = data.buildings.capitol;
    expect(capitol?.income).toEqual({ gold: 4000 });
    expect(capitol?.prereqs).toEqual(['city_hall', 'castle']);
    expect(capitol?.uniquePerPlayer).toBe(true);
  });

  it('Knight levels up with 35/45/10/10 early stat chances and no spellbook', () => {
    const knight = data.heroClasses.knight;
    expect(knight?.levelUpChancesEarly).toEqual([35, 45, 10, 10]);
    expect(knight?.hasSpellbook).toBe(false);
  });

  it('mine object has 7 subtypes and the gold mine pays 1000/day', () => {
    const mine = data.objectTypes.mine;
    expect(mine?.subtypes).toHaveLength(7);
    const goldMine = mine?.subtypes?.find((s) => s.id === 'gold_mine');
    expect(goldMine?.income).toEqual({ gold: 1000 });
  });

  it('xp thresholds start at 1000 and strictly increase', () => {
    expect(data.xpThresholds[0]).toBe(1000);
    expect(data.xpThresholds[1]).toBe(2000);
    for (let i = 1; i < data.xpThresholds.length; i++) {
      expect(data.xpThresholds[i]).toBeGreaterThan(data.xpThresholds[i - 1] ?? Infinity);
    }
  });

  it('Edric starts with Leadership + Armorer and a pikeman/archer army', () => {
    const edric = data.heroes.edric;
    expect(edric?.class).toBe('knight');
    expect(edric?.startSkills).toEqual([
      { skill: 'leadership', rank: 'basic' },
      { skill: 'armorer', rank: 'basic' },
    ]);
    expect(edric?.startArmy.map((s) => s.creature)).toEqual(['pikeman', 'archer']);
  });
});

describe('schema validation', () => {
  it('rejects a creature with dmgMin > dmgMax', () => {
    const pikeman = data.creatures.pikeman;
    expect(pikeman).toBeDefined();
    const broken = { ...structuredClone(pikeman), dmgMin: 5, dmgMax: 2 };
    expect(CreatureSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a creature with non-positive hp', () => {
    const pikeman = data.creatures.pikeman;
    const broken = { ...structuredClone(pikeman), hp: 0 };
    expect(CreatureSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a creature with an unknown special', () => {
    const pikeman = data.creatures.pikeman;
    const broken = { ...structuredClone(pikeman), specials: [{ type: 'timeTravel' }] };
    expect(CreatureSchema.safeParse(broken).success).toBe(false);
  });
});

describe('validateCrossReferences', () => {
  it('returns no errors for shipped data', () => {
    expect(validateCrossReferences(data)).toEqual([]);
  });

  it('catches a dangling creature id in a faction roster', () => {
    const broken = clone(data);
    const entry = broken.factions.castle?.creatures[0];
    if (!entry) throw new Error('fixture missing');
    entry.base = 'no_such_creature';
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('no_such_creature'))).toBe(true);
  });

  it('catches a dangling building prereq', () => {
    const broken = clone(data);
    broken.buildings.city_hall?.prereqs.push('no_such_building');
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('no_such_building'))).toBe(true);
  });

  it('catches a building prereq cycle', () => {
    const broken = clone(data);
    const tavern = broken.buildings.tavern;
    if (!tavern) throw new Error('fixture missing');
    tavern.prereqs = ['town_hall'];
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('catches a dangling spell in a faction guild pool', () => {
    const broken = clone(data);
    broken.factions.rampart?.spellPool.push('summon_kraken');
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('summon_kraken'))).toBe(true);
  });

  it('catches a hero with an unknown start spell', () => {
    const broken = clone(data);
    const hero = broken.heroes.beatrice;
    if (!hero) throw new Error('fixture missing');
    hero.startSpell = 'no_such_spell';
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('no_such_spell'))).toBe(true);
  });

  it('catches an upgrade pair with mismatched tiers', () => {
    const broken = clone(data);
    const halberdier = broken.creatures.halberdier;
    if (!halberdier) throw new Error('fixture missing');
    halberdier.tier = 2;
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('tier mismatch'))).toBe(true);
  });

  it('catches non-increasing xp thresholds', () => {
    const broken = clone(data);
    broken.xpThresholds[3] = broken.xpThresholds[2] ?? 0;
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes('xpThresholds'))).toBe(true);
  });

  it('catches duplicate terrain/road chars', () => {
    const broken = clone(data);
    const dirtRoad = broken.roads.dirt_road;
    if (!dirtRoad) throw new Error('fixture missing');
    dirtRoad.char = 'g';
    const errors = validateCrossReferences(broken);
    expect(errors.some((e) => e.includes("char 'g'"))).toBe(true);
  });
});
