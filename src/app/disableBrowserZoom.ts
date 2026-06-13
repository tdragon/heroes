// iOS Safari pinch-zooms the *page* via non-standard WebKit gesture events that
// ignore both `touch-action` and the viewport's `user-scalable=no`, and once the
// visual viewport is scaled there is no JS API to reset it — the user gets stuck.
// Preventing these events app-wide keeps every pinch on the map's own gesture FSM
// (pointer-event driven, unaffected here). Android/desktop page zoom is handled by
// the viewport meta and `touch-action` in index.html.
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];

export function disableBrowserZoom(target: EventTarget = document): () => void {
  const block = (e: Event): void => {
    e.preventDefault();
  };
  for (const type of GESTURE_EVENTS) {
    target.addEventListener(type, block, { passive: false });
  }
  return () => {
    for (const type of GESTURE_EVENTS) {
      target.removeEventListener(type, block);
    }
  };
}
