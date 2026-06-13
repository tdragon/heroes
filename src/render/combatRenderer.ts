// Combat battlefield renderer: pointy-top hexes (odd rows shifted right),
// stack tokens, siege walls, reachable shading and lightweight animations.
// The pixel<->hex math, damage estimate and log-line helpers are pure and
// unit-tested; only the CombatRenderer class touches the canvas.

import type { GameData } from '../data';
import {
  effectiveAttack,
  effectiveDefense,
  effectiveHp,
  hasSpecial,
  minCellDistance,
  requireCreature,
  stackCells,
  stackHpPool,
} from '../core/combat/abilities';
import { computeDamage, RANGED_PENALTY_DISTANCE } from '../core/combat/damage';
import { DEFEND_DEFENSE_BONUS, reachableHexesFor } from '../core/combat/engine';
import { FIELD_HEIGHT, FIELD_WIDTH, hexEquals, type Hex } from '../core/combat/grid';
import { isMoatHex } from '../core/combat/siege';
import {
  getCombatStack,
  heroInfoFor,
  isStackAlive,
  livingStacks,
  occupiedHexes,
  tailOffset,
  type CombatEvent,
  type CombatState,
} from '../core/combat/state';
import { initialsOf, NEUTRAL_COLOR, PLAYER_COLOR_HEX, type Painter } from './painter';
import type { PlayerColor } from '../maps/schema';

// --- hex pixel math (pointy-top, odd-r offset) ---

export const HEX_R = 30;
export const HEX_W = Math.sqrt(3) * HEX_R;
export const FIELD_MARGIN_X = 36;
export const FIELD_MARGIN_Y = 28;
export const COMBAT_CANVAS_W = Math.ceil(FIELD_MARGIN_X * 2 + HEX_W * (FIELD_WIDTH + 0.5));
export const COMBAT_CANVAS_H = Math.ceil(
  FIELD_MARGIN_Y * 2 + HEX_R * (1.5 * (FIELD_HEIGHT - 1) + 2),
);

export interface Pixel {
  x: number;
  y: number;
}

export function hexCenter(hex: Hex): Pixel {
  return {
    x: FIELD_MARGIN_X + HEX_W * (hex.x + 0.5 * (hex.y % 2)) + HEX_W / 2,
    y: FIELD_MARGIN_Y + HEX_R * (1 + 1.5 * hex.y),
  };
}

// uniform scale-to-fit for the non-scrolling battlefield: never upscale past
// 1, never shrink below the floor
export const COMBAT_FIT_MIN = 0.35;

export function combatFitScale(availW: number, availH: number): number {
  return Math.max(
    COMBAT_FIT_MIN,
    Math.min(1, availW / COMBAT_CANVAS_W, availH / COMBAT_CANVAS_H),
  );
}

// nearest hex center wins (centers form a triangular lattice whose Voronoi
// cells are exactly the hexes); null when the point is outside the field
export function hexAtPixel(px: number, py: number): Hex | null {
  let best: Hex | null = null;
  let bestSq = Infinity;
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    for (let x = 0; x < FIELD_WIDTH; x++) {
      const c = hexCenter({ x, y });
      const sq = (c.x - px) ** 2 + (c.y - py) ** 2;
      if (sq < bestSq) {
        bestSq = sq;
        best = { x, y };
      }
    }
  }
  return best !== null && bestSq <= HEX_R * HEX_R ? best : null;
}

// --- reachable-set memo (recomputed only when the version changes) ---

export type ReachableCompute = (combat: CombatState, stackId: string, data: GameData) => Hex[];

export function createReachableCache(
  compute: ReachableCompute = reachableHexesFor,
): (combat: CombatState, stackId: string, data: GameData, version: number) => Hex[] {
  let key = '';
  let cached: Hex[] = [];
  return (combat, stackId, data, version) => {
    const next = `${stackId}:${String(version)}`;
    if (next !== key) {
      key = next;
      cached = compute(combat, stackId, data);
    }
    return cached;
  };
}

// --- damage estimate for the hover tooltip ---

export interface DamageEstimate {
  min: number;
  max: number;
  killsMin: number;
  killsMax: number;
}

function minStackDistance(combat: CombatState, aId: string, bId: string, data: GameData): number {
  return minCellDistance(
    stackCells(getCombatStack(combat, aId), data),
    stackCells(getCombatStack(combat, bId), data),
  );
}

export function estimateAttack(
  combat: CombatState,
  attackerId: string,
  targetId: string,
  ranged: boolean,
  data: GameData,
): DamageEstimate {
  const attacker = getCombatStack(combat, attackerId);
  const target = getCombatStack(combat, targetId);
  const attackerCreature = requireCreature(data, attacker.creature);
  const targetCreature = requireCreature(data, target.creature);
  const attackerHero = heroInfoFor(combat, attacker.side);
  const targetHero = heroInfoFor(combat, target.side);

  const attack = effectiveAttack(attacker, attackerCreature, !ranged) + attackerHero.attack;
  let defense = effectiveDefense(target, targetCreature) + targetHero.defense;
  if (target.defending) {
    defense = Math.floor(defense * (1 + DEFEND_DEFENSE_BONUS));
  }
  const isShooter = attackerCreature.shots !== undefined;
  const shared = {
    attack,
    defense,
    ranged,
    offenseBonus: ranged ? 0 : attackerHero.offenseBonus,
    archeryBonus: ranged ? attackerHero.archeryBonus : 0,
    armorerReduction: targetHero.armorerReduction,
    distancePenalty:
      ranged && minStackDistance(combat, attackerId, targetId, data) > RANGED_PENALTY_DISTANCE,
    meleePenalty: !ranged && isShooter && !hasSpecial(attackerCreature, 'noMeleePenalty'),
  };
  const min = computeDamage({ ...shared, base: attacker.count * attackerCreature.dmgMin }).total;
  const max = computeDamage({ ...shared, base: attacker.count * attackerCreature.dmgMax }).total;

  const hp = effectiveHp(target, targetCreature);
  const pool = stackHpPool(target, hp);
  const killsFor = (damage: number): number =>
    damage >= pool ? target.count : target.count - Math.ceil((pool - damage) / hp);
  return { min, max, killsMin: killsFor(min), killsMax: killsFor(max) };
}

export function damageRangeText(estimate: DamageEstimate): string {
  const dmg =
    estimate.min === estimate.max
      ? String(estimate.min)
      : `${String(estimate.min)}–${String(estimate.max)}`;
  const kills =
    estimate.killsMin === estimate.killsMax
      ? String(estimate.killsMin)
      : `${String(estimate.killsMin)}–${String(estimate.killsMax)}`;
  return `Damage ${dmg}, kills ${kills}`;
}

// --- combat log lines ---

function stackLabel(combat: CombatState, stackId: string, data: GameData): string {
  const stack = getCombatStack(combat, stackId);
  const creature = requireCreature(data, stack.creature);
  return stack.count > 0 ? `${String(stack.count)} ${creature.name}` : creature.name;
}

function spellName(spell: string, data: GameData): string {
  return data.spells[spell]?.name ?? spell;
}

export function combatEventText(
  event: CombatEvent,
  combat: CombatState,
  data: GameData,
): string | null {
  const name = (id: string): string => stackLabel(combat, id, data);
  switch (event.type) {
    case 'roundStarted':
      return `— Round ${String(event.round)} —`;
    case 'stackAttacked': {
      const verb = event.retaliation ? 'retaliate against' : event.ranged ? 'shoot' : 'attack';
      const kills = event.kills > 0 ? `; ${String(event.kills)} perish` : '';
      return `${name(event.attacker)} ${verb} ${name(event.target)} for ${String(event.damage)} damage${kills}`;
    }
    case 'stackDied':
      return `${name(event.stack)} is destroyed`;
    case 'stackWaited':
      return `${name(event.stack)} wait`;
    case 'stackDefended':
      return `${name(event.stack)} defend`;
    case 'stackSkipped':
      return `${name(event.stack)} are blinded and skip the turn`;
    case 'moraleSurge':
      return `${name(event.stack)} get an extra action from high morale`;
    case 'moraleFreeze':
      return `${name(event.stack)} freeze from low morale`;
    case 'luck':
      return `${name(event.stack)} strike with luck — double damage`;
    case 'abilityTriggered':
      return `${name(event.stack)}: ${event.ability}`;
    case 'effectApplied':
      return `${name(event.stack)} affected by ${event.kind} (${String(event.rounds)} rounds)`;
    case 'stackHealed':
      return `${name(event.stack)} heal ${String(event.amount)} HP`;
    case 'stackResurrected':
      return `${name(event.stack)}: ${String(event.revived)} return to life`;
    case 'manaDrained':
      return `${name(event.by)} drain ${String(event.amount)} mana`;
    case 'spellCast':
      return `The ${event.side} casts ${spellName(event.spell, data)}`;
    case 'spellResisted':
      return event.reason === 'immune'
        ? `${name(event.stack)} are immune to ${spellName(event.spell, data)}`
        : `${name(event.stack)} resist ${spellName(event.spell, data)}`;
    case 'spellDamage': {
      const kills = event.kills > 0 ? `; ${String(event.kills)} perish` : '';
      return `${spellName(event.spell, data)} hits ${name(event.stack)} for ${String(event.damage)} damage${kills}`;
    }
    case 'wallHit':
      return `${event.source === 'catapult' ? 'The catapult hits' : 'Melee attack hits'} a wall segment (${String(event.hp)} HP left)`;
    case 'towerShot':
      return `An arrow tower hits ${name(event.target)} for ${String(event.damage)} damage`;
    case 'moatDamage':
      return `${name(event.stack)} suffer ${String(event.damage)} moat damage`;
    case 'combatEnded':
      return `The ${event.winner} wins the battle`;
    case 'combatStarted':
    case 'stackMoved':
    case 'effectExpired':
      return null;
  }
}

// --- animations ---

export const MOVE_TWEEN_MS = 200;
export const FLOAT_MS = 700;

interface MoveTween {
  stack: string;
  from: Hex;
  to: Hex;
  start: number;
}

interface FloatingText {
  text: string;
  color: string;
  at: Pixel;
  start: number;
}

// --- renderer ---

export interface CombatView {
  combat: CombatState;
  reachable: Hex[];
  hover: Hex | null;
  activeStack: string | null;
}

const HEX_FILL = '#2c3440';
const HEX_STROKE = '#1a202c';
const OBSTACLE_FILL = '#565f6e';
const MOAT_FILL = 'rgba(49, 130, 206, 0.35)';
const REACHABLE_FILL = 'rgba(72, 187, 120, 0.25)';
const HOVER_STROKE = '#ecc94b';

// stack-token disc radius, as a fraction of HEX_R. A wide creature occupies two
// horizontally-adjacent hexes and its seal is centered on their midpoint, so it
// gets a larger disc to read across the pair; a single-hex creature sits inside
// its one hex.
const WIDE_TOKEN_RADIUS = HEX_R * 0.85;
const NARROW_TOKEN_RADIUS = HEX_R * 0.68;
const SELECTION_RING_PAD = 4; // gap between the token disc and the active ring
const WALL_FILL = '#8b6d3f';
const WALL_RUBBLE_FILL = '#4f4434';
const STATIC_WALL_FILL = '#6b5430';

function isPlayerColor(value: string): value is PlayerColor {
  return value in PLAYER_COLOR_HEX;
}

export function sideColor(player: string | null): string {
  return player !== null && isPlayerColor(player) ? PLAYER_COLOR_HEX[player] : NEUTRAL_COLOR;
}

function hexPath(ctx: CanvasRenderingContext2D, center: Pixel, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i + 30);
    const x = center.x + r * Math.cos(angle);
    const y = center.y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export class CombatRenderer {
  private tweens: MoveTween[] = [];
  private floats: FloatingText[] = [];
  private fit = 1;
  private dpr = 1;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly painter: Painter,
    private readonly data: GameData,
  ) {}

  // backing store is logical size × fit × dpr; drawing stays in logical px
  setViewScale(fit: number, dpr: number): void {
    this.fit = fit;
    this.dpr = dpr;
  }

  addMoveTween(stack: string, from: Hex, to: Hex, now: number): void {
    this.tweens.push({ stack, from, to, start: now });
  }

  addFloatingText(at: Hex, text: string, color: string, now: number): void {
    this.floats.push({ text, color, at: hexCenter(at), start: now });
  }

  skipAnimations(): void {
    this.tweens = [];
    this.floats = [];
  }

  hasAnimations(now: number): boolean {
    this.prune(now);
    return this.tweens.length > 0 || this.floats.length > 0;
  }

  private prune(now: number): void {
    this.tweens = this.tweens.filter((t) => now - t.start < MOVE_TWEEN_MS);
    this.floats = this.floats.filter((f) => now - f.start < FLOAT_MS);
  }

  render(view: CombatView, now: number): void {
    this.prune(now);
    const { ctx } = this;
    const { combat } = view;
    const scale = this.fit * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#171c24';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    for (let y = 0; y < FIELD_HEIGHT; y++) {
      for (let x = 0; x < FIELD_WIDTH; x++) {
        const hex = { x, y };
        const center = hexCenter(hex);
        hexPath(ctx, center, HEX_R - 1);
        ctx.fillStyle = HEX_FILL;
        ctx.fill();
        if (combat.siege && isMoatHex(combat.siege, hex)) {
          ctx.fillStyle = MOAT_FILL;
          ctx.fill();
        }
        if (view.reachable.some((h) => hexEquals(h, hex))) {
          ctx.fillStyle = REACHABLE_FILL;
          ctx.fill();
        }
        ctx.strokeStyle = HEX_STROKE;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    for (const obstacle of combat.obstacles) {
      hexPath(ctx, hexCenter(obstacle), HEX_R - 6);
      ctx.fillStyle = OBSTACLE_FILL;
      ctx.fill();
    }

    this.drawSiege(combat);
    this.drawStacks(view, now);

    if (view.hover) {
      // outline every hex the hovered stack occupies (both cells of a wide
      // creature), so the gold outline matches the seal's two-hex footprint
      // instead of marking a single hex while the disc sits at the midpoint
      ctx.strokeStyle = HOVER_STROKE;
      ctx.lineWidth = 2;
      for (const hex of this.hoverHexes(combat, view.hover)) {
        hexPath(ctx, hexCenter(hex), HEX_R - 2);
        ctx.stroke();
      }
    }

    this.drawFloats(now);
  }

  private drawSiege(combat: CombatState): void {
    const siege = combat.siege;
    if (!siege) return;
    const { ctx } = this;
    for (const wall of siege.staticWalls) {
      hexPath(ctx, hexCenter(wall), HEX_R - 3);
      ctx.fillStyle = STATIC_WALL_FILL;
      ctx.fill();
    }
    for (const segment of siege.segments) {
      const center = hexCenter(segment.pos);
      hexPath(ctx, center, HEX_R - 3);
      ctx.fillStyle = segment.hp > 0 ? WALL_FILL : WALL_RUBBLE_FILL;
      ctx.fill();
      ctx.fillStyle = '#f7fafc';
      ctx.font = `bold 13px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = segment.isGate ? `Gate ${String(segment.hp)}` : `Wall ${String(segment.hp)}`;
      ctx.fillText(segment.hp > 0 ? label : 'Rubble', center.x, center.y);
    }
    siege.towers.forEach((tower, i) => {
      this.painter.objectToken(ctx, hexCenter(tower.pos).x, hexCenter(tower.pos).y, HEX_R * 0.55, '#718096', `T${String(i + 1)}`);
    });
  }

  // the hex(es) the hover outline should mark: if the hovered hex belongs to a
  // living stack, every hex that stack occupies (so a wide creature's gold
  // outline spans both its cells), otherwise just the hovered hex itself
  private hoverHexes(combat: CombatState, hover: Hex): Hex[] {
    for (const stack of livingStacks(combat)) {
      const creature = requireCreature(this.data, stack.creature);
      const cells = occupiedHexes(stack, creature);
      if (cells.some((h) => hexEquals(h, hover))) return cells;
    }
    return [hover];
  }

  private stackCenter(stack: { id: string; pos: Hex }, now: number): Pixel {
    const tween = this.tweens.find((t) => t.stack === stack.id);
    if (!tween) return hexCenter(stack.pos);
    const t = Math.min(1, (now - tween.start) / MOVE_TWEEN_MS);
    const from = hexCenter(tween.from);
    const to = hexCenter(tween.to);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }

  private drawStacks(view: CombatView, now: number): void {
    const { ctx } = this;
    const combat = view.combat;
    for (const stack of livingStacks(combat)) {
      const creature = requireCreature(this.data, stack.creature);
      const color = sideColor(heroInfoFor(combat, stack.side).player);
      const wide = creature.flags.includes('wide');
      const center = this.stackCenter(stack, now);
      if (wide) {
        // a wide creature's tail sits half a hex to the side of its head (same
        // row), so its seal is centered half a hex-width toward the tail — of
        // the *tweened* head position, so the disc tracks smoothly during a
        // move instead of popping to the midpoint only when it stops
        center.x += (tailOffset(stack.side) * HEX_W) / 2;
      }
      const r = wide ? WIDE_TOKEN_RADIUS : NARROW_TOKEN_RADIUS;
      this.painter.creatureToken(
        ctx,
        center.x,
        center.y,
        r,
        color,
        creature.id,
        initialsOf(creature.name),
        creature.tier,
      );
      if (view.activeStack === stack.id && isStackAlive(stack)) {
        this.painter.selectionRing(ctx, center.x, center.y, r + SELECTION_RING_PAD);
      }
      // count badge top-right of the token: the seal's lower arc carries the
      // tier pips (cy + 0.55r) and the bottom banner notch, so the upper-right
      // is the only clear quadrant for the count
      const text = String(stack.count);
      ctx.font = 'bold 12px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 8;
      const bx = center.x + r * 0.55;
      const by = center.y - r * 0.55;
      ctx.fillStyle = '#1a202c';
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 16, 3);
      ctx.fill();
      ctx.strokeStyle = '#718096';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f7fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + w / 2, by + 8);
    }
  }

  private drawFloats(now: number): void {
    const { ctx } = this;
    for (const float of this.floats) {
      const t = Math.min(1, (now - float.start) / FLOAT_MS);
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = float.color;
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(float.text, float.at.x, float.at.y - HEX_R * 0.6 - t * 24);
      ctx.globalAlpha = 1;
    }
  }
}
