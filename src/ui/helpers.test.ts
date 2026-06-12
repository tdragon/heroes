import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame, townIdAt } from '../core/setup';
import { tradeReceived } from '../core/town';
import type { GameState, PendingChoice, Town } from '../core/state';
import {
  buildAvailability,
  choiceOptionLabel,
  choiceTitle,
  clampPopupPosition,
  costText,
  maxTrades,
  recruitMax,
  scaledCost,
  stackUpgradeOffer,
  tradeModel,
  xpProgressText,
} from './helpers';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

function makeGame(): GameState {
  return newGame(tinyMap, {}, 42, data);
}

function redTown(state: GameState): Town {
  const town = state.towns[townIdAt([2, 2])];
  if (!town) throw new Error('missing red town');
  return town;
}

function building(id: string) {
  const b = data.buildings[id];
  if (!b) throw new Error(`missing building ${id}`);
  return b;
}

describe('buildAvailability', () => {
  it('reports built, available, and missing-prereq states', () => {
    const state = makeGame();
    const town = redTown(state);
    expect(buildAvailability(state, town, building('village_hall'), data)).toEqual({
      status: 'built',
    });
    expect(buildAvailability(state, town, building('tavern'), data)).toEqual({
      status: 'available',
    });
    expect(buildAvailability(state, town, building('town_hall'), data)).toEqual({
      status: 'locked',
      reason: 'requires Tavern',
    });
  });

  it('locks lower halls, capped guilds, duplicates per player, and after building today', () => {
    const state = makeGame();
    const town = redTown(state);
    expect(buildAvailability(state, town, building('mage_guild_5'), data).status).toBe('locked');

    town.buildings = town.buildings.filter((id) => id !== 'village_hall');
    town.buildings.push('tavern', 'town_hall');
    const hall = buildAvailability(state, town, building('village_hall'), data);
    expect(hall).toEqual({ status: 'locked', reason: 'superseded by Town Hall' });

    const otherTown: Town = { ...structuredClone(town), id: 'other', buildings: ['capitol'] };
    state.towns.other = otherTown;
    town.buildings.push('city_hall', 'castle');
    expect(buildAvailability(state, town, building('capitol'), data)).toEqual({
      status: 'locked',
      reason: 'already built in another town',
    });

    town.builtToday = true;
    expect(buildAvailability(state, town, building('fort'), data)).toEqual({
      status: 'locked',
      reason: 'already built today',
    });
  });

  it('reports unaffordable with the missing resources', () => {
    const state = makeGame();
    const player = state.players[0];
    if (!player) throw new Error('no player');
    player.resources.gold = 100;
    player.resources.wood = 0;
    expect(buildAvailability(state, redTown(state), building('tavern'), data)).toEqual({
      status: 'unaffordable',
      reason: 'not enough gold, wood',
    });
  });
});

describe('recruitMax', () => {
  const resources = { gold: 1000, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 2 };

  it('is bounded by the pool and by every resource', () => {
    expect(recruitMax(14, { gold: 60 }, resources)).toBe(14);
    expect(recruitMax(50, { gold: 60 }, resources)).toBe(16);
    expect(recruitMax(5, { gold: 100, gems: 1 }, resources)).toBe(2);
    expect(recruitMax(5, { gold: 5000 }, resources)).toBe(0);
  });
});

describe('tradeModel', () => {
  it('models gold-to-resource, resource-to-gold, and resource-to-resource', () => {
    expect(tradeModel('gold', 'wood', 1)).toEqual({ rate: 10, giveStep: 2500, receiveStep: 1 });
    expect(tradeModel('wood', 'gold', 1)).toEqual({ rate: 10, giveStep: 1, receiveStep: 25 });
    expect(tradeModel('wood', 'ore', 2)).toEqual({ rate: 7, giveStep: 7, receiveStep: 1 });
    expect(() => tradeModel('wood', 'wood', 1)).toThrow();
  });

  it('matches the core tradeReceived math for whole trade units', () => {
    for (const [give, receive] of [
      ['gold', 'ore'],
      ['ore', 'gold'],
      ['wood', 'gems'],
    ] as const) {
      for (const markets of [1, 2, 3]) {
        const model = tradeModel(give, receive, markets);
        expect(tradeReceived(give, receive, model.giveStep * 3, model.rate)).toBe(
          model.receiveStep * 3,
        );
      }
    }
  });

  it('computes the max number of trade units', () => {
    const model = tradeModel('gold', 'wood', 1);
    expect(maxTrades(model, 20000)).toBe(8);
    expect(maxTrades(model, 100)).toBe(0);
  });
});

describe('choice labels', () => {
  const base: PendingChoice = { id: 'c1', player: 'red', kind: 'chest', options: [] };

  it('labels chest, level-up, and plain options', () => {
    expect(choiceOptionLabel(base, 'gold:1500', data)).toBe('1500 Gold');
    expect(choiceOptionLabel(base, 'xp:1000', data)).toBe('1000 Experience');
    const levelUp: PendingChoice = { ...base, kind: 'levelUp' };
    expect(choiceOptionLabel(levelUp, 'logistics:basic', data)).toBe('Basic Logistics');
    expect(choiceOptionLabel(levelUp, 'leadership:advanced', data)).toBe('Advanced Leadership');
    const guard: PendingChoice = { ...base, kind: 'guardAttack' };
    expect(choiceOptionLabel(guard, 'attack', data)).toBe('Attack');
  });

  it('titles level-up choices with the hero name and level', () => {
    const state = makeGame();
    const hero = state.heroes.edric;
    if (!hero) throw new Error('missing edric');
    hero.level = 2;
    const choice: PendingChoice = {
      id: 'l',
      player: 'red',
      kind: 'levelUp',
      hero: 'edric',
      options: [],
    };
    expect(choiceTitle(choice, state)).toBe('Edric reaches level 2 — choose a skill');
    expect(choiceTitle({ ...choice, message: 'custom' }, state)).toBe('custom');
  });
});

describe('misc helpers', () => {
  it('formats costs and xp progress', () => {
    expect(costText({ gold: 2500, wood: 5 })).toBe('2500 gold, 5 wood');
    expect(costText({})).toBe('free');
    const state = makeGame();
    const hero = state.heroes.edric;
    if (!hero) throw new Error('missing edric');
    expect(xpProgressText(hero, data)).toBe('0 / 1000 XP');
  });
});

describe('stackUpgradeOffer', () => {
  it('offers the upgrade when its dwelling is built, priced by the cost difference', () => {
    const state = makeGame();
    const town = redTown(state);
    town.buildings.push('fort', 'castle_dwelling_1', 'castle_dwelling_1u');
    const offer = stackUpgradeOffer(town, { creature: 'pikeman', count: 10 }, data);
    expect(offer?.to.id).toBe('halberdier');
    // halberdier 75 gold vs pikeman 60 gold: 15 gold per head
    expect(offer?.cost).toEqual({ gold: 150 });
  });

  it('returns null without the upgraded dwelling or for upgrade-less creatures', () => {
    const state = makeGame();
    const town = redTown(state);
    town.buildings.push('fort', 'castle_dwelling_1');
    expect(stackUpgradeOffer(town, { creature: 'pikeman', count: 10 }, data)).toBeNull();
    town.buildings.push('castle_dwelling_1u');
    expect(stackUpgradeOffer(town, { creature: 'peasant', count: 5 }, data)).toBeNull();
  });
});

describe('scaledCost', () => {
  it('multiplies each non-zero resource by the count', () => {
    expect(scaledCost({ gold: 60, wood: 2 }, 3)).toEqual({ gold: 180, wood: 6 });
    expect(scaledCost({ gold: 10 }, 1)).toEqual({ gold: 10 });
  });
});

describe('clampPopupPosition', () => {
  it('keeps an interior position unchanged', () => {
    expect(clampPopupPosition(100, 80, 120, 40, 400, 300)).toEqual([100, 80]);
  });

  it('flips across the anchor at the right and bottom edges', () => {
    // 350 + 120 > 400 -> flip left of the anchor
    expect(clampPopupPosition(350, 80, 120, 40, 400, 300)).toEqual([230, 80]);
    // 280 + 40 > 300 -> flip above the anchor
    expect(clampPopupPosition(100, 280, 120, 40, 400, 300)).toEqual([100, 240]);
    expect(clampPopupPosition(350, 280, 120, 40, 400, 300)).toEqual([230, 240]);
  });

  it('clamps to zero when flipping would go past the left/top edge', () => {
    expect(clampPopupPosition(50, 10, 120, 40, 100, 300)).toEqual([0, 10]);
  });

  it('pins a popup larger than the bounds to the origin', () => {
    expect(clampPopupPosition(20, 20, 500, 400, 390, 300)).toEqual([0, 0]);
  });
});
