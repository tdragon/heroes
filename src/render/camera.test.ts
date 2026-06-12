import { describe, expect, it } from 'vitest';
import {
  centerCameraOn,
  clampCamera,
  panCamera,
  screenToWorld,
  tileAtScreen,
  tileScreenRect,
  TILE_PX,
  visibleTileRange,
  worldSizePx,
  worldToScreen,
  type Camera,
} from './camera';

const cam = (x: number, y: number, width = 1000, height = 760): Camera => ({
  x,
  y,
  width,
  height,
});

describe('world/screen conversion', () => {
  it('round-trips world -> screen -> world', () => {
    const c = cam(120, 340);
    const [sx, sy] = worldToScreen(c, 500, 600);
    expect([sx, sy]).toEqual([380, 260]);
    expect(screenToWorld(c, sx, sy)).toEqual([500, 600]);
  });

  it('maps screen pixels to tiles', () => {
    const c = cam(0, 0);
    expect(tileAtScreen(c, 0, 0, 36)).toEqual([0, 0]);
    expect(tileAtScreen(c, TILE_PX - 1, TILE_PX - 1, 36)).toEqual([0, 0]);
    expect(tileAtScreen(c, TILE_PX, TILE_PX, 36)).toEqual([1, 1]);
  });

  it('accounts for camera offset in tile hit-testing', () => {
    const c = cam(TILE_PX * 3, TILE_PX * 2);
    expect(tileAtScreen(c, 10, 10, 36)).toEqual([3, 2]);
  });

  it('returns null for tiles outside the map', () => {
    const c = cam(0, 0, 100, 100);
    expect(tileAtScreen(c, -1, 5, 36)).toBeNull();
    const edge = cam(worldSizePx(36) - 100, worldSizePx(36) - 100, 100, 100);
    expect(tileAtScreen(edge, 99, 99, 36)).toEqual([35, 35]);
    expect(tileAtScreen(edge, 101, 99, 36)).toBeNull();
  });

  it('computes tile screen rects', () => {
    const c = cam(48, 96);
    expect(tileScreenRect(c, [2, 3])).toEqual({ x: 48, y: 48, size: TILE_PX });
  });
});

describe('clamping and panning', () => {
  it('clamps camera into world bounds', () => {
    const world = worldSizePx(36); // 1728
    expect(clampCamera(cam(-50, -50), 36)).toMatchObject({ x: 0, y: 0 });
    expect(clampCamera(cam(99999, 99999), 36)).toMatchObject({
      x: world - 1000,
      y: world - 760,
    });
  });

  it('pins camera at 0 when viewport is larger than the world', () => {
    expect(clampCamera(cam(30, 30, 2000, 2000), 12)).toMatchObject({ x: 0, y: 0 });
  });

  it('pans with clamping', () => {
    const c = cam(0, 0);
    expect(panCamera(c, -100, 50, 36)).toMatchObject({ x: 0, y: 50 });
    const world = worldSizePx(36);
    expect(panCamera(cam(world, world), 100, 100, 36)).toMatchObject({
      x: world - 1000,
      y: world - 760,
    });
  });

  it('centers camera on a tile', () => {
    const c = centerCameraOn(cam(0, 0), [18, 18], 36);
    expect(c.x).toBe((18 + 0.5) * TILE_PX - 500);
    expect(c.y).toBe((18 + 0.5) * TILE_PX - 380);
    // near origin the centering clamps to 0
    expect(centerCameraOn(cam(500, 500), [4, 5], 36)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('visibleTileRange', () => {
  it('covers exactly the tiles intersecting the viewport', () => {
    expect(visibleTileRange(cam(0, 0, 96, 96), 36)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(visibleTileRange(cam(1, 1, 96, 96), 36)).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 });
  });

  it('clamps to map edges', () => {
    const world = worldSizePx(36);
    expect(visibleTileRange(cam(world - 96, world - 96, 1000, 760), 36)).toEqual({
      x0: 34,
      y0: 34,
      x1: 35,
      y1: 35,
    });
  });
});
