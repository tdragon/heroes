import { hasAnyConnection, type Painter, type RoadConnections } from './painter';
import { RASTER_PX } from './spriteAtlas';

// Gilded Woodcut war-fog (concept Night palette)
export const FOG_SHROUD_COLOR = '#16100c';
export const FOG_DIMMED_COLOR = 'rgba(22, 16, 12, 0.5)';

// road seam patch: the middle slice of the band (source columns 0.375..0.625),
// where the road SVGs keep the band at full extent, redrawn unrotated to hide
// the seam where the hand-drawn contours of rotated arms meet
const SEAM_PATCH_START_FRAC = 0.375;
const SEAM_PATCH_WIDTH_FRAC = 0.25;

// the slice of SpriteAtlas the painter needs (keeps tests cast-free)
export interface SpriteLookup {
  get(key: string): CanvasImageSource | null;
}

// Theme-art painter: draws terrain/road sprites from the atlas and themed fog,
// delegating to the wrapped placeholder painter whenever a bitmap is missing
// (unknown id, rasterization pending or failed).
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
    terrainId: string,
    color: string,
  ): void {
    if (!this.drawSprite(ctx, `terrain/${terrainId}`, x, y, size)) {
      this.fallback.terrain(ctx, x, y, size, terrainId, color);
    }
  }

  // The road bitmap is a horizontal band. Straight roads draw it whole
  // (rotated for vertical); other shapes compose one half-band arm per
  // connected direction plus a center patch hiding the seam where the
  // hand-drawn contours of rotated arms meet.
  road(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    roadId: string,
    connections: RoadConnections,
  ): void {
    const sprite = this.atlas.get(`road/${roadId}`);
    if (!sprite) {
      this.fallback.road(ctx, x, y, size, roadId, connections);
      return;
    }
    const { n, e, s, w } = connections;
    if (!hasAnyConnection(connections) || (e && w && !n && !s)) {
      ctx.drawImage(sprite, x, y, size, size);
      return;
    }
    const cx = x + size / 2;
    const cy = y + size / 2;
    if (n && s && !e && !w) {
      this.drawRotated(ctx, sprite, cx, cy, Math.PI / 2, 0, size);
      return;
    }
    const arms: [boolean, number][] = [
      [e, 0],
      [s, Math.PI / 2],
      [w, Math.PI],
      [n, -Math.PI / 2],
    ];
    for (const [connected, angle] of arms) {
      if (connected) this.drawRotated(ctx, sprite, cx, cy, angle, RASTER_PX / 2, size);
    }
    const patchX = RASTER_PX * SEAM_PATCH_START_FRAC;
    const patchW = RASTER_PX * SEAM_PATCH_WIDTH_FRAC;
    const scale = size / RASTER_PX;
    ctx.drawImage(
      sprite,
      patchX,
      0,
      patchW,
      RASTER_PX,
      x + patchX * scale,
      y,
      patchW * scale,
      size,
    );
  }

  // draws the source columns [srcX..RASTER_PX] rotated around the tile center
  // so they extend from the center toward the rotated east edge
  private drawRotated(
    ctx: CanvasRenderingContext2D,
    sprite: CanvasImageSource,
    cx: number,
    cy: number,
    angle: number,
    srcX: number,
    size: number,
  ): void {
    const srcW = RASTER_PX - srcX;
    const destX = (srcX / RASTER_PX - 0.5) * size;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.drawImage(
      sprite,
      srcX,
      0,
      srcW,
      RASTER_PX,
      destX,
      -size / 2,
      (srcW / RASTER_PX) * size,
      size,
    );
    ctx.restore();
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
    const sprite = this.atlas.get(key);
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
