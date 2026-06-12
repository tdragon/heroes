import { describe, expect, it } from 'vitest';
import {
  cameraForViewport,
  centerCameraOn,
  clampCamera,
  panCamera,
  screenToWorld,
  tileAtClientPoint,
  tileAtScreen,
  tileScreenRect,
  TILE_PX,
  visibleTileRange,
  worldSizePx,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomCameraAt,
  type Camera,
} from './camera';

const cam = (x: number, y: number, width = 1000, height = 760, zoom = 1): Camera => ({
  x,
  y,
  width,
  height,
  zoom,
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

describe('cameraForViewport', () => {
  it('derives world-px viewport from css size and zoom', () => {
    const c = cameraForViewport(cam(0, 0), 800, 600, 2, 36);
    expect(c).toMatchObject({ width: 400, height: 300, zoom: 2 });
    const half = cameraForViewport(cam(0, 0), 800, 600, 0.5, 36);
    expect(half).toMatchObject({ width: 1600, height: 1200, zoom: 0.5 });
  });

  it('clamps zoom to [ZOOM_MIN, ZOOM_MAX]', () => {
    expect(cameraForViewport(cam(0, 0), 800, 600, 10, 36).zoom).toBe(ZOOM_MAX);
    expect(cameraForViewport(cam(0, 0), 800, 600, 0.01, 36).zoom).toBe(ZOOM_MIN);
  });

  it('preserves the viewport center across a resize', () => {
    const start = cam(200, 300, 1000, 760); // center (700, 680)
    const resized = cameraForViewport(start, 600, 400, 1, 36);
    expect(resized.x + resized.width / 2).toBe(700);
    expect(resized.y + resized.height / 2).toBe(680);
  });

  it('preserves the center across a zoom change', () => {
    const start = cam(480, 480, 800, 600); // center (880, 780)
    const zoomed = cameraForViewport(start, 800, 600, 2, 36);
    expect(zoomed.x + zoomed.width / 2).toBe(880);
    expect(zoomed.y + zoomed.height / 2).toBe(780);
  });

  it('pins to origin when the viewport exceeds the map', () => {
    // 12 tiles = 576 world px; at zoom 0.5 an 800x600 css viewport is 1600x1200 world px
    const c = cameraForViewport(cam(100, 100, 400, 300), 800, 600, 0.5, 12);
    expect(c).toMatchObject({ x: 0, y: 0, width: 1600, height: 1200 });
  });

  it('clamps to map bounds after centering', () => {
    const world = worldSizePx(36);
    const corner = cam(world - 100, world - 100, 100, 100);
    const grown = cameraForViewport(corner, 1000, 760, 1, 36);
    expect(grown.x).toBe(world - 1000);
    expect(grown.y).toBe(world - 760);
  });

  // the adventure screen boots with a zero-size camera: centerCameraOn stores
  // the focus point and the first cameraForViewport recovers it as the center
  it('recovers a focus stored in a zero-size camera once the viewport is known', () => {
    const zero = cam(0, 0, 0, 0);
    const focused = centerCameraOn(zero, [10, 10], 36);
    expect(focused).toMatchObject({ x: 10.5 * TILE_PX, y: 10.5 * TILE_PX });
    const sized = cameraForViewport(focused, 800, 600, 1, 36);
    expect(sized.x + sized.width / 2).toBe(10.5 * TILE_PX);
    expect(sized.y + sized.height / 2).toBe(10.5 * TILE_PX);
  });
});

describe('zoomCameraAt', () => {
  const worldAtAnchor = (c: Camera, sx: number, sy: number): [number, number] => [
    c.x + sx / c.zoom,
    c.y + sy / c.zoom,
  ];

  it('keeps the world point under the anchor fixed', () => {
    const start = cam(480, 480, 1000, 760);
    const [wx, wy] = worldAtAnchor(start, 300, 200);
    const zoomed = zoomCameraAt(start, 2, 300, 200, 1000, 760, 36);
    expect(zoomed.zoom).toBe(2);
    expect(zoomed.width).toBe(500);
    expect(zoomed.height).toBe(380);
    const [nwx, nwy] = worldAtAnchor(zoomed, 300, 200);
    expect(nwx).toBeCloseTo(wx, 10);
    expect(nwy).toBeCloseTo(wy, 10);
  });

  it('keeps the anchor fixed when zooming back out', () => {
    const start = cam(600, 500, 500, 380, 2);
    const [wx, wy] = worldAtAnchor(start, 100, 50);
    const out = zoomCameraAt(start, 1, 100, 50, 1000, 760, 36);
    const [nwx, nwy] = worldAtAnchor(out, 100, 50);
    expect(nwx).toBeCloseTo(wx, 10);
    expect(nwy).toBeCloseTo(wy, 10);
  });

  it('clamps the requested zoom', () => {
    expect(zoomCameraAt(cam(0, 0), 100, 0, 0, 1000, 760, 36).zoom).toBe(ZOOM_MAX);
    expect(zoomCameraAt(cam(0, 0), 0, 0, 0, 1000, 760, 36).zoom).toBe(ZOOM_MIN);
  });

  it('clamps position at map edges (anchor cannot be honored)', () => {
    // zoom out at the top-left corner: viewport grows, x/y must stay >= 0
    const corner = zoomCameraAt(cam(0, 0), 0.5, 0, 0, 1000, 760, 36);
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0);
    expect(corner.width).toBe(2000);
    // zoom out at the bottom-right corner of a large map: clamped to max scroll
    const world = worldSizePx(72); // 3456 > 2000x1520 zoomed-out viewport
    const br = zoomCameraAt(
      cam(world - 1000, world - 760, 1000, 760),
      0.5,
      1000,
      760,
      1000,
      760,
      72,
    );
    expect(br.x).toBe(world - 2000);
    expect(br.y).toBe(world - 1520);
  });
});

describe('tileAtClientPoint', () => {
  it('matches tileAtScreen at zoom 1', () => {
    const c = cam(TILE_PX * 3, TILE_PX * 2);
    expect(tileAtClientPoint(c, 10, 10, 36)).toEqual([3, 2]);
    expect(tileAtClientPoint(c, 10, 10, 36)).toEqual(tileAtScreen(c, 10, 10, 36));
  });

  it('divides css px by zoom at zoom 2', () => {
    const c = cam(0, 0, 500, 380, 2);
    // css (95, 95) -> world (47.5, 47.5) -> tile [0, 0]
    expect(tileAtClientPoint(c, 95, 95, 36)).toEqual([0, 0]);
    expect(tileAtClientPoint(c, 96, 96, 36)).toEqual([1, 1]);
  });

  it('divides css px by zoom at zoom 0.5', () => {
    const c = cam(0, 0, 2000, 1520, 0.5);
    // css (25, 25) -> world (50, 50) -> tile [1, 1]
    expect(tileAtClientPoint(c, 23, 23, 36)).toEqual([0, 0]);
    expect(tileAtClientPoint(c, 25, 25, 36)).toEqual([1, 1]);
  });

  it('returns null outside the map at any zoom', () => {
    const c = cam(0, 0, 2000, 1520, 0.5);
    const world = worldSizePx(36);
    expect(tileAtClientPoint(c, world * 0.5 + 1, 10, 36)).toBeNull();
    expect(tileAtClientPoint(c, -1, 10, 36)).toBeNull();
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
