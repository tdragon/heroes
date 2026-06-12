import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpriteAtlas, withRasterSize, type Rasterize } from './spriteAtlas';

interface RasterCall {
  svg: string;
  px: number;
  bitmap: ImageBitmap;
}

// node has no real CanvasImageSource; a plain object structurally satisfies
// ImageBitmap, so no casts are needed
function stubBitmap(px: number): ImageBitmap {
  return { width: px, height: px, close: () => undefined };
}

function fakeRasterizer(failFor: (svg: string) => boolean = () => false): {
  rasterize: Rasterize;
  calls: RasterCall[];
} {
  const calls: RasterCall[] = [];
  const rasterize: Rasterize = (svg, px) => {
    if (failFor(svg)) return Promise.reject(new Error(`boom: ${svg}`));
    const bitmap = stubBitmap(px);
    calls.push({ svg, px, bitmap });
    return Promise.resolve(bitmap);
  };
  return { rasterize, calls };
}

function bitmapFor(calls: RasterCall[], svg: string, px: number): ImageBitmap {
  const call = calls.find((c) => c.svg === svg && c.px === px);
  if (!call) throw new Error(`no rasterize call for ${svg}@${String(px)}`);
  return call.bitmap;
}

const SOURCES = { 'terrain/grass': '<svg>g</svg>', 'road/dirt_road': '<svg>r</svg>' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpriteAtlas.get', () => {
  it('returns null before load() starts', () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    expect(atlas.get('terrain/grass', 48)).toBeNull();
  });

  it('returns null for unknown keys after load', async () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.get('terrain/unknown', 48)).toBeNull();
    expect(atlas.get('creature/grass', 48)).toBeNull();
  });

  it('picks the exact bucket when the size matches', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.get('terrain/grass', 32)).toBe(bitmapFor(calls, '<svg>g</svg>', 32));
    expect(atlas.get('terrain/grass', 64)).toBe(bitmapFor(calls, '<svg>g</svg>', 64));
  });

  it('picks the smallest bucket >= the requested size', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.get('terrain/grass', 20)).toBe(bitmapFor(calls, '<svg>g</svg>', 32));
    expect(atlas.get('road/dirt_road', 48)).toBe(bitmapFor(calls, '<svg>r</svg>', 64));
  });

  it('falls back to the largest bucket above the max', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.get('terrain/grass', 100)).toBe(bitmapFor(calls, '<svg>g</svg>', 64));
  });
});

describe('SpriteAtlas.load', () => {
  it('rasterizes each key exactly once per bucket', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(calls).toHaveLength(4); // 2 keys x 2 buckets
    const pxByKey = new Map<string, number[]>();
    for (const { svg, px } of calls) {
      pxByKey.set(svg, [...(pxByKey.get(svg) ?? []), px].sort((a, b) => a - b));
    }
    expect(pxByKey.get('<svg>g</svg>')).toEqual([32, 64]);
    expect(pxByKey.get('<svg>r</svg>')).toEqual([32, 64]);
  });

  it('is idempotent: a second load() reuses the same work and promise', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    const first = atlas.load();
    const second = atlas.load();
    expect(second).toBe(first);
    await first;
    await atlas.load();
    expect(calls).toHaveLength(4);
  });

  it('scales rasterization by devicePixelRatio, capped at 2', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas({ 'terrain/grass': '<svg>g</svg>' }, rasterize);
    await atlas.load();
    expect(calls.map((c) => c.px).sort((a, b) => a - b)).toEqual([64, 128]);
    // lookup still uses CSS px buckets
    expect(atlas.get('terrain/grass', 48)).toBe(bitmapFor(calls, '<svg>g</svg>', 128));
  });

  it('uses fractional dpr below the cap', async () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas({ 'terrain/grass': '<svg>g</svg>' }, rasterize);
    await atlas.load();
    expect(calls.map((c) => c.px).sort((a, b) => a - b)).toEqual([48, 96]);
  });
});

describe('SpriteAtlas.ready and failures', () => {
  it('ready resolves after load completes', async () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    void atlas.load();
    await expect(atlas.ready).resolves.toBeUndefined();
    expect(atlas.get('terrain/grass', 48)).not.toBeNull();
  });

  it('failed rasterizations resolve ready, warn once, and stay null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rasterize } = fakeRasterizer((svg) => svg.includes('>g<'));
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    await expect(atlas.ready).resolves.toBeUndefined();
    // both buckets of terrain/grass failed -> still a single warning
    expect(warn).toHaveBeenCalledTimes(1);
    expect(atlas.get('terrain/grass', 32)).toBeNull();
    expect(atlas.get('terrain/grass', 64)).toBeNull();
    expect(atlas.get('road/dirt_road', 64)).not.toBeNull();
  });
});

describe('withRasterSize', () => {
  it('injects explicit width/height into the svg root', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect/></svg>';
    expect(withRasterSize(svg, 96)).toBe(
      '<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect/></svg>',
    );
  });

  it('only touches the root svg tag, not nested content', () => {
    const svg = '<svg viewBox="0 0 64 64"><svg viewBox="0 0 8 8"/></svg>';
    const sized = withRasterSize(svg, 32);
    expect(sized.startsWith('<svg width="32" height="32" viewBox="0 0 64 64">')).toBe(true);
    expect(sized).toContain('<svg viewBox="0 0 8 8"/>');
  });
});
