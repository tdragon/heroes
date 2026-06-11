import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame, townIdAt } from './setup';
import { isExplored } from './fog';
import { type CreatureStack } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

function makeGame(seed = 42) {
  return newGame(tinyMap, {}, seed, data);
}

describe('newGame', () => {
  it('creates players with default starting resources', () => {
    const state = makeGame();
    expect(state.players).toHaveLength(2);
    for (const player of state.players) {
      expect(player.resources).toEqual({
        gold: 20000,
        wood: 20,
        ore: 20,
        mercury: 5,
        sulfur: 5,
        crystal: 5,
        gems: 5,
      });
      expect(player.defeated).toBe(false);
      expect(player.daysWithoutTown).toBe(0);
    }
    expect(state.players[0]?.id).toBe('red');
    expect(state.players[1]?.id).toBe('blue');
    expect(state.currentPlayer).toBe('red');
    expect(state.day).toBe(1);
    expect(state.status).toBe('running');
    expect(state.combat).toBeNull();
    expect(state.pendingChoices).toEqual([]);
  });

  it('honors starting resource overrides', () => {
    const state = newGame(tinyMap, { startingResources: { gold: 999, wood: 1 } }, 1, data);
    expect(state.players[0]?.resources.gold).toBe(999);
    expect(state.players[0]?.resources.wood).toBe(1);
    expect(state.players[0]?.resources.ore).toBe(20);
  });

  it('places towns with owners, village hall, and visiting start hero', () => {
    const state = makeGame();
    const redTown = state.towns[townIdAt([2, 2])];
    const blueTown = state.towns[townIdAt([9, 9])];
    expect(redTown).toBeDefined();
    expect(blueTown).toBeDefined();
    expect(redTown?.owner).toBe('red');
    expect(redTown?.faction).toBe('castle');
    expect(redTown?.buildings).toEqual(['village_hall']);
    expect(redTown?.visitingHero).toBe('edric');
    expect(redTown?.garrison).toHaveLength(7);
    expect(redTown?.garrison.every((s) => s === null)).toBe(true);
    expect(blueTown?.owner).toBe('blue');
    expect(blueTown?.faction).toBe('necropolis');
    expect(blueTown?.visitingHero).toBe('mortus');
    expect(state.players[0]?.towns).toEqual([townIdAt([2, 2])]);
  });

  it('creates start heroes with class stats, template skills, and rolled army', () => {
    const state = makeGame();
    const edric = state.heroes.edric;
    expect(edric).toBeDefined();
    if (!edric) return;
    expect(edric.owner).toBe('red');
    expect(edric.pos).toEqual([2, 2]);
    expect([edric.attack, edric.defense, edric.spellPower, edric.knowledge]).toEqual([2, 2, 1, 1]);
    expect(edric.level).toBe(1);
    expect(edric.xp).toBe(0);
    expect(edric.skills).toEqual([
      { skill: 'leadership', rank: 'basic' },
      { skill: 'armorer', rank: 'basic' },
    ]);
    expect(edric.hasSpellbook).toBe(false);
    expect(edric.spells).toEqual([]);

    expect(edric.army).toHaveLength(7);
    const pikemen = edric.army[0];
    const archers = edric.army[1];
    expect(pikemen?.creature).toBe('pikeman');
    expect(pikemen?.count).toBeGreaterThanOrEqual(10);
    expect(pikemen?.count).toBeLessThanOrEqual(20);
    expect(archers?.creature).toBe('archer');
    expect(archers?.count).toBeGreaterThanOrEqual(4);
    expect(archers?.count).toBeLessThanOrEqual(7);
    expect(edric.army.slice(2).every((s) => s === null)).toBe(true);
  });

  it('initializes mana and movement points from formulas', () => {
    const state = makeGame();
    const edric = state.heroes.edric;
    const mortus = state.heroes.mortus;
    // knight knowledge 1 -> 10 mana; slowest creature speed 4 -> 1500 + 200 MP
    expect(edric?.mana).toBe(10);
    expect(edric?.movementPoints).toBe(1700);
    // death knight knowledge 1 -> 10 mana; walking dead speed 3 -> 1650 MP
    expect(mortus?.mana).toBe(10);
    expect(mortus?.movementPoints).toBe(1650);
  });

  it('is deterministic per seed', () => {
    expect(makeGame(7)).toEqual(makeGame(7));
    const armyCounts = (seed: number): number[] =>
      Object.values(newGame(tinyMap, {}, seed, data).heroes).flatMap((h) =>
        h.army.filter((s): s is CreatureStack => s !== null).map((s) => s.count),
      );
    expect(armyCounts(1)).not.toEqual(armyCounts(2));
  });

  it('creates object states with guards, amounts, and ids', () => {
    const state = makeGame();
    expect(state.map.objects).toHaveLength(tinyMapSource.objects.length);

    const mine = state.map.objects.find((o) => o.type === 'mine');
    expect(mine?.subtype).toBe('sawmill');
    expect(mine?.owner).toBeNull();
    expect(mine?.guard).toEqual({ creature: 'wolf', count: 4 });
    expect(mine?.removed).toBe(false);

    const wood = state.map.objects.find((o) => o.type === 'resource' && o.subtype === 'wood');
    expect(wood?.amount).toBe(6);

    const chest = state.map.objects.find((o) => o.type === 'treasure_chest');
    expect(chest?.amount).toBeUndefined();

    const ids = state.map.objects.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rolls amounts for resource piles that do not specify one', () => {
    const source = {
      ...tinyMapSource,
      objects: [
        ...tinyMapSource.objects,
        { type: 'resource', subtype: 'ore' as const, at: [10, 3] as [number, number] },
      ],
    };
    const map = compileMap(source, data);
    const state = newGame(map, {}, 5, data);
    const ore = state.map.objects.find((o) => o.type === 'resource' && o.subtype === 'ore');
    expect(ore?.amount).toBeGreaterThanOrEqual(5);
    expect(ore?.amount).toBeLessThanOrEqual(10);
  });

  it('reveals initial fog around own heroes and towns only', () => {
    const state = makeGame();
    const red = state.players[0];
    const blue = state.players[1];
    if (!red || !blue) throw new Error('missing players');
    const size = state.map.size;

    expect(isExplored(red, size, [2, 2])).toBe(true);
    expect(isExplored(red, size, [2, 7])).toBe(true); // radius 5 below town
    expect(isExplored(red, size, [11, 11])).toBe(false);
    expect(isExplored(blue, size, [9, 9])).toBe(true);
    expect(isExplored(blue, size, [0, 0])).toBe(false);
    expect(red.explored).toHaveLength(size * size);
  });
});
