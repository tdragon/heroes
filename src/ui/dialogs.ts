import type { GameState } from '../core/state';
import { choiceOptionLabel, choiceTitle } from './helpers';
import { el, type UiContext } from './components';

interface DialogButton {
  label: string;
  testId: string;
  action: () => void;
}

// Modal dialog queue: pending choices from the core (level-up picks, chest
// choices, guard confirmations) take priority, then queued informational
// dialogs (week banner, signs, combat results). Enter confirms the first
// option, Escape the last.
export class DialogQueue {
  readonly root: HTMLElement;
  private readonly info: string[] = [];

  constructor(
    private readonly ctx: UiContext,
    private readonly onChanged: () => void,
  ) {
    this.root = el('div', 'modal-overlay', 'modal-overlay');
    this.root.style.display = 'none';
    window.addEventListener('keydown', this.onKeyDown);
  }

  enqueueInfo(message: string): void {
    this.info.push(message);
  }

  update(state: GameState): void {
    if (state.status !== 'running') {
      this.render(`Game over — ${state.status.winner} wins!`, []);
      return;
    }
    if (state.combat !== null) {
      // the combat screen owns the UI while a battle is in progress
      this.root.style.display = 'none';
      return;
    }
    const choice = state.pendingChoices.find((c) => c.player === this.ctx.playerId);
    if (choice) {
      this.render(
        choiceTitle(choice, state),
        choice.options.map((option, i) => ({
          label: choiceOptionLabel(choice, option, this.ctx.data),
          testId: `choice-option-${String(i)}`,
          action: () => {
            this.ctx.run({
              type: 'resolveChoice',
              player: choice.player,
              choiceId: choice.id,
              option: i,
            });
          },
        })),
      );
      return;
    }
    const message = this.info[0];
    if (message !== undefined) {
      this.render(message, [
        {
          label: 'OK',
          testId: 'dialog-ok',
          action: () => {
            this.info.shift();
            this.onChanged();
          },
        },
      ]);
      return;
    }
    this.root.style.display = 'none';
  }

  private render(message: string, buttons: DialogButton[]): void {
    this.root.replaceChildren();
    const box = el('div', 'modal-box');
    const text = el('div', 'modal-message', 'modal-message');
    text.textContent = message;
    box.appendChild(text);
    for (const entry of buttons) {
      const node = el('button', 'modal-button', entry.testId);
      node.textContent = entry.label;
      node.addEventListener('click', entry.action);
      box.appendChild(node);
    }
    this.root.appendChild(box);
    this.root.style.display = 'flex';
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.root.style.display === 'none') return;
    const buttons = this.root.querySelectorAll('button');
    if (buttons.length === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      buttons[0]?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      buttons[buttons.length - 1]?.click();
    }
  };
}
