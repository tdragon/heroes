// Modal combat screen: canvas battlefield + DOM controls (Wait / Defend /
// Auto / Flee / Spellbook), combat log and hover damage estimates. All game
// rules stay in the core; this screen only translates clicks into
// `combatAction` commands and replays the emitted events as log lines and
// small animations. AI-side stacks and the Auto button are played by the
// combat AI.
//
// Hotseat human-vs-human battles share this one screen: control follows the
// acting stack's side, so each human plays their own stacks in initiative
// order (the hero panels show whose side is whose). Commands are issued as
// the acting side's owner so the core can validate spellbook ownership.

import type { GameEvent } from '../core/commands';
import { chooseCombatAction } from '../core/ai/combatAI';
import { getEffect, requireCreature } from '../core/combat/abilities';
import { activeCombatStack, type CombatAction } from '../core/combat/engine';
import { hexDistance, type Hex } from '../core/combat/grid';
import { segmentAt } from '../core/combat/siege';
import {
  heroInfoFor,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatSideId,
  type CombatStack,
  type CombatState,
} from '../core/combat/state';
import type { GameState, PlayerId } from '../core/state';
import {
  COMBAT_CANVAS_H,
  COMBAT_CANVAS_W,
  combatEventText,
  CombatRenderer,
  createReachableCache,
  damageRangeText,
  estimateAttack,
  hexAtPixel,
  hexCenter,
  sideColor,
} from '../render/combatRenderer';
import { TokenPainter } from '../render/painter';
import { combatShortcut, isTypingTarget } from '../app/shortcuts';
import { el, type UiContext } from './components';
import { SpellbookOverlay, spellbookEntries, type SpellbookEntry } from './spellbook';

export const COMBAT_LOG_LIMIT = 50;
const AI_ACTION_LIMIT = 400;
const AUTO_ACTION_LIMIT = 600;

function stackCells(stack: CombatStack, ctx: UiContext): Hex[] {
  return occupiedHexes(stack, requireCreature(ctx.data, stack.creature));
}

function attackerCells(head: Hex, wide: boolean, side: CombatSideId): Hex[] {
  return wide ? [head, { x: head.x + tailOffset(side), y: head.y }] : [head];
}

export class CombatScreen {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: CombatRenderer;
  private readonly logEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly roundEl: HTMLElement;
  private readonly attackerPanel: HTMLElement;
  private readonly defenderPanel: HTMLElement;
  private readonly stackStrip: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  private hover: Hex | null = null;
  private targeting: SpellbookEntry | null = null;
  private spellbook: SpellbookOverlay | null = null;
  private version = 0;
  private readonly reachable = createReachableCache();
  private logLines: string[] = [];
  private lastCombat: CombatState | null = null;
  private aiRunning = false;
  private running = true;

  constructor(private readonly ctx: UiContext) {
    this.root = el('div', 'combat-overlay', 'combat-screen');
    const box = el('div', 'combat-panel');

    const header = el('div', 'combat-header');
    this.attackerPanel = el('div', 'combat-hero-panel', 'combat-hero-attacker');
    this.roundEl = el('div', 'combat-round', 'combat-round');
    this.defenderPanel = el('div', 'combat-hero-panel', 'combat-hero-defender');
    header.append(this.attackerPanel, this.roundEl, this.defenderPanel);

    const canvasWrap = el('div', 'combat-canvas-wrap');
    this.canvas = el('canvas', 'combat-canvas', 'combat-canvas');
    this.canvas.width = COMBAT_CANVAS_W;
    this.canvas.height = COMBAT_CANVAS_H;
    this.tooltip = el('div', 'info-popup', 'combat-tooltip');
    this.tooltip.style.display = 'none';
    canvasWrap.append(this.canvas, this.tooltip);

    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('combat canvas 2d context unavailable');
    this.renderer = new CombatRenderer(context, new TokenPainter(), ctx.data);

    const bottom = el('div', 'combat-bottom');
    this.logEl = el('div', 'combat-log', 'combat-log');
    const controls = el('div', 'combat-controls');
    const addButton = (label: string, id: string, onClick: () => void): void => {
      const node = el('button', 'ui-button', id);
      node.textContent = label;
      node.addEventListener('click', onClick);
      this.buttons.set(id, node);
      controls.appendChild(node);
    };
    addButton('Wait', 'combat-wait-button', () => {
      this.onHumanAction({ type: 'wait' });
    });
    addButton('Defend', 'combat-defend-button', () => {
      this.onHumanAction({ type: 'defend' });
    });
    addButton('Auto', 'combat-auto-button', () => {
      this.autoCombat();
    });
    addButton('Spellbook', 'combat-spellbook-button', () => {
      this.openSpellbook();
    });
    addButton('Flee', 'combat-flee-button', () => {
      this.flee();
    });
    this.statusEl = el('div', 'combat-status', 'combat-status');
    const side = el('div', 'combat-side');
    side.append(controls, this.statusEl);
    bottom.append(this.logEl, side);

    this.stackStrip = el('div', 'combat-stacks', 'combat-stacks');
    box.append(header, canvasWrap, bottom, this.stackStrip);
    this.root.appendChild(box);

    this.bindInput();
    this.update();
    requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.running = false;
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  // --- state access ---

  private combatState(): CombatState | null {
    return this.ctx.getState().combat?.combat ?? null;
  }

  private isHumanOwned(playerId: string | null): boolean {
    if (playerId === null) return false;
    return this.ctx.getState().players.find((p) => p.id === playerId)?.isHuman === true;
  }

  // sides controlled by a human player (any human, not just the viewer:
  // hotseat battles hand control to whichever human owns the acting stack)
  private humanSides(combat: CombatState): CombatSideId[] {
    const sides: CombatSideId[] = [];
    if (this.isHumanOwned(combat.attackerHero.player)) sides.push('attacker');
    if (this.isHumanOwned(combat.defenderHero.player)) sides.push('defender');
    return sides;
  }

  // the side the human at the device currently speaks for: the acting
  // stack's side when human-owned, otherwise the (single) human side
  private humanSide(combat: CombatState): CombatSideId | null {
    const sides = this.humanSides(combat);
    const active = activeCombatStack(combat)?.side;
    if (active !== undefined && sides.includes(active)) return active;
    return sides[0] ?? null;
  }

  private isHumanTurn(combat: CombatState): boolean {
    const stack = activeCombatStack(combat);
    return stack !== null && this.humanSides(combat).includes(stack.side);
  }

  private sideOwnerId(combat: CombatState, side: CombatSideId | null): PlayerId {
    const owner = side === null ? null : heroInfoFor(combat, side).player;
    const state = this.ctx.getState();
    return state.players.find((p) => p.id === owner)?.id ?? state.currentPlayer;
  }

  private stackAt(combat: CombatState, hex: Hex): CombatStack | null {
    for (const stack of livingStacks(combat)) {
      if (stackCells(stack, this.ctx).some((c) => c.x === hex.x && c.y === hex.y)) {
        return stack;
      }
    }
    return null;
  }

  private canShoot(combat: CombatState, stack: CombatStack): boolean {
    const creature = requireCreature(this.ctx.data, stack.creature);
    if (creature.shots === undefined || stack.shots < 1) return false;
    const forget = getEffect(stack, 'forgetfulness');
    if (forget && forget.value >= 100) return false;
    const cells = stackCells(stack, this.ctx);
    return !livingStacks(combat, oppositeSide(stack.side)).some((enemy) =>
      stackCells(enemy, this.ctx).some((c) => cells.some((o) => hexDistance(c, o) === 1)),
    );
  }

  // reachable from-hexes adjacent to the target, for melee direction picking
  private meleeOrigins(combat: CombatState, stack: CombatStack, target: CombatStack): Hex[] {
    const creature = requireCreature(this.ctx.data, stack.creature);
    const wide = creature.flags.includes('wide');
    const targetCells = stackCells(target, this.ctx);
    const candidates = [stack.pos, ...this.reachable(combat, stack.id, this.ctx.data, this.version)];
    return candidates.filter((from) =>
      attackerCells(from, wide, stack.side).some((cell) =>
        targetCells.some((t) => hexDistance(cell, t) === 1),
      ),
    );
  }

  // --- commands ---

  private runAction(action: CombatAction | { type: 'flee' }, asPlayer: PlayerId): boolean {
    const message = this.ctx.run({ type: 'combatAction', player: asPlayer, action });
    this.statusEl.textContent = message ?? '';
    return message === null;
  }

  // human-initiated actions act for the human-controlled side
  private onHumanAction(action: CombatAction): void {
    const combat = this.combatState();
    if (!combat) return;
    if (this.runAction(action, this.sideOwnerId(combat, this.humanSide(combat)))) {
      this.ensureAiActs();
    }
  }

  private flee(): void {
    const combat = this.combatState();
    if (!combat) return;
    this.runAction({ type: 'flee' }, this.sideOwnerId(combat, this.humanSide(combat)));
  }

  // the combat AI plays a stack on behalf of the acting side's owner
  private runAiAction(combat: CombatState): boolean {
    const side = activeCombatStack(combat)?.side ?? null;
    return this.runAction(chooseCombatAction(combat, this.ctx.data), this.sideOwnerId(combat, side));
  }

  // auto-play AI-side stacks with the combat AI
  ensureAiActs(): void {
    if (this.aiRunning) return;
    this.aiRunning = true;
    try {
      let guard = 0;
      while (guard++ < AI_ACTION_LIMIT) {
        const combat = this.combatState();
        if (!combat) break;
        const stack = activeCombatStack(combat);
        if (!stack || this.humanSides(combat).includes(stack.side)) break;
        if (!this.runAiAction(combat)) break;
      }
    } finally {
      this.aiRunning = false;
    }
  }

  private autoCombat(): void {
    if (this.aiRunning) return;
    this.aiRunning = true;
    try {
      let guard = 0;
      while (guard++ < AUTO_ACTION_LIMIT) {
        const combat = this.combatState();
        if (!combat || activeCombatStack(combat) === null) break;
        if (!this.runAiAction(combat)) break;
      }
    } finally {
      this.aiRunning = false;
    }
  }

  // --- events from the dispatcher ---

  consume(events: GameEvent[]): void {
    const combatEvents = events.flatMap((e) => (e.type === 'combat' ? [e.event] : []));
    if (combatEvents.length === 0) return;
    this.version += 1;
    const combat = this.combatState() ?? this.lastCombat;
    if (!combat) return;
    const now = performance.now();
    for (const event of combatEvents) {
      const text = combatEventText(event, combat, this.ctx.data);
      if (text !== null) {
        this.logLines.push(text);
      }
      this.animate(event, combat, now);
    }
    if (this.logLines.length > COMBAT_LOG_LIMIT) {
      this.logLines = this.logLines.slice(-COMBAT_LOG_LIMIT);
    }
    this.lastCombat = this.combatState() ?? combat;
    this.renderLog();
  }

  private animate(
    event: Extract<GameEvent, { type: 'combat' }>['event'],
    combat: CombatState,
    now: number,
  ): void {
    const posOf = (stackId: string): Hex | null =>
      combat.stacks.find((s) => s.id === stackId)?.pos ?? null;
    switch (event.type) {
      case 'stackMoved':
        this.renderer.addMoveTween(event.stack, event.from, event.to, now);
        break;
      case 'stackAttacked': {
        const at = posOf(event.target);
        if (at) this.renderer.addFloatingText(at, `-${String(event.damage)}`, '#fc8181', now);
        break;
      }
      case 'spellDamage':
      case 'moatDamage': {
        const at = posOf(event.stack);
        if (at) this.renderer.addFloatingText(at, `-${String(event.damage)}`, '#fc8181', now);
        break;
      }
      case 'towerShot': {
        const at = posOf(event.target);
        if (at) this.renderer.addFloatingText(at, `-${String(event.damage)}`, '#fc8181', now);
        break;
      }
      case 'stackHealed': {
        const at = posOf(event.stack);
        if (at) this.renderer.addFloatingText(at, `+${String(event.amount)}`, '#68d391', now);
        break;
      }
      case 'stackResurrected': {
        const at = posOf(event.stack);
        if (at) this.renderer.addFloatingText(at, `+${String(event.revived)}`, '#68d391', now);
        break;
      }
      default:
        break;
    }
  }

  private renderLog(): void {
    this.logEl.replaceChildren();
    for (const line of this.logLines) {
      const node = el('div', 'combat-log-line');
      node.textContent = line;
      this.logEl.appendChild(node);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // --- input ---

  private canvasPoint(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private bindInput(): void {
    this.canvas.addEventListener('click', (e) => {
      this.renderer.skipAnimations();
      const [px, py] = this.canvasPoint(e);
      const hex = hexAtPixel(px, py);
      if (hex) this.handleHexClick(hex, px, py);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      const [px, py] = this.canvasPoint(e);
      this.hover = hexAtPixel(px, py);
      this.updateTooltip(px, py);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tooltip.style.display = 'none';
    });
    window.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape') {
      if (this.spellbook) {
        e.preventDefault();
        this.closeSpellbook();
      } else if (this.targeting) {
        e.preventDefault();
        this.targeting = null;
        this.statusEl.textContent = '';
      }
      return;
    }
    if (this.spellbook || this.targeting) return;
    const shortcut = combatShortcut(e.key);
    if (!shortcut) return;
    const combat = this.combatState();
    if (!combat || !this.isHumanTurn(combat)) return;
    e.preventDefault();
    this.onHumanAction({ type: shortcut.type });
  };

  private handleHexClick(hex: Hex, px: number, py: number): void {
    const combat = this.combatState();
    if (!combat) return;
    if (this.targeting) {
      this.resolveTargeting(combat, hex);
      return;
    }
    if (!this.isHumanTurn(combat)) return;
    const stack = activeCombatStack(combat);
    if (!stack) return;

    const target = this.stackAt(combat, hex);
    if (target && target.side !== stack.side) {
      this.attackTarget(combat, stack, target, px, py);
      return;
    }
    if (target) return;

    const siege = combat.siege;
    if (siege && stack.side === 'attacker') {
      const segment = segmentAt(siege, hex);
      if (segment?.isGate === true && segment.hp > 0) {
        this.attackGate(combat, stack, hex, px, py);
        return;
      }
    }

    const reachable = this.reachable(combat, stack.id, this.ctx.data, this.version);
    if (reachable.some((h) => h.x === hex.x && h.y === hex.y)) {
      this.onHumanAction({ type: 'move', to: hex });
    } else {
      this.statusEl.textContent = 'That hex is out of reach';
    }
  }

  private closestOrigin(origins: Hex[], px: number, py: number): Hex | null {
    let best: Hex | null = null;
    let bestSq = Infinity;
    for (const origin of origins) {
      const c = hexCenter(origin);
      const sq = (c.x - px) ** 2 + (c.y - py) ** 2;
      if (sq < bestSq) {
        bestSq = sq;
        best = origin;
      }
    }
    return best;
  }

  private attackTarget(
    combat: CombatState,
    stack: CombatStack,
    target: CombatStack,
    px: number,
    py: number,
  ): void {
    if (this.canShoot(combat, stack)) {
      this.onHumanAction({ type: 'shoot', target: target.id });
      return;
    }
    const from = this.closestOrigin(this.meleeOrigins(combat, stack, target), px, py);
    if (!from) {
      this.statusEl.textContent = 'Cannot reach that target this turn';
      return;
    }
    this.onHumanAction({ type: 'melee', target: target.id, from });
  }

  private attackGate(
    combat: CombatState,
    stack: CombatStack,
    gateHex: Hex,
    px: number,
    py: number,
  ): void {
    const siege = combat.siege;
    if (!siege) return;
    const segment = segmentAt(siege, gateHex);
    if (!segment) return;
    const creature = requireCreature(this.ctx.data, stack.creature);
    const wide = creature.flags.includes('wide');
    const candidates = [
      stack.pos,
      ...this.reachable(combat, stack.id, this.ctx.data, this.version),
    ].filter((from) =>
      attackerCells(from, wide, stack.side).some((cell) => hexDistance(cell, gateHex) === 1),
    );
    const from = this.closestOrigin(candidates, px, py);
    if (!from) {
      this.statusEl.textContent = 'Cannot reach the gate this turn';
      return;
    }
    this.onHumanAction({ type: 'attackWall', segment: siege.segments.indexOf(segment), from });
  }

  // --- spellbook & targeting ---

  private openSpellbook(): void {
    const combat = this.combatState();
    if (!combat) return;
    const side = this.humanSide(combat);
    if (side === null) return;
    const hero = heroInfoFor(combat, side);
    if (!hero.hasSpellbook) {
      this.statusEl.textContent = 'The hero has no spellbook';
      return;
    }
    this.closeSpellbook();
    this.spellbook = new SpellbookOverlay(
      spellbookEntries(combat, side, this.ctx.data),
      (entry) => {
        this.closeSpellbook();
        this.pickSpell(entry);
      },
      () => {
        this.closeSpellbook();
      },
    );
    this.root.appendChild(this.spellbook.root);
  }

  private closeSpellbook(): void {
    this.spellbook?.root.remove();
    this.spellbook = null;
  }

  private pickSpell(entry: SpellbookEntry): void {
    if (entry.need === 'none') {
      this.onHumanAction({ type: 'cast', spell: entry.spell.id });
      return;
    }
    this.targeting = entry;
    this.statusEl.textContent =
      entry.need === 'hex'
        ? `Select a hex for ${entry.spell.name} (Esc cancels)`
        : `Select a target for ${entry.spell.name} (Esc cancels)`;
  }

  private resolveTargeting(combat: CombatState, hex: Hex): void {
    const entry = this.targeting;
    if (!entry) return;
    if (entry.need === 'hex') {
      this.targeting = null;
      this.onHumanAction({ type: 'cast', spell: entry.spell.id, hex });
      return;
    }
    const target = this.stackAt(combat, hex);
    if (!target) {
      this.statusEl.textContent = 'Select a target stack (Esc cancels)';
      return;
    }
    this.targeting = null;
    this.onHumanAction({ type: 'cast', spell: entry.spell.id, target: target.id });
  }

  private updateTooltip(px: number, py: number): void {
    const combat = this.combatState();
    const hover = this.hover;
    if (!combat || !hover || !this.isHumanTurn(combat) || this.targeting) {
      this.tooltip.style.display = 'none';
      return;
    }
    const stack = activeCombatStack(combat);
    const target = this.stackAt(combat, hover);
    if (!stack || !target || target.side === stack.side) {
      this.tooltip.style.display = 'none';
      return;
    }
    const ranged = this.canShoot(combat, stack);
    if (!ranged && this.meleeOrigins(combat, stack, target).length === 0) {
      this.tooltip.style.display = 'none';
      return;
    }
    const estimate = estimateAttack(combat, stack.id, target.id, ranged, this.ctx.data);
    this.tooltip.textContent = damageRangeText(estimate);
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${String(px + 14)}px`;
    this.tooltip.style.top = `${String(py + 14)}px`;
  }

  // --- rendering ---

  private readonly frame = (): void => {
    if (!this.running) return;
    const combat = this.combatState() ?? this.lastCombat;
    if (combat) {
      const stack = activeCombatStack(combat);
      const reachable =
        stack !== null
          ? this.reachable(combat, stack.id, this.ctx.data, this.version)
          : [];
      this.renderer.render(
        {
          combat,
          reachable,
          hover: this.hover,
          activeStack: stack?.id ?? null,
        },
        performance.now(),
      );
    }
    requestAnimationFrame(this.frame);
  };

  private heroPanelText(state: GameState, combat: CombatState, side: CombatSideId): string {
    const active = state.combat;
    const hero = heroInfoFor(combat, side);
    const heroId = side === 'attacker' ? active?.attackerHero : active?.defenderHero;
    const name =
      heroId !== null && heroId !== undefined
        ? (state.heroes[heroId]?.name ?? heroId)
        : 'No hero';
    if (hero.hero === null) return name;
    const cast = combat.castThisRound[side] ? ' (cast used)' : '';
    return `${name} — mana ${String(hero.mana)}${cast}`;
  }

  update(): void {
    const state = this.ctx.getState();
    const combat = this.combatState();
    if (!combat) return;
    const stack = activeCombatStack(combat);
    this.root.dataset.activeStack = stack?.id ?? '';
    this.root.dataset.activeSide = stack?.side ?? '';
    this.root.dataset.round = String(combat.round);
    this.root.dataset.version = String(this.version);
    this.roundEl.textContent = `Round ${String(combat.round)}`;

    this.attackerPanel.textContent = this.heroPanelText(state, combat, 'attacker');
    this.attackerPanel.style.borderColor = sideColor(combat.attackerHero.player);
    this.attackerPanel.dataset.mana = String(combat.attackerHero.mana);
    this.defenderPanel.textContent = this.heroPanelText(state, combat, 'defender');
    this.defenderPanel.style.borderColor = sideColor(combat.defenderHero.player);
    this.defenderPanel.dataset.mana = String(combat.defenderHero.mana);

    const human = this.isHumanTurn(combat);
    const humanSide = this.humanSide(combat);
    const setEnabled = (id: string, enabled: boolean): void => {
      const node = this.buttons.get(id);
      if (node) node.disabled = !enabled;
    };
    setEnabled('combat-wait-button', human && stack !== null && !stack.waited);
    setEnabled('combat-defend-button', human);
    setEnabled('combat-auto-button', stack !== null);
    setEnabled(
      'combat-spellbook-button',
      human && humanSide !== null && heroInfoFor(combat, humanSide).hasSpellbook,
    );
    // flee removes the fleeing side's own hero; siege defenders cannot flee
    const canFlee =
      humanSide !== null &&
      heroInfoFor(combat, humanSide).hero !== null &&
      !(state.combat?.reason === 'siege' && humanSide === 'defender');
    setEnabled('combat-flee-button', canFlee);

    this.stackStrip.replaceChildren();
    for (const s of livingStacks(combat)) {
      const node = el('div', 'combat-stack-info', `combat-stack-${s.id}`);
      node.dataset.x = String(s.pos.x);
      node.dataset.y = String(s.pos.y);
      node.dataset.count = String(s.count);
      node.dataset.side = s.side;
      node.dataset.creature = s.creature;
      this.stackStrip.appendChild(node);
    }
  }
}
