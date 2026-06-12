import type { Pos } from '../maps/schema';

export const TILE_PX = 48;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

export interface Camera {
  // x/y/width/height are in WORLD px; width = cssWidth / zoom, height = cssHeight / zoom
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number; // 1 = 48 css px per tile
}

export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
}

export function worldSizePx(mapTiles: number): number {
  return mapTiles * TILE_PX;
}

export function clampCamera(cam: Camera, mapTiles: number): Camera {
  const world = worldSizePx(mapTiles);
  const maxX = Math.max(0, world - cam.width);
  const maxY = Math.max(0, world - cam.height);
  return {
    ...cam,
    x: Math.min(Math.max(cam.x, 0), maxX),
    y: Math.min(Math.max(cam.y, 0), maxY),
  };
}

export function panCamera(cam: Camera, dx: number, dy: number, mapTiles: number): Camera {
  return clampCamera({ ...cam, x: cam.x + dx, y: cam.y + dy }, mapTiles);
}

export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [wx - cam.x, wy - cam.y];
}

export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [sx + cam.x, sy + cam.y];
}

export function tileAtScreen(cam: Camera, sx: number, sy: number, mapTiles: number): Pos | null {
  const [wx, wy] = screenToWorld(cam, sx, sy);
  const tx = Math.floor(wx / TILE_PX);
  const ty = Math.floor(wy / TILE_PX);
  if (tx < 0 || ty < 0 || tx >= mapTiles || ty >= mapTiles) return null;
  return [tx, ty];
}

// hit-testing for input handlers: sx/sy are CSS px relative to the canvas
export function tileAtClientPoint(
  cam: Camera,
  sx: number,
  sy: number,
  mapTiles: number,
): Pos | null {
  return tileAtScreen(cam, sx / cam.zoom, sy / cam.zoom, mapTiles);
}

// resize/zoom entry point: derives the world-px viewport from the CSS size,
// preserves the current viewport center, clamps
export function cameraForViewport(
  cam: Camera,
  cssW: number,
  cssH: number,
  zoom: number,
  mapTiles: number,
): Camera {
  const z = clampZoom(zoom);
  const width = cssW / z;
  const height = cssH / z;
  const cx = cam.x + cam.width / 2;
  const cy = cam.y + cam.height / 2;
  return clampCamera({ x: cx - width / 2, y: cy - height / 2, width, height, zoom: z }, mapTiles);
}

// change zoom keeping the world point under (anchorSx, anchorSy) fixed;
// anchor is in CSS px relative to the canvas
export function zoomCameraAt(
  cam: Camera,
  newZoom: number,
  anchorSx: number,
  anchorSy: number,
  cssW: number,
  cssH: number,
  mapTiles: number,
): Camera {
  const z = clampZoom(newZoom);
  return clampCamera(
    {
      x: cam.x + anchorSx / cam.zoom - anchorSx / z,
      y: cam.y + anchorSy / cam.zoom - anchorSy / z,
      width: cssW / z,
      height: cssH / z,
      zoom: z,
    },
    mapTiles,
  );
}

export interface TileRect {
  x: number;
  y: number;
  size: number;
}

export function tileScreenRect(cam: Camera, pos: Pos): TileRect {
  return { x: pos[0] * TILE_PX - cam.x, y: pos[1] * TILE_PX - cam.y, size: TILE_PX };
}

export function centerCameraOn(cam: Camera, pos: Pos, mapTiles: number): Camera {
  const cx = (pos[0] + 0.5) * TILE_PX;
  const cy = (pos[1] + 0.5) * TILE_PX;
  return clampCamera({ ...cam, x: cx - cam.width / 2, y: cy - cam.height / 2 }, mapTiles);
}

export interface TileRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// inclusive range of tiles intersecting the viewport
export function visibleTileRange(cam: Camera, mapTiles: number): TileRange {
  return {
    x0: Math.max(0, Math.floor(cam.x / TILE_PX)),
    y0: Math.max(0, Math.floor(cam.y / TILE_PX)),
    x1: Math.min(mapTiles - 1, Math.floor((cam.x + cam.width - 1) / TILE_PX)),
    y1: Math.min(mapTiles - 1, Math.floor((cam.y + cam.height - 1) / TILE_PX)),
  };
}
