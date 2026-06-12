import type { Painter, TerrainStyle } from './painter';

// Below this tile size sprites are unreadable (minimap territory): always use
// the flat-color fallback there.
export const SPRITE_MIN_TILE_PX = 12;

// Gilded Woodcut war-fog (concept Night palette)
export const FOG_SHROUD_COLOR = '#16100c';
export const FOG_DIMMED_COLOR = 'rgba(22, 16, 12, 0.5)';

// the slice of SpriteAtlas the painter needs (keeps tests cast-free)
export interface SpriteLookup {
  get(key: string, sizePx: number): CanvasImageSource | null;
}

// Theme-art painter: draws terrain/road sprites from the atlas and themed fog,
// delegating to the wrapped placeholder painter whenever a bitmap is missing
// (unknown id, rasterization pending/failed, or sub-threshold tile size).
export class SpritePainter implements Painter {
  constructor(
    private readonly atlas: SpriteLookup,
    private readonly fallback: Painter,
  ) {}

  terrain(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrain: TerrainStyle,
  ): void {
    if (!this.drawSprite(ctx, `terrain/${terrain.id}`, x, y, size)) {
      this.fallback.terrain(ctx, x, y, size, terrain);
    }
  }

  road(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, roadId: string): void {
    if (!this.drawSprite(ctx, `road/${roadId}`, x, y, size)) {
      this.fallback.road(ctx, x, y, size, roadId);
    }
  }

  shroud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    ctx.fillStyle = FOG_SHROUD_COLOR;
    ctx.fillRect(x, y, size, size);
  }

  dimmed(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    ctx.fillStyle = FOG_DIMMED_COLOR;
    ctx.fillRect(x, y, size, size);
  }

  private drawSprite(
    ctx: CanvasRenderingContext2D,
    key: string,
    x: number,
    y: number,
    size: number,
  ): boolean {
    if (size < SPRITE_MIN_TILE_PX) return false;
    const sprite = this.atlas.get(key, size);
    if (!sprite) return false;
    ctx.drawImage(sprite, x, y, size, size);
    return true;
  }

  creatureToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initials: string,
    tier: number,
  ): void {
    this.fallback.creatureToken(ctx, cx, cy, r, color, initials, tier);
  }

  heroToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void {
    this.fallback.heroToken(ctx, cx, cy, r, color, initial);
  }

  townToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
    this.fallback.townToken(ctx, cx, cy, r, color);
  }

  objectToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    label: string,
  ): void {
    this.fallback.objectToken(ctx, cx, cy, r, color, label);
  }

  flag(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
    this.fallback.flag(ctx, x, y, size, color);
  }

  selectionRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    this.fallback.selectionRing(ctx, cx, cy, r);
  }

  pathDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    this.fallback.pathDot(ctx, cx, cy, r);
  }

  dayMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, day: number): void {
    this.fallback.dayMarker(ctx, cx, cy, r, day);
  }
}
