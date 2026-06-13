import { RESOURCE_IDS } from '../data/schema';
import type { GameData } from '../data';
import { maxMana, monthOf, weekOf, type GameState, type Hero, type Player } from '../core/state';
import { maxMovementPoints } from '../core/hero';
import { el } from './components';
import { clampPopupPosition } from './helpers';

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

// matches the narrow-screen breakpoint in index.html
const NARROW_SCREEN_QUERY = '(max-width: 768px)';

export class Hud {
  readonly sidebar: HTMLElement;
  readonly bottomBar: HTMLElement;
  // tap-to-close scrim behind the slide-in sidebar drawer on narrow screens
  readonly backdrop: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  private readonly dateIndicator: HTMLElement;
  private readonly heroList: HTMLElement;
  private readonly townList: HTMLElement;
  private readonly heroPanel: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly resourceCells = new Map<string, HTMLElement>();
  // End Turn / Next Hero live in the sidebar on wide screens and move into
  // the bottom bar on narrow ones so they stay reachable without the drawer
  private readonly hudButtons: HTMLElement;
  private readonly nextHeroButton: HTMLButtonElement;
  private readonly endTurnButton: HTMLButtonElement;
  private readonly spellbookButton: HTMLButtonElement;
  private readonly systemButton: HTMLButtonElement;
  private readonly menuToggle: HTMLButtonElement;
  private readonly narrowQuery: MediaQueryList;
  private readonly onNarrowChange = (e: MediaQueryListEvent): void => {
    this.placeActionButtons(e.matches);
    if (!e.matches) this.closeDrawer();
  };

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

    this.hudButtons = el('div', 'hud-buttons');
    this.nextHeroButton = el('button', 'hud-button', 'next-hero-button');
    this.nextHeroButton.textContent = 'Next Hero';
    this.nextHeroButton.addEventListener('click', () => {
      this.callbacks.onNextHero();
    });
    this.spellbookButton = el('button', 'hud-button', 'spellbook-button');
    this.spellbookButton.textContent = 'Spellbook';
    this.spellbookButton.addEventListener('click', () => {
      this.callbacks.onOpenSpellbook();
    });
    this.endTurnButton = el('button', 'hud-button', 'end-turn-button');
    this.endTurnButton.textContent = 'End Turn';
    this.endTurnButton.addEventListener('click', () => {
      this.callbacks.onEndTurn();
    });
    this.systemButton = el('button', 'hud-button', 'system-button');
    this.systemButton.textContent = 'System';
    this.systemButton.addEventListener('click', () => {
      this.callbacks.onOpenSystem();
    });
    this.hudButtons.append(
      this.nextHeroButton,
      this.spellbookButton,
      this.endTurnButton,
      this.systemButton,
    );
    this.sidebar.appendChild(this.hudButtons);

    this.statusLine = el('div', 'status-line', 'status-line');
    this.sidebar.appendChild(this.statusLine);

    this.backdrop = el('div', 'hud-backdrop', 'hud-backdrop');
    this.backdrop.addEventListener('click', () => {
      this.closeDrawer();
    });

    this.bottomBar = el('div', 'bottom-bar', 'resource-bar');
    const cells = el('div', 'resource-cells');
    for (const id of RESOURCE_IDS) {
      const cell = el('span', 'resource-cell', `resource-${id}`);
      const label = el('span', 'resource-label');
      label.textContent = `${id}: `;
      const value = el('span', 'resource-value');
      cell.append(label, value);
      this.resourceCells.set(id, value);
      cells.appendChild(cell);
    }
    this.menuToggle = el('button', 'hud-button hud-menu-toggle', 'hud-menu-toggle');
    this.menuToggle.textContent = '☰';
    this.menuToggle.setAttribute('aria-label', 'Toggle menu');
    this.menuToggle.addEventListener('click', () => {
      this.toggleDrawer();
    });
    this.bottomBar.append(cells, this.menuToggle);

    this.narrowQuery = window.matchMedia(NARROW_SCREEN_QUERY);
    this.narrowQuery.addEventListener('change', this.onNarrowChange);
    this.placeActionButtons(this.narrowQuery.matches);
  }

  destroy(): void {
    this.narrowQuery.removeEventListener('change', this.onNarrowChange);
  }

  // --- narrow-screen drawer ---

  private placeActionButtons(narrow: boolean): void {
    if (narrow) {
      this.bottomBar.insertBefore(this.nextHeroButton, this.menuToggle);
      this.bottomBar.insertBefore(this.endTurnButton, this.menuToggle);
    } else {
      this.hudButtons.insertBefore(this.nextHeroButton, this.spellbookButton);
      this.hudButtons.insertBefore(this.endTurnButton, this.systemButton);
    }
  }

  private toggleDrawer(): void {
    if (this.sidebar.classList.contains('open')) this.closeDrawer();
    else this.openDrawer();
  }

  private openDrawer(): void {
    this.sidebar.classList.add('open');
    this.backdrop.classList.add('open');
  }

  private closeDrawer(): void {
    this.sidebar.classList.remove('open');
    this.backdrop.classList.remove('open');
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
        this.closeDrawer();
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
        this.closeDrawer();
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

  // the popup positions and clamps itself inside this (positioned) container
  constructor(
    private readonly container: HTMLElement,
    testId = 'info-popup',
  ) {
    this.root = el('div', 'info-popup', testId);
    this.root.style.display = 'none';
    container.appendChild(this.root);
  }

  show(text: string, x: number, y: number): void {
    this.root.textContent = text;
    this.root.style.display = 'block';
    // measure after display so a long-press near the right/bottom edge of a
    // narrow screen keeps the popup inside its positioned container; ceil the
    // fractional layout size or the clamp leaves a sub-pixel overhang
    const rect = this.root.getBoundingClientRect();
    const [px, py] = clampPopupPosition(
      x,
      y,
      Math.ceil(rect.width),
      Math.ceil(rect.height),
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.root.style.left = `${String(px)}px`;
    this.root.style.top = `${String(py)}px`;
  }

  hide(): void {
    this.root.style.display = 'none';
  }
}
