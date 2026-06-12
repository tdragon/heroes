import type { PlayerColor } from '../maps/schema';

export interface TerrainStyle {
  id: string;
  color: string;
}

// Placeholder token art system (§10): every entity is a simple labeled shape
// drawn in a flat color. All drawing goes through this interface so real art
// can be swapped in later without touching the renderer.
export interface Painter {
  terrain(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrain: TerrainStyle,
  ): void;
  road(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, roadId: string): void;
  creatureToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initials: string,
    tier: number,
  ): void;
  heroToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void;
  townToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void;
  objectToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    label: string,
  ): void;
  flag(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void;
  shroud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void;
  dimmed(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void;
  selectionRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void;
  pathDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void;
  dayMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, day: number): void;
}

export const PLAYER_COLOR_HEX: Record<PlayerColor, string> = {
  red: '#c53030',
  blue: '#2b6cb0',
  tan: '#b7791f',
  green: '#2f855a',
};

export const NEUTRAL_COLOR = '#718096';

export function initialsOf(name: string, max = 2): string {
  return name
    .split(/[\s-]+/)
    .filter((w) => w.length > 0)
    .slice(0, max)
    .map((w) => (w[0] ?? '').toUpperCase())
    .join('');
}

// cheap deterministic per-tile hash for the terrain noise speckles
function tileHash(x: number, y: number, i: number): number {
  let h = (x * 374761393 + y * 668265263 + i * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class TokenPainter implements Painter {
  terrain(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrain: TerrainStyle,
  ): void {
    ctx.fillStyle = terrain.color;
    ctx.fillRect(x, y, size, size);
    const tx = Math.round(x / size);
    const ty = Math.round(y / size);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    for (let i = 0; i < 3; i++) {
      const nx = x + tileHash(tx, ty, i * 2) * (size - 6);
      const ny = y + tileHash(tx, ty, i * 2 + 1) * (size - 6);
      ctx.fillRect(nx, ny, 5, 5);
    }
  }

  // declares no roadId param: the placeholder band is the same for every road
  road(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    ctx.fillStyle = 'rgba(160, 140, 110, 0.85)';
    const w = size * 0.4;
    ctx.fillRect(x + (size - w) / 2, y + (size - w) / 2, w, w);
    ctx.fillRect(x, y + (size - w * 0.6) / 2, size, w * 0.6);
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
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#1a202c';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${String(Math.round(r * 0.9))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, cx, cy);
    ctx.font = `bold ${String(Math.round(r * 0.6))}px system-ui, sans-serif`;
    ctx.fillStyle = '#fbd38d';
    ctx.fillText(String(tier), cx + r * 0.7, cy + r * 0.7);
  }

  heroToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void {
    // shield shape: flat top, pointed bottom
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy - r);
    ctx.lineTo(cx + r, cy + r * 0.3);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy + r * 0.3);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#f7fafc';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${String(Math.round(r * 1.1))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy - r * 0.05);
  }

  townToken(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
    // castle silhouette: base block with three crenellations
    const x = cx - r;
    const y = cy - r * 0.2;
    const w = r * 2;
    const h = r * 1.2;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    const tw = w / 5;
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x + tw * (i * 2), y - r * 0.5, tw, r * 0.5);
    }
    ctx.strokeStyle = '#1a202c';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  objectToken(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    label: string,
  ): void {
    const x = cx - r;
    const y = cy - r * 0.75;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, r * 2, r * 1.5, 4);
    ctx.fill();
    ctx.strokeStyle = '#1a202c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${String(Math.round(r * 0.8))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  }

  flag(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
    ctx.fillStyle = color;
    ctx.fillRect(x + size * 0.7, y + size * 0.05, size * 0.25, size * 0.18);
    ctx.fillStyle = '#1a202c';
    ctx.fillRect(x + size * 0.68, y + size * 0.05, 2, size * 0.32);
  }

  shroud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, size, size);
  }

  dimmed(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(x, y, size, size);
  }

  selectionRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ecc94b';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  pathDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(236, 201, 75, 0.9)';
    ctx.fill();
  }

  dayMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, day: number): void {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#2d3748';
    ctx.fill();
    ctx.strokeStyle = '#ecc94b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ecc94b';
    ctx.font = `bold ${String(Math.round(r))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`D${String(day)}`, cx, cy);
  }
}
