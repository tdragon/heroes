import type { GameData } from '../../data';
import type { Creature, SpecialType } from '../../data/schema';
import { effectiveStats } from '../hero';
import type { RngState } from '../rng';
import { skillValue, type Hero } from '../state';
import {
  computeDamage,
  RANGED_PENALTY_DISTANCE,
  rollBaseDamage,
  type DamageContext,
} from './damage';
import {
  bfsReachable,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  generateObstacles,
  hexDistance,
  hexEquals,
  hexKey,
  inField,
  type Hex,
} from './grid';
import {
  getCombatStack,
  heroInfoFor,
  isStackAlive,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatHeroInfo,
  type CombatSideId,
  type CombatStack,
  type CombatState,
} from './state';

export type CombatAction =
  | { type: 'move'; to: Hex }
  | { type: 'melee'; target: string; from: Hex }
  | { type: 'shoot'; target: string }
  | { type: 'defend' }
  | { type: 'wait' };

export type CombatEvent =
  | { type: 'combatStarted'; obstacles: Hex[] }
  | { type: 'roundStarted'; round: number }
  | { type: 'stackMoved'; stack: string; from: Hex; to: Hex }
  | {
      type: 'stackAttacked';
      attacker: string;
      target: string;
      damage: number;
      kills: number;
      ranged: boolean;
      retaliation: boolean;
    }
  | { type: 'stackDied'; stack: string }
  | { type: 'stackWaited'; stack: string }
  | { type: 'stackDefended'; stack: string }
  | { type: 'combatEnded'; winner: CombatSideId };

export class CombatRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CombatRuleError';
  }
}

export const DEFEND_DEFENSE_BONUS = 0.2;

// rows used for up to 7 deployment slots, spread top-to-bottom
const SLOT_ROWS: readonly number[] = [0, 2, 4, 5, 6, 8, 10];

function requireCreature(data: GameData, id: string): Creature {
  const creature = data.creatures[id];
  if (!creature) {
    throw new Error(`unknown creature: ${id}`);
  }
  return creature;
}

function hasSpecial(creature: Creature, type: SpecialType): boolean {
  return creature.specials.some((s) => s.type === type);
}

function specialValue(creature: Creature, type: SpecialType): number | undefined {
  return creature.specials.find((s) => s.type === type)?.value;
}

export function heroCombatInfo(hero: Hero, data: GameData): CombatHeroInfo {
  const stats = effectiveStats(hero, data);
  return {
    hero: hero.id,
    player: hero.owner,
    attack: stats.attack,
    defense: stats.defense,
    spellPower: stats.spellPower,
    knowledge: stats.knowledge,
    offenseBonus: skillValue(hero, 'offense', data) / 100,
    archeryBonus: skillValue(hero, 'archery', data) / 100,
    armorerReduction: skillValue(hero, 'armorer', data) / 100,
  };
}

export interface CombatArmyStack {
  creature: string;
  count: number;
}

export interface CombatSetup {
  attacker: { hero: CombatHeroInfo; stacks: CombatArmyStack[] };
  defender: { hero: CombatHeroInfo; stacks: CombatArmyStack[] };
  rng: RngState;
  obstacles?: Hex[];
}

function deploySide(
  side: CombatSideId,
  stacks: CombatArmyStack[],
  data: GameData,
): CombatStack[] {
  if (stacks.length < 1 || stacks.length > SLOT_ROWS.length) {
    throw new Error(`${side} army must have 1-${String(SLOT_ROWS.length)} stacks`);
  }
  return stacks.map((entry, slot) => {
    const creature = requireCreature(data, entry.creature);
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      throw new Error(`${side} slot ${String(slot)}: invalid count ${String(entry.count)}`);
    }
    const row = SLOT_ROWS[slot];
    if (row === undefined) {
      throw new Error(`no deployment row for slot ${String(slot)}`);
    }
    const wide = creature.flags.includes('wide');
    const x = side === 'attacker' ? (wide ? 1 : 0) : wide ? 13 : 14;
    return {
      id: `${side === 'attacker' ? 'a' : 'd'}${String(slot)}`,
      side,
      slot,
      creature: creature.id,
      count: entry.count,
      firstHp: creature.hp,
      pos: { x, y: row },
      shots: creature.shots ?? 0,
      retaliationsLeft: 0,
      defending: false,
      waited: false,
    };
  });
}

function stackSpeed(stack: CombatStack, data: GameData): number {
  return requireCreature(data, stack.creature).speed;
}

// speed order with side-alternating ties, attacker first (spec 7.2)
function orderStacks(
  stacks: CombatStack[],
  data: GameData,
  direction: 'fastestFirst' | 'slowestFirst',
): string[] {
  const speeds = [...new Set(stacks.map((s) => stackSpeed(s, data)))].sort((a, b) =>
    direction === 'fastestFirst' ? b - a : a - b,
  );
  const out: string[] = [];
  for (const speed of speeds) {
    const attackers = stacks.filter(
      (s) => s.side === 'attacker' && stackSpeed(s, data) === speed,
    );
    const defenders = stacks.filter(
      (s) => s.side === 'defender' && stackSpeed(s, data) === speed,
    );
    for (let i = 0; i < Math.max(attackers.length, defenders.length); i++) {
      const a = attackers[i];
      if (a) out.push(a.id);
      const d = defenders[i];
      if (d) out.push(d.id);
    }
  }
  return out;
}

function retaliationsFor(creature: Creature): number {
  return specialValue(creature, 'extraRetaliations') ?? 1;
}

function startRound(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  combat.round += 1;
  const living = livingStacks(combat);
  for (const stack of living) {
    stack.waited = false;
    stack.retaliationsLeft = retaliationsFor(requireCreature(data, stack.creature));
  }
  combat.queue = orderStacks(living, data, 'fastestFirst');
  combat.waitQueue = [];
  events.push({ type: 'roundStarted', round: combat.round });
}

export function createCombat(
  setup: CombatSetup,
  data: GameData,
): { combat: CombatState; events: CombatEvent[] } {
  let rngState = setup.rng;
  let obstacles: Hex[];
  if (setup.obstacles) {
    obstacles = setup.obstacles;
  } else {
    [obstacles, rngState] = generateObstacles(rngState);
  }
  const combat: CombatState = {
    round: 0,
    rngState,
    attackerHero: setup.attacker.hero,
    defenderHero: setup.defender.hero,
    stacks: [
      ...deploySide('attacker', setup.attacker.stacks, data),
      ...deploySide('defender', setup.defender.stacks, data),
    ],
    obstacles,
    queue: [],
    waitQueue: [],
    winner: null,
  };
  const events: CombatEvent[] = [{ type: 'combatStarted', obstacles }];
  startRound(combat, data, events);
  return { combat, events };
}

export function activeCombatStack(combat: CombatState): CombatStack | null {
  const id = combat.queue[0];
  return id === undefined ? null : getCombatStack(combat, id);
}

export function reachableHexesFor(
  combat: CombatState,
  stackId: string,
  data: GameData,
): Hex[] {
  const stack = getCombatStack(combat, stackId);
  const creature = requireCreature(data, stack.creature);
  const canStand = buildCanStand(combat, stack, creature, data);
  if (creature.flags.includes('flying')) {
    const out: Hex[] = [];
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      for (let x = 0; x < FIELD_WIDTH; x++) {
        const hex = { x, y };
        if (hexEquals(hex, stack.pos)) continue;
        if (hexDistance(stack.pos, hex) > creature.speed) continue;
        if (canStand(hex)) out.push(hex);
      }
    }
    return out;
  }
  return bfsReachable(stack.pos, creature.speed, canStand);
}

function buildCanStand(
  combat: CombatState,
  stack: CombatStack,
  creature: Creature,
  data: GameData,
): (head: Hex) => boolean {
  const wide = creature.flags.includes('wide');
  const blocked = new Set<number>(combat.obstacles.map(hexKey));
  for (const other of livingStacks(combat)) {
    if (other.id === stack.id) continue;
    for (const hex of occupiedHexes(other, requireCreature(data, other.creature))) {
      blocked.add(hexKey(hex));
    }
  }
  return (head: Hex): boolean => {
    const cells = wide ? [head, { x: head.x + tailOffset(stack.side), y: head.y }] : [head];
    return cells.every((c) => inField(c) && !blocked.has(hexKey(c)));
  };
}

function minStackDistance(a: CombatStack, b: CombatStack, data: GameData): number {
  const aHexes = occupiedHexes(a, requireCreature(data, a.creature));
  const bHexes = occupiedHexes(b, requireCreature(data, b.creature));
  let min = Infinity;
  for (const ha of aHexes) {
    for (const hb of bHexes) {
      min = Math.min(min, hexDistance(ha, hb));
    }
  }
  return min;
}

function hexesAdjacentToStack(head: Hex, attacker: CombatStack, wide: boolean, target: CombatStack, data: GameData): boolean {
  const attackerCells = wide
    ? [head, { x: head.x + tailOffset(attacker.side), y: head.y }]
    : [head];
  const targetCells = occupiedHexes(target, requireCreature(data, target.creature));
  return attackerCells.some((a) => targetCells.some((t) => hexDistance(a, t) === 1));
}

function hasAdjacentEnemy(combat: CombatState, stack: CombatStack, data: GameData): boolean {
  return livingStacks(combat, oppositeSide(stack.side)).some(
    (enemy) => minStackDistance(stack, enemy, data) === 1,
  );
}

// damage hits the stack HP pool; returns creatures killed
export function applyDamage(stack: CombatStack, creature: Creature, damage: number): number {
  const pool = stack.firstHp + (stack.count - 1) * creature.hp;
  const remaining = pool - damage;
  if (remaining <= 0) {
    const kills = stack.count;
    stack.count = 0;
    stack.firstHp = 0;
    return kills;
  }
  const newCount = Math.ceil(remaining / creature.hp);
  const kills = stack.count - newCount;
  stack.count = newCount;
  stack.firstHp = remaining - (newCount - 1) * creature.hp;
  return kills;
}

interface StrikeOptions {
  ranged: boolean;
  retaliation: boolean;
  joustingHexes: number;
}

function strike(
  combat: CombatState,
  attacker: CombatStack,
  target: CombatStack,
  opts: StrikeOptions,
  data: GameData,
  events: CombatEvent[],
): void {
  const attackerCreature = requireCreature(data, attacker.creature);
  const targetCreature = requireCreature(data, target.creature);
  const attackerHero = heroInfoFor(combat, attacker.side);
  const targetHero = heroInfoFor(combat, target.side);

  const attack = attackerCreature.attack + attackerHero.attack;
  let defense = targetCreature.defense + targetHero.defense;
  if (target.defending) {
    defense = Math.floor(defense * (1 + DEFEND_DEFENSE_BONUS));
  }

  const [base, nextRng] = rollBaseDamage(
    combat.rngState,
    attackerCreature.dmgMin,
    attackerCreature.dmgMax,
    attacker.count,
  );
  combat.rngState = nextRng;

  const isShooter = (attackerCreature.shots ?? 0) > 0;
  const ctx: DamageContext = {
    base,
    attack,
    defense,
    ranged: opts.ranged,
    offenseBonus: opts.ranged ? 0 : attackerHero.offenseBonus,
    archeryBonus: opts.ranged ? attackerHero.archeryBonus : 0,
    armorerReduction: targetHero.armorerReduction,
    distancePenalty:
      opts.ranged && minStackDistance(attacker, target, data) > RANGED_PENALTY_DISTANCE,
    meleePenalty: !opts.ranged && isShooter && !hasSpecial(attackerCreature, 'noMeleePenalty'),
    joustingHexes: opts.joustingHexes,
  };
  const breakdown = computeDamage(ctx);
  const kills = applyDamage(target, targetCreature, breakdown.total);
  events.push({
    type: 'stackAttacked',
    attacker: attacker.id,
    target: target.id,
    damage: breakdown.total,
    kills,
    ranged: opts.ranged,
    retaliation: opts.retaliation,
  });
  if (!isStackAlive(target)) {
    events.push({ type: 'stackDied', stack: target.id });
  }
}

function checkWinner(combat: CombatState): CombatSideId | null {
  if (livingStacks(combat, 'defender').length === 0) return 'attacker';
  if (livingStacks(combat, 'attacker').length === 0) return 'defender';
  return null;
}

function finishTurn(
  combat: CombatState,
  actedId: string,
  data: GameData,
  events: CombatEvent[],
): void {
  const alive = (id: string): boolean => isStackAlive(getCombatStack(combat, id));
  combat.queue = combat.queue.filter((id) => id !== actedId && alive(id));
  combat.waitQueue = combat.waitQueue.filter(alive);

  const winner = checkWinner(combat);
  if (winner !== null) {
    combat.winner = winner;
    combat.queue = [];
    combat.waitQueue = [];
    events.push({ type: 'combatEnded', winner });
    return;
  }
  if (combat.queue.length === 0) {
    if (combat.waitQueue.length > 0) {
      const waiting = combat.waitQueue.map((id) => getCombatStack(combat, id));
      combat.queue = orderStacks(waiting, data, 'slowestFirst');
      combat.waitQueue = [];
    } else {
      startRound(combat, data, events);
    }
  }
}

function requireEnemyTarget(
  combat: CombatState,
  stack: CombatStack,
  targetId: string,
): CombatStack {
  const target = getCombatStack(combat, targetId);
  if (target.side === stack.side) {
    throw new CombatRuleError(`target ${targetId} is friendly`);
  }
  if (!isStackAlive(target)) {
    throw new CombatRuleError(`target ${targetId} is already dead`);
  }
  return target;
}

function applyMove(
  combat: CombatState,
  stack: CombatStack,
  to: Hex,
  data: GameData,
  events: CombatEvent[],
): void {
  if (hexEquals(to, stack.pos)) {
    throw new CombatRuleError('move: already standing there');
  }
  const reachable = reachableHexesFor(combat, stack.id, data);
  if (!reachable.some((h) => hexEquals(h, to))) {
    throw new CombatRuleError(
      `move: hex (${String(to.x)},${String(to.y)}) is not reachable`,
    );
  }
  const from = { ...stack.pos };
  stack.pos = { ...to };
  events.push({ type: 'stackMoved', stack: stack.id, from, to: { ...to } });
}

function applyMelee(
  combat: CombatState,
  stack: CombatStack,
  action: Extract<CombatAction, { type: 'melee' }>,
  data: GameData,
  events: CombatEvent[],
): void {
  const creature = requireCreature(data, stack.creature);
  const target = requireEnemyTarget(combat, stack, action.target);
  const wide = creature.flags.includes('wide');
  if (!hexesAdjacentToStack(action.from, stack, wide, target, data)) {
    throw new CombatRuleError(
      `melee: (${String(action.from.x)},${String(action.from.y)}) is not adjacent to ${target.id}`,
    );
  }
  const origin = { ...stack.pos };
  if (!hexEquals(action.from, stack.pos)) {
    applyMove(combat, stack, action.from, data, events);
  }
  const joustingHexes = hasSpecial(creature, 'jousting') ? hexDistance(origin, action.from) : 0;
  strike(combat, stack, target, { ranged: false, retaliation: false, joustingHexes }, data, events);

  const targetCreature = requireCreature(data, target.creature);
  const canRetaliate =
    isStackAlive(target) &&
    !hasSpecial(creature, 'noRetaliation') &&
    (hasSpecial(targetCreature, 'unlimitedRetaliation') || target.retaliationsLeft > 0);
  if (canRetaliate) {
    if (!hasSpecial(targetCreature, 'unlimitedRetaliation')) {
      target.retaliationsLeft -= 1;
    }
    strike(
      combat,
      target,
      stack,
      { ranged: false, retaliation: true, joustingHexes: 0 },
      data,
      events,
    );
  }
}

function applyShoot(
  combat: CombatState,
  stack: CombatStack,
  action: Extract<CombatAction, { type: 'shoot' }>,
  data: GameData,
  events: CombatEvent[],
): void {
  const creature = requireCreature(data, stack.creature);
  if (creature.shots === undefined) {
    throw new CombatRuleError(`${creature.id} is not a shooter`);
  }
  if (stack.shots < 1) {
    throw new CombatRuleError(`${stack.id} has no shots left`);
  }
  if (hasAdjacentEnemy(combat, stack, data)) {
    throw new CombatRuleError('cannot shoot with an adjacent enemy');
  }
  const target = requireEnemyTarget(combat, stack, action.target);
  stack.shots -= 1;
  strike(combat, stack, target, { ranged: true, retaliation: false, joustingHexes: 0 }, data, events);
}

export function combatAct(
  combat: CombatState,
  action: CombatAction,
  data: GameData,
): CombatEvent[] {
  if (combat.winner !== null) {
    throw new CombatRuleError('combat is over');
  }
  const stack = activeCombatStack(combat);
  if (!stack) {
    throw new Error('combat has no active stack');
  }
  const events: CombatEvent[] = [];
  stack.defending = false;
  switch (action.type) {
    case 'wait':
      if (stack.waited) {
        throw new CombatRuleError(`${stack.id} already waited this round`);
      }
      stack.waited = true;
      combat.waitQueue.push(stack.id);
      events.push({ type: 'stackWaited', stack: stack.id });
      break;
    case 'defend':
      stack.defending = true;
      events.push({ type: 'stackDefended', stack: stack.id });
      break;
    case 'move':
      applyMove(combat, stack, action.to, data, events);
      break;
    case 'melee':
      applyMelee(combat, stack, action, data, events);
      break;
    case 'shoot':
      applyShoot(combat, stack, action, data, events);
      break;
  }
  finishTurn(combat, stack.id, data, events);
  return events;
}
