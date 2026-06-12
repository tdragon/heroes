import { describe, expect, it } from 'vitest';
import { adventureShortcut, combatShortcut, KEY_ZOOM_STEP } from './shortcuts';

describe('adventure shortcuts', () => {
  it('maps E to end turn and H to next hero (case-insensitive)', () => {
    expect(adventureShortcut('e', 48)).toEqual({ type: 'endTurn' });
    expect(adventureShortcut('E', 48)).toEqual({ type: 'endTurn' });
    expect(adventureShortcut('h', 48)).toEqual({ type: 'nextHero' });
    expect(adventureShortcut('H', 48)).toEqual({ type: 'nextHero' });
  });

  it('maps Space to visit-again', () => {
    expect(adventureShortcut(' ', 48)).toEqual({ type: 'visitHere' });
  });

  it('maps arrow keys to camera pans scaled by the step', () => {
    expect(adventureShortcut('ArrowLeft', 10)).toEqual({ type: 'pan', dx: -10, dy: 0 });
    expect(adventureShortcut('ArrowRight', 10)).toEqual({ type: 'pan', dx: 10, dy: 0 });
    expect(adventureShortcut('ArrowUp', 10)).toEqual({ type: 'pan', dx: 0, dy: -10 });
    expect(adventureShortcut('ArrowDown', 10)).toEqual({ type: 'pan', dx: 0, dy: 10 });
  });

  it('maps +/= to zoom in and -/_ to zoom out by the key step', () => {
    expect(adventureShortcut('+', 48)).toEqual({ type: 'zoom', factor: KEY_ZOOM_STEP });
    expect(adventureShortcut('=', 48)).toEqual({ type: 'zoom', factor: KEY_ZOOM_STEP });
    expect(adventureShortcut('-', 48)).toEqual({ type: 'zoom', factor: 1 / KEY_ZOOM_STEP });
    expect(adventureShortcut('_', 48)).toEqual({ type: 'zoom', factor: 1 / KEY_ZOOM_STEP });
  });

  it('ignores unmapped keys', () => {
    expect(adventureShortcut('x', 48)).toBeNull();
    expect(adventureShortcut('Enter', 48)).toBeNull();
    expect(adventureShortcut('Escape', 48)).toBeNull();
  });
});

describe('combat shortcuts', () => {
  it('maps Space to defend and nothing else', () => {
    expect(combatShortcut(' ')).toEqual({ type: 'defend' });
    expect(combatShortcut('e')).toBeNull();
    expect(combatShortcut('Enter')).toBeNull();
  });
});
