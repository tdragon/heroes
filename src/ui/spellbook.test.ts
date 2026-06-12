import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { ADVENTURE_SPELL_MP_COST, DIMENSION_DOOR_DAILY_LIMIT } from '../core/magic';
import { newGame } from '../core/setup';
import type { GameState, Hero } from '../core/state';
import { adventureSpellbookEntries } from './spellbook';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

function makeCaster(): { state: GameState; hero: Hero } {
  const state = newGame(tinyMap, {}, 42, data);
  const hero = state.heroes.edric;
  if (!hero) throw new Error('edric missing');
  hero.hasSpellbook = true;
  hero.spells = ['magic_arrow', 'town_portal', 'dimension_door'];
  hero.mana = 50;
  hero.movementPoints = 1500;
  return { state, hero };
}

describe('adventureSpellbookEntries', () => {
  it('lists only adventure spells, castable with enough mana and MP', () => {
    const { state, hero } = makeCaster();
    const entries = adventureSpellbookEntries(state, hero, data);
    expect(entries.map((e) => e.spell.id)).toEqual(['town_portal', 'dimension_door']);
    expect(entries.every((e) => e.castable)).toBe(true);
  });

  it('gates by mana, movement points, the DD daily limit, and owning a town', () => {
    const { state, hero } = makeCaster();
    hero.mana = 10; // town portal costs 16, dimension door 25
    expect(adventureSpellbookEntries(state, hero, data).map((e) => e.reason)).toEqual([
      'not enough mana',
      'not enough mana',
    ]);

    hero.mana = 50;
    hero.movementPoints = ADVENTURE_SPELL_MP_COST - 1;
    expect(adventureSpellbookEntries(state, hero, data).every((e) => !e.castable)).toBe(true);

    hero.movementPoints = 1500;
    hero.dimensionDoorCasts = DIMENSION_DOOR_DAILY_LIMIT;
    const limited = adventureSpellbookEntries(state, hero, data);
    expect(limited.find((e) => e.spell.id === 'dimension_door')?.reason).toBe(
      'daily limit reached',
    );
    expect(limited.find((e) => e.spell.id === 'town_portal')?.castable).toBe(true);

    hero.dimensionDoorCasts = 0;
    const red = state.players.find((p) => p.id === 'red');
    if (!red) throw new Error('red player missing');
    red.towns = [];
    expect(
      adventureSpellbookEntries(state, hero, data).find((e) => e.spell.id === 'town_portal')
        ?.reason,
    ).toBe('requires an own town');
  });

  it('reports the earth-magic tier that gates choosing the town portal destination', () => {
    const { state, hero } = makeCaster();
    const tierOf = (): number | undefined =>
      adventureSpellbookEntries(state, hero, data).find((e) => e.spell.id === 'town_portal')?.tier;
    expect(tierOf()).toBe(0);
    hero.skills.push({ skill: 'earth_magic', rank: 'advanced' });
    expect(tierOf()).toBe(2);
  });
});
