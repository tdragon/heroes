import type { GameState } from '../core/state';
import {
  describeSlot,
  listAutosaves,
  listSlots,
  loadAutosave,
  loadFromSlot,
  type SaveStorage,
} from './saveload';
import type { Screen } from './screens';

export interface MainMenuCallbacks {
  onNewGame: () => void;
  onLoadGame: (state: GameState) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  testId?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (testId !== undefined) node.dataset.testid = testId;
  return node;
}

export class MainMenu implements Screen {
  readonly root: HTMLElement;
  private readonly loadPanel: HTMLElement;
  private readonly status: HTMLElement;

  constructor(
    private readonly storage: SaveStorage,
    private readonly callbacks: MainMenuCallbacks,
  ) {
    this.root = el('div', 'menu-screen', 'main-menu');
    const box = el('div', 'menu-box');

    const title = el('div', 'menu-title', 'game-title');
    title.textContent = 'Heroes Clone';
    box.appendChild(title);

    const buttons = el('div', 'menu-buttons menu-buttons-column');
    const newGame = el('button', 'menu-button', 'menu-new-game');
    newGame.textContent = 'New Game';
    newGame.addEventListener('click', () => {
      this.callbacks.onNewGame();
    });
    const loadGame = el('button', 'menu-button', 'menu-load-game');
    loadGame.textContent = 'Load Game';
    loadGame.addEventListener('click', () => {
      this.toggleLoadPanel();
    });
    const settings = el('button', 'menu-button', 'menu-settings');
    settings.textContent = 'Settings';
    settings.disabled = true;
    buttons.append(newGame, loadGame, settings);
    box.appendChild(buttons);

    this.loadPanel = el('div', 'menu-load-panel', 'load-panel');
    this.loadPanel.style.display = 'none';
    box.appendChild(this.loadPanel);

    this.status = el('div', 'panel-status', 'menu-status');
    box.appendChild(this.status);

    this.root.appendChild(box);
  }

  onShow(): void {
    this.status.textContent = '';
    if (this.loadPanel.style.display !== 'none') {
      this.renderLoadPanel();
    }
  }

  private toggleLoadPanel(): void {
    const visible = this.loadPanel.style.display !== 'none';
    this.loadPanel.style.display = visible ? 'none' : 'flex';
    if (!visible) this.renderLoadPanel();
  }

  private renderLoadPanel(): void {
    this.loadPanel.replaceChildren();
    listSlots(this.storage).forEach((meta, i) => {
      const slot = i + 1;
      const row = el('div', 'slot-row');
      const label = el('span', 'slot-label', `slot-info-${String(slot)}`);
      label.textContent = `Slot ${String(slot)}: ${describeSlot(meta)}`;
      const load = el('button', 'menu-button slot-button', `load-slot-${String(slot)}`);
      load.textContent = 'Load';
      load.disabled = meta === null;
      load.addEventListener('click', () => {
        this.tryLoad(() => loadFromSlot(this.storage, slot));
      });
      row.append(label, load);
      this.loadPanel.appendChild(row);
    });
    for (const { slot, meta } of listAutosaves(this.storage)) {
      const row = el('div', 'slot-row');
      const label = el('span', 'slot-label');
      label.textContent = `Autosave: ${describeSlot(meta)}`;
      const load = el('button', 'menu-button slot-button', `load-autosave-${String(slot)}`);
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        this.tryLoad(() => loadAutosave(this.storage, slot));
      });
      row.append(label, load);
      this.loadPanel.appendChild(row);
    }
  }

  private tryLoad(load: () => GameState): void {
    try {
      this.callbacks.onLoadGame(load());
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}
