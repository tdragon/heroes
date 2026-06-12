import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame } from '../core/setup';
import { getPlayer, type GameState } from '../core/state';
import { TILE_PX } from './camera';
import {
  AdventureRenderer,
  renderMinimap,
  roadConnections,
  type AdventureView,
} from './adventureRenderer';
import { asCtx, RecordingContext, RecordingPainter, type TileCall } from './testSupport';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const SIZE = tinyMap.size;

function makeView(
  state: GameState,
  overrides: { explored?: boolean; visible?: boolean[] } = {},
): AdventureView {
  const player = getPlayer(state, 'red');
  player.explored = player.explored.map(() => overrides.explored ?? true);
  return {
    state,
    player,
    visible: overrides.visible ?? Array.from({ length: SIZE * SIZE }, () => true),
    camera: { x: 0, y: 0, width: SIZE * TILE_PX, height: SIZE * TILE_PX, zoom: 1 },
    dpr: 1,
    selectedHero: null,
    pathPreview: null,
  };
}

function renderWith(view: AdventureView): RecordingPainter {
  const painter = new RecordingPainter();
  new AdventureRenderer(asCtx(new RecordingContext()), painter, data).render(view);
  return painter;
}

function callAt<T extends TileCall>(calls: T[], tx: number, ty: number): T {
  const call = calls.find((c) => c.x === tx * TILE_PX && c.y === ty * TILE_PX);
  if (!call) throw new Error(`no call for tile ${String(tx)},${String(ty)}`);
  return call;
}

describe('AdventureRenderer terrain id plumbing', () => {
  it('forwards the terrain id and color for every explored tile', () => {
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data)));
    expect(painter.terrainCalls).toHaveLength(SIZE * SIZE);
    expect(painter.shroudCalls).toHaveLength(0);
    // tiny map: grass at (0,0), dirt at (4,4), water at (0,5)
    expect(callAt(painter.terrainCalls, 0, 0)).toMatchObject({
      terrainId: 'grass',
      color: '#4a7c2f',
    });
    expect(callAt(painter.terrainCalls, 4, 4)).toMatchObject({
      terrainId: 'dirt',
      color: '#8b6b47',
    });
    expect(callAt(painter.terrainCalls, 0, 5)).toMatchObject({
      terrainId: 'water',
      color: '#2a5d9c',
    });
    expect(callAt(painter.terrainCalls, 4, 4).size).toBe(TILE_PX);
  });

  it('forwards the resolved road id only on road tiles', () => {
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data)));
    // tiny map: a 4-tile dirt road band at y=4, x=4..7
    expect(painter.roadCalls).toHaveLength(4);
    for (const call of painter.roadCalls) {
      expect(call.roadId).toBe('dirt_road');
      expect(call.y).toBe(4 * TILE_PX);
    }
    expect(painter.roadCalls.map((c) => c.x).sort((a, b) => a - b)).toEqual(
      [4, 5, 6, 7].map((tx) => tx * TILE_PX),
    );
  });

  it('draws terrain before (under) the road on a road tile', () => {
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data)));
    const px = 4 * TILE_PX;
    const terrainIdx = painter.sequence.findIndex(
      (c) => c.method === 'terrain' && c.x === px && c.y === px,
    );
    const roadIdx = painter.sequence.findIndex(
      (c) => c.method === 'road' && c.x === px && c.y === px,
    );
    expect(terrainIdx).toBeGreaterThanOrEqual(0);
    expect(roadIdx).toBeGreaterThan(terrainIdx);
  });

  it('falls back to empty id and black for unknown terrain and road chars', () => {
    const state = newGame(tinyMap, {}, 7, data);
    const mutated: GameState = {
      ...state,
      map: {
        ...state.map,
        terrain: `?${state.map.terrain.slice(1)}`,
        roads: `?${state.map.roads.slice(1)}`,
      },
    };
    const painter = renderWith(makeView(mutated));
    expect(callAt(painter.terrainCalls, 0, 0)).toMatchObject({ terrainId: '', color: '#000000' });
    expect(callAt(painter.roadCalls, 0, 0).roadId).toBe('');
  });
});

describe('road connectivity mask', () => {
  function roadsWith(tiles: [number, number][], char = 'D'): string {
    const grid = Array.from({ length: SIZE * SIZE }, () => '.');
    for (const [x, y] of tiles) grid[y * SIZE + x] = char;
    return grid.join('');
  }

  const allExplored = (): boolean[] => Array.from({ length: SIZE * SIZE }, () => true);

  it('marks both ends of a straight vertical road', () => {
    const roads = roadsWith([
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
    expect(roadConnections(roads, SIZE, 2, 2, allExplored())).toEqual({
      n: true,
      e: false,
      s: true,
      w: false,
    });
    expect(roadConnections(roads, SIZE, 2, 1, allExplored())).toEqual({
      n: false,
      e: false,
      s: true,
      w: false,
    });
  });

  it('marks the two arms of a corner', () => {
    const roads = roadsWith([
      [2, 2],
      [3, 2],
      [2, 3],
    ]);
    expect(roadConnections(roads, SIZE, 2, 2, allExplored())).toEqual({
      n: false,
      e: true,
      s: true,
      w: false,
    });
  });

  it('returns no connections for an isolated tile', () => {
    expect(roadConnections(roadsWith([[5, 5]]), SIZE, 5, 5, allExplored())).toEqual({
      n: false,
      e: false,
      s: false,
      w: false,
    });
  });

  it('treats different road types as connected', () => {
    const grid = Array.from({ length: SIZE * SIZE }, () => '.');
    grid[2 * SIZE + 2] = 'D';
    grid[2 * SIZE + 3] = 'C';
    expect(roadConnections(grid.join(''), SIZE, 2, 2, allExplored()).e).toBe(true);
  });

  it('does not crash at map edges and treats out-of-bounds as no road', () => {
    const roads = roadsWith([
      [0, 0],
      [SIZE - 1, SIZE - 1],
      [SIZE - 2, SIZE - 1],
    ]);
    expect(roadConnections(roads, SIZE, 0, 0, allExplored())).toEqual({
      n: false,
      e: false,
      s: false,
      w: false,
    });
    expect(roadConnections(roads, SIZE, SIZE - 1, SIZE - 1, allExplored())).toEqual({
      n: false,
      e: false,
      s: false,
      w: true,
    });
  });

  it('ignores unexplored road neighbors until they are explored (no fog leak)', () => {
    const roads = roadsWith([
      [2, 2],
      [3, 2],
      [2, 3],
    ]);
    const explored = allExplored();
    explored[2 * SIZE + 3] = false; // east neighbor (3,2) hidden behind fog
    expect(roadConnections(roads, SIZE, 2, 2, explored)).toEqual({
      n: false,
      e: false,
      s: true,
      w: false,
    });
    explored[2 * SIZE + 3] = true; // exploring it adds the arm
    expect(roadConnections(roads, SIZE, 2, 2, explored)).toEqual({
      n: false,
      e: true,
      s: true,
      w: false,
    });
  });

  it('flows through the renderer to the painter on the tiny map road band', () => {
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data)));
    // tiny map: horizontal road y=4, x=4..7
    expect(callAt(painter.roadCalls, 4, 4).connections).toEqual({
      n: false,
      e: true,
      s: false,
      w: false,
    });
    expect(callAt(painter.roadCalls, 5, 4).connections).toEqual({
      n: false,
      e: true,
      s: false,
      w: true,
    });
    expect(callAt(painter.roadCalls, 7, 4).connections).toEqual({
      n: false,
      e: false,
      s: false,
      w: true,
    });
  });
});

describe('AdventureRenderer fog branches', () => {
  it('draws shroud instead of terrain on unexplored tiles', () => {
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data), { explored: false }));
    expect(painter.terrainCalls).toHaveLength(0);
    expect(painter.roadCalls).toHaveLength(0);
    expect(painter.shroudCalls).toHaveLength(SIZE * SIZE);
    expect(callAt(painter.shroudCalls, 3, 2).size).toBe(TILE_PX);
  });

  it('dims explored tiles that are out of sight', () => {
    const visible = Array.from({ length: SIZE * SIZE }, () => false);
    visible[0] = true; // keep (0,0) bright
    const painter = renderWith(makeView(newGame(tinyMap, {}, 7, data), { visible }));
    expect(painter.terrainCalls).toHaveLength(SIZE * SIZE);
    expect(painter.dimmedCalls).toHaveLength(SIZE * SIZE - 1);
    expect(painter.dimmedCalls.some((c) => c.x === 0 && c.y === 0)).toBe(false);
  });
});

// the minimap bypasses the Painter entirely: flat terrain colors only
describe('renderMinimap', () => {
  it('fills explored tiles with flat terrain colors and skips unexplored ones', () => {
    const view = makeView(newGame(tinyMap, {}, 7, data));
    view.player.explored[1] = false; // unexplore tile (1,0)
    const scale = 4;
    const stub = new RecordingContext();
    renderMinimap(asCtx(stub), view, SIZE * scale, data);

    // black background clear first
    const fills = stub.ops.filter((o) => o.op === 'fillRect');
    expect(fills[0]).toEqual({
      op: 'fillRect',
      fillStyle: '#000000',
      args: [0, 0, SIZE * scale, SIZE * scale],
    });
    // terrain cells are scale x scale; entity dots are larger, filter them out
    const cells = fills.filter((f) => f.args[2] === scale && f.args[3] === scale);
    const cellAt = (x: number, y: number): string | undefined =>
      cells.find((f) => f.args[0] === x && f.args[1] === y)?.fillStyle;
    expect(cellAt(0, 0)).toBe('#4a7c2f'); // grass
    expect(cellAt(0, 5 * scale)).toBe('#2a5d9c'); // water
    expect(cellAt(scale, 0)).toBeUndefined(); // unexplored
    // viewport rectangle outline
    const strokes = stub.ops.filter((o) => o.op === 'strokeRect');
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.strokeStyle).toBe('#ffffff');
  });
});
