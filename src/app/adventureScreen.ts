import type { GameData } from '../data';
import type { Pos } from '../maps/schema';
import { chooseAICommand } from '../core/ai/adventureAI';
import { CommandRejectedError, dispatch, type Command, type GameEvent } from '../core/commands';
import { CombatRuleError } from '../core/combat/state';
import { visibleTiles } from '../core/fog';
import { maxMovementPoints } from '../core/hero';
import { buildMoveContext, findPath, stepCost } from '../core/movement';
import type { GameState, Hero, Player } from '../core/state';
import { centerCameraOn, panCamera, tileAtScreen, TILE_PX, type Camera } from '../render/camera';
import {
  AdventureRenderer,
  minimapTile,
  renderMinimap,
  type AdventureView,
} from '../render/adventureRenderer';
import { TokenPainter } from '../render/painter';
import { splitPathByDays, type PathStepPreview } from '../render/pathPreview';
import { CombatScreen } from '../ui/combatScreen';
import type { UiContext } from '../ui/components';
import { DialogQueue } from '../ui/dialogs';
import { HeroScreen } from '../ui/heroScreen';
import { Hud, InfoPopup, MINIMAP_PX } from '../ui/hud';
import { TownScreen } from '../ui/townScreen';
import type { Screen } from './screens';

export const CANVAS_W = 1000;
export const CANVAS_H = 760;

const EDGE_SCROLL_MARGIN = 16;
const EDGE_SCROLL_SPEED = 10;
const KEY_SCROLL_STEP = TILE_PX;
const AI_COMMAND_LIMIT = 2000;

interface PendingPath {
  dest: Pos;
  path: Pos[];
  preview: PathStepPreview[];
}

export class AdventureScreen implements Screen {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: AdventureRenderer;
  private readonly minimapCtx: CanvasRenderingContext2D;
  private readonly hud: Hud;
  private readonly infoPopup: InfoPopup;
  private readonly dialogs: DialogQueue;
  private activePanel: TownScreen | HeroScreen | null = null;
  private combatPanel: CombatScreen | null = null;

  private state: GameState;
  private camera: Camera;
  private selectedHero: string | null = null;
  private pendingPath: PendingPath | null = null;
  private dirty = true;
  private mousePos: [number, number] | null = null;
  private dragFrom: [number, number] | null = null;
  private running = false;
  private aiTurnRunning = false;

  constructor(
    private readonly data: GameData,
    initialState: GameState,
  ) {
    this.state = initialState;

    this.root = document.createElement('div');
    this.root.className = 'adventure-screen';
    this.root.dataset.testid = 'adventure-screen';

    const main = document.createElement('div');
    main.className = 'adventure-main';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'canvas-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.canvas.dataset.testid = 'adventure-canvas';
    canvasWrap.appendChild(this.canvas);

    this.infoPopup = new InfoPopup();
    canvasWrap.appendChild(this.infoPopup.root);

    this.dialogs = new DialogQueue(this.uiContext(), () => {
      this.markDirty();
    });

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.renderer = new AdventureRenderer(ctx, new TokenPainter(), this.data);

    this.hud = new Hud(this.data, {
      onEndTurn: () => {
        this.endTurn();
      },
      onNextHero: () => {
        this.selectNextHero();
      },
      onSelectHero: (id) => {
        this.selectHero(id, true);
      },
      onSelectTown: (id) => {
        this.centerOnTown(id);
        this.openTownScreen(id);
      },
      onOpenHeroScreen: () => {
        if (this.selectedHero !== null) this.openHeroScreen(this.selectedHero, null);
      },
      onMinimapClick: (px, py) => {
        this.jumpToMinimap(px, py);
      },
    });
    const minimapCtx = this.hud.minimapCanvas.getContext('2d');
    if (!minimapCtx) throw new Error('minimap 2d context unavailable');
    this.minimapCtx = minimapCtx;

    main.append(canvasWrap, this.hud.sidebar);
    this.root.append(main, this.hud.bottomBar, this.dialogs.root);

    const startHero = this.viewPlayer().heroes[0];
    this.camera = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H };
    if (startHero !== undefined) {
      this.selectedHero = startHero;
      const hero = this.state.heroes[startHero];
      if (hero) {
        this.camera = centerCameraOn(this.camera, hero.pos, this.state.map.size);
      }
    }

    this.bindInput();
  }

  onShow(): void {
    this.running = true;
    this.dirty = true;
    requestAnimationFrame(this.frame);
  }

  onHide(): void {
    this.running = false;
  }

  // --- state / commands ---

  private viewPlayer(): Player {
    const player = this.state.players.find((p) => p.isHuman) ?? this.state.players[0];
    if (!player) throw new Error('no players in game state');
    return player;
  }

  private uiContext(): UiContext {
    return {
      data: this.data,
      playerId: this.viewPlayer().id,
      getState: () => this.state,
      run: (command) => this.runForUi(command),
    };
  }

  // dispatches a command, returns the rejection message or null on success
  private runForUi(command: Command): string | null {
    try {
      const result = dispatch(this.state, command, this.data);
      this.state = result.state;
      this.handleEvents(result.events);
      this.markDirty();
      return null;
    } catch (err) {
      if (err instanceof CommandRejectedError || err instanceof CombatRuleError) {
        this.hud.setStatus(err.message);
        this.markDirty();
        return err.message;
      }
      throw err;
    }
  }

  private runCommand(command: Command): boolean {
    return this.runForUi(command) === null;
  }

  private handleEvents(events: GameEvent[]): void {
    const xpGained = events.reduce(
      (sum, e) => (e.type === 'heroXpGained' ? sum + e.amount : sum),
      0,
    );
    for (const event of events) {
      switch (event.type) {
        case 'weekStarted':
          this.dialogs.enqueueInfo(`Week ${String(event.week)} begins`);
          break;
        case 'dayStarted':
          this.hud.setStatus(`Day ${String(event.day)}`);
          break;
        case 'messageShown':
          this.dialogs.enqueueInfo(event.message);
          break;
        case 'combatResolved':
          this.dialogs.enqueueInfo(this.combatResultText(event, xpGained));
          break;
        case 'heroLevelUp':
          this.hud.setStatus(`Level up: +1 ${event.stat}`);
          break;
        case 'gameOver':
          this.hud.setStatus(`Game over — ${event.winner} wins!`);
          break;
        default:
          break;
      }
    }
    this.syncCombatPanel();
    if (this.combatPanel) {
      this.combatPanel.consume(events);
      this.combatPanel.ensureAiActs();
    }
    this.maybeResumeAiTurns();
  }

  // create/destroy the combat overlay so it always mirrors state.combat;
  // AI-vs-neutral battles during enemy turns stay off-screen
  private syncCombatPanel(): void {
    if (this.state.combat !== null && this.humanInCombat() && !this.combatPanel) {
      this.combatPanel = new CombatScreen(this.uiContext());
      this.root.appendChild(this.combatPanel.root);
    } else if ((this.state.combat === null || !this.humanInCombat()) && this.combatPanel) {
      this.combatPanel.destroy();
      this.combatPanel = null;
    }
    this.markDirty();
  }

  private humanInCombat(): boolean {
    const combat = this.state.combat;
    if (!combat) return false;
    const humanId = this.viewPlayer().id;
    return (
      combat.combat.attackerHero.player === humanId ||
      combat.combat.defenderHero.player === humanId
    );
  }

  // --- AI turns ---

  // run AI players until it is a human's turn again, the game ends, or a
  // battle / pending choice needs the human's attention; also resolves
  // choices owned by AI players that arise off-turn (e.g. an AI defender's
  // level-up after surviving the human's attack)
  private maybeResumeAiTurns(): void {
    if (this.aiTurnRunning) return;
    this.aiTurnRunning = true;
    try {
      let guard = 0;
      while (guard++ < AI_COMMAND_LIMIT && this.state.status === 'running') {
        if (this.state.combat !== null && this.humanInCombat()) break;
        const aiChoice = this.state.pendingChoices.find(
          (c) => this.state.players.find((p) => p.id === c.player)?.isHuman === false,
        );
        if (aiChoice) {
          const resolve: Command = {
            type: 'resolveChoice',
            player: aiChoice.player,
            choiceId: aiChoice.id,
            option: 0,
          };
          if (!this.runCommand(resolve)) break;
          continue;
        }
        if (this.state.pendingChoices.length > 0) break;
        const player = this.state.players.find((p) => p.id === this.state.currentPlayer);
        if (!player || player.isHuman || player.defeated) break;
        this.hud.setStatus(`Enemy turn — ${player.id}…`);
        if (!this.runCommand(chooseAICommand(this.state, this.data))) break;
      }
    } finally {
      this.aiTurnRunning = false;
    }
  }

  private combatResultText(
    event: Extract<GameEvent, { type: 'combatResolved' }>,
    xpGained: number,
  ): string {
    const attacker = this.state.heroes[event.attacker]?.name ?? event.attacker;
    if (event.outcome === 'fled') return `${attacker} fled from the battle.`;
    if (event.outcome === 'attacker') {
      const xp = xpGained > 0 ? ` (+${String(xpGained)} XP)` : '';
      return `${attacker} is victorious!${xp}`;
    }
    return `${attacker} was defeated.`;
  }

  // --- overlay panels (town / hero screens) ---

  private closePanel(): void {
    if (!this.activePanel) return;
    this.activePanel.root.remove();
    this.activePanel = null;
    this.markDirty();
  }

  private openTownScreen(townId: string): void {
    const town = this.state.towns[townId];
    if (town?.owner !== this.viewPlayer().id) return;
    this.closePanel();
    this.activePanel = new TownScreen(this.uiContext(), townId, () => {
      this.closePanel();
    });
    this.root.appendChild(this.activePanel.root);
    this.markDirty();
  }

  private openHeroScreen(heroId: string, secondHeroId: string | null): void {
    this.closePanel();
    this.activePanel = new HeroScreen(this.uiContext(), heroId, secondHeroId, () => {
      this.closePanel();
    });
    this.root.appendChild(this.activePanel.root);
    this.markDirty();
  }

  private endTurn(): void {
    this.pendingPath = null;
    // AI turns run from handleEvents (maybeResumeAiTurns) once the turn passes
    this.runCommand({ type: 'endTurn', player: this.state.currentPlayer });
  }

  // --- selection and movement ---

  private selectHero(id: string, center: boolean): void {
    const hero = this.state.heroes[id];
    if (hero?.owner !== this.viewPlayer().id) return;
    this.selectedHero = id;
    this.pendingPath = null;
    if (center) {
      this.camera = centerCameraOn(this.camera, hero.pos, this.state.map.size);
    }
    this.markDirty();
  }

  private selectNextHero(): void {
    const ids = this.viewPlayer().heroes;
    if (ids.length === 0) return;
    const at = this.selectedHero !== null ? ids.indexOf(this.selectedHero) : -1;
    const next = ids[(at + 1) % ids.length];
    if (next !== undefined) this.selectHero(next, true);
  }

  private centerOnTown(id: string): void {
    const town = this.state.towns[id];
    if (!town) return;
    this.camera = centerCameraOn(this.camera, town.pos, this.state.map.size);
    this.markDirty();
  }

  private jumpToMinimap(px: number, py: number): void {
    const tile = minimapTile(px, py, MINIMAP_PX, this.state.map.size);
    this.camera = centerCameraOn(this.camera, tile, this.state.map.size);
    this.markDirty();
  }

  private heroAt(pos: Pos): Hero | null {
    for (const id of this.viewPlayer().heroes) {
      const hero = this.state.heroes[id];
      if (hero?.pos[0] === pos[0] && hero.pos[1] === pos[1]) return hero;
    }
    return null;
  }

  private handleTileClick(tile: Pos): void {
    const ownHero = this.heroAt(tile);
    if (ownHero) {
      const selected = this.selectedHero !== null ? this.state.heroes[this.selectedHero] : null;
      const adjacent =
        selected &&
        selected.id !== ownHero.id &&
        Math.max(
          Math.abs(selected.pos[0] - ownHero.pos[0]),
          Math.abs(selected.pos[1] - ownHero.pos[1]),
        ) <= 1;
      if (selected && adjacent === true) {
        this.openHeroScreen(selected.id, ownHero.id);
        return;
      }
      this.selectHero(ownHero.id, false);
      return;
    }
    if (this.selectedHero === null) return;
    const hero = this.state.heroes[this.selectedHero];
    if (!hero) return;

    if (this.pendingPath?.dest[0] === tile[0] && this.pendingPath.dest[1] === tile[1]) {
      const path = this.pendingPath.path;
      this.pendingPath = null;
      this.runCommand({ type: 'moveHero', player: hero.owner, hero: hero.id, path });
      return;
    }

    const path = findPath(this.state, this.data, hero, tile);
    if (!path || path.length === 0) {
      this.pendingPath = null;
      this.hud.setStatus('No path to that tile');
      this.markDirty();
      return;
    }
    const ctx = buildMoveContext(this.state, this.data, hero);
    const costs = path.map((step, i) => {
      const from = i === 0 ? hero.pos : (path[i - 1] ?? hero.pos);
      return stepCost(ctx, from, step);
    });
    const preview = splitPathByDays(
      path,
      costs,
      hero.movementPoints,
      maxMovementPoints(hero, this.data),
    );
    this.pendingPath = { dest: [...tile], path, preview };
    this.hud.setStatus('Click again to move');
    this.markDirty();
  }

  // --- info popup ---

  private describeTile(tile: Pos): string {
    const player = this.viewPlayer();
    const size = this.state.map.size;
    if (!(player.explored[tile[1] * size + tile[0]] ?? false)) {
      return 'Unexplored';
    }
    for (const hero of Object.values(this.state.heroes)) {
      if (hero.pos[0] === tile[0] && hero.pos[1] === tile[1]) {
        return `${hero.name}, level ${String(hero.level)} (${hero.owner})`;
      }
    }
    for (const obj of this.state.map.objects) {
      if (obj.removed || obj.at[0] !== tile[0] || obj.at[1] !== tile[1]) continue;
      if (obj.type === 'town') {
        const town = Object.values(this.state.towns).find(
          (t) => t.pos[0] === tile[0] && t.pos[1] === tile[1],
        );
        return town ? `${town.name} (${town.owner ?? 'neutral'})` : 'Town';
      }
      const typeName = this.data.objectTypes[obj.type]?.name ?? obj.type;
      const sub =
        obj.type === 'mine'
          ? this.data.objectTypes.mine?.subtypes?.find((s) => s.id === obj.subtype)?.name
          : obj.subtype;
      let text = sub !== undefined ? `${sub} (${typeName})` : typeName;
      if (obj.owner !== null) text += `, owned by ${obj.owner}`;
      if (obj.guard) {
        const guardName = this.data.creatures[obj.guard.creature]?.name ?? obj.guard.creature;
        text += ` — guarded by ${String(obj.guard.count)} ${guardName}`;
      }
      if (obj.type === 'monster' && obj.creature !== undefined) {
        const name = this.data.creatures[obj.creature]?.name ?? obj.creature;
        text = `${String(obj.count ?? 0)} ${name}`;
      }
      return text;
    }
    const terrainChar = this.state.map.terrain[tile[1] * size + tile[0]] ?? '';
    const terrain = Object.values(this.data.terrains).find((t) => t.char === terrainChar);
    return terrain?.name ?? 'Unknown';
  }

  // --- input ---

  private bindInput(): void {
    this.canvas.addEventListener('click', (e) => {
      this.infoPopup.hide();
      const rect = this.canvas.getBoundingClientRect();
      const tile = tileAtScreen(
        this.camera,
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.state.map.size,
      );
      if (tile) this.handleTileClick(tile);
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const tile = tileAtScreen(this.camera, sx, sy, this.state.map.size);
      if (tile) {
        this.infoPopup.show(this.describeTile(tile), sx + 8, sy + 8);
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this.dragFrom) {
        this.camera = panCamera(
          this.camera,
          this.dragFrom[0] - sx,
          this.dragFrom[1] - sy,
          this.state.map.size,
        );
        this.dragFrom = [sx, sy];
        this.markDirty();
      }
      this.mousePos = [sx, sy];
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mousePos = null;
      this.dragFrom = null;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.dragFrom = [e.clientX - rect.left, e.clientY - rect.top];
      }
    });
    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.dragFrom = null;
    });

    window.addEventListener('keydown', (e) => {
      if (!this.running) return;
      if (e.key === 'Escape' && this.activePanel && this.dialogs.root.style.display === 'none') {
        this.closePanel();
        return;
      }
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [-KEY_SCROLL_STEP, 0],
        ArrowRight: [KEY_SCROLL_STEP, 0],
        ArrowUp: [0, -KEY_SCROLL_STEP],
        ArrowDown: [0, KEY_SCROLL_STEP],
      };
      const delta = pan[e.key];
      if (delta) {
        e.preventDefault();
        this.camera = panCamera(this.camera, delta[0], delta[1], this.state.map.size);
        this.markDirty();
      }
    });
  }

  private edgeScroll(): void {
    if (!this.mousePos || this.dragFrom) return;
    const [sx, sy] = this.mousePos;
    let dx = 0;
    let dy = 0;
    if (sx < EDGE_SCROLL_MARGIN) dx = -EDGE_SCROLL_SPEED;
    else if (sx > CANVAS_W - EDGE_SCROLL_MARGIN) dx = EDGE_SCROLL_SPEED;
    if (sy < EDGE_SCROLL_MARGIN) dy = -EDGE_SCROLL_SPEED;
    else if (sy > CANVAS_H - EDGE_SCROLL_MARGIN) dy = EDGE_SCROLL_SPEED;
    if (dx !== 0 || dy !== 0) {
      const moved = panCamera(this.camera, dx, dy, this.state.map.size);
      if (moved.x !== this.camera.x || moved.y !== this.camera.y) {
        this.camera = moved;
        this.markDirty();
      }
    }
  }

  // --- render loop ---

  private markDirty(): void {
    this.dirty = true;
  }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.edgeScroll();
    if (this.dirty) {
      this.dirty = false;
      this.renderAll();
    }
    requestAnimationFrame(this.frame);
  };

  private renderAll(): void {
    const player = this.viewPlayer();
    if (this.selectedHero !== null && !(this.selectedHero in this.state.heroes)) {
      this.selectedHero = null;
    }
    const view: AdventureView = {
      state: this.state,
      player,
      visible: visibleTiles(this.state, player, this.data),
      camera: this.camera,
      selectedHero: this.selectedHero,
      pathPreview: this.pendingPath?.preview ?? null,
    };
    this.renderer.render(view);
    renderMinimap(this.minimapCtx, view, MINIMAP_PX, this.data);
    this.hud.update(this.state, player, this.selectedHero);
    this.canvas.dataset.cameraX = String(Math.round(this.camera.x));
    this.canvas.dataset.cameraY = String(Math.round(this.camera.y));
    this.activePanel?.update();
    this.combatPanel?.update();
    this.dialogs.update(this.state);
  }
}
