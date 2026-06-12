import { RESOURCE_IDS } from '../data/schema';
import type { GameData } from '../data';
import { maxMana, monthOf, weekOf, type GameState, type Hero, type Player } from '../core/state';
import { maxMovementPoints } from '../core/hero';
import { el } from './components';

export interface HudCallbacks {
  onEndTurn: () => void;
  onNextHero: () => void;
  onSelectHero: (id: string) => void;
  onSelectTown: (id: string) => void;
  onOpenHeroScreen: () => void;
  onOpenSpellbook: () => void;
  onMinimapClick: (px: number, py: number) => void;
  onOpenSystem: () => void;
}

export const MINIMAP_PX = 200;

export class Hud {
  readonly sidebar: HTMLElement;
  readonly bottomBar: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  private readonly dateIndicator: HTMLElement;
  private readonly heroList: HTMLElement;
  private readonly townList: HTMLElement;
  private readonly heroPanel: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly resourceCells = new Map<string, HTMLElement>();

  constructor(
    private readonly data: GameData,
    private readonly callbacks: HudCallbacks,
  ) {
    this.sidebar = el('div', 'sidebar', 'sidebar');

    const title = el('div', 'game-title', 'game-title');
    title.textContent = 'Open Heroes';
    this.sidebar.appendChild(title);

    this.minimapCanvas = el('canvas', 'minimap', 'minimap');
    this.minimapCanvas.width = MINIMAP_PX;
    this.minimapCanvas.height = MINIMAP_PX;
    this.minimapCanvas.addEventListener('click', (e) => {
      const rect = this.minimapCanvas.getBoundingClientRect();
      this.callbacks.onMinimapClick(e.clientX - rect.left, e.clientY - rect.top);
    });
    this.sidebar.appendChild(this.minimapCanvas);

    this.dateIndicator = el('div', 'date-indicator', 'date-indicator');
    this.sidebar.appendChild(this.dateIndicator);

    this.heroList = el('div', 'hero-list', 'hero-list');
    this.sidebar.appendChild(this.heroList);
    this.townList = el('div', 'town-list', 'town-list');
    this.sidebar.appendChild(this.townList);

    this.heroPanel = el('div', 'hero-panel', 'hero-panel');
    this.sidebar.appendChild(this.heroPanel);

    const buttons = el('div', 'hud-buttons');
    const nextHero = el('button', 'hud-button', 'next-hero-button');
    nextHero.textContent = 'Next Hero';
    nextHero.addEventListener('click', () => {
      this.callbacks.onNextHero();
    });
    const spellbook = el('button', 'hud-button', 'spellbook-button');
    spellbook.textContent = 'Spellbook';
    spellbook.addEventListener('click', () => {
      this.callbacks.onOpenSpellbook();
    });
    const endTurn = el('button', 'hud-button', 'end-turn-button');
    endTurn.textContent = 'End Turn';
    endTurn.addEventListener('click', () => {
      this.callbacks.onEndTurn();
    });
    const system = el('button', 'hud-button', 'system-button');
    system.textContent = 'System';
    system.addEventListener('click', () => {
      this.callbacks.onOpenSystem();
    });
    buttons.append(nextHero, spellbook, endTurn, system);
    this.sidebar.appendChild(buttons);

    this.statusLine = el('div', 'status-line', 'status-line');
    this.sidebar.appendChild(this.statusLine);

    this.bottomBar = el('div', 'bottom-bar', 'resource-bar');
    for (const id of RESOURCE_IDS) {
      const cell = el('span', 'resource-cell', `resource-${id}`);
      const label = el('span', 'resource-label');
      label.textContent = `${id}: `;
      const value = el('span', 'resource-value');
      cell.append(label, value);
      this.resourceCells.set(id, value);
      this.bottomBar.appendChild(cell);
    }
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }

  update(state: GameState, player: Player, selectedHero: string | null): void {
    for (const id of RESOURCE_IDS) {
      const cell = this.resourceCells.get(id);
      if (cell) cell.textContent = String(player.resources[id]);
    }
    this.dateIndicator.textContent = `Day ${String(state.day)}, Week ${String(weekOf(state.day))}, Month ${String(monthOf(state.day))}`;

    this.renderHeroList(state, player, selectedHero);
    this.renderTownList(state, player);
    this.renderHeroPanel(state, selectedHero);
  }

  private renderHeroList(state: GameState, player: Player, selectedHero: string | null): void {
    this.heroList.replaceChildren();
    for (const heroId of player.heroes) {
      const hero = state.heroes[heroId];
      if (!hero) continue;
      const item = el('button', 'hero-item', `hero-item-${hero.id}`);
      if (hero.id === selectedHero) item.classList.add('selected');
      const maxMp = maxMovementPoints(hero, this.data);
      const pct = maxMp > 0 ? Math.round((hero.movementPoints / maxMp) * 100) : 0;
      item.textContent = `${hero.name} (MP ${String(pct)}%)`;
      item.addEventListener('click', () => {
        this.callbacks.onSelectHero(hero.id);
      });
      this.heroList.appendChild(item);
    }
  }

  private renderTownList(state: GameState, player: Player): void {
    this.townList.replaceChildren();
    for (const townId of player.towns) {
      const town = state.towns[townId];
      if (!town) continue;
      const item = el('button', 'town-item', `town-item-${town.id}`);
      item.textContent = town.name;
      item.addEventListener('click', () => {
        this.callbacks.onSelectTown(town.id);
      });
      this.townList.appendChild(item);
    }
  }

  private renderHeroPanel(state: GameState, selectedHero: string | null): void {
    this.heroPanel.replaceChildren();
    const hero = selectedHero !== null ? state.heroes[selectedHero] : undefined;
    if (!hero) {
      this.heroPanel.textContent = 'No hero selected';
      return;
    }
    const name = el('div', 'hero-panel-name', 'hero-panel-name');
    name.textContent = `${hero.name} (level ${String(hero.level)})`;
    const pos = el('div', 'hero-panel-pos', 'hero-pos');
    pos.textContent = `${String(hero.pos[0])},${String(hero.pos[1])}`;
    const stats = el('div', 'hero-panel-stats', 'hero-panel-stats');
    stats.textContent = `MP ${String(hero.movementPoints)} | Mana ${String(hero.mana)}/${String(maxMana(hero, this.data))}`;
    const army = el('div', 'hero-panel-army', 'hero-panel-army');
    army.textContent = this.armySummary(hero);
    const details = el('button', 'hud-button', 'open-hero-screen');
    details.textContent = 'Hero Details';
    details.addEventListener('click', () => {
      this.callbacks.onOpenHeroScreen();
    });
    this.heroPanel.append(name, pos, stats, army, details);
  }

  private armySummary(hero: Hero): string {
    const parts: string[] = [];
    for (const stack of hero.army) {
      if (!stack) continue;
      const creature = this.data.creatures[stack.creature];
      parts.push(`${String(stack.count)} ${creature?.name ?? stack.creature}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'No army';
  }
}

// --- right-click info popup ---

export class InfoPopup {
  readonly root: HTMLElement;

  constructor() {
    this.root = el('div', 'info-popup', 'info-popup');
    this.root.style.display = 'none';
  }

  show(text: string, x: number, y: number): void {
    this.root.textContent = text;
    this.root.style.display = 'block';
    this.root.style.left = `${String(x)}px`;
    this.root.style.top = `${String(y)}px`;
  }

  hide(): void {
    this.root.style.display = 'none';
  }
}
