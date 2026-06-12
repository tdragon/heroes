// Viewport helpers for the responsive canvases: pure math plus a DPR watcher
// with injectable matchMedia, all unit-testable without a DOM.

export interface BackingSize {
  width: number;
  height: number;
}

// canvas backing-store size for a CSS box at a device pixel ratio
export function canvasBackingSize(cssW: number, cssH: number, dpr: number): BackingSize {
  return {
    width: Math.max(1, Math.round(cssW * dpr)),
    height: Math.max(1, Math.round(cssH * dpr)),
  };
}

// the slice of MediaQueryList the DPR watcher needs (injectable in tests)
export interface DprMediaQuery {
  addEventListener: (
    type: 'change',
    listener: () => void,
    options: { once: boolean; signal: AbortSignal },
  ) => void;
}

// fires onChange whenever devicePixelRatio changes (e.g. the window moves to
// a monitor with a different scale, which need not fire a resize event); the
// resolution media query matches the *current* dpr, so it is re-armed after
// every change
export function watchDevicePixelRatio(
  onChange: () => void,
  signal: AbortSignal,
  matchMediaFn: (query: string) => DprMediaQuery = (query) => window.matchMedia(query),
  getDpr: () => number = () => window.devicePixelRatio,
): void {
  const arm = (): void => {
    matchMediaFn(`(resolution: ${String(getDpr())}dppx)`).addEventListener(
      'change',
      () => {
        onChange();
        arm();
      },
      { once: true, signal },
    );
  };
  arm();
}

// edge-scroll pan delta for a pointer at (sx, sy) CSS px inside a cssW×cssH
// viewport; zero when the pointer is outside the margin bands
export function edgeScrollDelta(
  sx: number,
  sy: number,
  cssW: number,
  cssH: number,
  margin: number,
  speed: number,
): [number, number] {
  let dx = 0;
  let dy = 0;
  if (sx < margin) dx = -speed;
  else if (sx > cssW - margin) dx = speed;
  if (sy < margin) dy = -speed;
  else if (sy > cssH - margin) dy = speed;
  return [dx, dy];
}
