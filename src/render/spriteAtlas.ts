// Sprite atlas: rasterizes id-keyed SVG sources once and serves bitmaps
// synchronously. A `null` result means "not (yet) available" — the painter
// falls back to flat-color drawing, so the render path never waits.

export type Rasterize = (svg: string, px: number) => Promise<CanvasImageSource>;

// Rasterization size in px — 2x the 64-unit SVG viewBox, so authored strokes
// stay pixel-aligned. The canvas backing store IS dpr-scaled and the camera
// zooms up to ZOOM_MAX=2, so a tile can be drawn as large as
// TILE_PX * dpr * 2 device px (192 at dpr 2). Rasterizing at 128 keeps
// roads/terrain crisp when zoomed in instead of upscaling a 64px bitmap ~3x
// (bump toward 192 if absolute-max-zoom on retina still reads soft).
export const RASTER_PX = 128;

export class SpriteAtlas {
  private readonly sources: Record<string, string>;
  private readonly rasterize: Rasterize;
  private readonly bitmaps = new Map<string, CanvasImageSource>();
  private loadPromise: Promise<void> | null = null;
  private failures = 0;

  constructor(sources: Record<string, string>, rasterize: Rasterize) {
    this.sources = sources;
    this.rasterize = rasterize;
  }

  /** Sprites that failed to rasterize; final once `load()` resolves. */
  get failureCount(): number {
    return this.failures;
  }

  /** Kicks off rasterization for all keys; idempotent (memoized promise). */
  load(): Promise<void> {
    this.loadPromise ??= Promise.all(
      Object.entries(this.sources).map(([key, svg]) => this.fill(key, svg)),
    ).then(() => undefined);
    return this.loadPromise;
  }

  /** Sync lookup; `null` for unknown keys, pending loads, and failed sprites. */
  get(key: string): CanvasImageSource | null {
    return this.bitmaps.get(key) ?? null;
  }

  private async fill(key: string, svg: string): Promise<void> {
    try {
      this.bitmaps.set(key, await this.rasterize(svg, RASTER_PX));
    } catch (error) {
      // permanent miss: get() keeps returning null and the painter falls back
      this.failures += 1;
      console.warn(`sprite rasterization failed: ${key}`, error);
    }
  }
}

// The theme SVGs carry only a viewBox; give the root explicit pixel dimensions
// so the browser decodes the Image at the target raster size (and Firefox's
// createImageBitmap, which rejects intrinsically unsized SVGs, is satisfied).
// Pre-existing root width/height attributes are replaced, not duplicated.
export function withRasterSize(svg: string, px: number): string {
  const open = /<svg([^>]*)>/.exec(svg);
  if (!open) return svg;
  const attrs = (open[1] ?? '').replace(/\s+(?:width|height)="[^"]*"/g, '');
  const tag = `<svg width="${String(px)}" height="${String(px)}"${attrs}>`;
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('sprite SVG failed to decode'));
    };
    image.src = url;
  });
}

function drawToCanvas(image: HTMLImageElement, px: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for sprite rasterization');
  ctx.drawImage(image, 0, 0, px, px);
  return canvas;
}

/** Production rasterizer: Blob URL + Image, ImageBitmap when available. */
export const rasterizeSvg: Rasterize = async (svg, px) => {
  const blob = new Blob([withRasterSize(svg, px)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    // older browsers (e.g. Safari < 15) lack createImageBitmap; partial
    // implementations may reject this source — the image already decoded,
    // so fall back to canvas drawing in both cases
    if (typeof globalThis.createImageBitmap === 'function') {
      try {
        return await globalThis.createImageBitmap(image);
      } catch {
        // fall through to drawToCanvas
      }
    }
    return drawToCanvas(image, px);
  } finally {
    URL.revokeObjectURL(url);
  }
};
