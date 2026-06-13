import { describe, expect, it } from 'vitest';
import type { RoadConnections } from './painter';
import {
  FOG_DIMMED_COLOR,
  FOG_SHROUD_COLOR,
  SEAL_GILT,
  SEAL_PARCHMENT,
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

describe('SpritePainter.creatureToken', () => {
  const RED = '#c53030';
  const GREY = '#718096';

  it('blits the emblem bitmap when creature/<id> exists, with seal furniture', () => {
    const emblem = stubBitmap(64);
    const cx = 100;
    const cy = 80;
    const r = 20;
    const { painter, atlas, fallback, stub, ctx } = setup({ 'creature/gold_dragon': emblem });
    painter.creatureToken(ctx, cx, cy, r, RED, 'gold_dragon', 'GD', 3);
    expect(atlas.lookups).toContain('creature/gold_dragon');
    // emblem drawn (and only the emblem bitmap — no other drawImage)
    const draws = stub.ops.filter((o) => o.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0]?.image).toBe(emblem);
    // the emblem is a square (side 1.34r), nudged up by 0.2r so the figure's
    // mass sits in the disc's upper-middle and the feet clear pips + notch
    const side = r * 1.34;
    const ey = cy - r * 0.2;
    const left = cx - side / 2;
    const top = ey - side / 2;
    expect(draws[0]?.args).toEqual([left, top, side, side]);
    // the emblem destination box stays inside the disc bounds [cx±r, cy±r]
    expect(left).toBeGreaterThanOrEqual(cx - r);
    expect(left + side).toBeLessThanOrEqual(cx + r);
    expect(top).toBeGreaterThanOrEqual(cy - r);
    expect(top + side).toBeLessThanOrEqual(cy + r);
    // the emblem blit is wrapped in a circular clip just inside the ink ring,
    // so nothing can poke past the seal frame: save → arc(clip radius) → clip
    // → drawImage → restore, in that order
    const emblemAt = stub.ops.findIndex((o) => o.op === 'drawImage');
    const clipAt = stub.ops.findIndex((o) => o.op === 'clip');
    const saveBeforeClip = stub.ops
      .slice(0, clipAt)
      .map((o) => o.op)
      .lastIndexOf('save');
    expect(saveBeforeClip).toBeGreaterThanOrEqual(0);
    expect(clipAt).toBeGreaterThan(0);
    expect(clipAt).toBeLessThan(emblemAt);
    // the op just before clip is the clip-circle arc, just inside the ink ring
    expect(stub.ops[clipAt - 1]?.op).toBe('arc');
    expect(stub.ops[clipAt - 1]?.args).toEqual([cx, cy, r * 0.92, 0, Math.PI * 2]);
    // the clip is released after the emblem is drawn
    expect(stub.ops.slice(emblemAt).some((o) => o.op === 'restore')).toBe(true);
    // parchment disc filled
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === SEAL_PARCHMENT)).toBe(true);
    // no initials text on the emblem path
    expect(stub.ops.some((o) => o.op === 'fillText')).toBe(false);
    // 3 gilt diamond pips: 3 fills with the gilt color
    expect(stub.ops.filter((o) => o.op === 'fill' && o.fillStyle === SEAL_GILT)).toHaveLength(3);
    // banner notch filled with the owner color
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === RED)).toBe(true);
    // furniture is procedural, never delegated to the fallback
    expect(fallback.calls).toEqual([]);
  });

  it('falls back to centered initials when the emblem bitmap is missing', () => {
    const { painter, atlas, fallback, stub, ctx } = setup({});
    painter.creatureToken(ctx, 50, 50, 16, GREY, 'imp', 'Im', 1);
    expect(atlas.lookups).toEqual(['creature/imp']);
    // no emblem blit, initials drawn instead
    expect(stub.ops.some((o) => o.op === 'drawImage')).toBe(false);
    const text = stub.ops.find((o) => o.op === 'fillText');
    expect(text?.text).toBe('Im');
    // furniture still drawn: parchment disc + a single tier pip + neutral notch
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === SEAL_PARCHMENT)).toBe(true);
    expect(stub.ops.filter((o) => o.op === 'fill' && o.fillStyle === SEAL_GILT)).toHaveLength(1);
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === GREY)).toBe(true);
    expect(fallback.calls).toEqual([]);
  });

  it('draws one gilt pip per tier and uses the passed owner color for the notch', () => {
    const { painter, stub, ctx } = setup({});
    painter.creatureToken(ctx, 0, 0, 24, '#2b6cb0', 'archangel', 'A', 7);
    expect(stub.ops.filter((o) => o.op === 'fill' && o.fillStyle === SEAL_GILT)).toHaveLength(7);
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === '#2b6cb0')).toBe(true);
  });
});

describe('SpritePainter.heroToken', () => {
  const BLUE = '#2b6cb0';

  // the adventure renderer calls heroToken with r = tile*0.36 and draws the
  // selection ring at tile*0.48, so for a given r the ring radius is r*0.48/0.36
  const RING_RADIUS = (r: number): number => (r * 0.48) / 0.36;

  it('blits the horseman bitmap, then a banner in the owner color with the letter', () => {
    const horseman = stubBitmap(64);
    const { painter, atlas, fallback, stub, ctx } = setup({ 'hero/horseman': horseman });
    painter.heroToken(ctx, 120, 90, 18, BLUE, 'E');
    expect(atlas.lookups).toEqual(['hero/horseman']);
    // the horseman figure is blitted (and only that bitmap)
    const draws = stub.ops.filter((o) => o.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0]?.image).toBe(horseman);
    // procedural banner filled with the owner color
    expect(stub.ops.some((o) => o.op === 'fill' && o.fillStyle === BLUE)).toBe(true);
    // hero letter drawn in parchment over the banner
    const text = stub.ops.find((o) => o.op === 'fillText');
    expect(text?.text).toBe('E');
    expect(text?.fillStyle).toBe(SEAL_PARCHMENT);
    // banner is procedural, never delegated to the fallback
    expect(fallback.calls).toEqual([]);
  });

  it('keeps the horseman blit box and banner inside the selection ring with margin', () => {
    const horseman = stubBitmap(64);
    const cx = 120;
    const cy = 90;
    const r = 18;
    const { painter, stub, ctx } = setup({ 'hero/horseman': horseman });
    painter.heroToken(ctx, cx, cy, r, BLUE, 'E');
    const ring = RING_RADIUS(r);

    // the blit box [left, top, side, side]; its farthest corner from (cx,cy)
    // must clear the ring, so the full figure sits inside the gold circle
    const blit = stub.ops.find((o) => o.op === 'drawImage');
    if (!blit) throw new Error('no horseman blit');
    const [left, top, side] = blit.args as [number, number, number];
    const cornerDx = Math.max(cx - left, left + side - cx);
    const cornerDy = Math.max(cy - top, top + side - cy);
    expect(Math.hypot(cornerDx, cornerDy)).toBeLessThan(ring);

    // the procedural banner (every lineTo/moveTo vertex) also stays inside the
    // ring — its swallow-tail flag reaches toward the upper-right but clears it
    const verts = stub.ops.filter((o) => o.op === 'moveTo' || o.op === 'lineTo');
    expect(verts.length).toBeGreaterThan(0);
    for (const v of verts) {
      const [x, y] = v.args as [number, number];
      expect(Math.hypot(x - cx, y - cy)).toBeLessThan(ring);
    }
  });

  it('falls back to the wrapped shield when the horseman bitmap is missing', () => {
    const { painter, atlas, fallback, stub, ctx } = setup({});
    painter.heroToken(ctx, 10, 20, 16, BLUE, 'A');
    expect(atlas.lookups).toEqual(['hero/horseman']);
    // nothing drawn on the stub; the wrapped painter draws the shield instead
    expect(stub.ops.some((o) => o.op === 'drawImage')).toBe(false);
    expect(fallback.calls).toEqual([{ method: 'heroToken', args: [10, 20, 16, BLUE, 'A'] }]);
  });
});

describe('SpritePainter delegation', () => {
  it('forwards the remaining token/overlay methods to the wrapped painter', () => {
    const { painter, fallback, ctx } = setup({});
    painter.heroToken(ctx, 4, 5, 6, '#abc', 'E');
    painter.townToken(ctx, 7, 8, 9, '#def');
    painter.objectToken(ctx, 1, 1, 2, '#123', 'SM');
    painter.flag(ctx, 0, 0, 48, '#c53030');
    painter.selectionRing(ctx, 3, 3, 20);
    painter.pathDot(ctx, 2, 2, 5);
    painter.dayMarker(ctx, 9, 9, 12, 3);
    expect(fallback.calls.map((c) => c.method)).toEqual([
      'heroToken',
      'townToken',
      'objectToken',
      'flag',
      'selectionRing',
      'pathDot',
      'dayMarker',
    ]);
    expect(fallback.calls[0]?.args).toEqual([4, 5, 6, '#abc', 'E']);
    expect(fallback.calls[6]?.args).toEqual([9, 9, 12, 3]);
  });
});
