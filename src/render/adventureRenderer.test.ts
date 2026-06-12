import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame } from '../core/setup';
import { getPlayer, type GameState } from '../core/state';
import { TILE_PX } from './camera';
import type { Painter, TerrainStyle } from './painter';
import { AdventureRenderer, type AdventureView } from './adventureRenderer';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const SIZE = tinyMap.size;

interface TerrainCall {
  x: number;
  y: number;
  size: number;
  terrain: TerrainStyle;
}

interface RoadCall {
  x: number;
  y: number;
  size: number;
  roadId: string;
}

interface TileCall {
  x: number;
  y: number;
  size: number;
}

// records the land-layer calls the test asserts on; token/overlay methods are
// no-ops (the renderer may call them for objects and heroes)
class RecordingPainter implements Painter {
  readonly terrainCalls: TerrainCall[] = [];
  readonly roadCalls: RoadCall[] = [];
  readonly shroudCalls: TileCall[] = [];
  readonly dimmedCalls: TileCall[] = [];

  terrain(
    _ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrain: TerrainStyle,
  ): void {
    this.terrainCalls.push({ x, y, size, terrain });
  }

  road(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number, roadId: string): void {
    this.roadCalls.push({ x, y, size, roadId });
  }

  shroud(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.shroudCalls.push({ x, y, size });
  }

  dimmed(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.dimmedCalls.push({ x, y, size });
  }

  creatureToken(): void {
    /* not under test */
  }
  heroToken(): void {
    /* not under test */
  }
  townToken(): void {
    /* not under test */
  }
  objectToken(): void {
    /* not under test */
  }
  flag(): void {
    /* not under test */
  }
  selectionRing(): void {
    /* not under test */
  }
  pathDot(): void {
    /* not under test */
  }
  dayMarker(): void {
    /* not under test */
  }
}

// the renderer only clears the background through ctx directly
class StubContext {
  fillStyle = '';
  fillRect(): void {
    /* recorded nowhere: background clear only */
  }
}

function asCtx(stub: StubContext): CanvasRenderingContext2D {
  return stub as unknown as CanvasRenderingContext2D;
}

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
    camera: { x: 0, y: 0, width: SIZE * TILE_PX, height: SIZE * TILE_PX },
    selectedHero: null,
    pathPreview: null,
  };
}

function renderWith(view: AdventureView): RecordingPainter {
  const painter = new RecordingPainter();
  new AdventureRenderer(asCtx(new StubContext()), painter, data).render(view);
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
    expect(callAt(painter.terrainCalls, 0, 0).terrain).toEqual({ id: 'grass', color: '#4a7c2f' });
    expect(callAt(painter.terrainCalls, 4, 4).terrain).toEqual({ id: 'dirt', color: '#8b6b47' });
    expect(callAt(painter.terrainCalls, 0, 5).terrain).toEqual({ id: 'water', color: '#2a5d9c' });
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
    expect(callAt(painter.terrainCalls, 0, 0).terrain).toEqual({ id: '', color: '#000000' });
    expect(callAt(painter.roadCalls, 0, 0).roadId).toBe('');
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
