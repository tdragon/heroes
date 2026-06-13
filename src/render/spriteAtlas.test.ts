import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RASTER_PX,
  SpriteAtlas,
  rasterizeSvg,
  withRasterSize,
  type Rasterize,
} from './spriteAtlas';
import { stubBitmap } from './testSupport';

interface RasterCall {
  svg: string;
  px: number;
  bitmap: ImageBitmap;
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

const SOURCES = { 'terrain/grass': '<svg>g</svg>', 'road/dirt_road': '<svg>r</svg>' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpriteAtlas.get', () => {
  it('returns null before load() starts', () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    expect(atlas.get('terrain/grass')).toBeNull();
  });

  it('returns null for unknown keys after load', async () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.get('terrain/unknown')).toBeNull();
    expect(atlas.get('creature/grass')).toBeNull();
  });

  it('serves the bitmap rasterized for each key', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    const grass = calls.find((c) => c.svg === '<svg>g</svg>');
    const road = calls.find((c) => c.svg === '<svg>r</svg>');
    expect(atlas.get('terrain/grass')).toBe(grass?.bitmap);
    expect(atlas.get('road/dirt_road')).toBe(road?.bitmap);
  });
});

describe('SpriteAtlas.load', () => {
  it('rasterizes each key exactly once at RASTER_PX', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(calls.map((c) => c.svg).sort()).toEqual(['<svg>g</svg>', '<svg>r</svg>']);
    expect(calls.every((c) => c.px === RASTER_PX)).toBe(true);
  });

  it('is idempotent: repeated load() triggers no extra rasterization work', async () => {
    const { rasterize, calls } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(calls).toHaveLength(2);
    await atlas.load();
    expect(calls).toHaveLength(2);
  });

  it('memoizes the promise for concurrent load() calls', () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    const first = atlas.load();
    expect(atlas.load()).toBe(first);
  });
});

describe('SpriteAtlas failures', () => {
  it('a failed sprite warns with its key, counts the failure, and stays null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rasterize } = fakeRasterizer((svg) => svg.includes('>g<'));
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load(); // resolves despite the failure
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('terrain/grass');
    expect(atlas.failureCount).toBe(1);
    expect(atlas.get('terrain/grass')).toBeNull();
    expect(atlas.get('road/dirt_road')).not.toBeNull();
  });

  it('names every failing sprite in its own warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rasterize } = fakeRasterizer(() => true);
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.failureCount).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('terrain/grass'))).toBe(true);
    expect(messages.some((m) => m.includes('road/dirt_road'))).toBe(true);
  });

  it('reports zero failures when everything rasterizes', async () => {
    const { rasterize } = fakeRasterizer();
    const atlas = new SpriteAtlas(SOURCES, rasterize);
    await atlas.load();
    expect(atlas.failureCount).toBe(0);
  });
});

describe('withRasterSize', () => {
  it('injects explicit width/height into the svg root', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect/></svg>';
    expect(withRasterSize(svg, 96)).toBe(
      '<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect/></svg>',
    );
  });

  it('handles a root svg tag without attributes', () => {
    expect(withRasterSize('<svg><rect/></svg>', 64)).toBe(
      '<svg width="64" height="64"><rect/></svg>',
    );
  });

  it('replaces pre-existing root width/height instead of duplicating them', () => {
    const svg = '<svg width="10" height="10" viewBox="0 0 64 64"><rect/></svg>';
    expect(withRasterSize(svg, 96)).toBe(
      '<svg width="96" height="96" viewBox="0 0 64 64"><rect/></svg>',
    );
  });

  it('only touches the root svg tag, not nested content', () => {
    const svg = '<svg viewBox="0 0 64 64"><svg viewBox="0 0 8 8"/></svg>';
    const sized = withRasterSize(svg, 32);
    expect(sized.startsWith('<svg width="32" height="32" viewBox="0 0 64 64">')).toBe(true);
    expect(sized).toContain('<svg viewBox="0 0 8 8"/>');
  });
});

// --- production rasterizer (browser globals stubbed for node) ---

const SAMPLE_SVG = '<svg viewBox="0 0 64 64"><rect/></svg>';

interface RasterEnv {
  created: Blob[];
  revoked: string[];
}

function stubRasterEnv(options: { imageDecodes?: boolean } = {}): RasterEnv {
  const decodes = options.imageDecodes ?? true;
  const created: Blob[] = [];
  const revoked: string[] = [];
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_url: string) {
      queueMicrotask(() => {
        if (decodes) this.onload?.();
        else this.onerror?.();
      });
    }
  }
  vi.stubGlobal('Image', StubImage);
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob): string => {
      created.push(blob);
      return `blob:stub-${String(created.length)}`;
    },
    revokeObjectURL: (url: string): void => {
      revoked.push(url);
    },
  });
  return { created, revoked };
}

describe('rasterizeSvg', () => {
  it('returns an ImageBitmap when createImageBitmap is available and revokes the blob URL', async () => {
    const env = stubRasterEnv();
    const bitmap = stubBitmap(RASTER_PX);
    const create = vi.fn(() => Promise.resolve(bitmap));
    vi.stubGlobal('createImageBitmap', create);

    const result = await rasterizeSvg(SAMPLE_SVG, 64);
    expect(result).toBe(bitmap);
    expect(create).toHaveBeenCalledTimes(1);
    expect(env.revoked).toEqual(['blob:stub-1']);
    // the blob handed to the browser carries the explicit raster size
    expect(await env.created[0]?.text()).toContain('<svg width="64" height="64"');
  });

  it('falls back to canvas drawing when createImageBitmap is missing', async () => {
    const env = stubRasterEnv();
    vi.stubGlobal('createImageBitmap', undefined);
    const drawCalls: unknown[][] = [];
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]): void => {
          drawCalls.push(args);
        },
      }),
    };
    vi.stubGlobal('document', { createElement: () => fakeCanvas });

    const result = await rasterizeSvg(SAMPLE_SVG, 48);
    expect(result).toBe(fakeCanvas);
    expect(fakeCanvas.width).toBe(48);
    expect(fakeCanvas.height).toBe(48);
    expect(drawCalls).toHaveLength(1);
    expect(drawCalls[0]?.slice(1)).toEqual([0, 0, 48, 48]);
    expect(env.revoked).toHaveLength(1);
  });

  it('falls back to canvas drawing when createImageBitmap rejects', async () => {
    const env = stubRasterEnv();
    const create = vi.fn(() => Promise.reject(new Error('SVG sources unsupported')));
    vi.stubGlobal('createImageBitmap', create);
    const drawCalls: unknown[][] = [];
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]): void => {
          drawCalls.push(args);
        },
      }),
    };
    vi.stubGlobal('document', { createElement: () => fakeCanvas });

    const result = await rasterizeSvg(SAMPLE_SVG, 48);
    expect(result).toBe(fakeCanvas);
    expect(create).toHaveBeenCalledTimes(1);
    expect(drawCalls).toHaveLength(1);
    expect(env.revoked).toHaveLength(1);
  });

  it('rejects when the 2d context is unavailable, still revoking the URL', async () => {
    const env = stubRasterEnv();
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });

    await expect(rasterizeSvg(SAMPLE_SVG, 48)).rejects.toThrow('2d context unavailable');
    expect(env.revoked).toHaveLength(1);
  });

  it('rejects when the image fails to decode, still revoking the URL', async () => {
    const env = stubRasterEnv({ imageDecodes: false });

    await expect(rasterizeSvg(SAMPLE_SVG, 48)).rejects.toThrow('failed to decode');
    expect(env.revoked).toHaveLength(1);
  });
});
