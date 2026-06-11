import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { dispatch, type GameEvent } from './commands';
import {
  ARTIFACT_SLOT_CAPACITY,
  applyLevelUpChoice,
  countStacks,
  effectiveStats,
  equipArtifact,
  garrisonArmy,
  giveArtifact,
  giveExperience,
  heroArmy,
  levelForXp,
  maxMovementPoints,
  parseSkillOption,
  transferStack,
  unequipArtifact,
  xpForLevel,
  type ArmyRef,
} from './hero';
import { newGame, townIdAt } from './setup';
import {
  manaRegenPerDay,
  maxMana,
  sightRadius,
  type ArmySlots,
  type GameState,
  type Hero,
} from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

function makeGame(seed = 42): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function getHero(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) throw new Error(`missing hero ${id}`);
  return hero;
}

function statSum(hero: Hero): number {
  return hero.attack + hero.defense + hero.spellPower + hero.knowledge;
}

function totalCreatures(slots: ArmySlots): number {
  return slots.reduce((sum, stack) => sum + (stack?.count ?? 0), 0);
}

const EIGHT_SKILLS = [
  'leadership',
  'armorer',
  'offense',
  'archery',
  'logistics',
  'luck',
  'scouting',
  'pathfinding',
];

describe('xp thresholds', () => {
  it('maps xp to levels at exact boundaries', () => {
    const thresholds = data.xpThresholds;
    expect(levelForXp(0, thresholds)).toBe(1);
    expect(levelForXp(999, thresholds)).toBe(1);
    expect(levelForXp(1000, thresholds)).toBe(2);
    expect(levelForXp(1999, thresholds)).toBe(2);
    expect(levelForXp(2000, thresholds)).toBe(3);
    expect(levelForXp(10 ** 9, thresholds)).toBe(thresholds.length + 1);
  });

  it('returns the xp required per level and rejects unknown levels', () => {
    expect(xpForLevel(1, data.xpThresholds)).toBe(0);
    expect(xpForLevel(2, data.xpThresholds)).toBe(1000);
    expect(xpForLevel(5, data.xpThresholds)).toBe(4600);
    expect(() => xpForLevel(99, data.xpThresholds)).toThrow('no xp threshold');
  });
});

describe('giveExperience', () => {
  it('adds xp without leveling below the first threshold', () => {
    const state = makeGame();
    const events: GameEvent[] = [];
    giveExperience(state, 'edric', 999, data, events);
    const edric = getHero(state, 'edric');
    expect(edric.xp).toBe(999);
    expect(edric.level).toBe(1);
    expect(state.pendingChoices).toEqual([]);
    expect(events).toEqual([{ type: 'heroXpGained', hero: 'edric', amount: 999, total: 999 }]);
  });

  it('levels up exactly at the threshold with a stat gain and a two-skill choice', () => {
    const state = makeGame();
    const events: GameEvent[] = [];
    const before = statSum(getHero(state, 'edric'));
    giveExperience(state, 'edric', 1000, data, events);
    const edric = getHero(state, 'edric');
    expect(edric.level).toBe(2);
    expect(statSum(edric)).toBe(before + 1);

    expect(state.pendingChoices).toHaveLength(1);
    const choice = state.pendingChoices[0];
    expect(choice?.kind).toBe('levelUp');
    expect(choice?.player).toBe('red');
    expect(choice?.hero).toBe('edric');
    expect(choice?.options).toHaveLength(2);
    for (const option of choice?.options ?? []) {
      const parsed = parseSkillOption(option);
      expect(data.skills[parsed.skill]).toBeDefined();
    }
    expect(events.some((e) => e.type === 'heroLevelUp')).toBe(true);
  });

  it('queues one choice per level for a multi-level gain', () => {
    const state = makeGame();
    const events: GameEvent[] = [];
    giveExperience(state, 'edric', 5000, data, events);
    const edric = getHero(state, 'edric');
    expect(edric.level).toBe(5);
    expect(statSum(edric)).toBe(6 + 4);
    expect(state.pendingChoices).toHaveLength(4);
    const ids = state.pendingChoices.map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    expect(events.filter((e) => e.type === 'heroLevelUp')).toHaveLength(4);
  });

  it('rolls primary stats with the seeded rng (golden values)', () => {
    const state = makeGame(42);
    giveExperience(state, 'edric', 5000, data, []);
    const edric = getHero(state, 'edric');
    expect([edric.attack, edric.defense, edric.spellPower, edric.knowledge]).toEqual([5, 3, 1, 1]);

    const replay = makeGame(42);
    giveExperience(replay, 'edric', 5000, data, []);
    expect(replay.heroes.edric).toEqual(state.heroes.edric);
    expect(replay.pendingChoices).toEqual(state.pendingChoices);
  });

  it('keeps the stat-sum invariant up to the level cap', () => {
    const state = makeGame(7);
    const before = statSum(getHero(state, 'edric'));
    giveExperience(state, 'edric', 10_000_000, data, []);
    const edric = getHero(state, 'edric');
    expect(edric.level).toBe(data.xpThresholds.length + 1);
    expect(statSum(edric)).toBe(before + edric.level - 1);
    giveExperience(state, 'edric', 10_000_000, data, []);
    expect(getHero(state, 'edric').level).toBe(data.xpThresholds.length + 1);
  });

  it('offers only upgrades when the hero already has 8 skills', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    edric.skills = EIGHT_SKILLS.map((skill) => ({ skill, rank: 'basic' }));
    giveExperience(state, 'edric', 1000, data, []);
    const choice = state.pendingChoices[0];
    expect(choice).toBeDefined();
    expect(choice?.options.length).toBe(2);
    for (const option of choice?.options ?? []) {
      const parsed = parseSkillOption(option);
      expect(EIGHT_SKILLS).toContain(parsed.skill);
      expect(parsed.rank).toBe('advanced');
    }
  });

  it('offers no choice when 8 skills are all expert', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    edric.skills = EIGHT_SKILLS.map((skill) => ({ skill, rank: 'expert' }));
    giveExperience(state, 'edric', 1000, data, []);
    expect(getHero(state, 'edric').level).toBe(2);
    expect(state.pendingChoices).toEqual([]);
  });

  it('rejects negative and fractional xp and unknown heroes', () => {
    const state = makeGame();
    expect(() => { giveExperience(state, 'edric', -1, data, []); }).toThrow('invalid xp amount');
    expect(() => { giveExperience(state, 'edric', 1.5, data, []); }).toThrow('invalid xp amount');
    expect(() => { giveExperience(state, 'nobody', 100, data, []); }).toThrow('unknown hero');
  });
});

describe('level-up choice resolution', () => {
  it('applies the picked skill via the resolveChoice command', () => {
    const state = makeGame();
    giveExperience(state, 'edric', 1000, data, []);
    const choice = state.pendingChoices[0];
    if (!choice) throw new Error('no pending choice');
    const picked = parseSkillOption(choice.options[1] ?? '');

    const { state: next, events } = dispatch(
      state,
      { type: 'resolveChoice', player: 'red', choiceId: choice.id, option: 1 },
      data,
    );
    expect(next.pendingChoices).toEqual([]);
    const edric = getHero(next, 'edric');
    expect(edric.skills).toContainEqual({ skill: picked.skill, rank: picked.rank });
    expect(events).toContainEqual({ type: 'choiceResolved', choiceId: choice.id, option: 1 });
  });

  it('blocks other commands while a level-up choice is pending', () => {
    const state = makeGame();
    giveExperience(state, 'edric', 1000, data, []);
    expect(() => dispatch(state, { type: 'endTurn', player: 'red' }, data)).toThrow(
      'pending choice',
    );
  });

  it('upgrades an existing skill instead of duplicating it', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    edric.skills = [{ skill: 'leadership', rank: 'basic' }];
    applyLevelUpChoice(
      state,
      {
        id: 'levelup-edric-2',
        player: 'red',
        kind: 'levelUp',
        hero: 'edric',
        options: ['leadership:advanced'],
      },
      0,
    );
    expect(edric.skills).toEqual([{ skill: 'leadership', rank: 'advanced' }]);
  });

  it('rejects malformed options and missing heroes', () => {
    const state = makeGame();
    const base = {
      id: 'levelup-x-2',
      player: 'red' as const,
      kind: 'levelUp',
      options: ['offense:basic'],
    };
    expect(() => { applyLevelUpChoice(state, { ...base, hero: 'nobody' }, 0); }).toThrow(
      'no valid hero',
    );
    expect(() =>
      { applyLevelUpChoice(state, { ...base, hero: 'edric', options: ['offense:legendary'] }, 0); },
    ).toThrow('malformed skill option');
    expect(() => { applyLevelUpChoice(state, { ...base, hero: 'edric' }, 5); }).toThrow('out of range');
  });
});

describe('army transfers', () => {
  function army(stacks: ([string, number] | null)[], mustKeepStack = true): ArmyRef {
    const slots: ArmySlots = Array.from({ length: 7 }, (_, i) => {
      const entry = stacks[i] ?? null;
      return entry ? { creature: entry[0], count: entry[1] } : null;
    });
    return { slots, mustKeepStack };
  }

  it('merges stacks of the same creature conserving the total', () => {
    const a = army([['pikeman', 10], ['pikeman', 5]]);
    transferStack(a, 1, a, 0);
    expect(a.slots[0]).toEqual({ creature: 'pikeman', count: 15 });
    expect(a.slots[1]).toBeNull();
    expect(totalCreatures(a.slots)).toBe(15);
  });

  it('splits part of a stack into an empty slot', () => {
    const a = army([['pikeman', 10]]);
    transferStack(a, 0, a, 3, 4);
    expect(a.slots[0]).toEqual({ creature: 'pikeman', count: 6 });
    expect(a.slots[3]).toEqual({ creature: 'pikeman', count: 4 });
    expect(totalCreatures(a.slots)).toBe(10);
  });

  it('swaps stacks of different creatures on a full move', () => {
    const a = army([['pikeman', 10], ['archer', 4]]);
    transferStack(a, 0, a, 1);
    expect(a.slots[0]).toEqual({ creature: 'archer', count: 4 });
    expect(a.slots[1]).toEqual({ creature: 'pikeman', count: 10 });
  });

  it('rejects splitting onto a different creature stack', () => {
    const a = army([['pikeman', 10], ['archer', 4]]);
    expect(() => { transferStack(a, 0, a, 1, 3); }).toThrow('different creature');
  });

  it('moves and merges between two armies', () => {
    const hero = army([['pikeman', 10], ['archer', 4]]);
    const garrison = army([['pikeman', 2]], false);
    transferStack(hero, 0, garrison, 0, 10);
    expect(garrison.slots[0]).toEqual({ creature: 'pikeman', count: 12 });
    expect(hero.slots[0]).toBeNull();
    expect(totalCreatures(hero.slots) + totalCreatures(garrison.slots)).toBe(16);
  });

  it('cannot leave a hero without an army', () => {
    const hero = army([['pikeman', 10]]);
    const garrison = army([], false);
    expect(() => { transferStack(hero, 0, garrison, 0); }).toThrow('without an army');
    expect(() => { transferStack(hero, 0, garrison, 0, 9); }).not.toThrow();
    expect(hero.slots[0]).toEqual({ creature: 'pikeman', count: 1 });
  });

  it('allows moving the last stack within the same army and emptying a garrison', () => {
    const hero = army([['pikeman', 10]]);
    transferStack(hero, 0, hero, 6);
    expect(hero.slots[6]).toEqual({ creature: 'pikeman', count: 10 });

    const garrison = army([['pikeman', 3]], false);
    const other = army([['archer', 2]]);
    transferStack(garrison, 0, other, 1);
    expect(countStacks(garrison.slots)).toBe(0);
    expect(other.slots[1]).toEqual({ creature: 'pikeman', count: 3 });
  });

  it('validates slots, counts, and empty sources', () => {
    const a = army([['pikeman', 10]]);
    expect(() => { transferStack(a, 0, a, 7); }).toThrow('invalid army slot');
    expect(() => { transferStack(a, -1, a, 0); }).toThrow('invalid army slot');
    expect(() => { transferStack(a, 1, a, 2); }).toThrow('is empty');
    expect(() => { transferStack(a, 0, a, 0); }).toThrow('onto itself');
    expect(() => { transferStack(a, 0, a, 1, 0); }).toThrow('invalid transfer count');
    expect(() => { transferStack(a, 0, a, 1, 11); }).toThrow('invalid transfer count');
  });

  it('wraps hero and garrison armies with the right constraints', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    const town = state.towns[townIdAt([2, 2])];
    if (!town) throw new Error('missing town');
    expect(heroArmy(edric)).toEqual({ slots: edric.army, mustKeepStack: true });
    expect(garrisonArmy(town)).toEqual({ slots: town.garrison, mustKeepStack: false });

    transferStack(heroArmy(edric), 1, garrisonArmy(town), 0);
    expect(town.garrison[0]?.creature).toBe('archer');
    expect(edric.army[1]).toBeNull();
  });
});

describe('artifacts', () => {
  it('gives artifacts to the backpack and equips them with slot validation', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    giveArtifact(edric, 'iron_sword', data);
    expect(edric.backpack).toEqual(['iron_sword']);
    equipArtifact(edric, 'iron_sword', data);
    expect(edric.artifacts).toEqual(['iron_sword']);
    expect(edric.backpack).toEqual([]);
  });

  it('rejects equipping into a full slot per capacity table', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    expect(ARTIFACT_SLOT_CAPACITY.head).toBe(1);
    giveArtifact(edric, 'scholars_cap', data);
    giveArtifact(edric, 'crown_of_insight', data);
    equipArtifact(edric, 'scholars_cap', data);
    expect(() => { equipArtifact(edric, 'crown_of_insight', data); }).toThrow('slot head is full');

    expect(ARTIFACT_SLOT_CAPACITY.misc).toBe(4);
    for (const id of ['tome_of_basics', 'lucky_coin', 'banner_of_courage', 'spyglass']) {
      giveArtifact(edric, id, data);
      equipArtifact(edric, id, data);
    }
    giveArtifact(edric, 'mystic_orb', data);
    expect(() => { equipArtifact(edric, 'mystic_orb', data); }).toThrow('slot misc is full');
  });

  it('rejects equipping from outside the backpack and unknown artifacts', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    expect(() => { equipArtifact(edric, 'iron_sword', data); }).toThrow('not in the backpack');
    expect(() => { giveArtifact(edric, 'excalibur', data); }).toThrow('unknown artifact');
    expect(() => { unequipArtifact(edric, 'iron_sword'); }).toThrow('not equipped');
  });

  it('unequips back to the backpack', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    giveArtifact(edric, 'oak_shield', data);
    equipArtifact(edric, 'oak_shield', data);
    unequipArtifact(edric, 'oak_shield');
    expect(edric.artifacts).toEqual([]);
    expect(edric.backpack).toEqual(['oak_shield']);
  });

  it('aggregates effective stats from skills and equipped artifacts only', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    for (const id of ['iron_sword', 'lucky_coin', 'banner_of_courage', 'oak_shield']) {
      giveArtifact(edric, id, data);
    }
    equipArtifact(edric, 'iron_sword', data);
    equipArtifact(edric, 'lucky_coin', data);
    equipArtifact(edric, 'banner_of_courage', data);

    // knight 2/2/1/1, basic leadership; oak_shield stays in backpack
    expect(effectiveStats(edric, data)).toEqual({
      attack: 3,
      defense: 2,
      spellPower: 1,
      knowledge: 1,
      morale: 2,
      luck: 1,
    });
  });

  it('feeds artifact bonuses into mana, regen, sight, and movement formulas', () => {
    const state = makeGame();
    const edric = getHero(state, 'edric');
    const baseMp = maxMovementPoints(edric, data);
    for (const id of ['tome_of_basics', 'amulet_of_mana', 'spyglass', 'travelers_boots']) {
      giveArtifact(edric, id, data);
      equipArtifact(edric, id, data);
    }
    expect(maxMana(edric, data)).toBe(20);
    expect(manaRegenPerDay(edric, data)).toBe(3);
    expect(sightRadius(edric, data)).toBe(6);
    expect(maxMovementPoints(edric, data)).toBe(baseMp + 300);
  });
});
