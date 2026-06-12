import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { CommandRejectedError, dispatch, type GameEvent } from './commands';
import { newGame, townIdAt } from './setup';
import type { GameState } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const RED_TOWN = townIdAt([2, 2]);

function makeGame(seed = 42): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function fullRotation(state: GameState): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let current = state;
  const startDay = current.day;
  while (current.day === startDay) {
    const result = dispatch(current, { type: 'endTurn', player: current.currentPlayer }, data);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

function advanceToDay(state: GameState, day: number): GameState {
  let current = state;
  while (current.day < day) {
    current = fullRotation(current).state;
  }
  return current;
}

describe('endTurn', () => {
  it('passes the turn to the next player without advancing the day', () => {
    const start = makeGame();
    const { state, events } = dispatch(start, { type: 'endTurn', player: 'red' }, data);
    expect(state.currentPlayer).toBe('blue');
    expect(state.day).toBe(1);
    expect(events).toEqual([{ type: 'turnStarted', player: 'blue' }]);
  });

  it('advances the day after a full rotation and pays hall income', () => {
    const start = makeGame();
    const { state, events } = fullRotation(start);
    expect(state.day).toBe(2);
    expect(state.currentPlayer).toBe('red');
    expect(events).toContainEqual({ type: 'dayStarted', day: 2 });
    // village hall: +500 gold/day for both players
    expect(state.players[0]?.resources.gold).toBe(20500);
    expect(state.players[1]?.resources.gold).toBe(20500);
    expect(events).toContainEqual({
      type: 'income',
      player: 'red',
      amounts: { gold: 500, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0 },
    });
  });

  it('does not mutate the input state', () => {
    const start = makeGame();
    const snapshot = structuredClone(start);
    dispatch(start, { type: 'endTurn', player: 'red' }, data);
    expect(start).toEqual(snapshot);
  });

  it('resource silo pays +1 of the faction rare resource per day', () => {
    const start = makeGame();
    const town = start.towns[RED_TOWN];
    if (!town) throw new Error('missing red town');
    town.buildings.push('resource_silo');
    const { state, events } = fullRotation(start);
    expect(state.players[0]?.resources.gems).toBe(6); // castle silo: +1 gems
    expect(state.players[1]?.resources.gems).toBe(5);
    expect(events).toContainEqual({
      type: 'income',
      player: 'red',
      amounts: { gold: 500, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 1 },
    });
  });

  it('pays mine income to the mine owner only', () => {
    const start = makeGame();
    const mine = start.map.objects.find((o) => o.type === 'mine');
    if (!mine) throw new Error('no mine on tiny map');
    mine.owner = 'red';
    const { state } = fullRotation(start);
    expect(state.players[0]?.resources.wood).toBe(22); // sawmill +2
    expect(state.players[1]?.resources.wood).toBe(20);
  });

  it('skips defeated players in the rotation', () => {
    const start = makeGame();
    const blue = start.players[1];
    if (!blue) throw new Error('missing blue');
    blue.defeated = true;
    const { state } = dispatch(start, { type: 'endTurn', player: 'red' }, data);
    expect(state.day).toBe(2);
    expect(state.currentPlayer).toBe('red');
    expect(state.players[1]?.resources.gold).toBe(20000); // no income for defeated
  });

  it('regenerates movement points and +1 mana per day, capped at max', () => {
    const start = makeGame();
    const edric = start.heroes.edric;
    if (!edric) throw new Error('missing edric');
    edric.movementPoints = 0;
    edric.mana = 5;
    let state = fullRotation(start).state;
    expect(state.heroes.edric?.movementPoints).toBe(1700);
    expect(state.heroes.edric?.mana).toBe(6);
    state = advanceToDay(state, 10);
    expect(state.heroes.edric?.mana).toBe(10); // capped at knowledge * 10
  });

  it('resets builtToday on each new day', () => {
    const start = makeGame();
    const town = start.towns[RED_TOWN];
    if (!town) throw new Error('missing red town');
    town.builtToday = true;
    const { state } = fullRotation(start);
    expect(state.towns[RED_TOWN]?.builtToday).toBe(false);
  });

  it('tracks consecutive days without towns', () => {
    const start = makeGame();
    const red = start.players[0];
    if (!red) throw new Error('missing red');
    red.towns = [];
    let state = fullRotation(start).state;
    expect(state.players[0]?.daysWithoutTown).toBe(1);
    state = fullRotation(state).state;
    expect(state.players[0]?.daysWithoutTown).toBe(2);
    const restored = state.players[0];
    if (!restored) throw new Error('missing red');
    restored.towns = [RED_TOWN];
    state = fullRotation(state).state;
    expect(state.players[0]?.daysWithoutTown).toBe(0);
  });
});

describe('weekly growth', () => {
  it('adds dwelling growth to the pool on week start with a banner event', () => {
    let state = makeGame();
    state.towns[RED_TOWN]?.buildings.push('fort', 'castle_dwelling_1');
    state = advanceToDay(state, 7);
    expect(state.towns[RED_TOWN]?.availableCreatures).toEqual({});

    const { state: day8, events } = fullRotation(state);
    expect(day8.day).toBe(8);
    expect(events).toContainEqual({ type: 'weekStarted', week: 2 });
    expect(events).toContainEqual({ type: 'growth', town: RED_TOWN });
    expect(day8.towns[RED_TOWN]?.availableCreatures).toEqual({ pikeman: 14 });
  });

  it('applies citadel x1.5 and castle x2 growth multipliers', () => {
    const withBuildings = (extra: string[]): number => {
      let state = makeGame();
      state.towns[RED_TOWN]?.buildings.push('fort', 'castle_dwelling_1', ...extra);
      state = advanceToDay(state, 8);
      return state.towns[RED_TOWN]?.availableCreatures.pikeman ?? 0;
    };
    expect(withBuildings([])).toBe(14);
    expect(withBuildings(['citadel'])).toBe(21);
    expect(withBuildings(['citadel', 'castle'])).toBe(28);
  });

  it('grows the upgraded creature when the upgraded dwelling is built', () => {
    let state = makeGame();
    state.towns[RED_TOWN]?.buildings.push('fort', 'castle_dwelling_1', 'castle_dwelling_1u');
    state = advanceToDay(state, 8);
    expect(state.towns[RED_TOWN]?.availableCreatures).toEqual({ halberdier: 14 });
  });

  it('emits a month banner on day 29', () => {
    const state = advanceToDay(makeGame(), 28);
    const { state: day29, events } = fullRotation(state);
    expect(day29.day).toBe(29);
    expect(events).toContainEqual({ type: 'monthStarted', month: 2 });
    expect(events).toContainEqual({ type: 'weekStarted', week: 5 });
  });
});

describe('command rejection', () => {
  it('rejects commands from a non-current player', () => {
    const state = makeGame();
    expect(() => dispatch(state, { type: 'endTurn', player: 'blue' }, data)).toThrow(
      CommandRejectedError,
    );
  });

  it('rejects commands while a choice is pending', () => {
    const state = makeGame();
    state.pendingChoices.push({ id: 'c1', player: 'red', kind: 'test', options: ['a', 'b'] });
    expect(() => dispatch(state, { type: 'endTurn', player: 'red' }, data)).toThrow(
      'a pending choice must be resolved first',
    );
  });

  it('rejects commands after the game is over', () => {
    const state = makeGame();
    state.status = { winner: 'red' };
    expect(() => dispatch(state, { type: 'endTurn', player: 'red' }, data)).toThrow('game is over');
  });

  it('resolves a pending choice and unblocks other commands', () => {
    const start = makeGame();
    start.pendingChoices.push({ id: 'c1', player: 'red', kind: 'test', options: ['a', 'b'] });
    const { state, events } = dispatch(
      start,
      { type: 'resolveChoice', player: 'red', choiceId: 'c1', option: 1 },
      data,
    );
    expect(state.pendingChoices).toEqual([]);
    expect(events).toEqual([{ type: 'choiceResolved', choiceId: 'c1', option: 1 }]);
    const after = dispatch(state, { type: 'endTurn', player: 'red' }, data);
    expect(after.state.currentPlayer).toBe('blue');
  });

  it('rejects resolveChoice for unknown ids, foreign choices, and bad options', () => {
    const state = makeGame();
    state.pendingChoices.push({ id: 'c1', player: 'blue', kind: 'test', options: ['a', 'b'] });
    state.currentPlayer = 'blue';
    expect(() =>
      dispatch(state, { type: 'resolveChoice', player: 'blue', choiceId: 'nope', option: 0 }, data),
    ).toThrow('unknown choice');
    expect(() =>
      dispatch(state, { type: 'resolveChoice', player: 'blue', choiceId: 'c1', option: 2 }, data),
    ).toThrow('out of range');
    state.currentPlayer = 'red';
    state.pendingChoices = [{ id: 'c1', player: 'blue', kind: 'test', options: ['a'] }];
    expect(() =>
      dispatch(state, { type: 'resolveChoice', player: 'red', choiceId: 'c1', option: 0 }, data),
    ).toThrow('belongs to blue');
  });
});
