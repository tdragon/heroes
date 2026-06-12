import { describe, expect, it } from 'vitest';
import type { Painter, TerrainStyle } from './painter';
import {
  FOG_DIMMED_COLOR,
  FOG_SHROUD_COLOR,
  SPRITE_MIN_TILE_PX,
  SpritePainter,
  type SpriteLookup,
} from './spritePainter';

interface CtxOp {
  op: 'fillRect' | 'drawImage';
  fillStyle: string;
  args: number[];
  image?: CanvasImageSource;
}

// node has no CanvasRenderingContext2D; record the only members the painter
// touches and widen the stub for the call (test-only seam)
class RecordingContext {
  fillStyle = '';
  readonly ops: CtxOp[] = [];

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', fillStyle: this.fillStyle, args: [x, y, w, h] });
  }

  drawImage(image: CanvasImageSource, x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'drawImage', fillStyle: this.fillStyle, args: [x, y, w, h], image });
  }
}

function asCtx(stub: RecordingContext): CanvasRenderingContext2D {
  return stub as unknown as CanvasRenderingContext2D;
}

function stubBitmap(px: number): ImageBitmap {
  return { width: px, height: px, close: () => undefined };
}

function fakeAtlas(sprites: Record<string, CanvasImageSource>): SpriteLookup {
  return { get: (key) => sprites[key] ?? null };
}

class RecordingPainter implements Painter {
  readonly calls: { method: string; args: unknown[] }[] = [];

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  terrain(
    _ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrain: TerrainStyle,
  ): void {
    this.record('terrain', [x, y, size, terrain]);
  }

  road(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number, roadId: string): void {
    this.record('road', [x, y, size, roadId]);
  }

  creatureToken(
    _ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initials: string,
    tier: number,
  ): void {
    this.record('creatureToken', [cx, cy, r, color, initials, tier]);
  }

  heroToken(
    _ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    initial: string,
  ): void {
    this.record('heroToken', [cx, cy, r, color, initial]);
  }

  townToken(
    _ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
  ): void {
    this.record('townToken', [cx, cy, r, color]);
  }

  objectToken(
    _ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    label: string,
  ): void {
    this.record('objectToken', [cx, cy, r, color, label]);
  }

  flag(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
    this.record('flag', [x, y, size, color]);
  }

  shroud(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.record('shroud', [x, y, size]);
  }

  dimmed(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.record('dimmed', [x, y, size]);
  }

  selectionRing(_ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    this.record('selectionRing', [cx, cy, r]);
  }

  pathDot(_ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    this.record('pathDot', [cx, cy, r]);
  }

  dayMarker(_ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, day: number): void {
    this.record('dayMarker', [cx, cy, r, day]);
  }
}

const GRASS: TerrainStyle = { id: 'grass', color: '#4a7c2f' };

function setup(sprites: Record<string, CanvasImageSource>): {
  painter: SpritePainter;
  fallback: RecordingPainter;
  stub: RecordingContext;
  ctx: CanvasRenderingContext2D;
} {
  const fallback = new RecordingPainter();
  const painter = new SpritePainter(fakeAtlas(sprites), fallback);
  const stub = new RecordingContext();
  return { painter, fallback, stub, ctx: asCtx(stub) };
}

describe('SpritePainter.terrain', () => {
  it('draws the terrain sprite when the bitmap exists and size >= threshold', () => {
    const bitmap = stubBitmap(64);
    const { painter, fallback, stub, ctx } = setup({ 'terrain/grass': bitmap });
    painter.terrain(ctx, 96, 48, 48, GRASS);
    expect(stub.ops).toEqual([
      { op: 'drawImage', fillStyle: '', args: [96, 48, 48, 48], image: bitmap },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('falls back to flat color when the sprite is missing (pre-load / unknown id)', () => {
    const { painter, fallback, stub, ctx } = setup({});
    painter.terrain(ctx, 0, 0, 48, GRASS);
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([{ method: 'terrain', args: [0, 0, 48, GRASS] }]);
  });

  it('falls back below the minimap size threshold even when the sprite exists', () => {
    const { painter, fallback, stub, ctx } = setup({ 'terrain/grass': stubBitmap(64) });
    painter.terrain(ctx, 0, 0, SPRITE_MIN_TILE_PX - 1, GRASS);
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([
      { method: 'terrain', args: [0, 0, SPRITE_MIN_TILE_PX - 1, GRASS] },
    ]);
  });

  it('uses the sprite exactly at the size threshold', () => {
    const { painter, fallback, stub, ctx } = setup({ 'terrain/grass': stubBitmap(32) });
    painter.terrain(ctx, 0, 0, SPRITE_MIN_TILE_PX, GRASS);
    expect(stub.ops).toHaveLength(1);
    expect(fallback.calls).toEqual([]);
  });
});

describe('SpritePainter.road', () => {
  it('draws the road sprite when available', () => {
    const bitmap = stubBitmap(64);
    const { painter, fallback, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 48, 0, 48, 'dirt_road');
    expect(stub.ops).toEqual([
      { op: 'drawImage', fillStyle: '', args: [48, 0, 48, 48], image: bitmap },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('delegates to the fallback for unknown road ids', () => {
    const { painter, fallback, stub, ctx } = setup({ 'road/dirt_road': stubBitmap(64) });
    painter.road(ctx, 0, 0, 48, 'lost_road');
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([{ method: 'road', args: [0, 0, 48, 'lost_road'] }]);
  });

  it('delegates below the size threshold', () => {
    const { painter, fallback, stub, ctx } = setup({ 'road/dirt_road': stubBitmap(64) });
    painter.road(ctx, 0, 0, 8, 'dirt_road');
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([{ method: 'road', args: [0, 0, 8, 'dirt_road'] }]);
  });
});

describe('SpritePainter fog', () => {
  it('fills the shroud with the Night palette color', () => {
    const { painter, fallback, stub, ctx } = setup({});
    painter.shroud(ctx, 10, 20, 48);
    expect(stub.ops).toEqual([
      { op: 'fillRect', fillStyle: FOG_SHROUD_COLOR, args: [10, 20, 48, 48] },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('fills dimmed tiles with the warm dark overlay', () => {
    const { painter, fallback, stub, ctx } = setup({});
    painter.dimmed(ctx, 0, 0, 48);
    expect(stub.ops).toEqual([{ op: 'fillRect', fillStyle: FOG_DIMMED_COLOR, args: [0, 0, 48, 48] }]);
    expect(fallback.calls).toEqual([]);
  });
});

describe('SpritePainter delegation', () => {
  it('forwards every token/overlay method to the wrapped painter', () => {
    const { painter, fallback, ctx } = setup({});
    painter.creatureToken(ctx, 1, 2, 3, '#fff', 'Pi', 2);
    painter.heroToken(ctx, 4, 5, 6, '#abc', 'E');
    painter.townToken(ctx, 7, 8, 9, '#def');
    painter.objectToken(ctx, 1, 1, 2, '#123', 'SM');
    painter.flag(ctx, 0, 0, 48, '#c53030');
    painter.selectionRing(ctx, 3, 3, 20);
    painter.pathDot(ctx, 2, 2, 5);
    painter.dayMarker(ctx, 9, 9, 12, 3);
    expect(fallback.calls.map((c) => c.method)).toEqual([
      'creatureToken',
      'heroToken',
      'townToken',
      'objectToken',
      'flag',
      'selectionRing',
      'pathDot',
      'dayMarker',
    ]);
    expect(fallback.calls[0]?.args).toEqual([1, 2, 3, '#fff', 'Pi', 2]);
    expect(fallback.calls[7]?.args).toEqual([9, 9, 12, 3]);
  });
});
