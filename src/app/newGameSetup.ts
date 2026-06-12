import type { GameData } from '../data';
import type { FactionId, HeroTemplate } from '../data/schema';
import type { GameMap, PlayerColor } from '../maps/schema';
import { DIFFICULTIES, type Difficulty } from '../core/setup';
import type { Screen } from './screens';

export { DIFFICULTIES, type Difficulty };

export interface PlayerSetup {
  color: PlayerColor;
  faction: FactionId;
  isHuman: boolean;
}

export function heroesOfFaction(data: GameData, faction: FactionId): HeroTemplate[] {
  return Object.values(data.heroes).filter(
    (hero) => data.heroClasses[hero.class]?.faction === faction,
  );
}

// apply setup-screen choices to a map: per-player faction (with a matching
// starting hero) and human/AI control; hero templates are never duplicated
// and heroes locked in map prisons are never handed out as start heroes
export function configureMap(map: GameMap, data: GameData, setups: PlayerSetup[]): GameMap {
  const usedHeroes = new Set<string>();
  for (const obj of map.objects) {
    if (obj.type === 'prison' && obj.hero !== undefined) {
      usedHeroes.add(obj.hero);
    }
  }
  const players = map.players.map((player) => {
    const setup = setups.find((s) => s.color === player.color);
    const faction = setup?.faction ?? player.faction;
    const isHuman = setup?.isHuman ?? player.isHuman;
    let startHero = player.startHero;
    const heroFaction = data.heroClasses[data.heroes[startHero]?.class ?? '']?.faction;
    if (heroFaction !== faction || usedHeroes.has(startHero)) {
      const candidate = heroesOfFaction(data, faction).find((h) => !usedHeroes.has(h.id));
      if (!candidate) {
        throw new Error(`no free hero template for faction ${faction}`);
      }
      startHero = candidate.id;
    }
    usedHeroes.add(startHero);
    return { ...player, faction, isHuman, startHero };
  });
  return { ...map, players };
}

export interface NewGameSetupCallbacks {
  onStart: (map: GameMap, difficulty: Difficulty, seed: number) => void;
  onBack: () => void;
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

export class NewGameSetup implements Screen {
  readonly root: HTMLElement;
  private readonly playerRows: HTMLElement;
  private readonly status: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly difficultySelect: HTMLSelectElement;
  private readonly hotseatToggle: HTMLInputElement;
  private selectedMap: GameMap;
  private factionPicks = new Map<PlayerColor, FactionId>();

  constructor(
    private readonly data: GameData,
    maps: GameMap[],
    private readonly callbacks: NewGameSetupCallbacks,
  ) {
    const first = maps[0];
    if (!first) throw new Error('no maps available');
    this.selectedMap = first;

    this.root = el('div', 'menu-screen', 'new-game-setup');
    const box = el('div', 'menu-box setup-box');

    const title = el('div', 'menu-title');
    title.textContent = 'New Game';
    box.appendChild(title);

    const mapSection = el('div', 'menu-section');
    const mapLabel = el('div', 'menu-section-title');
    mapLabel.textContent = 'Map';
    mapSection.appendChild(mapLabel);
    const mapList = el('div', 'map-list', 'map-list');
    for (const map of maps) {
      const option = el('button', 'map-option', `map-option-${map.id}`);
      option.textContent = `${map.name} — ${String(map.size)}×${String(map.size)}, ${String(map.players.length)} players`;
      option.addEventListener('click', () => {
        this.selectMap(map);
      });
      mapList.appendChild(option);
    }
    mapSection.appendChild(mapList);
    box.appendChild(mapSection);

    const optionsRow = el('div', 'setup-options');

    const difficultyLabel = el('label', 'setup-option');
    difficultyLabel.textContent = 'Difficulty ';
    this.difficultySelect = el('select', 'trade-select', 'difficulty-select');
    for (const difficulty of DIFFICULTIES) {
      const option = document.createElement('option');
      option.value = difficulty;
      option.textContent = difficulty;
      this.difficultySelect.appendChild(option);
    }
    this.difficultySelect.value = 'normal';
    difficultyLabel.appendChild(this.difficultySelect);

    const hotseatLabel = el('label', 'setup-option');
    this.hotseatToggle = el('input', 'setup-checkbox', 'hotseat-toggle');
    this.hotseatToggle.type = 'checkbox';
    this.hotseatToggle.addEventListener('change', () => {
      this.renderPlayers();
    });
    hotseatLabel.append(this.hotseatToggle, document.createTextNode(' Hotseat (2nd player human)'));

    const seedLabel = el('label', 'setup-option');
    seedLabel.textContent = 'Seed ';
    this.seedInput = el('input', 'count-input', 'seed-input');
    this.seedInput.type = 'number';
    this.seedInput.value = String(Math.floor(Math.random() * 1_000_000));
    seedLabel.appendChild(this.seedInput);

    optionsRow.append(difficultyLabel, hotseatLabel, seedLabel);
    box.appendChild(optionsRow);

    const playersSection = el('div', 'menu-section');
    const playersLabel = el('div', 'menu-section-title');
    playersLabel.textContent = 'Players';
    this.playerRows = el('div', 'player-rows', 'player-rows');
    playersSection.append(playersLabel, this.playerRows);
    box.appendChild(playersSection);

    this.status = el('div', 'panel-status', 'setup-status');
    box.appendChild(this.status);

    const buttons = el('div', 'menu-buttons');
    const start = el('button', 'menu-button', 'start-game');
    start.textContent = 'Start Game';
    start.addEventListener('click', () => {
      this.start();
    });
    const back = el('button', 'menu-button', 'setup-back');
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      this.callbacks.onBack();
    });
    buttons.append(start, back);
    box.appendChild(buttons);

    this.root.appendChild(box);
    this.selectMap(first);
  }

  private selectMap(map: GameMap): void {
    this.selectedMap = map;
    this.factionPicks = new Map(map.players.map((p) => [p.color, p.faction]));
    for (const option of this.root.querySelectorAll('.map-option')) {
      option.classList.toggle(
        'selected',
        option.getAttribute('data-testid') === `map-option-${map.id}`,
      );
    }
    this.renderPlayers();
  }

  private playerSetups(): PlayerSetup[] {
    return this.selectedMap.players.map((player, i) => ({
      color: player.color,
      faction: this.factionPicks.get(player.color) ?? player.faction,
      isHuman: i === 0 || (i === 1 && this.hotseatToggle.checked),
    }));
  }

  private renderPlayers(): void {
    this.playerRows.replaceChildren();
    const setups = this.playerSetups();
    for (const setup of setups) {
      const row = el('div', 'player-row', `player-row-${setup.color}`);
      const colorTag = el('span', `player-color player-color-${setup.color}`);
      colorTag.textContent = setup.color;
      const control = el('span', 'player-control', `player-control-${setup.color}`);
      control.textContent = setup.isHuman ? 'Human' : 'AI';
      const faction = el('select', 'trade-select', `faction-select-${setup.color}`);
      for (const entry of Object.values(this.data.factions)) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.id;
        faction.appendChild(option);
      }
      faction.value = setup.faction;
      faction.addEventListener('change', () => {
        const picked = Object.values(this.data.factions).find((f) => f.id === faction.value);
        if (picked) this.factionPicks.set(setup.color, picked.id);
      });
      row.append(colorTag, control, faction);
      this.playerRows.appendChild(row);
    }
  }

  private start(): void {
    const seed = Number(this.seedInput.value);
    if (!Number.isFinite(seed)) {
      this.status.textContent = 'Seed must be a number';
      return;
    }
    const difficulty = DIFFICULTIES.find((d) => d === this.difficultySelect.value) ?? 'normal';
    try {
      const map = configureMap(this.selectedMap, this.data, this.playerSetups());
      this.callbacks.onStart(map, difficulty, Math.floor(seed));
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
    }
  }
}
