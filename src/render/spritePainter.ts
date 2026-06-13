import { hasAnyConnection, type Painter, type RoadConnections } from './painter';
import { RASTER_PX } from './spriteAtlas';

// Gilded Woodcut war-fog (concept Night palette)
export const FOG_SHROUD_COLOR = '#16100c';
export const FOG_DIMMED_COLOR = 'rgba(22, 16, 12, 0.5)';

// Seal token palette (concept "Ink, Parchment & Gold")
export const SEAL_PARCHMENT = '#ead9b5';
export const SEAL_INK = '#241b16';
export const SEAL_PARCHMENT_EDGE = '#c9b384';
export const SEAL_GILT = '#d9ab3c';

// Seal furniture geometry, expressed as fractions of the token radius `r`
// (concept #seal: 64-box, disc r=28, ring strokes 2.6/0.9, pips on the lower
// arc, banner notch chevron spanning x 22..42, y 52.5..61).
const RING_OUTER_WIDTH = 0.093; // outer ink ring stroke (2.6/28)
const RING_INNER_RADIUS = 0.843; // hairline inner ring radius (23.6/28)
const RING_INNER_WIDTH = 0.032; // hairline inner ring stroke (0.9/28)
const EMBLEM_SCALE = 1.5; // emblem square side relative to r (slightly overfills)
const PIP_HALF = 0.13; // pip diamond half-diagonal
const PIP_GAP = 0.36; // horizontal spacing between adjacent pips
const PIP_ARC_Y = 0.55; // pip row offset below center (on the lower arc)
const PIP_STROKE = 0.04; // pip outline width
const NOTCH_HALF_WIDTH = 0.31; // banner chevron half-width (10/32)
const NOTCH_TOP_Y = 0.66; // chevron top edge below center
const NOTCH_TIP_Y = 0.94; // chevron lower tip below center
const NOTCH_SHOULDER_Y = 0.84; // chevron shoulder below center
const NOTCH_STROKE = 0.057; // banner chevron outline width

// Horseman hero marker geometry, as fractions of the token radius `r`.
// The horseman art is a full figure in the 64-box; blit it at `2*r` square so
// horse+rider read at hero-token size. The adventure renderer draws the
// selection ring at `rect.size*0.48` and this token at `rect.size*0.36`, i.e.
// the ring radius is ~1.33*r — a `2*r` square extends only ~r from center, so
// the figure and its upper-right banner sit inside the ring and are not clipped.
const HORSEMAN_BLIT_SCALE = 2; // sprite square side relative to r
// Procedural player-color banner (swallow-tail) in the upper-right of the
// figure. Drawn on top of the rasterized sprite, whose own `currentColor`
// banner resolves to a fixed default in the static bitmap; these coordinates
// cover that area and carry the dynamic owner color + hero letter instead.
const BANNER_POLE_X = 0.2; // banner pole / left edge, right of center
const BANNER_RIGHT_X = 0.86; // banner outer (right) edge
const BANNER_TOP_Y = 0.86; // banner top edge above center
const BANNER_BOTTOM_Y = 0.5; // banner bottom edge above center
const BANNER_TAIL_NOTCH = 0.12; // swallow-tail inset depth on the right edge
const BANNER_STROKE = 0.06; // banner outline width
const BANNER_LETTER_SIZE = 0.34; // hero-letter font size

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

  // The road bitmap is a centered horizontal band. Straight runs draw it whole
  // (rotated 90° for vertical); a dead-end (single connection) uses the
  // dedicated rounded end tile so the road terminates smoothly; corners and
  // junctions compose one half-band arm per connected direction — the centered
  // band makes the arms meet cleanly at the tile center with no seam.
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
    // each arm/end opens toward its connected edge (E=0, rotating clockwise)
    const arms: [boolean, number][] = [
      [e, 0],
      [s, Math.PI / 2],
      [w, Math.PI],
      [n, -Math.PI / 2],
    ];
    const connected = arms.filter(([on]) => on);
    if (connected.length === 1) {
      const endSprite = this.atlas.get(`roadend/${roadId}`);
      const dir = connected[0];
      if (endSprite && dir) {
        this.drawRotated(ctx, endSprite, cx, cy, dir[1], 0, size);
        return;
      }
    }
    for (const [on, angle] of arms) {
      if (on) this.drawRotated(ctx, sprite, cx, cy, angle, RASTER_PX / 2, size);
    }
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

  // The seal: a parchment disc + double ink ring + gilt tier pips + a banner
  // notch in the owner color, carrying a creature emblem. Disc/ring/pips/notch
  // are drawn procedurally per-instance; only the emblem is a shared bitmap
  // (`creature/<id>`). When the emblem is missing the centered initials stand
  // in, so un-arted creatures still get the seal look.
  creatureToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    id: string,
    initials: string,
    tier: number,
  ): void {
    // parchment disc
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = SEAL_PARCHMENT;
    ctx.fill();

    // double ink ring: thick outer stroke + a thin parchment-edge hairline
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = SEAL_INK;
    ctx.lineWidth = r * RING_OUTER_WIDTH;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * RING_INNER_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = SEAL_PARCHMENT_EDGE;
    ctx.lineWidth = r * RING_INNER_WIDTH;
    ctx.stroke();

    // emblem (shared bitmap) or initials fallback, centered on the disc
    const emblem = this.atlas.get(`creature/${id}`);
    if (emblem) {
      const side = r * EMBLEM_SCALE;
      ctx.drawImage(emblem, cx - side / 2, cy - side / 2, side, side);
    } else {
      ctx.fillStyle = SEAL_INK;
      ctx.font = `bold ${String(Math.round(r * 0.9))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, cx, cy);
    }

    this.drawTierPips(ctx, cx, cy, r, tier);
    this.drawBannerNotch(ctx, cx, cy, r, color);
  }

  // `tier` gilt diamonds (1..7) along the lower arc, centered horizontally
  private drawTierPips(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    tier: number,
  ): void {
    const count = Math.max(1, Math.min(7, tier));
    const half = r * PIP_HALF;
    const gap = r * PIP_GAP;
    const py = cy + r * PIP_ARC_Y;
    const startX = cx - (gap * (count - 1)) / 2;
    ctx.fillStyle = SEAL_GILT;
    ctx.strokeStyle = SEAL_INK;
    ctx.lineWidth = r * PIP_STROKE;
    for (let i = 0; i < count; i++) {
      const px = startX + gap * i;
      ctx.beginPath();
      ctx.moveTo(px, py - half);
      ctx.lineTo(px + half, py);
      ctx.lineTo(px, py + half);
      ctx.lineTo(px - half, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // chevron/banner at the bottom of the disc; the only place owner color shows
  private drawBannerNotch(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
  ): void {
    const hw = r * NOTCH_HALF_WIDTH;
    const top = cy + r * NOTCH_TOP_Y;
    const shoulder = cy + r * NOTCH_SHOULDER_Y;
    const tip = cy + r * NOTCH_TIP_Y;
    ctx.beginPath();
    ctx.moveTo(cx - hw, top);
    ctx.lineTo(cx, top + (shoulder - top) * 0.6);
    ctx.lineTo(cx + hw, top);
    ctx.lineTo(cx + hw, tip);
    ctx.lineTo(cx + hw * 0.5, shoulder);
    ctx.lineTo(cx, tip + (shoulder - top) * 0.4);
    ctx.lineTo(cx - hw * 0.5, shoulder);
    ctx.lineTo(cx - hw, tip);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = SEAL_INK;
    ctx.lineWidth = r * NOTCH_STROKE;
    ctx.stroke();
  }

  // The mounted-horseman hero marker. The horse+rider is a shared static
  // bitmap (`hero/horseman`); the player-color banner and the hero's letter are
  // per-instance, so they are drawn procedurally on top of the blitted figure.
  // Falls back to the wrapped painter's shield when the bitmap is missing.
  heroToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void {
    const horseman = this.atlas.get('hero/horseman');
    if (!horseman) {
      this.fallback.heroToken(ctx, cx, cy, r, color, initial);
      return;
    }
    const side = r * HORSEMAN_BLIT_SCALE;
    ctx.drawImage(horseman, cx - side / 2, cy - side / 2, side, side);
    this.drawHeroBanner(ctx, cx, cy, r, color, initial);
  }

  // swallow-tail banner in the upper-right of the figure, in the owner color,
  // carrying the hero letter in parchment; covers the sprite's static banner
  private drawHeroBanner(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void {
    const left = cx + r * BANNER_POLE_X;
    const right = cx + r * BANNER_RIGHT_X;
    const top = cy - r * BANNER_TOP_Y;
    const bottom = cy - r * BANNER_BOTTOM_Y;
    const notch = r * BANNER_TAIL_NOTCH;
    const midY = (top + bottom) / 2;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    ctx.lineTo(right - notch, midY);
    ctx.lineTo(right, bottom);
    ctx.lineTo(left, bottom);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = SEAL_INK;
    ctx.lineWidth = r * BANNER_STROKE;
    ctx.stroke();

    ctx.fillStyle = SEAL_PARCHMENT;
    ctx.font = `bold ${String(Math.round(r * BANNER_LETTER_SIZE))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, (left + right) / 2 - notch / 2, midY);
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
