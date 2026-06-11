import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import type { Pos } from '../maps/schema';
import { CommandRejectedError, dispatch } from './commands';
import { maxMovementPoints } from './hero';
import {
  buildMoveContext,
  findPath,
  findPathInContext,
  isEnterable,
  pathCost,
  reducedTerrainCost,
  stepCost,
  type MoveContext,
} from './movement';
import { nextFloat, seedRng } from './rng';
import { newGame, townIdAt } from './setup';
import { isExplored } from './fog';
import { type GameState, type Hero, type HeroSkill } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const RED_TOWN = townIdAt([2, 2]);

function makeHero(pos: Pos, overrides: Partial<Hero> = {}): Hero {
  return {
    id: 'test-hero',
    template: 'edric',
    name: 'Test Hero',
    class: 'knight',
    owner: 'red',
    pos,
    attack: 2,
    defense: 2,
    spellPower: 1,
    knowledge: 1,
    level: 1,
    xp: 0,
    skills: [],
    army: Array.from({ length: 7 }, () => null),
    artifacts: [],
    backpack: [],
    hasSpellbook: false,
    spells: [],
    mana: 0,
    movementPoints: 2000,
    tempLuck: 0,
    tempMorale: 0,
    dimensionDoorCasts: 0,
    ...overrides,
  };
}

function makeState(terrain: string[], roads?: string[], heroes: Hero[] = []): GameState {
  const size = terrain[0]?.length ?? 0;
  if (terrain.some((row) => row.length !== size) || terrain.length !== size) {
    throw new Error('makeState: terrain grid must be square');
  }
  const roadRows = roads ?? terrain.map(() => '.'.repeat(size));
  return {
    seed: 1,
    rngState: seedRng(1),
    day: 1,
    players: [],
    currentPlayer: 'red',
    map: { id: 'test', size, terrain: terrain.join(''), roads: roadRows.join(''), objects: [] },
    heroes: Object.fromEntries(heroes.map((h) => [h.id, h])),
    towns: {},
    combat: null,
    tavernPool: [],
    pendingChoices: [],
    status: 'running',
  };
}

function contextFor(state: GameState, skills: HeroSkill[] = []): MoveContext {
  return buildMoveContext(state, data, makeHero([0, 0], { skills }));
}

describe('terrain cost lookup', () => {
  it('reduces terrain penalty by pathfinding percentage toward the 100 floor', () => {
    expect(reducedTerrainCost(175, 0)).toBe(175);
    expect(reducedTerrainCost(175, 25)).toBe(157);
    expect(reducedTerrainCost(175, 50)).toBe(138);
    expect(reducedTerrainCost(175, 75)).toBe(119);
    expect(reducedTerrainCost(150, 75)).toBe(113);
    expect(reducedTerrainCost(150, 100)).toBe(100);
    expect(reducedTerrainCost(100, 75)).toBe(100);
  });

  it('uses terrain move costs from data', () => {
    const state = makeState(['gs', 'Sr']);
    const ctx = contextFor(state);
    expect(ctx.tileCosts).toEqual([100, 150, 175, 125]);
  });

  it('lets roads override the terrain cost', () => {
    const state = makeState(['ssss', 'ssss', 'ssss', 'ssss'], ['.DGC', '....', '....', '....']);
    const ctx = contextFor(state);
    expect(ctx.tileCosts.slice(0, 4)).toEqual([150, 75, 65, 50]);
  });

  it('marks water as impassable', () => {
    const state = makeState(['gw', 'gg']);
    const ctx = contextFor(state);
    expect(ctx.tileCosts[1]).toBeNull();
    expect(isEnterable(ctx, [1, 0])).toBe(false);
  });

  it('applies the pathfinding skill of the moving hero', () => {
    const state = makeState(['SS', 'SS']);
    const expert = contextFor(state, [{ skill: 'pathfinding', rank: 'expert' }]);
    expect(expert.tileCosts[0]).toBe(119);
    const basic = contextFor(state, [{ skill: 'pathfinding', rank: 'basic' }]);
    expect(basic.tileCosts[0]).toBe(157);
  });

  it('does not apply pathfinding to roads', () => {
    const state = makeState(['ss', 'ss'], ['D.', '..']);
    const ctx = contextFor(state, [{ skill: 'pathfinding', rank: 'expert' }]);
    expect(ctx.tileCosts[0]).toBe(75);
  });

  it('charges diagonal steps at x1.414 rounded', () => {
    const state = makeState(['gg', 'gg']);
    const ctx = contextFor(state);
    expect(stepCost(ctx, [0, 0], [1, 0])).toBe(100);
    expect(stepCost(ctx, [0, 0], [1, 1])).toBe(141);
    const swamp = contextFor(makeState(['SS', 'SS']));
    expect(stepCost(swamp, [0, 0], [1, 1])).toBe(Math.round(175 * 1.414));
  });
});

describe('daily movement points', () => {
  it('is 1500 with no army', () => {
    expect(maxMovementPoints(makeHero([0, 0]), data)).toBe(1500);
  });

  it('adds 50 x slowest creature speed', () => {
    const hero = makeHero([0, 0], {
      army: [
        { creature: 'pikeman', count: 10 },
        { creature: 'griffin', count: 2 },
        ...Array.from({ length: 5 }, () => null),
      ],
    });
    // pikeman speed 4 is slowest: 1500 + 50*4
    expect(maxMovementPoints(hero, data)).toBe(1700);
  });

  it('applies the logistics bonus', () => {
    const hero = makeHero([0, 0], {
      army: [{ creature: 'pikeman', count: 10 }, ...Array.from({ length: 6 }, () => null)],
      skills: [{ skill: 'logistics', rank: 'basic' }],
    });
    expect(maxMovementPoints(hero, data)).toBe(Math.floor(1700 * 1.1));
    const expert = makeHero([0, 0], {
      army: [{ creature: 'pikeman', count: 10 }, ...Array.from({ length: 6 }, () => null)],
      skills: [{ skill: 'logistics', rank: 'expert' }],
    });
    expect(maxMovementPoints(expert, data)).toBe(Math.floor(1700 * 1.3));
  });

  it('throws on an unknown creature', () => {
    const hero = makeHero([0, 0], {
      army: [{ creature: 'nonexistent', count: 1 }, ...Array.from({ length: 6 }, () => null)],
    });
    expect(() => maxMovementPoints(hero, data)).toThrow('unknown creature');
  });
});

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function bruteForceCost(ctx: MoveContext, start: Pos, dest: Pos): number | null {
  const n = ctx.size * ctx.size;
  const dist = Array.from({ length: n }, () => Infinity);
  dist[start[1] * ctx.size + start[0]] = 0;
  const startIndex = start[1] * ctx.size + start[0];
  for (let iter = 0; iter < n; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const d = dist[i] ?? Infinity;
      if (d === Infinity) continue;
      if (i !== startIndex && ctx.triggers[i] !== null) continue;
      const x = i % ctx.size;
      const y = Math.floor(i / ctx.size);
      for (const [dx, dy] of NEIGHBORS) {
        const next: Pos = [x + dx, y + dy];
        if (!isEnterable(ctx, next)) continue;
        const j = next[1] * ctx.size + next[0];
        const c = d + stepCost(ctx, [x, y], next);
        if (c < (dist[j] ?? Infinity)) {
          dist[j] = c;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const result = dist[dest[1] * ctx.size + dest[0]] ?? Infinity;
  return result === Infinity ? null : result;
}

describe('A* pathfinding', () => {
  it('returns an empty path when already at the destination', () => {
    const state = makeState(['gg', 'gg']);
    expect(findPath(state, data, makeHero([0, 0]), [0, 0])).toEqual([]);
  });

  it('finds the optimal cost on randomized grids (vs brute force)', () => {
    const chars = ['g', 'g', 's', 'S', 'r', 'w'];
    let rng = seedRng(1234);
    for (let trial = 0; trial < 25; trial++) {
      const size = 8;
      const rows: string[] = [];
      for (let y = 0; y < size; y++) {
        let row = '';
        for (let x = 0; x < size; x++) {
          const [v, next] = nextFloat(rng);
          rng = next;
          row += chars[Math.floor(v * chars.length)] ?? 'g';
        }
        rows.push(row);
      }
      const state = makeState(rows);
      const ctx = contextFor(state);
      const passable: Pos[] = [];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (isEnterable(ctx, [x, y])) passable.push([x, y]);
        }
      }
      if (passable.length < 2) continue;
      const [a, nextA] = nextFloat(rng);
      rng = nextA;
      const [b, nextB] = nextFloat(rng);
      rng = nextB;
      const start = passable[Math.floor(a * passable.length)];
      const dest = passable[Math.floor(b * passable.length)];
      if (!start || !dest) continue;

      const path = findPathInContext(ctx, start, dest);
      const expected = bruteForceCost(ctx, start, dest);
      if (expected === null) {
        expect(path).toBeNull();
      } else {
        expect(path).not.toBeNull();
        if (path) expect(pathCost(ctx, start, path)).toBe(expected);
      }
    }
  });

  it('prefers a road detour over expensive direct terrain', () => {
    const state = makeState(
      ['sssss', 'sssss', 'sssss', 'sssss', 'sssss'],
      ['.....', 'CCCCC', '.....', '.....', '.....'],
    );
    const ctx = contextFor(state);
    const path = findPathInContext(ctx, [0, 0], [4, 0]);
    expect(path).not.toBeNull();
    if (!path) return;
    // direct over sand: 4 x 150 = 600; the road detour is far cheaper:
    // diag onto road 71, 3 straight road steps 150, straight back onto sand 150
    expect(pathCost(ctx, [0, 0], path)).toBe(371);
    expect(pathCost(ctx, [0, 0], path)).toBe(bruteForceCost(ctx, [0, 0], [4, 0]));
    expect(path.some(([, y]) => y === 1)).toBe(true);
  });

  it('returns null when the destination is unreachable or impassable', () => {
    const walled = makeState(['ggwgg', 'ggwgg', 'ggwgg', 'ggwgg', 'ggwgg']);
    const ctx = contextFor(walled);
    expect(findPathInContext(ctx, [0, 0], [4, 4])).toBeNull();
    expect(findPathInContext(ctx, [0, 0], [2, 2])).toBeNull(); // water tile
  });

  it('routes around impassable water', () => {
    const state = makeState(['ggggg', 'wwwwg', 'ggggg', 'ggggg', 'ggggg']);
    const ctx = contextFor(state);
    const path = findPathInContext(ctx, [0, 0], [0, 2]);
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.every(([x, y]) => ctx.tileCosts[y * 5 + x] !== null)).toBe(true);
    expect(pathCost(ctx, [0, 0], path)).toBe(bruteForceCost(ctx, [0, 0], [0, 2]));
  });

  it('does not path through another hero', () => {
    const blocker = makeHero([1, 0], { id: 'blocker', owner: 'blue' });
    const state = makeState(['ggg', 'www', 'ggg'], undefined, [blocker]);
    const mover = makeHero([0, 0]);
    state.heroes[mover.id] = mover;
    expect(findPath(state, data, mover, [2, 0])).toBeNull();
  });

  it('does not path through a trigger tile', () => {
    const state = makeState(['ggg', 'www', 'ggg']);
    state.map.objects.push({
      id: 'obj-0',
      type: 'resource',
      subtype: 'wood',
      at: [1, 0],
      owner: null,
      guard: null,
      amount: 5,
      removed: false,
      visitedBy: [],
      lastResetDay: 0,
    });
    const hero = makeHero([0, 0]);
    state.heroes[hero.id] = hero;
    expect(findPath(state, data, hero, [2, 0])).toBeNull();
    // the trigger itself is a valid destination
    expect(findPath(state, data, hero, [1, 0])).toEqual([[1, 0]]);
    // a removed object no longer stops anything
    const removed = structuredClone(state);
    const obj = removed.map.objects[0];
    if (obj) obj.removed = true;
    expect(findPath(removed, data, hero, [2, 0])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it('does not path through object footprints but allows the trigger tile', () => {
    const game = newGame(tinyMap, {}, 42, data);
    const hero = game.heroes.edric;
    if (!hero) throw new Error('missing edric');
    hero.pos = [0, 0];
    const ctx = buildMoveContext(game, data, hero);
    // red town footprint blocks non-trigger tiles
    expect(isEnterable(ctx, [1, 1])).toBe(false);
    expect(isEnterable(ctx, [3, 2])).toBe(false);
    expect(isEnterable(ctx, [2, 2])).toBe(true); // trigger tile
  });
});

describe('moveHero command', () => {
  function makeGame(seed = 42): GameState {
    return newGame(tinyMap, {}, seed, data);
  }

  it('moves the hero along the path, consuming MP per destination tile', () => {
    const start = makeGame();
    const { state, events } = dispatch(
      start,
      { type: 'moveHero', player: 'red', hero: 'edric', path: [[3, 3]] },
      data,
    );
    expect(state.heroes.edric?.pos).toEqual([3, 3]);
    expect(state.heroes.edric?.movementPoints).toBe(1700 - 141); // diagonal onto grass
    expect(events).toEqual([
      { type: 'heroMoved', hero: 'edric', from: [2, 2], to: [3, 3], mpLeft: 1559 },
    ]);
  });

  it('stops at a trigger tile and emits objectTriggered', () => {
    const start = makeGame();
    const resource = start.map.objects.find((o) => o.type === 'resource' && o.at[0] === 4);
    if (!resource) throw new Error('missing wood resource');
    const { state, events } = dispatch(
      start,
      {
        type: 'moveHero',
        player: 'red',
        hero: 'edric',
        path: [
          [3, 3],
          [4, 4],
          [5, 5],
        ],
      },
      data,
    );
    // stopped on the trigger at [4,4]; [5,5] never executed
    expect(state.heroes.edric?.pos).toEqual([4, 4]);
    expect(events).toContainEqual({ type: 'objectTriggered', hero: 'edric', object: resource.id });
    // diagonal grass 141 + diagonal dirt road 75 -> 106
    expect(state.heroes.edric?.movementPoints).toBe(1700 - 141 - 106);
  });

  it('stops mid-path when movement points run out', () => {
    const start = makeGame();
    const hero = start.heroes.edric;
    if (!hero) throw new Error('missing edric');
    hero.movementPoints = 150;
    const { state, events } = dispatch(
      start,
      {
        type: 'moveHero',
        player: 'red',
        hero: 'edric',
        path: [
          [3, 3],
          [3, 4],
        ],
      },
      data,
    );
    expect(state.heroes.edric?.pos).toEqual([3, 3]);
    expect(state.heroes.edric?.movementPoints).toBe(9);
    expect(events).toHaveLength(1);
  });

  it('makes no move at all when the first step is unaffordable', () => {
    const start = makeGame();
    const hero = start.heroes.edric;
    if (!hero) throw new Error('missing edric');
    hero.movementPoints = 100;
    const { state, events } = dispatch(
      start,
      { type: 'moveHero', player: 'red', hero: 'edric', path: [[3, 3]] },
      data,
    );
    expect(state.heroes.edric?.pos).toEqual([2, 2]);
    expect(state.heroes.edric?.movementPoints).toBe(100);
    expect(events).toEqual([]);
  });

  it('cannot move through or onto another hero', () => {
    const start = makeGame();
    const mortus = start.heroes.mortus;
    if (!mortus) throw new Error('missing mortus');
    mortus.pos = [3, 3];
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'edric', path: [[3, 3]] }, data),
    ).toThrow(CommandRejectedError);
  });

  it('rejects invalid paths and foreign heroes', () => {
    const start = makeGame();
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'edric', path: [] }, data),
    ).toThrow('empty path');
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'edric', path: [[5, 5]] }, data),
    ).toThrow('not adjacent');
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'edric', path: [[3, 2]] }, data),
    ).toThrow('not passable'); // town footprint tile
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'mortus', path: [[8, 9]] }, data),
    ).toThrow('belongs to blue');
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'blue', hero: 'mortus', path: [[8, 9]] }, data),
    ).toThrow(CommandRejectedError); // blue is not the current player
    expect(() =>
      dispatch(start, { type: 'moveHero', player: 'red', hero: 'ghost', path: [[3, 3]] }, data),
    ).toThrow('unknown hero');
  });

  it('does not mutate the input state', () => {
    const start = makeGame();
    const snapshot = structuredClone(start);
    dispatch(start, { type: 'moveHero', player: 'red', hero: 'edric', path: [[3, 3]] }, data);
    expect(start).toEqual(snapshot);
  });

  it('clears and restores the town visiting hero when leaving and returning', () => {
    const start = makeGame();
    expect(start.towns[RED_TOWN]?.visitingHero).toBe('edric');
    const left = dispatch(
      start,
      { type: 'moveHero', player: 'red', hero: 'edric', path: [[2, 3]] },
      data,
    ).state;
    expect(left.towns[RED_TOWN]?.visitingHero).toBeNull();
    const back = dispatch(
      left,
      { type: 'moveHero', player: 'red', hero: 'edric', path: [[2, 2]] },
      data,
    );
    expect(back.state.towns[RED_TOWN]?.visitingHero).toBe('edric');
    const townObj = back.state.map.objects.find((o) => o.type === 'town' && o.at[0] === 2);
    expect(back.events).toContainEqual({
      type: 'objectTriggered',
      hero: 'edric',
      object: townObj?.id,
    });
  });

  it('reveals fog of war along the way', () => {
    const start = makeGame();
    const red = start.players[0];
    if (!red) throw new Error('missing red player');
    expect(isExplored(red, start.map.size, [8, 3])).toBe(false);
    const { state } = dispatch(
      start,
      {
        type: 'moveHero',
        player: 'red',
        hero: 'edric',
        path: [
          [3, 3],
          [4, 4],
        ],
      },
      data,
    );
    const redAfter = state.players[0];
    if (!redAfter) throw new Error('missing red player');
    expect(isExplored(redAfter, state.map.size, [8, 3])).toBe(true);
    // blue learns nothing from red's move
    const blueAfter = state.players[1];
    if (!blueAfter) throw new Error('missing blue player');
    expect(isExplored(blueAfter, state.map.size, [8, 3])).toBe(false);
  });
});
