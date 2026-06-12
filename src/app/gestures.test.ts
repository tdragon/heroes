import { describe, expect, it } from 'vitest';
import {
  GestureRecognizer,
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  type GestureAction,
  type GesturePointer,
  type GestureSchedule,
} from './gestures';

interface Harness {
  fsm: GestureRecognizer;
  actions: GestureAction[];
  fireTimer: () => void;
  timerPending: () => boolean;
  scheduledMs: number[];
}

function harness(): Harness {
  const actions: GestureAction[] = [];
  const scheduledMs: number[] = [];
  let pending: (() => void) | null = null;
  const schedule: GestureSchedule = (cb, ms) => {
    scheduledMs.push(ms);
    pending = cb;
    return () => {
      if (pending === cb) pending = null;
    };
  };
  const fsm = new GestureRecognizer((a) => actions.push(a), schedule);
  return {
    fsm,
    actions,
    fireTimer: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
    timerPending: () => pending !== null,
    scheduledMs,
  };
}

function touch(id: number, x: number, y: number, button = 0): GesturePointer {
  return { pointerId: id, x, y, pointerType: 'touch', button };
}

function mouse(x: number, y: number, button: number): GesturePointer {
  return { pointerId: 1, x, y, pointerType: 'mouse', button };
}

describe('GestureRecognizer taps', () => {
  it('emits tap at the press point on touch up within slop', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerMove(touch(1, 103, 102, -1));
    h.fsm.pointerUp(touch(1, 103, 102, -1));
    expect(h.actions).toEqual([{ type: 'tap', x: 100, y: 100 }]);
    expect(h.fsm.state).toBe('idle');
  });

  it('slide-off release taps at the press point, not the off-canvas release point', () => {
    // pointerup is window-level: pressing on the canvas and releasing far away
    // (moves off-canvas are never observed, so the FSM stays pressed) must not
    // produce a tap at the release coordinates
    const h = harness();
    h.fsm.pointerDown(mouse(630, 470, 0));
    h.fsm.pointerUp(mouse(900, 600, -1));
    expect(h.actions).toEqual([{ type: 'tap', x: 630, y: 470 }]);
    expect(h.fsm.state).toBe('idle');
  });

  it('fast flick with no intermediate moves taps at the press point', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 50, 50));
    h.fsm.pointerUp(touch(1, -200, 400, -1));
    expect(h.actions).toEqual([{ type: 'tap', x: 50, y: 50 }]);
    expect(h.fsm.state).toBe('idle');
  });

  it('emits tap for a mouse left click', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(50, 60, 0));
    h.fsm.pointerUp(mouse(50, 60, -1));
    expect(h.actions).toEqual([{ type: 'tap', x: 50, y: 60 }]);
  });

  it('does not emit tap for middle or right buttons', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(50, 60, 1));
    h.fsm.pointerUp(mouse(50, 60, -1));
    h.fsm.pointerDown(mouse(50, 60, 2));
    h.fsm.pointerUp(mouse(50, 60, -1));
    expect(h.actions).toEqual([]);
    expect(h.fsm.state).toBe('idle');
  });
});

describe('GestureRecognizer panning', () => {
  it('touch drag past slop emits panBy and no tap on release', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerMove(touch(1, 120, 100, -1));
    expect(h.fsm.state).toBe('panning');
    expect(h.actions).toEqual([{ type: 'panBy', dx: -20, dy: 0 }]);
    h.fsm.pointerMove(touch(1, 125, 110, -1));
    expect(h.actions[1]).toEqual({ type: 'panBy', dx: -5, dy: -10 });
    h.fsm.pointerUp(touch(1, 125, 110, -1));
    expect(h.actions).toHaveLength(2);
    expect(h.fsm.state).toBe('idle');
  });

  it('stays a tap candidate within the slop radius', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerMove(touch(1, 100 + TAP_SLOP_PX, 100, -1));
    expect(h.fsm.state).toBe('pressed');
    expect(h.actions).toEqual([]);
  });

  it('mouse middle-button drag pans', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(100, 100, 1));
    h.fsm.pointerMove(mouse(80, 90, -1));
    expect(h.actions).toEqual([
      { type: 'hover', x: 80, y: 90 },
      { type: 'panBy', dx: 20, dy: 10 },
    ]);
  });

  it('mouse left-button drag does NOT pan and does not tap after slop', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(100, 100, 0));
    h.fsm.pointerMove(mouse(150, 150, -1));
    expect(h.fsm.state).toBe('suppressed');
    h.fsm.pointerUp(mouse(150, 150, -1));
    const types = h.actions.map((a) => a.type);
    expect(types).not.toContain('panBy');
    expect(types).not.toContain('tap');
  });
});

describe('GestureRecognizer long press', () => {
  it('fires once after the timeout and suppresses the tap', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 40, 50));
    expect(h.scheduledMs).toEqual([LONG_PRESS_MS]);
    h.fireTimer();
    expect(h.actions).toEqual([{ type: 'longPress', x: 40, y: 50 }]);
    h.fireTimer(); // no double fire
    h.fsm.pointerUp(touch(1, 40, 50, -1));
    expect(h.actions).toHaveLength(1);
    expect(h.fsm.state).toBe('idle');
  });

  it('is cancelled by movement past slop', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 40, 50));
    h.fsm.pointerMove(touch(1, 80, 50, -1));
    expect(h.timerPending()).toBe(false);
    expect(h.actions).toEqual([{ type: 'panBy', dx: -40, dy: 0 }]);
  });

  it('is not scheduled for mouse presses', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(40, 50, 0));
    expect(h.scheduledMs).toEqual([]);
  });
});

describe('GestureRecognizer pinch', () => {
  it('emits midpoint pan plus scale ratio from two touch pointers', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(touch(2, 200, 100));
    expect(h.fsm.state).toBe('pinching');
    expect(h.timerPending()).toBe(false);
    h.fsm.pointerMove(touch(2, 300, 100, -1));
    expect(h.actions).toEqual([
      { type: 'panBy', dx: -50, dy: 0 },
      { type: 'pinch', scale: 2, cx: 200, cy: 100 },
    ]);
    h.fsm.pointerMove(touch(1, 200, 100, -1));
    expect(h.actions.slice(2)).toEqual([
      { type: 'panBy', dx: -50, dy: 0 },
      { type: 'pinch', scale: 0.5, cx: 250, cy: 100 },
    ]);
  });

  it('two-finger drag at constant spacing pans without zooming', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(touch(2, 200, 100));
    // rotate finger 1 around finger 2: spacing stays 100, midpoint moves
    h.fsm.pointerMove(touch(1, 200, 200, -1));
    expect(h.actions).toEqual([{ type: 'panBy', dx: -50, dy: -50 }]);
  });

  it('a second finger landing during a pan switches to pinching', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerMove(touch(1, 150, 100, -1));
    expect(h.fsm.state).toBe('panning');
    h.fsm.pointerDown(touch(2, 250, 100));
    expect(h.fsm.state).toBe('pinching');
    h.fsm.pointerMove(touch(2, 350, 100, -1));
    expect(h.actions.slice(1)).toEqual([
      { type: 'panBy', dx: -50, dy: 0 },
      { type: 'pinch', scale: 2, cx: 250, cy: 100 },
    ]);
  });

  it('a second finger during a suppressed press is ignored', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 40, 50));
    h.fireTimer(); // long press fired -> suppressed
    expect(h.fsm.state).toBe('suppressed');
    h.fsm.pointerDown(touch(2, 200, 100));
    expect(h.fsm.state).toBe('suppressed');
    h.fsm.pointerMove(touch(2, 300, 100, -1));
    expect(h.actions.map((a) => a.type)).toEqual(['longPress']);
  });

  it('continues panning with the remaining finger after the primary lifts', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(touch(2, 200, 100));
    h.fsm.pointerUp(touch(1, 100, 100, -1));
    expect(h.fsm.state).toBe('panning');
    h.fsm.pointerMove(touch(2, 190, 90, -1));
    expect(h.actions).toEqual([{ type: 'panBy', dx: 10, dy: 10 }]);
    h.fsm.pointerUp(touch(2, 190, 90, -1));
    expect(h.fsm.state).toBe('idle');
  });

  it('continues panning with the primary finger after the secondary lifts', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(touch(2, 200, 100));
    h.fsm.pointerUp(touch(2, 200, 100, -1));
    expect(h.fsm.state).toBe('panning');
    h.fsm.pointerMove(touch(1, 90, 110, -1));
    expect(h.actions).toEqual([{ type: 'panBy', dx: 10, dy: -10 }]);
  });

  it('guards against a zero initial pinch distance', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(touch(2, 100, 100));
    // first spread from coincident fingers: no pinch (no division by zero)
    h.fsm.pointerMove(touch(2, 150, 100, -1));
    expect(h.actions.filter((a) => a.type === 'pinch')).toEqual([]);
    // once a real distance exists, scale is finite
    h.fsm.pointerMove(touch(2, 200, 100, -1));
    expect(h.actions.filter((a) => a.type === 'pinch')).toEqual([
      { type: 'pinch', scale: 2, cx: 150, cy: 100 },
    ]);
  });

  it('ignores a mouse pointer as the second pinch finger', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerDown(mouse(200, 100, 0));
    expect(h.fsm.state).toBe('pressed');
  });
});

describe('GestureRecognizer cancel and reset', () => {
  it('pointer cancel resets state and kills pending gestures', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerCancel(touch(1, 100, 100, -1));
    expect(h.fsm.state).toBe('idle');
    expect(h.timerPending()).toBe(false);
    h.fsm.pointerUp(touch(1, 100, 100, -1));
    expect(h.actions).toEqual([]);
    // a fresh press still works after the cancel
    h.fsm.pointerDown(touch(3, 10, 10));
    h.fsm.pointerUp(touch(3, 10, 10, -1));
    expect(h.actions).toEqual([{ type: 'tap', x: 10, y: 10 }]);
  });

  it('cancel of an untracked pointer is ignored', () => {
    const h = harness();
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerCancel(touch(9, 0, 0, -1));
    expect(h.fsm.state).toBe('pressed');
  });
});

describe('GestureRecognizer hover', () => {
  it('emits hover for mouse moves when idle or pressed', () => {
    const h = harness();
    h.fsm.pointerMove(mouse(5, 6, -1));
    h.fsm.pointerDown(mouse(5, 6, 0));
    h.fsm.pointerMove(mouse(7, 8, -1));
    expect(h.actions).toEqual([
      { type: 'hover', x: 5, y: 6 },
      { type: 'hover', x: 7, y: 8 },
    ]);
  });

  it('keeps emitting hover while panning and suppressed so the position never goes stale', () => {
    const h = harness();
    h.fsm.pointerDown(mouse(100, 100, 1));
    h.fsm.pointerMove(mouse(50, 50, -1));
    h.fsm.pointerMove(mouse(40, 40, -1));
    expect(h.actions.filter((a) => a.type === 'hover')).toEqual([
      { type: 'hover', x: 50, y: 50 },
      { type: 'hover', x: 40, y: 40 },
    ]);
    expect(h.actions.filter((a) => a.type === 'panBy')).toHaveLength(2);
    h.fsm.pointerUp(mouse(40, 40, -1));
    h.fsm.pointerDown(mouse(40, 40, 0));
    h.fsm.pointerMove(mouse(90, 90, -1));
    expect(h.fsm.state).toBe('suppressed');
    expect(h.actions[h.actions.length - 1]).toEqual({ type: 'hover', x: 90, y: 90 });
  });

  it('does not emit hover for touch moves', () => {
    const h = harness();
    h.fsm.pointerMove(touch(1, 5, 6, -1));
    h.fsm.pointerDown(touch(1, 100, 100));
    h.fsm.pointerMove(touch(1, 150, 100, -1));
    expect(h.actions.map((a) => a.type)).not.toContain('hover');
  });
});
