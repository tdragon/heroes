// Keyboard shortcut → action mapping, kept pure so it is unit-testable.
// The screens translate the returned actions into commands / UI calls.

export type AdventureShortcutAction =
  | { type: 'endTurn' }
  | { type: 'nextHero' }
  | { type: 'visitHere' }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number };

// keyboard zoom step (multiplicative, about the viewport center)
export const KEY_ZOOM_STEP = 1.25;

export function adventureShortcut(
  key: string,
  panStep: number,
): AdventureShortcutAction | null {
  switch (key) {
    case 'e':
    case 'E':
      return { type: 'endTurn' };
    case 'h':
    case 'H':
      return { type: 'nextHero' };
    case ' ':
      return { type: 'visitHere' };
    case '+':
    case '=':
      return { type: 'zoom', factor: KEY_ZOOM_STEP };
    case '-':
    case '_':
      return { type: 'zoom', factor: 1 / KEY_ZOOM_STEP };
    case 'ArrowLeft':
      return { type: 'pan', dx: -panStep, dy: 0 };
    case 'ArrowRight':
      return { type: 'pan', dx: panStep, dy: 0 };
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: -panStep };
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: panStep };
    default:
      return null;
  }
}

export interface CombatShortcutAction {
  type: 'defend';
}

export function combatShortcut(key: string): CombatShortcutAction | null {
  return key === ' ' ? { type: 'defend' } : null;
}

// shortcuts must never fire while the user is typing in a form control
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}
