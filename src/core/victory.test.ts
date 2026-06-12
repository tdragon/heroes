import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap, type MapSource } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { dispatch, type GameEvent } from './commands';
import { newGame, townIdAt } from './setup';
import { getPlayer, type GameState } from './state';
import { evaluateVictory, isEliminated, TOWNLESS_DEFEAT_DAYS } from './victory';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const BLUE_TOWN = townIdAt([9, 9]);

function makeGame(seed = 5): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function transferBlueTownToRed(state: GameState): void {
  const town = state.towns[BLUE_TOWN];
  if (!town) throw new Error('missing blue town');
  town.owner = 'red';
  town.visitingHero = null;
  getPlayer(state, 'blue').towns = [];
  getPlayer(state, 'red').towns.push(BLUE_TOWN);
}

function removeBlueHero(state: GameState): void {
  const blue = getPlayer(state, 'blue');
  state.heroes = Object.fromEntries(
    Object.entries(state.heroes).filter(([id]) => !blue.heroes.includes(id)),
  );
  for (const town of Object.values(state.towns)) {
    if (town.visitingHero !== null && blue.heroes.includes(town.visitingHero)) {
      town.visitingHero = null;
    }
  }
  blue.heroes = [];
}

describe('isEliminated', () => {
  it('covers the loss matrix', () => {
    const state = makeGame();
    const blue = getPlayer(state, 'blue');
    expect(isEliminated(blue)).toBe(false); // town + hero
    blue.towns = [];
    expect(isEliminated(blue)).toBe(false); // hero, countdown not expired
    blue.daysWithoutTown = TOWNLESS_DEFEAT_DAYS;
    expect(isEliminated(blue)).toBe(true); // townless 7 days
    blue.daysWithoutTown = 0;
    blue.heroes = [];
    expect(isEliminated(blue)).toBe(true); // nothing left
    blue.towns = [BLUE_TOWN];
    expect(isEliminated(blue)).toBe(false); // a town alone keeps you alive
  });
});

describe('defeatAll victory', () => {
  it('declares the winner exactly when the enemy has no towns and no heroes', () => {
    const state = makeGame();
    transferBlueTownToRed(state);
    removeBlueHero(state);
    const { state: after, events } = dispatch(state, { type: 'endTurn', player: 'red' }, data);
    expect(events).toContainEqual({ type: 'playerDefeated', player: 'blue' });
    expect(events).toContainEqual({ type: 'gameOver', winner: 'red' });
    expect(after.status).toEqual({ winner: 'red' });
    expect(getPlayer(after, 'blue').defeated).toBe(true);
    expect(() => dispatch(after, { type: 'endTurn', player: 'red' }, data)).toThrow(
      'game is over',
    );
  });

  it('does not trigger while the enemy still has a hero or a town', () => {
    const townless = makeGame();
    transferBlueTownToRed(townless); // hero remains
    const afterTownLoss = dispatch(townless, { type: 'endTurn', player: 'red' }, data).state;
    expect(afterTownLoss.status).toBe('running');
    expect(getPlayer(afterTownLoss, 'blue').defeated).toBe(false);

    const heroless = makeGame();
    removeBlueHero(heroless); // town remains
    const afterHeroLoss = dispatch(heroless, { type: 'endTurn', player: 'red' }, data).state;
    expect(afterHeroLoss.status).toBe('running');
    expect(getPlayer(afterHeroLoss, 'blue').defeated).toBe(false);
  });
});

describe('townless countdown', () => {
  it('eliminates a player after 7 townless days and pools their heroes', () => {
    const state = makeGame();
    transferBlueTownToRed(state);
    getPlayer(state, 'blue').daysWithoutTown = TOWNLESS_DEFEAT_DAYS - 1;

    const mid = dispatch(state, { type: 'endTurn', player: 'red' }, data).state;
    expect(mid.status).toBe('running');

    const { state: after, events } = dispatch(mid, { type: 'endTurn', player: 'blue' }, data);
    expect(getPlayer(after, 'blue').daysWithoutTown).toBe(TOWNLESS_DEFEAT_DAYS);
    expect(events).toContainEqual({ type: 'playerDefeated', player: 'blue' });
    expect(after.status).toEqual({ winner: 'red' });
    expect(after.heroes.mortus).toBeUndefined();
    expect(after.tavernPool).toContain('mortus');
  });

  it('resets while the player holds a town', () => {
    const state = makeGame();
    getPlayer(state, 'blue').daysWithoutTown = TOWNLESS_DEFEAT_DAYS - 1;
    const mid = dispatch(state, { type: 'endTurn', player: 'red' }, data).state;
    const after = dispatch(mid, { type: 'endTurn', player: 'blue' }, data).state;
    expect(getPlayer(after, 'blue').daysWithoutTown).toBe(0);
    expect(after.status).toBe('running');
  });
});

describe('simultaneous elimination', () => {
  function ruinEveryone(state: GameState): void {
    // all players hit the 7-day townless limit on the same evaluation
    for (const player of state.players) {
      player.towns = [];
      player.daysWithoutTown = TOWNLESS_DEFEAT_DAYS;
    }
    for (const town of Object.values(state.towns)) town.owner = null;
  }

  it('ends the game when every remaining player is eliminated in the same pass', () => {
    const state = makeGame();
    ruinEveryone(state);
    expect(state.currentPlayer).toBe('red');
    const events: GameEvent[] = [];
    evaluateVictory(state, data, events);
    expect(events).toContainEqual({ type: 'playerDefeated', player: 'red' });
    expect(events).toContainEqual({ type: 'playerDefeated', player: 'blue' });
    // the current player falls first; the seat the rotation reaches last wins
    expect(state.status).toEqual({ winner: 'blue' });
    expect(events).toContainEqual({ type: 'gameOver', winner: 'blue' });
    expect(() => dispatch(state, { type: 'endTurn', player: 'red' }, data)).toThrow(
      'game is over',
    );
  });

  it('follows the rotation from the current player, not the player array order', () => {
    const state = makeGame();
    ruinEveryone(state);
    state.currentPlayer = 'blue';
    const events: GameEvent[] = [];
    evaluateVictory(state, data, events);
    // rotation blue -> red: blue (current) falls first, red is reached last
    const defeats = events.filter((e) => e.type === 'playerDefeated');
    expect(defeats).toEqual([
      { type: 'playerDefeated', player: 'blue' },
      { type: 'playerDefeated', player: 'red' },
    ]);
    expect(state.status).toEqual({ winner: 'red' });
    expect(events).toContainEqual({ type: 'gameOver', winner: 'red' });
  });
});

describe('current-player elimination', () => {
  const threePlayerSource: MapSource = {
    id: 'three-way',
    name: 'Three Way',
    terrain: Array.from({ length: 12 }, () => 'g'.repeat(12)),
    players: [
      { color: 'red', faction: 'castle', isHuman: true, startTownAt: [2, 2], startHero: 'edric' },
      {
        color: 'blue',
        faction: 'necropolis',
        isHuman: false,
        startTownAt: [9, 9],
        startHero: 'mortus',
      },
      {
        color: 'tan',
        faction: 'rampart',
        isHuman: false,
        startTownAt: [9, 2],
        startHero: 'faelan',
      },
    ],
    objects: [
      { type: 'town', at: [2, 2], owner: 'red' },
      { type: 'town', at: [9, 9], owner: 'blue' },
      { type: 'town', at: [9, 2], owner: 'tan' },
    ],
  };
  const threePlayerMap = compileMap(threePlayerSource, data);

  function eliminateEverything(state: GameState, playerId: 'red' | 'tan'): void {
    const player = getPlayer(state, playerId);
    const town = state.towns[townIdAt(playerId === 'red' ? [2, 2] : [9, 2])];
    if (!town) throw new Error('missing town');
    town.owner = 'blue';
    getPlayer(state, 'blue').towns.push(town.id);
    town.visitingHero = null;
    state.heroes = Object.fromEntries(
      Object.entries(state.heroes).filter(([id]) => !player.heroes.includes(id)),
    );
    player.towns = [];
    player.heroes = [];
  }

  it('passes the turn to the next active player without advancing the day', () => {
    const state = newGame(threePlayerMap, {}, 3, data);
    eliminateEverything(state, 'red'); // red is the current player
    const events: GameEvent[] = [];
    evaluateVictory(state, data, events);
    expect(getPlayer(state, 'red').defeated).toBe(true);
    expect(state.status).toBe('running');
    expect(state.currentPlayer).toBe('blue');
    expect(state.day).toBe(1);
    expect(events).toContainEqual({ type: 'turnStarted', player: 'blue' });
  });

  it('advances the day when the eliminated current player was last in rotation', () => {
    const state = newGame(threePlayerMap, {}, 3, data);
    state.currentPlayer = 'tan';
    eliminateEverything(state, 'tan');
    const events: GameEvent[] = [];
    evaluateVictory(state, data, events);
    expect(getPlayer(state, 'tan').defeated).toBe(true);
    expect(state.status).toBe('running');
    expect(state.currentPlayer).toBe('red');
    expect(state.day).toBe(2);
    expect(events).toContainEqual({ type: 'dayStarted', day: 2 });
  });

  it('clears pending choices of the eliminated player', () => {
    const state = makeGame();
    transferBlueTownToRed(state);
    removeBlueHero(state);
    state.pendingChoices.push({
      id: 'stale-choice',
      player: 'blue',
      kind: 'chest',
      options: ['gold:1000', 'xp:500'],
    });
    const events: GameEvent[] = [];
    evaluateVictory(state, data, events);
    expect(state.pendingChoices).toEqual([]);
    expect(state.status).toEqual({ winner: 'red' });
  });
});
