// Pure viewport math for the responsive adventure canvas, unit-testable
// without a DOM.

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
