import type { GameData } from '../data';
import type { Command } from '../core/commands';
import type { GameState, PlayerId } from '../core/state';

// shared context handed to the town/hero overlay screens by the adventure screen
export interface UiContext {
  data: GameData;
  playerId: PlayerId;
  getState: () => GameState;
  // dispatches a command; returns the rejection message or null on success
  run: (command: Command) => string | null;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  testId?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (testId !== undefined) node.dataset.testid = testId;
  return node;
}

export function button(label: string, testId: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'ui-button', testId);
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

export interface CountDialogOptions {
  title: string;
  min: number;
  max: number;
  initial: number;
  describe?: (count: number) => string;
  onConfirm: (count: number) => void;
}

// modal count picker with a slider + number input, used by recruit and split dialogs
export function openCountDialog(host: HTMLElement, opts: CountDialogOptions): void {
  const overlay = el('div', 'count-dialog-overlay', 'count-dialog');
  const box = el('div', 'modal-box count-dialog-box');

  const title = el('div', 'modal-message', 'count-title');
  title.textContent = opts.title;

  const slider = el('input', 'count-slider', 'count-slider');
  slider.type = 'range';
  slider.min = String(opts.min);
  slider.max = String(opts.max);
  slider.value = String(opts.initial);

  const input = el('input', 'count-input', 'count-input');
  input.type = 'number';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.value = String(opts.initial);

  const detail = el('div', 'count-detail', 'count-detail');

  const clamp = (value: number): number =>
    Math.min(opts.max, Math.max(opts.min, Math.round(Number.isFinite(value) ? value : opts.min)));

  const current = (): number => clamp(Number(input.value));

  const sync = (value: number): void => {
    slider.value = String(value);
    input.value = String(value);
    detail.textContent = opts.describe?.(value) ?? '';
  };
  sync(opts.initial);

  slider.addEventListener('input', () => {
    sync(clamp(Number(slider.value)));
  });
  input.addEventListener('input', () => {
    detail.textContent = opts.describe?.(current()) ?? '';
  });

  const close = (): void => {
    overlay.remove();
  };

  const maxButton = button('Max', 'count-max', () => {
    sync(opts.max);
  });
  const confirm = button('OK', 'count-confirm', () => {
    const count = current();
    close();
    opts.onConfirm(count);
  });
  const cancel = button('Cancel', 'count-cancel', close);

  const row = el('div', 'count-row');
  row.append(slider, input, maxButton);
  const buttons = el('div', 'count-buttons');
  buttons.append(confirm, cancel);
  box.append(title, row, detail, buttons);
  overlay.appendChild(box);
  host.appendChild(overlay);
}
