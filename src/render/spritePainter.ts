import { hasAnyConnection, type Painter, type RoadConnections } from './painter';
import { RASTER_PX } from './spriteAtlas';

// Gilded Woodcut war-fog (concept Night palette)
export const FOG_SHROUD_COLOR = '#16100c';
export const FOG_DIMMED_COLOR = 'rgba(22, 16, 12, 0.5)';

// Seal token palette (concept "Ink, Parchment & Gold")
export const SEAL_PARCHMENT = '#ead9b5';
const SEAL_INK = '#241b16';
const SEAL_PARCHMENT_EDGE = '#c9b384';
export const SEAL_GILT = '#d9ab3c';

// Tier is shown as 1-3 pips in a rising metal rather than 1-7 pips in a row
// (seven in a row read as clutter): bronze for tiers 1-3, silver for 4-6, gold
// for 7. metal = floor((tier-1)/3), pips = ((tier-1) mod 3) + 1.
export const PIP_BRONZE = '#a9743b';
export const PIP_SILVER = '#c2ccd6';
export const PIP_GOLD = SEAL_GILT;

export function tierPipSpec(tier: number): { color: string; count: number } {
  const t = Math.max(1, Math.min(9, Math.trunc(tier)));
  const metal = Math.floor((t - 1) / 3);
  const count = ((t - 1) % 3) + 1;
  const color = metal === 0 ? PIP_BRONZE : metal === 1 ? PIP_SILVER : PIP_GOLD;
  return { color, count };
}

// Seal furniture geometry, expressed as fractions of the token radius `r`
// (concept #seal: 64-box, disc r=28, ring strokes 2.6/0.9, pips on the lower
// arc, banner notch chevron spanning x 22..42, y 52.5..61).
const RING_OUTER_WIDTH = 0.093; // outer ink ring stroke (2.6/28)
const RING_INNER_RADIUS = 0.843; // hairline inner ring radius (23.6/28)
const RING_INNER_WIDTH = 0.032; // hairline inner ring stroke (0.9/28)
// The creature emblems are full-figure art in a 64-box (head/spear near the top
// edge, feet + ground shadow near the bottom). Framing it like a medallion: blit
// a square a touch wider than r, nudged up so the figure's focal mass sits in
// the disc's upper-middle and the feet clear the tier pips + banner notch, then
// clip to a circle just inside the ink ring so nothing can poke past the frame.
const EMBLEM_SCALE = 1.34; // emblem square side relative to r
const EMBLEM_VERT_OFFSET = 0.2; // upward shift of the emblem center, fraction of r
const EMBLEM_CLIP_RADIUS = 0.92; // circular clip radius, just inside the ink ring
const PIP_HALF = 0.13; // pip diamond half-diagonal
const PIP_GAP = 0.36; // horizontal spacing between adjacent pips
const PIP_ARC_Y = 0.55; // pip row offset below center (on the lower arc)
const PIP_STROKE = 0.04; // pip outline width
const NOTCH_HALF_WIDTH = 0.31; // banner chevron half-width (10/32)
const NOTCH_TOP_Y = 0.66; // chevron top edge below center
const NOTCH_TIP_Y = 0.94; // chevron lower tip below center
const NOTCH_SHOULDER_Y = 0.84; // chevron shoulder below center
const NOTCH_STROKE = 0.057; // banner chevron outline width
const NOTCH_TOP_DIP = 0.6; // top-edge dip, fraction of (shoulder-top)
const NOTCH_TIP_DIP = 0.4; // center swallow-tail notch depth, fraction of (shoulder-top)
const NOTCH_SHOULDER_INSET = 0.5; // shoulder horizontal inset, fraction of half-width

// Horseman hero marker geometry, as fractions of the token radius `r`.
// The horseman art is a full figure in the 64-box. The adventure renderer draws
// the selection ring at `rect.size*0.48` and this token at `rect.size*0.36`, so
// the ring radius is ~1.33*r. A naive `2*r` blit makes the full figure overshoot
// the ring (the horse's hindquarters and hooves spill past the gold circle), so
// the figure is blitted at `1.55*r` and nudged up a hair: at that size the whole
// horse+rider+banner sits inside the ring with a small margin (max figure radius
// ~0.85 of the ring radius).
const HORSEMAN_BLIT_SCALE = 1.55; // sprite square side relative to r
const HORSEMAN_VERT_OFFSET = 0.04; // upward shift of the figure center, fraction of r
// Procedural player-color banner (swallow-tail) in the upper-right of the
// figure. Drawn on top of the rasterized sprite, whose own pennant is a muted
// parchment-neutral in the static bitmap; these coordinates cover that area and
// carry the dynamic owner color + hero letter instead. Kept inside the selection
// ring: the far top-right corner sits at radius ~1.1*r (~0.83 of the ring radius)
// so the flag clears the gold circle with a margin.
const BANNER_POLE_X = 0.18; // banner pole / left edge, right of center
const BANNER_RIGHT_X = 0.74; // banner outer (right) edge
const BANNER_TOP_Y = 0.82; // banner top edge above center (covers the sprite pennant)
const BANNER_BOTTOM_Y = 0.46; // banner bottom edge above center
const BANNER_TAIL_NOTCH = 0.12; // swallow-tail inset depth on the right edge
const BANNER_STROKE = 0.06; // banner outline width
const BANNER_LETTER_SIZE = 0.34; // hero-letter font size
// the swallow-tail eats into the right edge, so the banner's visual mass sits
// left of its bounding-box midpoint; bias the letter left by half the tail
// notch to center it on the cloth rather than the box
const BANNER_LETTER_TAIL_BIAS = 0.5; // fraction of the tail notch, toward the pole

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

    // emblem (shared bitmap) or initials fallback, framed inside the disc
    const emblem = this.atlas.get(`creature/${id}`);
    if (emblem) {
      const side = r * EMBLEM_SCALE;
      const ey = cy - r * EMBLEM_VERT_OFFSET;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r * EMBLEM_CLIP_RADIUS, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(emblem, cx - side / 2, ey - side / 2, side, side);
      ctx.restore();
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

  // 1-3 diamond pips along the lower arc, colored by metal (bronze/silver/gold)
  // so tier reads at a glance without seven pips crowding the rim
  private drawTierPips(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    tier: number,
  ): void {
    const { color, count } = tierPipSpec(tier);
    const half = r * PIP_HALF;
    const gap = r * PIP_GAP;
    const py = cy + r * PIP_ARC_Y;
    const startX = cx - (gap * (count - 1)) / 2;
    ctx.fillStyle = color;
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
    const span = shoulder - top;
    ctx.beginPath();
    ctx.moveTo(cx - hw, top);
    ctx.lineTo(cx, top + span * NOTCH_TOP_DIP);
    ctx.lineTo(cx + hw, top);
    ctx.lineTo(cx + hw, tip);
    ctx.lineTo(cx + hw * NOTCH_SHOULDER_INSET, shoulder);
    ctx.lineTo(cx, tip + span * NOTCH_TIP_DIP);
    ctx.lineTo(cx - hw * NOTCH_SHOULDER_INSET, shoulder);
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
    const fy = cy - r * HORSEMAN_VERT_OFFSET;
    ctx.drawImage(horseman, cx - side / 2, fy - side / 2, side, side);
    this.drawHeroBanner(ctx, cx, fy, r, color, initial);
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
    ctx.fillText(initial, (left + right) / 2 - notch * BANNER_LETTER_TAIL_BIAS, midY);
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
