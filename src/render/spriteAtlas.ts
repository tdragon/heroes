// Sprite atlas: rasterizes id-keyed SVG sources once per zoom bucket and
// serves bitmaps synchronously. A `null` result means "not (yet) available" —
// the painter falls back to flat-color drawing, so the render path never waits.

export type Rasterize = (svg: string, px: number) => Promise<CanvasImageSource>;

// Zoom buckets in CSS px, ascending. Lookup picks the smallest bucket >= the
// requested size, else the largest (live tile size 48 -> the 64 bucket).
export const ATLAS_BUCKETS: readonly number[] = [32, 64];
export const MAX_DPR = 2;

function bucketFor(sizePx: number): number {
  let largest = 0;
  for (const bucket of ATLAS_BUCKETS) {
    if (bucket >= sizePx) return bucket;
    if (bucket > largest) largest = bucket;
  }
  return largest;
}

function slotOf(key: string, bucket: number): string {
  return `${key}@${String(bucket)}`;
}

function effectiveDpr(): number {
  // node (vitest) has no devicePixelRatio (the DOM lib types it as a plain
  // `number`); Number.isFinite also rejects NaN from exotic embedders
  const dpr = Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1;
  return Math.min(dpr, MAX_DPR);
}

export class SpriteAtlas {
  /** Resolves once every key x bucket finished rasterizing (failures included). */
  readonly ready: Promise<void>;

  private readonly sources: Record<string, string>;
  private readonly rasterize: Rasterize;
  private readonly bitmaps = new Map<string, CanvasImageSource>();
  private readonly resolveReady: () => void;
  private started = false;
  private warned = false;

  constructor(sources: Record<string, string>, rasterize: Rasterize) {
    this.sources = sources;
    this.rasterize = rasterize;
    let resolveReady: () => void = () => undefined;
    this.ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    this.resolveReady = resolveReady;
  }

  /** Kicks off rasterization for all keys x buckets; idempotent. */
  load(): Promise<void> {
    if (!this.started) {
      this.started = true;
      const dpr = effectiveDpr();
      const jobs: Promise<void>[] = [];
      for (const [key, svg] of Object.entries(this.sources)) {
        for (const bucket of ATLAS_BUCKETS) {
          jobs.push(this.fill(key, svg, bucket, dpr));
        }
      }
      void Promise.all(jobs).then(() => {
        this.resolveReady();
      });
    }
    return this.ready;
  }

  /** Sync lookup; `null` for unknown keys, pending loads, and failed sprites. */
  get(key: string, sizePx: number): CanvasImageSource | null {
    return this.bitmaps.get(slotOf(key, bucketFor(sizePx))) ?? null;
  }

  private async fill(key: string, svg: string, bucket: number, dpr: number): Promise<void> {
    try {
      const image = await this.rasterize(svg, Math.round(bucket * dpr));
      this.bitmaps.set(slotOf(key, bucket), image);
    } catch (error) {
      // permanent miss: get() keeps returning null and the painter falls back
      if (!this.warned) {
        this.warned = true;
        console.warn(`sprite rasterization failed (first: ${slotOf(key, bucket)})`, error);
      }
    }
  }
}

// The theme SVGs carry only a viewBox; give the root explicit pixel dimensions
// so the browser decodes the Image at the target raster size (and Firefox's
// createImageBitmap, which rejects intrinsically unsized SVGs, is satisfied).
export function withRasterSize(svg: string, px: number): string {
  return svg.replace(/<svg(\s)/, `<svg width="${String(px)}" height="${String(px)}"$1`);
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
    // older browsers (e.g. Safari < 15) lack createImageBitmap
    if (typeof globalThis.createImageBitmap === 'function') {
      return await globalThis.createImageBitmap(image);
    }
    return drawToCanvas(image, px);
  } finally {
    URL.revokeObjectURL(url);
  }
};
