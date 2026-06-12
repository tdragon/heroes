// Pure pointer-gesture state machine: consumes minimal pointer snapshots and
// emits semantic actions. No DOM types; the timer is injected so tests drive
// time explicitly.

export const TAP_SLOP_PX = 8;
export const LONG_PRESS_MS = 500;

export interface GesturePointer {
  pointerId: number;
  // CSS px relative to the canvas
  x: number;
  y: number;
  pointerType: string; // 'mouse' | 'touch' | 'pen'
  button: number; // pointerdown button; -1 on moves (unused on up/cancel)
}

export type GestureAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number }
  // camera pan delta in CSS px (inverted pointer motion: drag the map)
  | { type: 'panBy'; dx: number; dy: number }
  // incremental scale relative to the previous pinch event + current midpoint
  | { type: 'pinch'; scale: number; cx: number; cy: number }
  // mouse-only pointer position, feeds edge scroll; emitted for every mouse
  // move regardless of state so the position never goes stale
  | { type: 'hover'; x: number; y: number };

// 'suppressed' = the press can no longer become a tap/pan (long-press fired,
// or a non-pannable pointer moved past slop); waits for pointerup
export type GestureState = 'idle' | 'pressed' | 'panning' | 'pinching' | 'suppressed';

// schedule(cb, ms) returns a cancel function
export type GestureSchedule = (cb: () => void, ms: number) => () => void;

interface TrackedPointer {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  pointerType: string;
  pannable: boolean;
  tappable: boolean;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export class GestureRecognizer {
  private current: GestureState = 'idle';
  private primary: TrackedPointer | null = null;
  private secondary: TrackedPointer | null = null;
  private pinchDist = 0;
  private cancelTimer: (() => void) | null = null;

  constructor(
    private readonly emit: (action: GestureAction) => void,
    private readonly schedule: GestureSchedule,
  ) {}

  get state(): GestureState {
    return this.current;
  }

  reset(): void {
    this.clearLongPress();
    this.current = 'idle';
    this.primary = null;
    this.secondary = null;
    this.pinchDist = 0;
  }

  pointerDown(p: GesturePointer): void {
    if (this.current === 'idle') {
      // right button is handled natively via contextmenu
      if (p.pointerType === 'mouse' && p.button === 2) return;
      this.primary = this.track(p);
      this.current = 'pressed';
      if (p.pointerType === 'touch') {
        this.clearLongPress();
        this.cancelTimer = this.schedule(() => {
          this.fireLongPress();
        }, LONG_PRESS_MS);
      }
      return;
    }
    if (
      (this.current === 'pressed' || this.current === 'panning') &&
      this.primary !== null &&
      this.primary.pointerType === 'touch' &&
      p.pointerType === 'touch' &&
      this.secondary === null
    ) {
      this.clearLongPress();
      this.secondary = this.track(p);
      this.pinchDist = distance(this.primary.x, this.primary.y, p.x, p.y);
      this.current = 'pinching';
    }
    // extra pointers beyond two are ignored
  }

  pointerMove(p: GesturePointer): void {
    if (p.pointerType === 'mouse') {
      this.emit({ type: 'hover', x: p.x, y: p.y });
    }
    if (this.current === 'pressed' && this.primary?.id === p.pointerId) {
      this.primary.x = p.x;
      this.primary.y = p.y;
      if (distance(this.primary.startX, this.primary.startY, p.x, p.y) > TAP_SLOP_PX) {
        this.clearLongPress();
        if (this.primary.pannable) {
          this.current = 'panning';
          this.emit({
            type: 'panBy',
            dx: this.primary.startX - p.x,
            dy: this.primary.startY - p.y,
          });
        } else {
          this.current = 'suppressed';
        }
      }
      return;
    }
    if (this.current === 'panning' && this.primary?.id === p.pointerId) {
      this.emit({ type: 'panBy', dx: this.primary.x - p.x, dy: this.primary.y - p.y });
      this.primary.x = p.x;
      this.primary.y = p.y;
      return;
    }
    if (this.current === 'pinching') {
      const tracked =
        this.primary?.id === p.pointerId
          ? this.primary
          : this.secondary?.id === p.pointerId
            ? this.secondary
            : null;
      if (tracked === null || this.primary === null || this.secondary === null) return;
      const prevCx = (this.primary.x + this.secondary.x) / 2;
      const prevCy = (this.primary.y + this.secondary.y) / 2;
      tracked.x = p.x;
      tracked.y = p.y;
      const cx = (this.primary.x + this.secondary.x) / 2;
      const cy = (this.primary.y + this.secondary.y) / 2;
      // two-finger drag pans by the midpoint translation, spread change zooms
      if (cx !== prevCx || cy !== prevCy) {
        this.emit({ type: 'panBy', dx: prevCx - cx, dy: prevCy - cy });
      }
      const dist = distance(this.primary.x, this.primary.y, this.secondary.x, this.secondary.y);
      if (this.pinchDist > 0 && dist > 0 && dist !== this.pinchDist) {
        this.emit({ type: 'pinch', scale: dist / this.pinchDist, cx, cy });
      }
      this.pinchDist = dist;
    }
  }

  pointerUp(p: GesturePointer): void {
    if (this.current === 'pinching') {
      if (this.primary?.id !== p.pointerId && this.secondary?.id !== p.pointerId) return;
      // the remaining finger keeps panning from its current position
      const remaining = this.primary?.id === p.pointerId ? this.secondary : this.primary;
      this.primary = remaining;
      this.secondary = null;
      this.pinchDist = 0;
      this.current = remaining !== null ? 'panning' : 'idle';
      return;
    }
    if (this.primary?.id !== p.pointerId) return;
    const { tappable, startX, startY } = this.primary;
    const wasPressed = this.current === 'pressed';
    this.reset();
    if (wasPressed && tappable) {
      // emit at the press point, not the release point: pointerup is bound at
      // window level, so a slide-off release (or a fast flick with no observed
      // moves) would otherwise report coordinates outside the canvas
      this.emit({ type: 'tap', x: startX, y: startY });
    }
  }

  pointerCancel(p: GesturePointer): void {
    if (this.primary?.id === p.pointerId || this.secondary?.id === p.pointerId) {
      this.reset();
    }
  }

  private fireLongPress(): void {
    this.cancelTimer = null;
    if (this.current !== 'pressed' || this.primary === null) return;
    this.current = 'suppressed';
    this.emit({ type: 'longPress', x: this.primary.x, y: this.primary.y });
  }

  private clearLongPress(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private track(p: GesturePointer): TrackedPointer {
    return {
      id: p.pointerId,
      startX: p.x,
      startY: p.y,
      x: p.x,
      y: p.y,
      pointerType: p.pointerType,
      // touch pans with one finger; mouse pans with the middle button only
      pannable: p.pointerType !== 'mouse' || p.button === 1,
      tappable: p.button === 0,
    };
  }
}
