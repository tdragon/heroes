// System overlay (save/load slots, export/import, quit to menu), following
// the town/hero screen overlay pattern: a self-contained component appended
// to the adventure screen root.

import type { GameState } from '../core/state';
import {
  buildExportFile,
  describeSlot,
  importSave,
  listAutosaves,
  listSlots,
  loadAutosave,
  loadFromSlot,
  saveToSlot,
  type SaveStorage,
} from '../app/saveload';
import { button, el } from './components';

export interface SystemPanelOptions {
  storage: SaveStorage;
  getState: () => GameState;
  onLoad: (state: GameState) => void;
  onExit: () => void;
  onClose: () => void;
}

export class SystemPanel {
  readonly root: HTMLElement;

  constructor(private readonly opts: SystemPanelOptions) {
    this.root = el('div', 'panel-overlay', 'system-panel');
    const panel = el('div', 'panel system-panel-box');

    const header = el('div', 'panel-header');
    const title = el('div', 'panel-title');
    title.textContent = 'System';
    const close = button('Close', 'system-close', () => {
      this.opts.onClose();
    });
    header.append(title, close);
    panel.appendChild(header);

    const status = el('div', 'panel-status', 'system-status');

    const slots = el('div', 'panel-section');
    const renderSlots = (): void => {
      slots.replaceChildren();
      const sectionTitle = el('div', 'section-title');
      sectionTitle.textContent = 'Save Slots';
      slots.appendChild(sectionTitle);
      listSlots(this.opts.storage).forEach((meta, i) => {
        const slot = i + 1;
        const row = el('div', 'slot-row');
        const label = el('span', 'slot-label', `slot-info-${String(slot)}`);
        label.textContent = `Slot ${String(slot)}: ${describeSlot(meta)}`;
        const save = button('Save', `save-slot-${String(slot)}`, () => {
          try {
            saveToSlot(this.opts.storage, slot, this.opts.getState());
            status.textContent = `Saved to slot ${String(slot)}`;
          } catch {
            status.textContent = `Could not save to slot ${String(slot)} (storage full?)`;
          }
          renderSlots();
        });
        const load = button('Load', `load-slot-${String(slot)}`, () => {
          this.tryLoad(status, () => loadFromSlot(this.opts.storage, slot));
        });
        load.disabled = meta === null;
        row.append(label, save, load);
        slots.appendChild(row);
      });
      for (const { slot, meta } of listAutosaves(this.opts.storage)) {
        const row = el('div', 'slot-row');
        const label = el('span', 'slot-label');
        label.textContent = `Autosave: ${describeSlot(meta)}`;
        const load = button('Load', `load-autosave-${String(slot)}`, () => {
          this.tryLoad(status, () => loadAutosave(this.opts.storage, slot));
        });
        row.append(label, load);
        slots.appendChild(row);
      }
    };
    renderSlots();
    panel.appendChild(slots);

    const fileSection = el('div', 'panel-section');
    const fileTitle = el('div', 'section-title');
    fileTitle.textContent = 'Export / Import';
    const fileRow = el('div', 'slot-row');
    const exportButton = button('Export Save', 'export-save', () => {
      const file = buildExportFile(this.opts.getState());
      const url = URL.createObjectURL(new Blob([file.json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    });
    const importInput = el('input', 'import-input', 'import-save-input');
    importInput.type = 'file';
    importInput.accept = 'application/json';
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (!file) return;
      file.text().then(
        (text) => {
          this.tryLoad(status, () => importSave(text));
        },
        () => {
          status.textContent = 'Could not read the selected file';
        },
      );
    });
    fileRow.append(exportButton, importInput);
    fileSection.append(fileTitle, fileRow);
    panel.appendChild(fileSection);

    const quitRow = el('div', 'panel-section');
    quitRow.appendChild(
      button('Quit to Menu', 'quit-to-menu', () => {
        this.opts.onExit();
      }),
    );
    panel.appendChild(quitRow);

    panel.appendChild(status);
    this.root.appendChild(panel);
  }

  private tryLoad(status: HTMLElement, load: () => GameState): void {
    try {
      this.opts.onLoad(load());
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}
