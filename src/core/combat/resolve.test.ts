import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data';
import { compileMap, type MapSource } from '../../maps/dsl';
import { dispatch, CommandRejectedError, type GameEvent } from '../commands';
import { handleObjectTrigger } from '../objects';
import { newGame, townIdAt } from '../setup';
import type { GameState, Hero, MapObjectState, PlayerId } from '../state';
import { hexDistance, type Hex } from './grid';
import {
  activeCombatStack,
  reachableHexesFor,
  type CombatAction,
} from './engine';
import { livingStacks, oppositeSide } from './state';

const data = loadGameData();

const SIZE = 16;
const arenaSource: MapSource = {
  id: 'resolve-arena',
  name: 'Resolve Arena',
  terrain: Array.from({ length: SIZE }, () => 'g'.repeat(SIZE)),
  players: [
    { color: 'red', faction: 'castle', isHuman: true, startTownAt: [2, 2], startHero: 'edric' },
    {
      color: 'blue',
      faction: 'necropolis',
      isHuman: false,
      startTownAt: [13, 13],
      startHero: 'mortus',
    },
  ],
  objects: [
    { type: 'town', at: [2, 2], owner: 'red' },
    { type: 'town', at: [13, 13], owner: 'blue' },
    { type: 'mine', subtype: 'sawmill', at: [7, 1], guard: { creature: 'wolf', count: 4 } },
    { type: 'monster', creature: 'wolf', count: 6, at: [5, 4] },
  ],
};
const arenaMap = compileMap(arenaSource, data);

function makeGame(seed = 7): GameState {
  return newGame(arenaMap, {}, seed, data);
}

function getHero(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) throw new Error(`missing hero ${id}`);
  return hero;
}

function findObject(state: GameState, type: string, at?: [number, number]): MapObjectState {
  const obj = state.map.objects.find(
    (o) => o.type === type && (at === undefined || (o.at[0] === at[0] && o.at[1] === at[1])),
  );
  if (!obj) throw new Error(`fixture object not found: ${type}`);
  return obj;
}

// move the hero adjacent to a trigger and step on it via the command API
function stepOnTrigger(state: GameState, heroId: string, target: [number, number]): GameState {
  const hero = getHero(state, heroId);
  hero.pos = [target[0] - 1, target[1]];
  hero.movementPoints = 2000;
  const result = dispatch(
    state,
    { type: 'moveHero', player: hero.owner, hero: heroId, path: [target] },
    data,
  );
  return result.state;
}

function pickAction(state: GameState): CombatAction {
  const combat = state.combat?.combat;
  if (!combat) throw new Error('no combat');
  const stack = activeCombatStack(combat);
  if (!stack) throw new Error('no active stack');
  const creature = data.creatures[stack.creature];
  if (!creature) throw new Error('unknown creature');
  const enemies = livingStacks(combat, oppositeSide(stack.side));
  const nearest = enemies.reduce((best, e) =>
    hexDistance(stack.pos, e.pos) < hexDistance(stack.pos, best.pos) ? e : best,
  );
  const adjacent = enemies.find((e) => hexDistance(stack.pos, e.pos) === 1);
  if (creature.shots !== undefined && stack.shots > 0 && !adjacent) {
    return { type: 'shoot', target: nearest.id };
  }
  if (adjacent) {
    return { type: 'melee', target: adjacent.id, from: stack.pos };
  }
  const reachable = reachableHexesFor(combat, stack.id, data);
  const attackFrom = reachable.find((h) => hexDistance(h, nearest.pos) === 1);
  if (attackFrom) {
    return { type: 'melee', target: nearest.id, from: attackFrom };
  }
  let best: Hex | null = null;
  let bestDistance = hexDistance(stack.pos, nearest.pos);
  for (const hex of reachable) {
    const d = hexDistance(hex, nearest.pos);
    if (d < bestDistance) {
      bestDistance = d;
      best = hex;
    }
  }
  return best ? { type: 'move', to: best } : { type: 'defend' };
}

function driveCombat(
  state: GameState,
  player: PlayerId,
): { state: GameState; events: GameEvent[] } {
  const all: GameEvent[] = [];
  let guard = 0;
  let current = state;
  while (current.combat !== null) {
    guard += 1;
    if (guard > 500) throw new Error('combat did not resolve');
    const action = pickAction(current);
    const result = dispatch(current, { type: 'combatAction', player, action }, data);
    current = result.state;
    all.push(...result.events);
  }
  return { state: current, events: all };
}

function startGuardFight(seed = 7): GameState {
  let state = makeGame(seed);
  state = stepOnTrigger(state, 'edric', [7, 1]);
  expect(state.pendingChoices[0]?.kind).toBe('guardAttack');
  const choiceId = state.pendingChoices[0]?.id ?? '';
  const result = dispatch(
    state,
    { type: 'resolveChoice', player: 'red', choiceId, option: 0 },
    data,
  );
  expect(result.state.combat).not.toBeNull();
  return result.state;
}

describe('guard combat resolution', () => {
  it('winning clears the guard, awards XP, and flags the mine', () => {
    const start = startGuardFight();
    const { state, events } = driveCombat(start, 'red');

    expect(state.combat).toBeNull();
    const mine = findObject(state, 'mine', [7, 1]);
    expect(mine.guard).toBeNull();
    expect(mine.owner).toBe('red');

    const hero = getHero(state, 'edric');
    const wolves = data.creatures.wolf;
    if (!wolves) throw new Error('missing wolf');
    expect(hero.xp).toBe(4 * wolves.aiValue);
    expect(events.some((e) => e.type === 'combatResolved' && e.outcome === 'attacker')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'objectFlagged')).toBe(true);
    // survivors synced back: army counts can only have dropped
    const total = hero.army.reduce((sum, s) => sum + (s?.count ?? 0), 0);
    expect(total).toBeGreaterThan(0);
  });

  it('losing removes the hero, keeps guard survivors, and returns the hero to the tavern pool', () => {
    const start = startGuardFight();
    // cripple the attacker to guarantee a loss
    const combat = start.combat?.combat;
    if (!combat) throw new Error('no combat');
    for (const stack of combat.stacks) {
      if (stack.side === 'attacker') {
        stack.count = stack.count > 0 ? 1 : 0;
        stack.firstHp = 1;
      }
      if (stack.side === 'defender') {
        stack.count = 99;
        stack.initialCount = 99;
      }
    }
    const { state, events } = driveCombat(start, 'red');

    expect(state.heroes.edric).toBeUndefined();
    expect(state.players[0]?.heroes).toEqual([]);
    expect(state.tavernPool).toContain('edric');
    const mine = findObject(state, 'mine', [7, 1]);
    expect(mine.owner).toBeNull();
    expect(mine.guard?.count).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'heroDefeated')).toBe(true);
    expect(events.some((e) => e.type === 'combatResolved' && e.outcome === 'defender')).toBe(
      true,
    );
  });

  it('fleeing loses the army but returns the hero template to the tavern pool', () => {
    const start = startGuardFight();
    const result = dispatch(
      start,
      { type: 'combatAction', player: 'red', action: { type: 'flee' } },
      data,
    );
    const state = result.state;
    expect(state.combat).toBeNull();
    expect(state.heroes.edric).toBeUndefined();
    expect(state.tavernPool).toContain('edric');
    expect(result.events.some((e) => e.type === 'heroFled')).toBe(true);
    // the guard survives untouched
    expect(findObject(state, 'mine', [7, 1]).guard?.count).toBe(4);
  });

  it('rejects combat actions when no combat runs and other commands during combat', () => {
    const idle = makeGame();
    expect(() =>
      dispatch(idle, { type: 'combatAction', player: 'red', action: { type: 'defend' } }, data),
    ).toThrow(CommandRejectedError);

    const fighting = startGuardFight();
    expect(() => dispatch(fighting, { type: 'endTurn', player: 'red' }, data)).toThrow(
      'combat must be resolved',
    );
  });
});

describe('necromancy', () => {
  it('raises skeletons from enemy losses after victory', () => {
    let state = makeGame();
    // mortus (basic necromancy, 10%) attacks the wandering wolves
    state.currentPlayer = 'blue';
    state = stepOnTrigger(state, 'mortus', [5, 4]);
    const choiceId = state.pendingChoices[0]?.id ?? '';
    state = dispatch(state, { type: 'resolveChoice', player: 'blue', choiceId, option: 0 }, data)
      .state;
    const { state: done, events } = driveCombat(state, 'blue');
    const raised = events.find((e) => e.type === 'necromancyRaised');
    expect(raised).toBeDefined();
    if (raised?.type !== 'necromancyRaised') throw new Error('unreachable');
    // 6 wolves x 15 HP x 10% = 9 HP -> 1 skeleton (6 HP each)
    expect(raised.count).toBe(1);
    const skeletonsAfter = getHero(done, 'mortus').army.reduce(
      (sum, s) => sum + (s?.creature === 'skeleton' ? s.count : 0),
      0,
    );
    expect(skeletonsAfter).toBeGreaterThanOrEqual(1);
    expect(done.map.objects.find((o) => o.type === 'monster')?.removed).toBe(true);
  });
});

describe('siege resolution', () => {
  function startSiege(garrison = true): GameState {
    const state = makeGame();
    const blueTown = state.towns[townIdAt([13, 13])];
    if (!blueTown) throw new Error('missing blue town');
    if (garrison) {
      blueTown.garrison[0] = { creature: 'skeleton', count: 5 };
    }
    // strengthen the attacker so the outcome is certain; the defending hero
    // occupies the town tile, so trigger the town object directly
    const edric = getHero(state, 'edric');
    edric.army[0] = { creature: 'angel', count: 4 };
    const events: GameEvent[] = [];
    handleObjectTrigger(state, edric, findObject(state, 'town', [13, 13]).id, data, events);
    expect(state.combat?.reason).toBe('siege');
    return state;
  }

  it('capturing a town defeats the visiting hero and transfers artifacts', () => {
    const start = startSiege();
    const mortus = getHero(start, 'mortus');
    mortus.backpack.push('iron_sword');
    const { state, events } = driveCombat(start, 'red');

    const blueTown = state.towns[townIdAt([13, 13])];
    expect(blueTown?.owner).toBe('red');
    expect(blueTown?.visitingHero).toBe('edric');
    expect(blueTown?.garrison.every((s) => s === null)).toBe(true);
    expect(state.heroes.mortus).toBeUndefined();
    expect(state.tavernPool).toContain('mortus');
    expect(getHero(state, 'edric').backpack).toContain('iron_sword');
    expect(state.players[0]?.towns).toContain(blueTown?.id ?? '');
    expect(state.players[1]?.towns).not.toContain(blueTown?.id ?? '');
    expect(events.some((e) => e.type === 'townCaptured')).toBe(true);
    expect(events.some((e) => e.type === 'artifactsSeized')).toBe(true);
  });

  it('a fort adds walls to the siege battlefield', () => {
    const state = makeGame();
    const blueTown = state.towns[townIdAt([13, 13])];
    if (!blueTown) throw new Error('missing blue town');
    blueTown.buildings.push('fort');
    blueTown.garrison[0] = { creature: 'skeleton', count: 5 };
    const events: GameEvent[] = [];
    handleObjectTrigger(
      state,
      getHero(state, 'edric'),
      findObject(state, 'town', [13, 13]).id,
      data,
      events,
    );
    expect(state.combat?.combat.siege?.level).toBe('fort');
  });

  it('defender survivors are written back to garrison and hero army', () => {
    const start = startSiege();
    // make the defenders overwhelming instead
    const combat = start.combat?.combat;
    if (!combat) throw new Error('no combat');
    for (const stack of combat.stacks) {
      if (stack.side === 'attacker') {
        stack.count = 1;
        stack.firstHp = 1;
        stack.creature = 'peasant';
      }
    }
    const { state } = driveCombat(start, 'red');
    expect(state.heroes.edric).toBeUndefined();
    const blueTown = state.towns[townIdAt([13, 13])];
    const garrisonCount = blueTown?.garrison[0]?.count ?? 0;
    expect(garrisonCount).toBeGreaterThan(0);
    expect(state.heroes.mortus).toBeDefined();
  });
});

describe('post-combat hero state', () => {
  it('resets temporary luck/morale blessings after the battle', () => {
    const start = startGuardFight();
    const hero = getHero(start, 'edric');
    hero.tempLuck = 2;
    hero.tempMorale = 1;
    const result = dispatch(
      start,
      { type: 'combatAction', player: 'red', action: { type: 'flee' } },
      data,
    );
    // hero fled (removed), so check via a winning fight instead
    expect(result.state.heroes.edric).toBeUndefined();

    const winState = startGuardFight();
    getHero(winState, 'edric').tempLuck = 2;
    getHero(winState, 'edric').tempMorale = 1;
    const { state } = driveCombat(winState, 'red');
    expect(getHero(state, 'edric').tempLuck).toBe(0);
    expect(getHero(state, 'edric').tempMorale).toBe(0);
  });
});
