// Shared test doubles for the render unit tests. Imported only by *.test.ts
// files; never ships in the production bundle.
import type { Painter, RoadConnections } from './painter';

// node has no real CanvasImageSource; a plain object structurally satisfies
// ImageBitmap, so no casts are needed
export function stubBitmap(px: number): ImageBitmap {
  return { width: px, height: px, close: () => undefined };
}

export interface CtxOp {
  op:
    | 'fillRect'
    | 'strokeRect'
    | 'drawImage'
    | 'save'
    | 'restore'
    | 'translate'
    | 'rotate'
    | 'setTransform'
    | 'beginPath'
    | 'closePath'
    | 'moveTo'
    | 'lineTo'
    | 'arc'
    | 'fill'
    | 'stroke'
    | 'fillText';
  fillStyle: string;
  args: number[];
  image?: CanvasImageSource;
  strokeStyle?: string;
  text?: string;
  font?: string;
}

// node has no CanvasRenderingContext2D; record the only members the painters
// and renderers touch and widen the stub for the call (test-only seam)
export class RecordingContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = '';
  textBaseline = '';
  readonly canvas = { width: 0, height: 0 };
  readonly ops: CtxOp[] = [];

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ops.push({ op: 'setTransform', fillStyle: this.fillStyle, args: [a, b, c, d, e, f] });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', fillStyle: this.fillStyle, args: [x, y, w, h] });
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({
      op: 'strokeRect',
      fillStyle: this.fillStyle,
      args: [x, y, w, h],
      strokeStyle: this.strokeStyle,
    });
  }

  // both the 5-arg and the 9-arg (source-cropping) overloads
  drawImage(image: CanvasImageSource, ...args: number[]): void {
    this.ops.push({ op: 'drawImage', fillStyle: this.fillStyle, args, image });
  }

  save(): void {
    this.ops.push({ op: 'save', fillStyle: this.fillStyle, args: [] });
  }

  restore(): void {
    this.ops.push({ op: 'restore', fillStyle: this.fillStyle, args: [] });
  }

  translate(x: number, y: number): void {
    this.ops.push({ op: 'translate', fillStyle: this.fillStyle, args: [x, y] });
  }

  rotate(angle: number): void {
    this.ops.push({ op: 'rotate', fillStyle: this.fillStyle, args: [angle] });
  }

  beginPath(): void {
    this.ops.push({ op: 'beginPath', fillStyle: this.fillStyle, args: [] });
  }

  closePath(): void {
    this.ops.push({ op: 'closePath', fillStyle: this.fillStyle, args: [] });
  }

  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', fillStyle: this.fillStyle, args: [x, y] });
  }

  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', fillStyle: this.fillStyle, args: [x, y] });
  }

  arc(cx: number, cy: number, r: number, start: number, end: number): void {
    this.ops.push({ op: 'arc', fillStyle: this.fillStyle, args: [cx, cy, r, start, end] });
  }

  fill(): void {
    this.ops.push({ op: 'fill', fillStyle: this.fillStyle, args: [] });
  }

  stroke(): void {
    this.ops.push({ op: 'stroke', fillStyle: this.fillStyle, args: [], strokeStyle: this.strokeStyle });
  }

  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', fillStyle: this.fillStyle, args: [x, y], text, font: this.font });
  }
}

export function asCtx(stub: RecordingContext): CanvasRenderingContext2D {
  return stub as unknown as CanvasRenderingContext2D;
}

export interface PainterCall {
  method: string;
  args: unknown[];
}

export interface TerrainCall {
  x: number;
  y: number;
  size: number;
  terrainId: string;
  color: string;
}

export interface RoadCall {
  x: number;
  y: number;
  size: number;
  roadId: string;
  connections: RoadConnections;
}

export interface TileCall {
  x: number;
  y: number;
  size: number;
}

export interface SequenceEntry {
  method: 'terrain' | 'road';
  x: number;
  y: number;
}

// Records every Painter call (sans ctx) in order, plus typed views of the
// land-layer calls for renderer-level assertions.
export class RecordingPainter implements Painter {
  readonly calls: PainterCall[] = [];
  readonly terrainCalls: TerrainCall[] = [];
  readonly roadCalls: RoadCall[] = [];
  readonly shroudCalls: TileCall[] = [];
  readonly dimmedCalls: TileCall[] = [];
  // interleaved land-layer order, so layering (terrain under road) is pinned
  readonly sequence: SequenceEntry[] = [];

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  terrain(
    _ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    terrainId: string,
    color: string,
  ): void {
    this.record('terrain', [x, y, size, terrainId, color]);
    this.terrainCalls.push({ x, y, size, terrainId, color });
    this.sequence.push({ method: 'terrain', x, y });
  }

  road(
    _ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    roadId: string,
    connections: RoadConnections,
  ): void {
    this.record('road', [x, y, size, roadId, connections]);
    this.roadCalls.push({ x, y, size, roadId, connections });
    this.sequence.push({ method: 'road', x, y });
  }

  shroud(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.record('shroud', [x, y, size]);
    this.shroudCalls.push({ x, y, size });
  }

  dimmed(_ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    this.record('dimmed', [x, y, size]);
    this.dimmedCalls.push({ x, y, size });
  }

  creatureToken(
    _ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    color: string,
    id: string,
    initials: string,
    tier: number,
  ): void {
    this.record('creatureToken', [cx, cy, r, color, id, initials, tier]);
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
