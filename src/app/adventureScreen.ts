import type { GameData } from '../data';
import type { Pos } from '../maps/schema';
import { CommandRejectedError, dispatch, type Command, type GameEvent } from '../core/commands';
import { CombatRuleError } from '../core/combat/state';
import { visibleTiles } from '../core/fog';
import { maxMovementPoints } from '../core/hero';
import { buildMoveContext, findPath, stepCost } from '../core/movement';
import type { GameState, Hero, MapObjectState, Player, PlayerId } from '../core/state';
import {
  cameraForViewport,
  centerCameraOn,
  panCamera,
  tileAtClientPoint,
  TILE_PX,
  zoomCameraAt,
  type Camera,
} from '../render/camera';
import {
  AdventureRenderer,
  minimapTile,
  renderMinimap,
  type AdventureView,
} from '../render/adventureRenderer';
import { TokenPainter } from '../render/painter';
import { splitPathByDays, type PathStepPreview } from '../render/pathPreview';
import { CombatScreen } from '../ui/combatScreen';
import { el, openCountDialog, type UiContext } from '../ui/components';
import { DialogQueue } from '../ui/dialogs';
import { costText, recruitMax, scaledCost } from '../ui/helpers';
import { HeroScreen } from '../ui/heroScreen';
import { Hud, InfoPopup, MINIMAP_PX } from '../ui/hud';
import { adventureSpellbookEntries, SpellbookOverlay, type SpellbookEntry } from '../ui/spellbook';
import { SystemPanel } from '../ui/systemPanel';
import { TownScreen } from '../ui/townScreen';
import { AiDriver } from './aiDriver';
import { GestureRecognizer, type GestureAction, type GesturePointer } from './gestures';
import { autosave, type SaveStorage } from './saveload';
import { adventureShortcut, isTypingTarget, type AdventureShortcutAction } from './shortcuts';
import { canvasBackingSize, edgeScrollDelta } from './viewport';
import type { Screen } from './screens';

export interface ShellCallbacks {
  onExit: () => void;
  onLoad: (state: GameState) => void;
  storage: SaveStorage;
}

const EDGE_SCROLL_MARGIN = 16;
const EDGE_SCROLL_SPEED = 10;
const KEY_SCROLL_STEP = TILE_PX;
const WHEEL_ZOOM_STEP = 1.1;

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
  // live CSS size of the canvas, kept in sync by the ResizeObserver
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private readonly canvasWrap: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private selectedHero: string | null = null;
  private pendingPath: PendingPath | null = null;
  private dirty = true;
  private mousePos: [number, number] | null = null;
  private running = false;
  // set when a touch long-press already showed the info popup, so the
  // synthetic contextmenu that follows on some platforms is swallowed
  private suppressContextmenu = false;
  private readonly gestures = new GestureRecognizer(
    (action) => {
      this.applyGesture(action);
    },
    (cb, ms) => {
      const id = window.setTimeout(cb, ms);
      return () => {
        window.clearTimeout(id);
      };
    },
  );
  private readonly aiDriver: AiDriver;
  // aborting detaches every canvas/window listener bound in bindInput()
  private readonly inputAborter = new AbortController();
  // hotseat: the human player whose perspective is rendered; a "pass device"
  // overlay gates the switch when another human's turn starts
  private viewPlayerId: string;
  private readonly passOverlay: HTMLElement;
  private readonly gameOverOverlay: HTMLElement;
  private systemPanel: SystemPanel | null = null;
  // adventure spellbook (Town Portal / Dimension Door, spec §10.2)
  private advSpellbook: SpellbookOverlay | null = null;
  private townPortalPick: HTMLElement | null = null;
  // when set, the next canvas click casts this spell at the clicked tile
  private tileTargetSpell: string | null = null;

  constructor(
    private readonly data: GameData,
    initialState: GameState,
    private readonly shell: ShellCallbacks,
  ) {
    this.state = initialState;
    const current = initialState.players.find((p) => p.id === initialState.currentPlayer);
    const firstHuman = initialState.players.find((p) => p.isHuman);
    this.viewPlayerId =
      (current?.isHuman === true ? current.id : firstHuman?.id) ??
      initialState.players[0]?.id ??
      'red';

    this.root = document.createElement('div');
    this.root.className = 'adventure-screen';
    this.root.dataset.testid = 'adventure-screen';

    const main = document.createElement('div');
    main.className = 'adventure-main';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'canvas-wrap';
    this.canvasWrap = canvasWrap;
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.testid = 'adventure-canvas';
    canvasWrap.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => {
      this.syncViewport();
    });
    this.resizeObserver.observe(canvasWrap);

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
      onOpenSpellbook: () => {
        this.openAdventureSpellbook();
      },
      onMinimapClick: (px, py) => {
        this.jumpToMinimap(px, py);
      },
      onOpenSystem: () => {
        this.openSystemPanel();
      },
    });
    const minimapCtx = this.hud.minimapCanvas.getContext('2d');
    if (!minimapCtx) throw new Error('minimap 2d context unavailable');
    this.minimapCtx = minimapCtx;

    this.passOverlay = document.createElement('div');
    this.passOverlay.className = 'pass-overlay';
    this.passOverlay.dataset.testid = 'pass-device';
    this.passOverlay.style.display = 'none';

    this.gameOverOverlay = document.createElement('div');
    this.gameOverOverlay.className = 'game-over-overlay';
    this.gameOverOverlay.dataset.testid = 'game-over';
    this.gameOverOverlay.style.display = 'none';

    main.append(canvasWrap, this.hud.sidebar);
    this.root.append(
      main,
      this.hud.bottomBar,
      this.dialogs.root,
      this.passOverlay,
      this.gameOverOverlay,
    );

    // zero-size until the first syncViewport: centerCameraOn stores the focus
    // point, cameraForViewport preserves it once the CSS size is known
    const startHero = this.viewPlayer().heroes[0];
    this.camera = { x: 0, y: 0, width: 0, height: 0, zoom: 1 };
    if (startHero !== undefined) {
      this.selectedHero = startHero;
      const hero = this.state.heroes[startHero];
      if (hero) {
        this.camera = centerCameraOn(this.camera, hero.pos, this.state.map.size);
      }
    }

    this.bindInput();

    this.aiDriver = new AiDriver(
      {
        getState: () => this.state,
        runCommand: (command) => this.runCommand(command),
        humanInCombat: () => this.humanInCombat(),
        setStatus: (text) => {
          this.hud.setStatus(text);
        },
      },
      this.data,
    );

    // a loaded save can be mid-combat or mid-AI-turn: bring the combat panel
    // and the AI turn driver up immediately or the session is unplayable
    this.syncCombatPanel();
    this.combatPanel?.ensureAiActs();
    this.aiDriver.maybeResumeAiTurns();
    this.checkPassDevice();
  }

  onShow(): void {
    this.running = true;
    this.syncViewport();
    this.dirty = true;
    requestAnimationFrame(this.frame);
  }

  onHide(): void {
    this.running = false;
  }

  destroy(): void {
    this.running = false;
    this.resizeObserver.disconnect();
    this.inputAborter.abort();
    this.gestures.reset();
    this.dialogs.destroy();
    this.combatPanel?.destroy();
    this.combatPanel = null;
  }

  // keeps the canvas backing store (CSS size × dpr) and the camera viewport
  // in sync with the live layout; runs on ResizeObserver, window resize
  // (devicePixelRatio changes) and onShow
  private syncViewport(): void {
    const rect = this.canvasWrap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const backing = canvasBackingSize(rect.width, rect.height, this.dpr);
    if (this.canvas.width !== backing.width) this.canvas.width = backing.width;
    if (this.canvas.height !== backing.height) this.canvas.height = backing.height;
    this.camera = cameraForViewport(
      this.camera,
      rect.width,
      rect.height,
      this.camera.zoom,
      this.state.map.size,
    );
    this.markDirty();
  }

  private applyZoom(factor: number, anchorSx: number, anchorSy: number): void {
    this.camera = zoomCameraAt(
      this.camera,
      this.camera.zoom * factor,
      anchorSx,
      anchorSy,
      this.cssW,
      this.cssH,
      this.state.map.size,
    );
    this.markDirty();
  }

  // --- state / commands ---

  private viewPlayer(): Player {
    const player =
      this.state.players.find((p) => p.id === this.viewPlayerId) ??
      this.state.players.find((p) => p.isHuman) ??
      this.state.players[0];
    if (!player) throw new Error('no players in game state');
    return player;
  }

  private uiContext(): UiContext {
    const viewId = (): PlayerId => this.viewPlayer().id;
    return {
      data: this.data,
      // dynamic: in hotseat the viewing player changes between turns
      get playerId() {
        return viewId();
      },
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
          // a full localStorage must never break the turn/AI flow
          try {
            autosave(this.shell.storage, this.state);
          } catch {
            this.hud.setStatus(`Day ${String(event.day)} — autosave failed (storage unavailable)`);
          }
          break;
        case 'messageShown':
          this.dialogs.enqueueInfo(event.message);
          break;
        case 'townCaptured': {
          // garrison-only defenses are auto-resolved off-screen (no hero, no
          // combat panel), so losing a town must be surfaced explicitly
          const previous = event.previousOwner;
          const lostByHuman =
            previous !== null &&
            this.state.players.find((p) => p.id === previous)?.isHuman === true;
          if (lostByHuman) {
            const name = this.state.towns[event.town]?.name ?? event.town;
            this.dialogs.enqueueInfo(`${name} has been captured by ${event.player}!`);
          }
          break;
        }
        case 'combatResolved':
          // the combat panel is still open here iff the viewing player fought;
          // off-screen AI battles must not interrupt the player with dialogs
          if (this.combatPanel) {
            this.dialogs.enqueueInfo(this.combatResultText(event, xpGained));
          }
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
    this.maybeOfferDwellingRecruit(events);
    this.syncCombatPanel();
    if (this.combatPanel) {
      this.combatPanel.consume(events);
      this.combatPanel.ensureAiActs();
    }
    this.aiDriver.maybeResumeAiTurns();
    this.checkPassDevice();
  }

  // --- hotseat pass-device flow ---

  private checkPassDevice(): void {
    if (this.state.status !== 'running') return;
    const current = this.state.players.find((p) => p.id === this.state.currentPlayer);
    if (!current || !current.isHuman || current.defeated || current.id === this.viewPlayerId) {
      return;
    }
    this.passOverlay.replaceChildren();
    const box = document.createElement('div');
    box.className = 'menu-box';
    const message = document.createElement('div');
    message.className = 'menu-title';
    message.dataset.testid = 'pass-device-message';
    message.textContent = `Pass the device to ${current.id}`;
    const confirm = document.createElement('button');
    confirm.className = 'menu-button';
    confirm.dataset.testid = 'pass-device-confirm';
    confirm.textContent = `Start ${current.id}'s turn`;
    confirm.addEventListener('click', () => {
      this.switchViewTo(current.id);
    });
    box.append(message, confirm);
    this.passOverlay.appendChild(box);
    this.passOverlay.style.display = 'flex';
  }

  private switchViewTo(playerId: string): void {
    this.viewPlayerId = playerId;
    this.passOverlay.style.display = 'none';
    this.selectedHero = null;
    this.pendingPath = null;
    this.closePanel();
    this.closeAdventureSpellbook();
    this.closeTownPortalPick();
    this.cancelTileTargeting();
    const firstHero = this.viewPlayer().heroes[0];
    if (firstHero !== undefined) this.selectHero(firstHero, true);
    this.syncCombatPanel();
    this.markDirty();
  }

  // --- game over ---

  private updateGameOver(): void {
    const player = this.viewPlayer();
    const finished = this.state.status !== 'running';
    // while the game runs, only declare defeat if no human is left to play on
    // (in hotseat the device passes to the surviving human instead)
    const otherHumanAlive = this.state.players.some(
      (p) => p.isHuman && !p.defeated && p.id !== player.id,
    );
    if (!finished && (!player.defeated || otherHumanAlive)) {
      this.gameOverOverlay.style.display = 'none';
      return;
    }
    if (this.gameOverOverlay.style.display !== 'none') return;
    const won = this.state.status !== 'running' && this.state.status.winner === player.id;
    this.gameOverOverlay.replaceChildren();
    const box = document.createElement('div');
    box.className = 'menu-box';
    const message = document.createElement('div');
    message.className = 'menu-title';
    message.dataset.testid = 'game-over-message';
    message.textContent = won
      ? 'Victory! All enemies have been vanquished.'
      : `Defeat — ${this.state.status !== 'running' ? this.state.status.winner : 'the enemy'} prevails.`;
    const toMenu = document.createElement('button');
    toMenu.className = 'menu-button';
    toMenu.dataset.testid = 'game-over-menu';
    toMenu.textContent = 'Return to Menu';
    toMenu.addEventListener('click', () => {
      this.shell.onExit();
    });
    box.append(message, toMenu);
    this.gameOverOverlay.appendChild(box);
    this.gameOverOverlay.style.display = 'flex';
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

  // a combat needs the screen when ANY human owns a fighting hero (hotseat
  // battles included, not just the viewing player's). A garrison-only siege
  // of a human town has no defender hero: it is auto-resolved off-screen and
  // the outcome is surfaced via the townCaptured dialog (documented MVP rule)
  private humanInCombat(): boolean {
    const combat = this.state.combat;
    if (!combat) return false;
    const attacker = combat.combat.attackerHero.player;
    const defender = combat.combat.defenderHero.player;
    return this.state.players.some((p) => p.isHuman && (p.id === attacker || p.id === defender));
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

  // --- system panel (save / load / export / import / quit) ---

  private closeSystemPanel(): void {
    this.systemPanel?.root.remove();
    this.systemPanel = null;
  }

  private openSystemPanel(): void {
    this.closeSystemPanel();
    this.systemPanel = new SystemPanel({
      storage: this.shell.storage,
      getState: () => this.state,
      onLoad: this.shell.onLoad,
      onExit: this.shell.onExit,
      onClose: () => {
        this.closeSystemPanel();
      },
    });
    this.root.appendChild(this.systemPanel.root);
  }

  private endTurn(): void {
    this.pendingPath = null;
    // AI turns run from handleEvents (maybeResumeAiTurns) once the turn passes
    this.runCommand({ type: 'endTurn', player: this.state.currentPlayer });
  }

  // --- adventure spellbook (Town Portal / Dimension Door, spec §10.2) ---

  private closeAdventureSpellbook(): void {
    this.advSpellbook?.root.remove();
    this.advSpellbook = null;
  }

  private closeTownPortalPick(): void {
    this.townPortalPick?.remove();
    this.townPortalPick = null;
  }

  private cancelTileTargeting(): void {
    if (this.tileTargetSpell === null) return;
    this.tileTargetSpell = null;
    this.hud.setStatus('');
    this.markDirty();
  }

  private openAdventureSpellbook(): void {
    const hero = this.selectedHero !== null ? this.state.heroes[this.selectedHero] : null;
    if (hero?.owner !== this.viewPlayer().id) {
      this.hud.setStatus('Select a hero to open the spellbook');
      return;
    }
    if (!hero.hasSpellbook) {
      this.hud.setStatus(`${hero.name} has no spellbook`);
      return;
    }
    this.closeAdventureSpellbook();
    this.cancelTileTargeting();
    this.advSpellbook = new SpellbookOverlay(
      adventureSpellbookEntries(this.state, hero, this.data),
      (entry) => {
        this.closeAdventureSpellbook();
        this.pickAdventureSpell(hero.id, entry);
      },
      () => {
        this.closeAdventureSpellbook();
      },
    );
    this.root.appendChild(this.advSpellbook.root);
  }

  private pickAdventureSpell(heroId: string, entry: SpellbookEntry): void {
    const hero = this.state.heroes[heroId];
    if (!hero) return;
    if (entry.spell.id === 'dimension_door') {
      this.tileTargetSpell = entry.spell.id;
      this.hud.setStatus(`Click a target tile for ${entry.spell.name} (Esc cancels)`);
      return;
    }
    if (entry.spell.id === 'town_portal' && entry.tier >= 2) {
      // advanced+ earth magic: the destination town is the caster's choice
      this.openTownPortalPick(hero);
      return;
    }
    // basic town portal teleports to the nearest own town automatically
    this.runCommand({
      type: 'castAdventureSpell',
      player: hero.owner,
      hero: hero.id,
      spell: entry.spell.id,
    });
  }

  private openTownPortalPick(hero: Hero): void {
    this.closeTownPortalPick();
    const overlay = el('div', 'modal-overlay', 'town-portal-pick');
    const box = el('div', 'modal-box');
    const title = el('div', 'modal-message', 'town-portal-title');
    title.textContent = 'Town Portal: choose the destination town';
    box.appendChild(title);
    for (const townId of this.viewPlayer().towns) {
      const town = this.state.towns[townId];
      if (!town) continue;
      const occupied = town.visitingHero !== null && town.visitingHero !== hero.id;
      const pick = el('button', 'modal-button', `tp-town-${town.id}`);
      pick.textContent = occupied ? `${town.name} (occupied)` : town.name;
      pick.disabled = occupied;
      pick.addEventListener('click', () => {
        this.closeTownPortalPick();
        this.runCommand({
          type: 'castAdventureSpell',
          player: hero.owner,
          hero: hero.id,
          spell: 'town_portal',
          town: town.id,
        });
      });
      box.appendChild(pick);
    }
    const cancel = el('button', 'modal-button', 'tp-cancel');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this.closeTownPortalPick();
    });
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.style.display = 'flex';
    this.root.appendChild(overlay);
    this.townPortalPick = overlay;
  }

  // --- external dwelling recruiting (spec §8.3) ---

  // flagging or revisiting an own external dwelling offers recruitment
  private maybeOfferDwellingRecruit(events: GameEvent[]): void {
    if (this.state.combat !== null) return;
    for (const event of events) {
      if (event.type !== 'objectFlagged' && event.type !== 'objectVisited') continue;
      const obj = this.state.map.objects.find((o) => o.id === event.object);
      if (!obj || obj.removed || obj.type !== 'dwelling' || obj.creature === undefined) continue;
      if (obj.owner !== this.viewPlayer().id || (obj.count ?? 0) < 1) continue;
      const hero = this.heroAt(obj.at);
      if (!hero) continue;
      this.openDwellingRecruit(obj, hero);
      return;
    }
  }

  private openDwellingRecruit(obj: MapObjectState, hero: Hero): void {
    const creature = obj.creature === undefined ? undefined : this.data.creatures[obj.creature];
    if (!creature) return;
    const available = obj.count ?? 0;
    const max = recruitMax(available, creature.cost, this.viewPlayer().resources);
    if (max < 1) {
      this.hud.setStatus(`Cannot afford any ${creature.name}`);
      return;
    }
    openCountDialog(this.root, {
      title: `Recruit ${creature.name} (${String(available)} available)`,
      min: 1,
      max,
      initial: max,
      describe: (count) => `Cost: ${costText(scaledCost(creature.cost, count))}`,
      onConfirm: (count) => {
        this.runCommand({
          type: 'recruitDwelling',
          player: hero.owner,
          object: obj.id,
          hero: hero.id,
          count,
        });
      },
    });
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
    if (this.tileTargetSpell !== null) {
      const spell = this.tileTargetSpell;
      const hero = this.selectedHero !== null ? this.state.heroes[this.selectedHero] : null;
      this.tileTargetSpell = null;
      this.hud.setStatus('');
      if (hero?.owner === this.viewPlayer().id) {
        this.runCommand({
          type: 'castAdventureSpell',
          player: hero.owner,
          hero: hero.id,
          spell,
          dest: [...tile],
        });
      }
      this.markDirty();
      return;
    }
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
    const index = tile[1] * size + tile[0];
    if (!(player.explored[index] ?? false)) {
      return 'Unexplored';
    }
    // fog of war: live heroes and live object state are only described on
    // tiles in current sight; fogged-but-explored tiles use the last-seen
    // snapshot (no enemy hero positions, no live guard counts or owners)
    const visible = visibleTiles(this.state, player, this.data)[index] ?? false;
    if (!visible) {
      return this.describeSeenTile(player, tile) ?? this.describeTerrain(tile);
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
    return this.describeTerrain(tile);
  }

  private describeSeenTile(player: Player, tile: Pos): string | null {
    for (const seen of Object.values(player.seenObjects)) {
      if (seen.removed || seen.at[0] !== tile[0] || seen.at[1] !== tile[1]) continue;
      if (seen.type === 'town') {
        const town = Object.values(this.state.towns).find(
          (t) => t.pos[0] === tile[0] && t.pos[1] === tile[1],
        );
        return `${town?.name ?? 'Town'} (${seen.owner ?? 'neutral'})`;
      }
      const typeName = this.data.objectTypes[seen.type]?.name ?? seen.type;
      const sub =
        seen.type === 'mine'
          ? this.data.objectTypes.mine?.subtypes?.find((s) => s.id === seen.subtype)?.name
          : seen.subtype;
      let text = sub !== undefined ? `${sub} (${typeName})` : typeName;
      if (seen.owner !== null) text += `, owned by ${seen.owner}`;
      return text;
    }
    return null;
  }

  private describeTerrain(tile: Pos): string {
    const size = this.state.map.size;
    const terrainChar = this.state.map.terrain[tile[1] * size + tile[0]] ?? '';
    const terrain = Object.values(this.data.terrains).find((t) => t.char === terrainChar);
    return terrain?.name ?? 'Unknown';
  }

  // --- input ---

  // pointer events → gesture FSM → semantic actions
  private applyGesture(action: GestureAction): void {
    switch (action.type) {
      case 'tap': {
        this.infoPopup.hide();
        const tile = tileAtClientPoint(this.camera, action.x, action.y, this.state.map.size);
        if (tile) this.handleTileClick(tile);
        break;
      }
      case 'longPress': {
        this.suppressContextmenu = true;
        const tile = tileAtClientPoint(this.camera, action.x, action.y, this.state.map.size);
        if (tile) {
          this.infoPopup.show(this.describeTile(tile), action.x + 8, action.y + 8);
        }
        break;
      }
      case 'panBy':
        // CSS px → world px so the map tracks the pointer 1:1 at any zoom
        this.camera = panCamera(
          this.camera,
          action.dx / this.camera.zoom,
          action.dy / this.camera.zoom,
          this.state.map.size,
        );
        this.markDirty();
        break;
      case 'pinch':
        this.applyZoom(action.scale, action.cx, action.cy);
        break;
      case 'hover':
        this.mousePos = [action.x, action.y];
        break;
    }
  }

  private gesturePointer(e: PointerEvent): GesturePointer {
    const rect = this.canvas.getBoundingClientRect();
    return {
      pointerId: e.pointerId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pointerType: e.pointerType,
      button: e.button,
    };
  }

  private bindInput(): void {
    const opts = { signal: this.inputAborter.signal };
    this.canvas.addEventListener(
      'pointerdown',
      (e) => {
        // middle button: block autoscroll, it pans the map instead
        if (e.button === 1) e.preventDefault();
        this.gestures.pointerDown(this.gesturePointer(e));
      },
      opts,
    );
    this.canvas.addEventListener(
      'pointermove',
      (e) => {
        this.gestures.pointerMove(this.gesturePointer(e));
        const state = this.gestures.state;
        if (
          (state === 'panning' || state === 'pinching') &&
          !this.canvas.hasPointerCapture(e.pointerId)
        ) {
          this.canvas.setPointerCapture(e.pointerId);
        }
      },
      opts,
    );
    this.canvas.addEventListener(
      'pointerup',
      (e) => {
        this.gestures.pointerUp(this.gesturePointer(e));
      },
      opts,
    );
    this.canvas.addEventListener(
      'pointercancel',
      (e) => {
        this.gestures.pointerCancel(this.gesturePointer(e));
      },
      opts,
    );
    this.canvas.addEventListener(
      'pointerleave',
      (e) => {
        if (e.pointerType === 'mouse') this.mousePos = null;
      },
      opts,
    );

    this.canvas.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        if (this.suppressContextmenu) {
          this.suppressContextmenu = false;
          return;
        }
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const tile = tileAtClientPoint(this.camera, sx, sy, this.state.map.size);
        if (tile) {
          this.infoPopup.show(this.describeTile(tile), sx + 8, sy + 8);
        }
      },
      opts,
    );

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY === 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        this.applyZoom(factor, e.clientX - rect.left, e.clientY - rect.top);
      },
      { signal: this.inputAborter.signal, passive: false },
    );

    window.addEventListener(
      'resize',
      () => {
        // ResizeObserver misses pure devicePixelRatio changes (browser zoom)
        this.syncViewport();
      },
      opts,
    );

    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.running || isTypingTarget(e.target)) return;
        if (e.key === 'Escape' && this.dialogs.root.style.display === 'none') {
          if (this.advSpellbook) {
            this.closeAdventureSpellbook();
            return;
          }
          if (this.townPortalPick) {
            this.closeTownPortalPick();
            return;
          }
          if (this.tileTargetSpell !== null) {
            this.cancelTileTargeting();
            return;
          }
          if (this.systemPanel) {
            this.closeSystemPanel();
            return;
          }
          if (this.activePanel) {
            this.closePanel();
            return;
          }
        }
        if (this.shortcutsBlocked()) return;
        const action = adventureShortcut(e.key, KEY_SCROLL_STEP);
        if (!action) return;
        e.preventDefault();
        this.applyShortcut(action);
      },
      opts,
    );
  }

  // overlays own the keyboard while they are visible
  private shortcutsBlocked(): boolean {
    return (
      this.activePanel !== null ||
      this.systemPanel !== null ||
      this.combatPanel !== null ||
      this.advSpellbook !== null ||
      this.townPortalPick !== null ||
      this.tileTargetSpell !== null ||
      this.dialogs.root.style.display !== 'none' ||
      this.passOverlay.style.display !== 'none' ||
      this.gameOverOverlay.style.display !== 'none'
    );
  }

  private applyShortcut(action: AdventureShortcutAction): void {
    switch (action.type) {
      case 'endTurn':
        this.endTurn();
        break;
      case 'nextHero':
        this.selectNextHero();
        break;
      case 'visitHere':
        this.visitHere();
        break;
      case 'pan':
        this.camera = panCamera(this.camera, action.dx, action.dy, this.state.map.size);
        this.markDirty();
        break;
      case 'zoom':
        this.applyZoom(action.factor, this.cssW / 2, this.cssH / 2);
        break;
    }
  }

  // Space: re-visit whatever the selected hero is standing on; an own town
  // opens its screen instead of re-triggering the map object
  private visitHere(): void {
    if (this.selectedHero === null) return;
    const hero = this.state.heroes[this.selectedHero];
    if (hero?.owner !== this.viewPlayer().id) return;
    const town = Object.values(this.state.towns).find(
      (t) => t.pos[0] === hero.pos[0] && t.pos[1] === hero.pos[1],
    );
    if (town?.owner === hero.owner) {
      this.openTownScreen(town.id);
      return;
    }
    this.runCommand({ type: 'visitObject', player: hero.owner, hero: hero.id });
  }

  private edgeScroll(): void {
    // mousePos is only fed by mouse hover actions, so touch never edge-scrolls
    const gesture = this.gestures.state;
    if (!this.mousePos || gesture === 'panning' || gesture === 'pinching') return;
    const [sx, sy] = this.mousePos;
    // bounds in live CSS px, pan delta a world-px constant
    const [dx, dy] = edgeScrollDelta(
      sx,
      sy,
      this.cssW,
      this.cssH,
      EDGE_SCROLL_MARGIN,
      EDGE_SCROLL_SPEED,
    );
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
      dpr: this.dpr,
      selectedHero: this.selectedHero,
      pathPreview: this.pendingPath?.preview ?? null,
    };
    this.renderer.render(view);
    renderMinimap(this.minimapCtx, view, MINIMAP_PX, this.data);
    this.hud.update(this.state, player, this.selectedHero);
    this.canvas.dataset.cameraX = String(Math.round(this.camera.x));
    this.canvas.dataset.cameraY = String(Math.round(this.camera.y));
    this.canvas.dataset.zoom = String(this.camera.zoom);
    this.activePanel?.update();
    this.combatPanel?.update();
    this.dialogs.update(this.state);
    this.updateGameOver();
  }
}
