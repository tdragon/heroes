import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import {
  isExplored,
  isVisible,
  revealCircle,
  revealFor,
  sightRadius,
  snapshotObject,
  visibleTiles,
} from './fog';
import { newGame } from './setup';
import { getPlayer, type GameState, type MapObjectState, type Player } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

function makeGame(seed = 7): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function red(state: GameState): Player {
  return getPlayer(state, 'red');
}

function requireObject(state: GameState, type: string, at: [number, number]): MapObjectState {
  const obj = state.map.objects.find(
    (o) => o.type === type && o.at[0] === at[0] && o.at[1] === at[1],
  );
  if (!obj) throw new Error(`fixture object not found: ${type} at ${String(at)}`);
  return obj;
}

describe('revealCircle', () => {
  it('reveals a euclidean disc of the given radius', () => {
    const size = 11;
    const explored = Array.from({ length: size * size }, () => false);
    revealCircle(explored, size, [5, 5], 2);
    // dx²+dy² ≤ 4: center, 4 orthogonal at 1, 4 diagonals at 1, 4 orthogonal at 2
    expect(explored.filter(Boolean)).toHaveLength(13);
    expect(explored[5 * size + 5]).toBe(true);
    expect(explored[5 * size + 7]).toBe(true);
    expect(explored[3 * size + 4]).toBe(false); // dx=1, dy=2 → 5 > 4
  });

  it('clips at map corners without wrapping', () => {
    const size = 5;
    const explored = Array.from({ length: size * size }, () => false);
    revealCircle(explored, size, [0, 0], 2);
    expect(explored.filter(Boolean)).toHaveLength(6);
    expect(explored.some((v, i) => v && i % size === size - 1)).toBe(false);
  });

  it('does not wrap across the horizontal edge', () => {
    const size = 5;
    const explored = Array.from({ length: size * size }, () => false);
    revealCircle(explored, size, [0, 2], 1);
    expect(explored.filter(Boolean)).toHaveLength(4);
    expect(explored[2 * size + size - 1]).toBe(false);
  });
});

describe('fog in a new game', () => {
  it('explores around own start town and hero only', () => {
    const state = makeGame();
    expect(isExplored(red(state), state.map.size, [2, 2])).toBe(true);
    expect(isExplored(red(state), state.map.size, [2, 7])).toBe(true); // radius 5
    expect(isExplored(red(state), state.map.size, [9, 9])).toBe(false);
    const blue = getPlayer(state, 'blue');
    expect(isExplored(blue, state.map.size, [9, 9])).toBe(true);
    expect(isExplored(blue, state.map.size, [0, 0])).toBe(false);
  });

  it('keeps explored tiles permanent while visibility follows heroes and towns', () => {
    const state = makeGame();
    const player = red(state);
    revealFor(state, player, [9, 5], 1); // e.g. observatory-style reveal far away
    expect(isExplored(player, state.map.size, [9, 5])).toBe(true);

    const visible = visibleTiles(state, player, data);
    expect(isVisible(visible, state.map.size, [2, 2])).toBe(true);
    expect(isVisible(visible, state.map.size, [9, 5])).toBe(false); // explored but dimmed
    expect(isVisible(visible, state.map.size, [9, 9])).toBe(false); // shrouded
  });

  it('uses base sight radius 5 for a fresh hero', () => {
    const state = makeGame();
    const hero = state.heroes.edric;
    if (!hero) throw new Error('missing red hero');
    expect(sightRadius(hero, data)).toBe(5);
  });
});

describe('last-seen object snapshots', () => {
  it('records objects inside the revealed circle at their current state', () => {
    const state = makeGame();
    const sawmill = requireObject(state, 'mine', [6, 2]);
    expect(red(state).seenObjects[sawmill.id]).toMatchObject({
      type: 'mine',
      subtype: 'sawmill',
      owner: null,
      removed: false,
    });
    const blueTown = requireObject(state, 'town', [9, 9]);
    expect(red(state).seenObjects[blueTown.id]).toBeUndefined();
  });

  it('keeps a stale snapshot until the tile is revealed again', () => {
    const state = makeGame();
    const player = red(state);
    const sawmill = requireObject(state, 'mine', [6, 2]);
    sawmill.owner = 'blue'; // flagged out of sight
    expect(player.seenObjects[sawmill.id]?.owner).toBeNull();
    revealFor(state, player, [6, 2], 1);
    expect(player.seenObjects[sawmill.id]?.owner).toBe('blue');
  });

  it('records removal once the tile is seen again', () => {
    const state = makeGame();
    const player = red(state);
    const wood = requireObject(state, 'resource', [4, 4]);
    wood.removed = true;
    expect(player.seenObjects[wood.id]?.removed).toBe(false);
    revealFor(state, player, [4, 4], 1);
    expect(player.seenObjects[wood.id]?.removed).toBe(true);
  });

  it('snapshots copy position instead of referencing live state', () => {
    const state = makeGame();
    const sawmill = requireObject(state, 'mine', [6, 2]);
    const seen = snapshotObject(sawmill);
    sawmill.at[0] = 11;
    expect(seen.at).toEqual([6, 2]);
  });
});
