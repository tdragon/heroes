import { describe, expect, it } from 'vitest';
import type { RoadConnections } from './painter';
import {
  FOG_DIMMED_COLOR,
  FOG_SHROUD_COLOR,
  SpritePainter,
  type SpriteLookup,
} from './spritePainter';
import { asCtx, RecordingContext, RecordingPainter, stubBitmap } from './testSupport';

interface FakeAtlas extends SpriteLookup {
  /** keys requested from the atlas, in call order */
  readonly lookups: string[];
}

function fakeAtlas(sprites: Record<string, CanvasImageSource>): FakeAtlas {
  const lookups: string[] = [];
  return {
    lookups,
    get: (key) => {
      lookups.push(key);
      return sprites[key] ?? null;
    },
  };
}

const GRASS_COLOR = '#4a7c2f';

function setup(sprites: Record<string, CanvasImageSource>): {
  painter: SpritePainter;
  atlas: FakeAtlas;
  fallback: RecordingPainter;
  stub: RecordingContext;
  ctx: CanvasRenderingContext2D;
} {
  const fallback = new RecordingPainter();
  const atlas = fakeAtlas(sprites);
  const painter = new SpritePainter(atlas, fallback);
  const stub = new RecordingContext();
  return { painter, atlas, fallback, stub, ctx: asCtx(stub) };
}

describe('SpritePainter.terrain', () => {
  it('looks up the terrain key and draws the sprite when the bitmap exists', () => {
    const bitmap = stubBitmap(64);
    const { painter, atlas, fallback, stub, ctx } = setup({ 'terrain/grass': bitmap });
    painter.terrain(ctx, 96, 48, 48, 'grass', GRASS_COLOR);
    expect(atlas.lookups).toEqual(['terrain/grass']);
    expect(stub.ops).toEqual([
      { op: 'drawImage', fillStyle: '', args: [96, 48, 48, 48], image: bitmap },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('falls back to flat color when the sprite is missing (pre-load / unknown id)', () => {
    const { painter, atlas, fallback, stub, ctx } = setup({});
    painter.terrain(ctx, 0, 0, 48, 'grass', GRASS_COLOR);
    expect(atlas.lookups).toEqual(['terrain/grass']);
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([{ method: 'terrain', args: [0, 0, 48, 'grass', GRASS_COLOR] }]);
  });
});

function conn(dirs: string): RoadConnections {
  return {
    n: dirs.includes('n'),
    e: dirs.includes('e'),
    s: dirs.includes('s'),
    w: dirs.includes('w'),
  };
}

describe('SpritePainter.road', () => {
  it('draws the full band for an isolated road tile', () => {
    const bitmap = stubBitmap(64);
    const { painter, atlas, fallback, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 48, 0, 48, 'dirt_road', conn(''));
    expect(atlas.lookups).toEqual(['road/dirt_road']);
    expect(stub.ops).toEqual([
      { op: 'drawImage', fillStyle: '', args: [48, 0, 48, 48], image: bitmap },
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('draws the full band unrotated for a straight horizontal road', () => {
    const bitmap = stubBitmap(64);
    const { painter, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 0, 0, 48, 'dirt_road', conn('ew'));
    expect(stub.ops).toEqual([
      { op: 'drawImage', fillStyle: '', args: [0, 0, 48, 48], image: bitmap },
    ]);
  });

  it('draws the full band rotated 90 degrees for a straight vertical road', () => {
    const bitmap = stubBitmap(64);
    const { painter, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 48, 96, 48, 'dirt_road', conn('ns'));
    expect(stub.ops.map((o) => o.op)).toEqual([
      'save',
      'translate',
      'rotate',
      'drawImage',
      'restore',
    ]);
    expect(stub.ops[1]?.args).toEqual([72, 120]); // tile center
    expect(stub.ops[2]?.args).toEqual([Math.PI / 2]);
    // full source (no crop), centered dest
    expect(stub.ops[3]?.args).toEqual([0, 0, 64, 64, -24, -24, 48, 48]);
  });

  it('composes a corner from two rotated east-half arms with no seam patch', () => {
    const bitmap = stubBitmap(64);
    const { painter, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 0, 0, 48, 'dirt_road', conn('es'));
    const draws = stub.ops.filter((o) => o.op === 'drawImage');
    const rotations = stub.ops.filter((o) => o.op === 'rotate').map((o) => o.args[0]);
    // one arm per connected direction (E then S); the centered band makes them
    // meet cleanly at the center, so there is no seam patch
    expect(draws).toHaveLength(2);
    expect(rotations).toEqual([0, Math.PI / 2]);
    // arms crop the east half of the source band and extend center -> edge
    expect(draws[0]?.args).toEqual([32, 0, 32, 64, 0, -24, 24, 48]);
    expect(draws[1]?.args).toEqual([32, 0, 32, 64, 0, -24, 24, 48]);
    expect(stub.ops.filter((o) => o.op === 'save')).toHaveLength(2);
    expect(stub.ops.filter((o) => o.op === 'restore')).toHaveLength(2);
  });

  it('draws four arms for a crossroads with no seam patch', () => {
    const bitmap = stubBitmap(64);
    const { painter, stub, ctx } = setup({ 'road/dirt_road': bitmap });
    painter.road(ctx, 0, 0, 48, 'dirt_road', conn('nesw'));
    const draws = stub.ops.filter((o) => o.op === 'drawImage');
    expect(draws).toHaveLength(4);
    expect(stub.ops.filter((o) => o.op === 'rotate').map((o) => o.args[0])).toEqual([
      0,
      Math.PI / 2,
      Math.PI,
      -Math.PI / 2,
    ]);
  });

  it('uses the dedicated rounded end tile for a dead-end, rotated to its one connection', () => {
    const road = stubBitmap(64);
    const end = stubBitmap(64);
    const { painter, atlas, stub, ctx } = setup({
      'road/dirt_road': road,
      'roadend/dirt_road': end,
    });
    // only a southern neighbor: the end tile's open side faces south (rotate 90°)
    painter.road(ctx, 0, 0, 48, 'dirt_road', conn('s'));
    expect(atlas.lookups).toEqual(['road/dirt_road', 'roadend/dirt_road']);
    expect(stub.ops.map((o) => o.op)).toEqual([
      'save',
      'translate',
      'rotate',
      'drawImage',
      'restore',
    ]);
    expect(stub.ops[1]?.args).toEqual([24, 24]); // tile center
    expect(stub.ops[2]?.args).toEqual([Math.PI / 2]);
    // the whole end sprite is drawn (no crop), rotated and centered
    expect(stub.ops[3]?.args).toEqual([0, 0, 64, 64, -24, -24, 48, 48]);
    expect(stub.ops[3]?.image).toBe(end);
  });

  it('falls back to a single capped arm for a dead-end when no end tile exists', () => {
    const road = stubBitmap(64);
    const { painter, atlas, stub, ctx } = setup({ 'road/dirt_road': road });
    painter.road(ctx, 0, 0, 48, 'dirt_road', conn('n'));
    // it still looks for the end tile, then degrades to one north arm
    expect(atlas.lookups).toEqual(['road/dirt_road', 'roadend/dirt_road']);
    const draws = stub.ops.filter((o) => o.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(stub.ops.filter((o) => o.op === 'rotate').map((o) => o.args[0])).toEqual([-Math.PI / 2]);
    expect(draws[0]?.args).toEqual([32, 0, 32, 64, 0, -24, 24, 48]);
    expect(draws[0]?.image).toBe(road);
  });

  it('delegates to the fallback for unknown road ids, connections included', () => {
    const { painter, fallback, stub, ctx } = setup({ 'road/dirt_road': stubBitmap(64) });
    painter.road(ctx, 0, 0, 48, 'lost_road', conn('ns'));
    expect(stub.ops).toEqual([]);
    expect(fallback.calls).toEqual([{ method: 'road', args: [0, 0, 48, 'lost_road', conn('ns')] }]);
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
    expect(stub.ops).toEqual([
      { op: 'fillRect', fillStyle: FOG_DIMMED_COLOR, args: [0, 0, 48, 48] },
    ]);
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
