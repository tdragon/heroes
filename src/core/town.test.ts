import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { necromancyPercent } from './combat/resolve';
import { CommandRejectedError, dispatch, type Command, type GameEvent } from './commands';
import { newGame, townIdAt } from './setup';
import {
  ARMY_SLOTS,
  getPlayer,
  type GameState,
  type Hero,
  type MapObjectState,
  type Player,
  type Town,
} from './state';
import {
  applyMysticPonds,
  defenderLuckBonus,
  GOLD_PER_RESOURCE,
  HERO_HIRE_COST,
  marketplaceCount,
  MYSTIC_POND_MAX,
  MYSTIC_POND_MIN,
  STABLES_MOVEMENT_BONUS,
  TAVERN_OFFER_COUNT,
  tavernMoraleBonus,
  tradeRate,
  tradeReceived,
} from './town';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const RED_TOWN = townIdAt([2, 2]);
const BLUE_TOWN = townIdAt([9, 9]);

const RICH = {
  gold: 99999,
  wood: 99,
  ore: 99,
  mercury: 99,
  sulfur: 99,
  crystal: 99,
  gems: 99,
};

function makeGame(seed = 42): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function getTown(state: GameState, id: string): Town {
  const town = state.towns[id];
  if (!town) throw new Error(`missing town ${id}`);
  return town;
}

function redTown(state: GameState): Town {
  return getTown(state, RED_TOWN);
}

function blueTown(state: GameState): Town {
  return getTown(state, BLUE_TOWN);
}

function red(state: GameState): Player {
  return getPlayer(state, 'red');
}

function heroOf(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) throw new Error(`missing hero ${id}`);
  return hero;
}

function objectOf(state: GameState, id: string): MapObjectState {
  const obj = state.map.objects.find((o) => o.id === id);
  if (!obj) throw new Error(`missing object ${id}`);
  return obj;
}

function run(state: GameState, command: Command): { state: GameState; events: GameEvent[] } {
  return dispatch(state, command, data);
}

function build(state: GameState, building: string, town = RED_TOWN): GameState {
  const result = run(state, { type: 'build', player: 'red', town, building });
  getTown(result.state, town).builtToday = false;
  return result.state;
}

function nextDay(state: GameState): GameState {
  let current = state;
  while (current.day === state.day) {
    current = run(current, { type: 'endTurn', player: current.currentPlayer }).state;
  }
  return current;
}

function advanceToDay(state: GameState, day: number): GameState {
  let current = state;
  while (current.day < day) {
    current = nextDay(current);
  }
  return current;
}

function pikemenCount(hero: Hero): number {
  return hero.army.reduce((sum, s) => (s?.creature === 'pikeman' ? sum + s.count : sum), 0);
}

describe('build command', () => {
  it('builds a tavern, pays the cost, and marks the build slot used', () => {
    const start = makeGame();
    const { state, events } = run(start, {
      type: 'build',
      player: 'red',
      town: RED_TOWN,
      building: 'tavern',
    });
    const town = redTown(state);
    expect(town.buildings).toContain('tavern');
    expect(town.builtToday).toBe(true);
    expect(red(state).resources.gold).toBe(19500);
    expect(red(state).resources.wood).toBe(15);
    expect(events).toContainEqual({ type: 'buildingBuilt', town: RED_TOWN, building: 'tavern' });
    // the tavern immediately offers heroes for hire
    expect(town.tavernHeroes).toHaveLength(TAVERN_OFFER_COUNT);
  });

  it('rejects a second build in the same town on the same day', () => {
    const start = makeGame();
    const { state } = run(start, {
      type: 'build',
      player: 'red',
      town: RED_TOWN,
      building: 'tavern',
    });
    expect(() =>
      run(state, { type: 'build', player: 'red', town: RED_TOWN, building: 'marketplace' }),
    ).toThrow('already built today');
  });

  it('validates prereq edges', () => {
    const start = makeGame();
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'town_hall' }),
    ).toThrow('requires tavern');
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'citadel' }),
    ).toThrow('requires fort');
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'castle_dwelling_1' }),
    ).toThrow('requires fort');
    const withTavern = build(start, 'tavern');
    const withHall = build(withTavern, 'town_hall');
    expect(redTown(withHall).buildings).toContain('town_hall');
  });

  it('rejects unknown, duplicate, foreign-faction, and unaffordable buildings', () => {
    const start = makeGame();
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'palace_of_doom' }),
    ).toThrow('unknown building');
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'village_hall' }),
    ).toThrow('village_hall is already built');
    // mystic pond is a rampart special; red town is castle
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'mystic_pond' }),
    ).toThrow('unknown building');
    expect(() =>
      run(start, { type: 'build', player: 'red', town: BLUE_TOWN, building: 'tavern' }),
    ).toThrow('not owned by red');
    red(start).resources.gold = 100;
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'tavern' }),
    ).toThrow('cannot afford');
    expect(red(start).resources.gold).toBe(100);
  });

  it('halls replace each other and pay the new income', () => {
    const start = makeGame();
    let state = build(start, 'tavern');
    state = build(state, 'town_hall');
    const town = redTown(state);
    expect(town.buildings).toContain('town_hall');
    expect(town.buildings).not.toContain('village_hall');
    // downgrading back is rejected
    expect(() =>
      run(state, { type: 'build', player: 'red', town: RED_TOWN, building: 'village_hall' }),
    ).toThrow('already has town_hall');
    // income next day reflects the new hall only
    const goldBefore = red(state).resources.gold;
    const tomorrow = nextDay(state);
    expect(red(tomorrow).resources.gold).toBe(goldBefore + 1000);
  });

  it('enforces capitol uniqueness per player', () => {
    const start = makeGame();
    // give red the blue town too, with all prereqs ready in both
    const blue = blueTown(start);
    blue.owner = 'red';
    red(start).towns.push(BLUE_TOWN);
    getPlayer(start, 'blue').towns = [];
    const prereqs = ['city_hall', 'castle'];
    redTown(start).buildings.push(...prereqs);
    blue.buildings.push(...prereqs);
    red(start).resources.gold = 50000;

    const { state } = run(start, {
      type: 'build',
      player: 'red',
      town: RED_TOWN,
      building: 'capitol',
    });
    expect(() =>
      run(state, { type: 'build', player: 'red', town: BLUE_TOWN, building: 'capitol' }),
    ).toThrow('unique per player');
  });

  it('caps the mage guild at the faction maximum', () => {
    const start = makeGame();
    const town = redTown(start);
    town.buildings.push('mage_guild_1', 'mage_guild_2', 'mage_guild_3', 'mage_guild_4');
    red(start).resources = { ...RICH };
    // castle is capped at guild level 4
    expect(() =>
      run(start, { type: 'build', player: 'red', town: RED_TOWN, building: 'mage_guild_5' }),
    ).toThrow('capped at level 4');
  });
});

describe('mage guild spell rolls', () => {
  it('rolls 5 distinct level-1 spells from the faction pool, deterministically per seed', () => {
    const roll = (seed: number): string[] => {
      const start = makeGame(seed);
      const { state, events } = run(start, {
        type: 'build',
        player: 'red',
        town: RED_TOWN,
        building: 'mage_guild_1',
      });
      const event = events.find((e) => e.type === 'guildSpellsRolled');
      expect(event).toMatchObject({ town: RED_TOWN, level: 1 });
      return redTown(state).guildSpells;
    };
    const spells = roll(42);
    expect(spells).toHaveLength(5);
    expect(new Set(spells).size).toBe(5);
    for (const id of spells) {
      expect(data.spells[id]?.level).toBe(1);
      expect(data.factions.castle?.spellPool).toContain(id);
    }
    expect(roll(42)).toEqual(spells);
  });

  it('higher guild levels add 4/3/2 spells without duplicates', () => {
    let state = makeGame();
    red(state).resources = { ...RICH };
    for (const guild of ['mage_guild_1', 'mage_guild_2', 'mage_guild_3', 'mage_guild_4']) {
      state = build(state, guild);
    }
    const spells = redTown(state).guildSpells;
    expect(new Set(spells).size).toBe(spells.length);
    const byLevel = (level: number): number =>
      spells.filter((id) => data.spells[id]?.level === level).length;
    expect(byLevel(1)).toBe(5);
    expect(byLevel(2)).toBe(4);
    // castle pool has only 2 level-3 spells (fireball, forgetfulness)
    expect(byLevel(3)).toBe(2);
    expect(byLevel(4)).toBe(2);
  });

  it('teaches the visiting hero rolled spells he can learn', () => {
    const start = makeGame();
    heroOf(start, 'edric').hasSpellbook = true;
    const { state, events } = run(start, {
      type: 'build',
      player: 'red',
      town: RED_TOWN,
      building: 'mage_guild_1',
    });
    const learned = events.find((e) => e.type === 'spellsLearned');
    expect(learned).toBeDefined();
    expect(heroOf(state, 'edric').spells).toEqual(redTown(state).guildSpells);
  });
});

describe('recruit command', () => {
  function withPikemen(seed = 42): GameState {
    const start = makeGame(seed);
    redTown(start).buildings.push('fort');
    return build(start, 'castle_dwelling_1');
  }

  it('a new dwelling grants its initial growth as recruits', () => {
    const state = withPikemen();
    expect(redTown(state).availableCreatures.pikeman).toBe(14);
  });

  it('recruits into the garrison: pays gold, reduces the pool, fills a slot', () => {
    const state = withPikemen();
    const goldBefore = red(state).resources.gold;
    const { state: next, events } = run(state, {
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      creature: 'pikeman',
      count: 5,
    });
    const town = redTown(next);
    expect(town.availableCreatures.pikeman).toBe(9);
    expect(town.garrison[0]).toEqual({ creature: 'pikeman', count: 5 });
    expect(red(next).resources.gold).toBe(goldBefore - 5 * 60);
    expect(events).toContainEqual({
      type: 'creaturesRecruited',
      creature: 'pikeman',
      count: 5,
      town: RED_TOWN,
      object: null,
    });
    // recruiting again merges into the same stack
    const again = run(next, {
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      creature: 'pikeman',
      count: 9,
    }).state;
    expect(redTown(again).garrison[0]).toEqual({ creature: 'pikeman', count: 14 });
    expect(redTown(again).availableCreatures.pikeman).toBe(0);
  });

  it('recruits to the visiting hero army', () => {
    const state = withPikemen();
    const before = pikemenCount(heroOf(state, 'edric'));
    const { state: next } = run(state, {
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'visitingHero',
      creature: 'pikeman',
      count: 3,
    });
    // edric starts with pikemen, so they merge
    expect(pikemenCount(heroOf(next, 'edric'))).toBe(before + 3);
  });

  it('rejects bad counts, empty pools, missing gold, and full armies', () => {
    const state = withPikemen();
    const recruit = (creature: string, count: number): Command => ({
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      creature,
      count,
    });
    expect(() => run(state, recruit('pikeman', 0))).toThrow('invalid recruit count');
    expect(() => run(state, recruit('pikeman', 15))).toThrow('only 14 pikeman available');
    expect(() => run(state, recruit('angel', 1))).toThrow('only 0 angel available');
    red(state).resources.gold = 59;
    expect(() => run(state, recruit('pikeman', 1))).toThrow('cannot afford');
    red(state).resources.gold = 9999;
    redTown(state).garrison = Array.from({ length: ARMY_SLOTS }, (_, i) => ({
      creature: 'archer',
      count: i + 1,
    }));
    expect(() => run(state, recruit('pikeman', 1))).toThrow('no free army slot');
  });

  it('upgrades a recruited stack for the cost difference', () => {
    let state = withPikemen();
    state = run(state, {
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      creature: 'pikeman',
      count: 10,
    }).state;
    const upgrade: Command = {
      type: 'upgradeStack',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      slot: 0,
    };
    // upgrade requires the upgraded dwelling
    expect(() => run(state, upgrade)).toThrow('requires its dwelling');
    state = build(state, 'castle_dwelling_1u');
    // building the upgrade converts the remaining pool
    expect(redTown(state).availableCreatures.halberdier).toBe(4);
    expect(redTown(state).availableCreatures.pikeman).toBe(0);
    const goldBefore = red(state).resources.gold;
    const { state: next, events } = run(state, upgrade);
    expect(redTown(next).garrison[0]).toEqual({ creature: 'halberdier', count: 10 });
    // halberdier 75 - pikeman 60 = 15 gold per head
    expect(red(next).resources.gold).toBe(goldBefore - 150);
    expect(events).toContainEqual({
      type: 'stackUpgraded',
      town: RED_TOWN,
      from: 'pikeman',
      to: 'halberdier',
      count: 10,
    });
    // already upgraded stacks cannot upgrade again
    expect(() => run(next, upgrade)).toThrow('has no upgrade');
  });

  it('recruits from a flagged external dwelling through the same checks', () => {
    const state = makeGame();
    state.map.objects.push({
      id: 'obj-dwelling',
      type: 'dwelling',
      at: [4, 2],
      owner: 'red',
      guard: null,
      creature: 'wolf',
      count: 7,
      removed: false,
      visitedBy: [],
      lastResetDay: 0,
    });
    heroOf(state, 'edric').pos = [4, 2];
    const { state: next, events } = run(state, {
      type: 'recruitDwelling',
      player: 'red',
      object: 'obj-dwelling',
      hero: 'edric',
      count: 5,
    });
    expect(objectOf(next, 'obj-dwelling').count).toBe(2);
    const wolves = heroOf(next, 'edric').army.find((s) => s?.creature === 'wolf');
    expect(wolves?.count).toBe(5);
    expect(events).toContainEqual({
      type: 'creaturesRecruited',
      creature: 'wolf',
      count: 5,
      town: null,
      object: 'obj-dwelling',
    });
    const again: Command = {
      type: 'recruitDwelling',
      player: 'red',
      object: 'obj-dwelling',
      hero: 'edric',
      count: 1,
    };
    // unflagged or distant dwellings reject
    objectOf(next, 'obj-dwelling').owner = 'blue';
    expect(() => run(next, again)).toThrow('not flagged');
    objectOf(next, 'obj-dwelling').owner = 'red';
    heroOf(next, 'edric').pos = [3, 3];
    expect(() => run(next, again)).toThrow('must stand at the dwelling');
  });
});

describe('marketplace trading', () => {
  it('rates improve with the number of owned marketplaces', () => {
    expect(tradeRate(1)).toBe(10);
    expect(tradeRate(2)).toBe(7);
    expect(tradeRate(3)).toBe(5);
    expect(tradeRate(4)).toBe(4);
    expect(tradeRate(5)).toBe(3);
    expect(tradeRate(6)).toBe(2);
    expect(tradeRate(9)).toBe(2);
    expect(() => tradeRate(0)).toThrow('at least one marketplace');
  });

  it('computes received units for resource, sell, and buy trades', () => {
    expect(tradeReceived('wood', 'ore', 20, 10)).toBe(2);
    expect(tradeReceived('wood', 'gold', 4, 10)).toBe(4 * Math.floor(GOLD_PER_RESOURCE / 10));
    expect(tradeReceived('gold', 'wood', 5000, 10)).toBe(2);
    expect(tradeReceived('gold', 'wood', 2499, 10)).toBe(0);
  });

  it('executes a trade and rejects invalid ones', () => {
    const start = makeGame();
    expect(() =>
      run(start, { type: 'trade', player: 'red', give: 'wood', receive: 'ore', amount: 10 }),
    ).toThrow('owns no marketplace');
    const state = build(start, 'marketplace');
    expect(marketplaceCount(state, 'red')).toBe(1);
    const { state: next, events } = run(state, {
      type: 'trade',
      player: 'red',
      give: 'wood',
      receive: 'gems',
      amount: 10,
    });
    expect(red(next).resources.wood).toBe(red(state).resources.wood - 10);
    expect(red(next).resources.gems).toBe(red(state).resources.gems + 1);
    expect(events).toContainEqual({
      type: 'resourcesTraded',
      player: 'red',
      gave: 'wood',
      gaveAmount: 10,
      received: 'gems',
      receivedAmount: 1,
    });
    expect(() =>
      run(next, { type: 'trade', player: 'red', give: 'wood', receive: 'wood', amount: 10 }),
    ).toThrow('for itself');
    expect(() =>
      run(next, { type: 'trade', player: 'red', give: 'wood', receive: 'ore', amount: 5 }),
    ).toThrow('yields nothing');
    red(next).resources.mercury = 3;
    expect(() =>
      run(next, { type: 'trade', player: 'red', give: 'mercury', receive: 'gold', amount: 10 }),
    ).toThrow('not enough mercury');
  });
});

describe('tavern hiring', () => {
  function withTavern(seed = 42): GameState {
    const start = makeGame(seed);
    const state = build(start, 'tavern');
    // free the visiting slot so a hire can move in
    redTown(state).visitingHero = null;
    heroOf(state, 'edric').pos = [5, 2];
    return state;
  }

  function firstOffer(state: GameState): string {
    const offer = redTown(state).tavernHeroes[0];
    if (offer === undefined) throw new Error('tavern offers nothing');
    return offer;
  }

  it('offers heroes that are not on the map', () => {
    const state = withTavern();
    const offers = redTown(state).tavernHeroes;
    expect(offers).toHaveLength(TAVERN_OFFER_COUNT);
    expect(new Set(offers).size).toBe(TAVERN_OFFER_COUNT);
    for (const id of offers) {
      expect(state.heroes[id]).toBeUndefined();
      expect(data.heroes[id]).toBeDefined();
    }
  });

  it('hires a hero for 2500 gold into the visiting slot', () => {
    const state = withTavern();
    const template = firstOffer(state);
    const goldBefore = red(state).resources.gold;
    const { state: next, events } = run(state, {
      type: 'hireHero',
      player: 'red',
      town: RED_TOWN,
      hero: template,
    });
    const hired = heroOf(next, template);
    expect(hired.owner).toBe('red');
    expect(hired.pos).toEqual(redTown(next).pos);
    expect(redTown(next).visitingHero).toBe(template);
    expect(red(next).heroes).toContain(template);
    expect(red(next).resources.gold).toBe(goldBefore - HERO_HIRE_COST);
    expect(redTown(next).tavernHeroes).not.toContain(template);
    expect(events).toContainEqual({
      type: 'heroHired',
      hero: template,
      town: RED_TOWN,
      player: 'red',
    });
  });

  it('rejects hires beyond the 8-hero cap, without gold, or with an occupied slot', () => {
    const state = withTavern();
    const hire: Command = {
      type: 'hireHero',
      player: 'red',
      town: RED_TOWN,
      hero: firstOffer(state),
    };

    const occupied = structuredClone(state);
    redTown(occupied).visitingHero = 'edric';
    expect(() => run(occupied, hire)).toThrow('already visits');

    const broke = structuredClone(state);
    red(broke).resources.gold = HERO_HIRE_COST - 1;
    expect(() => run(broke, hire)).toThrow('2500 gold');

    const capped = structuredClone(state);
    red(capped).heroes = ['edric', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
    expect(() => run(capped, hire)).toThrow('8 heroes');

    expect(() =>
      run(state, { type: 'hireHero', player: 'red', town: RED_TOWN, hero: 'edric' }),
    ).toThrow('not offered');
  });

  it('requires a tavern and refreshes offers weekly', () => {
    const start = makeGame();
    expect(() =>
      run(start, { type: 'hireHero', player: 'red', town: RED_TOWN, hero: 'marcus' }),
    ).toThrow('no tavern');

    let state = build(start, 'tavern');
    let sawRefresh = false;
    while (state.day < 8) {
      const result = run(state, { type: 'endTurn', player: state.currentPlayer });
      state = result.state;
      if (result.events.some((e) => e.type === 'tavernRefreshed' && e.town === RED_TOWN)) {
        sawRefresh = true;
      }
    }
    expect(sawRefresh).toBe(true);
    expect(redTown(state).tavernHeroes).toHaveLength(TAVERN_OFFER_COUNT);
  });

  it('a defeated hero returns to the pool and can be offered again', () => {
    const state = withTavern();
    // simulate a defeat: remove edric from the map
    red(state).heroes = [];
    state.heroes = {};
    state.tavernPool.push('edric');
    let offers: string[] = [];
    let current = state;
    for (let week = 1; week <= 30 && !offers.includes('edric'); week++) {
      current = advanceToDay(current, week * 7 + 1);
      offers = redTown(current).tavernHeroes;
    }
    expect(offers).toContain('edric');
  });
});

describe('town capture', () => {
  it('captures an undefended enemy town without combat', () => {
    const state = makeGame();
    blueTown(state).visitingHero = null; // mortus steps out
    heroOf(state, 'mortus').pos = [0, 11];
    heroOf(state, 'edric').pos = [9, 8];
    const { state: next, events } = run(state, {
      type: 'moveHero',
      player: 'red',
      hero: 'edric',
      path: [[9, 9]],
    });
    expect(blueTown(next).owner).toBe('red');
    expect(red(next).towns).toContain(BLUE_TOWN);
    expect(getPlayer(next, 'blue').towns).not.toContain(BLUE_TOWN);
    expect(next.combat).toBeNull();
    expect(events).toContainEqual({
      type: 'townCaptured',
      town: BLUE_TOWN,
      player: 'red',
      previousOwner: 'blue',
    });
  });

  it('downgrades a captured capitol when the captor already owns one', () => {
    const state = makeGame();
    redTown(state).buildings = ['capitol'];
    blueTown(state).buildings = ['capitol'];
    blueTown(state).visitingHero = null;
    heroOf(state, 'mortus').pos = [0, 11];
    heroOf(state, 'edric').pos = [9, 8];
    const { state: next, events } = run(state, {
      type: 'moveHero',
      player: 'red',
      hero: 'edric',
      path: [[9, 9]],
    });
    expect(blueTown(next).owner).toBe('red');
    expect(blueTown(next).buildings).toEqual(['city_hall']);
    expect(redTown(next).buildings).toEqual(['capitol']);
    expect(events).toContainEqual({ type: 'capitolDowngraded', town: BLUE_TOWN });
  });

  it('keeps a captured capitol when the captor has none', () => {
    const state = makeGame();
    blueTown(state).buildings = ['capitol'];
    blueTown(state).visitingHero = null;
    heroOf(state, 'mortus').pos = [0, 11];
    heroOf(state, 'edric').pos = [9, 8];
    const { state: next, events } = run(state, {
      type: 'moveHero',
      player: 'red',
      hero: 'edric',
      path: [[9, 9]],
    });
    expect(blueTown(next).buildings).toEqual(['capitol']);
    expect(events.some((e) => e.type === 'capitolDowngraded')).toBe(false);
  });

  it('re-rolls tavern offers for the captor and keeps the daily build lock', () => {
    const state = makeGame();
    const blue = blueTown(state);
    blue.buildings.push('tavern');
    blue.tavernHeroes = [];
    blue.builtToday = true;
    blue.visitingHero = null;
    heroOf(state, 'mortus').pos = [0, 11];
    heroOf(state, 'edric').pos = [9, 8];
    const { state: next, events } = run(state, {
      type: 'moveHero',
      player: 'red',
      hero: 'edric',
      path: [[9, 9]],
    });
    expect(blueTown(next).tavernHeroes).toHaveLength(TAVERN_OFFER_COUNT);
    expect(events.some((e) => e.type === 'tavernRefreshed' && e.town === BLUE_TOWN)).toBe(true);
    // one build per town per day, even across a change of ownership
    expect(blueTown(next).builtToday).toBe(true);
  });

  it('a garrisoned town defends itself in a siege before capture', () => {
    const state = makeGame();
    const blue = blueTown(state);
    blue.visitingHero = null;
    blue.garrison[0] = { creature: 'skeleton', count: 10 };
    heroOf(state, 'mortus').pos = [0, 11];
    heroOf(state, 'edric').pos = [9, 8];
    const { state: next, events } = run(state, {
      type: 'moveHero',
      player: 'red',
      hero: 'edric',
      path: [[9, 9]],
    });
    expect(next.combat).not.toBeNull();
    expect(next.combat?.reason).toBe('siege');
    expect(next.combat?.defenderTown).toBe(BLUE_TOWN);
    expect(blueTown(next).owner).toBe('blue');
    expect(events).toContainEqual({
      type: 'combatStarted',
      attacker: 'edric',
      defender: null,
      object: expect.any(String) as string,
      reason: 'siege',
    });
  });
});

describe('skeleton transformer', () => {
  it('converts a visiting hero stack into same-count skeletons', () => {
    const state = makeGame();
    blueTown(state).buildings.push('skeleton_transformer');
    // play as blue
    const current = run(state, { type: 'endTurn', player: 'red' }).state;
    const mortus = heroOf(current, 'mortus');
    const slot = mortus.army.findIndex((s) => s !== null && s.creature !== 'skeleton');
    expect(slot).toBeGreaterThanOrEqual(0);
    const before = mortus.army[slot];
    if (!before) throw new Error('expected a stack to transform');
    const { state: next, events } = run(current, {
      type: 'transformToSkeletons',
      player: 'blue',
      town: BLUE_TOWN,
      slot,
    });
    expect(heroOf(next, 'mortus').army[slot]).toEqual({
      creature: 'skeleton',
      count: before.count,
    });
    expect(events).toContainEqual({
      type: 'stackTransformed',
      hero: 'mortus',
      slot,
      from: before.creature,
      count: before.count,
    });
    // skeletons cannot be transformed again
    expect(() =>
      run(next, { type: 'transformToSkeletons', player: 'blue', town: BLUE_TOWN, slot }),
    ).toThrow('already consists of skeletons');
  });

  it('requires the building and a visiting hero', () => {
    const state = makeGame();
    const current = run(state, { type: 'endTurn', player: 'red' }).state;
    expect(() =>
      run(current, { type: 'transformToSkeletons', player: 'blue', town: BLUE_TOWN, slot: 0 }),
    ).toThrow('no skeleton transformer');
    blueTown(current).buildings.push('skeleton_transformer');
    blueTown(current).visitingHero = null;
    expect(() =>
      run(current, { type: 'transformToSkeletons', player: 'blue', town: BLUE_TOWN, slot: 0 }),
    ).toThrow('no own visiting hero');
  });
});

describe('special building effects', () => {
  it('tavern and brotherhood raise defender morale; fountain raises luck', () => {
    const town = redTown(makeGame());
    expect(tavernMoraleBonus(town)).toBe(0);
    town.buildings.push('tavern');
    expect(tavernMoraleBonus(town)).toBe(1);
    town.buildings.push('brotherhood_of_the_sword');
    expect(tavernMoraleBonus(town)).toBe(2);
    expect(defenderLuckBonus(town)).toBe(0);
    town.buildings.push('fountain_of_fortune');
    expect(defenderLuckBonus(town)).toBe(2);
  });

  it('necromancy amplifiers add +10% per own town', () => {
    const state = makeGame();
    const mortus = heroOf(state, 'mortus');
    const base = necromancyPercent(state, mortus, data);
    blueTown(state).buildings.push('necromancy_amplifier');
    expect(necromancyPercent(state, mortus, data)).toBe(base + 10);
    // a foreign town's amplifier does not help
    redTown(state).buildings.push('necromancy_amplifier');
    expect(necromancyPercent(state, mortus, data)).toBe(base + 10);
  });

  it('stables grant +400 MP on build and at dawn while visiting', () => {
    const start = makeGame();
    const { state } = run(start, {
      type: 'build',
      player: 'red',
      town: RED_TOWN,
      building: 'stables',
    });
    const baseMp = heroOf(start, 'edric').movementPoints;
    expect(heroOf(state, 'edric').movementPoints).toBe(baseMp + STABLES_MOVEMENT_BONUS);
    // at dawn the visiting hero gets the bonus on top of full MP
    const tomorrow = nextDay(state);
    expect(heroOf(tomorrow, 'edric').movementPoints).toBe(baseMp + STABLES_MOVEMENT_BONUS);
  });

  it('mystic pond yields a rare resource each week', () => {
    const state = makeGame();
    // graft a rampart town so the pond resolves against rampart data
    const pondTown: Town = {
      ...structuredClone(redTown(state)),
      id: 'town-pond',
      faction: 'rampart',
      buildings: ['village_hall', 'mystic_pond'],
      visitingHero: null,
    };
    state.towns['town-pond'] = pondTown;
    red(state).towns.push('town-pond');
    const before = structuredClone(red(state).resources);
    const events: GameEvent[] = [];
    applyMysticPonds(state, events);
    const yieldEvent = events.find((e) => e.type === 'mysticPondYield');
    if (yieldEvent?.type !== 'mysticPondYield') throw new Error('expected a mystic pond yield');
    expect(['mercury', 'sulfur', 'crystal', 'gems']).toContain(yieldEvent.resource);
    expect(yieldEvent.amount).toBeGreaterThanOrEqual(MYSTIC_POND_MIN);
    expect(yieldEvent.amount).toBeLessThanOrEqual(MYSTIC_POND_MAX);
    expect(red(state).resources[yieldEvent.resource]).toBe(
      before[yieldEvent.resource] + yieldEvent.amount,
    );
  });

  it('griffin bastion adds +3 griffins to the weekly growth', () => {
    const start = makeGame();
    const town = redTown(start);
    town.buildings.push(
      'fort',
      'castle_dwelling_1',
      'castle_dwelling_2',
      'castle_dwelling_3',
      'griffin_bastion',
    );
    const state = advanceToDay(start, 8);
    // griffin growth 7 + 3 bastion bonus
    expect(redTown(state).availableCreatures.griffin).toBe(10);
  });
});

describe('command guards', () => {
  it('rejects town commands from the wrong player', () => {
    const state = makeGame();
    expect(() =>
      run(state, { type: 'build', player: 'blue', town: BLUE_TOWN, building: 'tavern' }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      run(state, {
        type: 'recruit',
        player: 'red',
        town: BLUE_TOWN,
        dest: 'garrison',
        creature: 'skeleton',
        count: 1,
      }),
    ).toThrow('not owned by red');
  });

  it('does not mutate the input state on town commands', () => {
    const state = makeGame();
    const snapshot = structuredClone(state);
    run(state, { type: 'build', player: 'red', town: RED_TOWN, building: 'tavern' });
    expect(state).toEqual(snapshot);
  });
});
