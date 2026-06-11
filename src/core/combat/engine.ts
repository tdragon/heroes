import type { GameData } from '../../data';
import type { Creature } from '../../data/schema';
import { effectiveStats } from '../hero';
import { rollChance, rollRange, type RngState } from '../rng';
import { skillValue, type Hero } from '../state';
import {
  addEffect,
  damageStack,
  effectiveAttack,
  effectiveDefense,
  effectiveHp,
  effectiveSpeed,
  getEffect,
  hasSpecial,
  healTopCreature,
  isBlinded,
  isBound,
  MORALE_LUCK_DIE,
  ON_HIT_EFFECT_ROUNDS,
  requireCreature,
  resurrectStack,
  sideLuck,
  specialValue,
  stackHpPool,
  stackMorale,
  type DamageOutcome,
} from './abilities';
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
  hexLineExtend,
  inField,
  type Hex,
} from './grid';
import { castCombatSpell, type CastAction } from '../magic';
import {
  CATAPULT_HIT_CHANCE,
  createSiege,
  isMoatHex,
  MOAT_DAMAGE,
  siegeBlockedHexes,
  standingSegments,
  TOWER_CREATURE,
  WALL_MELEE_DAMAGE,
  WALL_X,
  wallsBreached,
  type SiegeLevel,
} from './siege';
import {
  CombatRuleError,
  getCombatStack,
  heroInfoFor,
  isStackAlive,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatEvent,
  type CombatHeroInfo,
  type CombatSideId,
  type CombatStack,
  type CombatState,
} from './state';

export { CombatRuleError, type CombatEvent } from './state';
export { applyDamage } from './abilities';

export type CombatAction =
  | { type: 'move'; to: Hex }
  | { type: 'melee'; target: string; from: Hex }
  | { type: 'shoot'; target: string }
  | { type: 'defend' }
  | { type: 'wait' }
  | ({ type: 'cast' } & CastAction)
  | { type: 'resurrect'; target: string }
  | { type: 'attackWall'; segment: number; from: Hex };

export const DEFEND_DEFENSE_BONUS = 0.2;

// rows used for up to 7 deployment slots, spread top-to-bottom
const SLOT_ROWS: readonly number[] = [0, 2, 4, 5, 6, 8, 10];

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
    morale: stats.morale + hero.tempMorale,
    luck: stats.luck + hero.tempLuck,
    mana: hero.mana,
    hasSpellbook: hero.hasSpellbook,
    spells: [...hero.spells],
    schoolTiers: {
      air: skillValue(hero, 'air_magic', data),
      earth: skillValue(hero, 'earth_magic', data),
      fire: skillValue(hero, 'fire_magic', data),
      water: skillValue(hero, 'water_magic', data),
    },
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
  siege?: SiegeLevel;
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
      initialCount: entry.count,
      firstHp: creature.hp,
      pos: { x, y: row },
      shots: creature.shots ?? 0,
      retaliationsLeft: 0,
      defending: false,
      waited: false,
      moraleSurged: false,
      usedResurrect: false,
      effects: [],
    };
  });
}

function stackSpeed(stack: CombatStack, data: GameData): number {
  return effectiveSpeed(stack, requireCreature(data, stack.creature));
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

function pushDamageEvents(
  target: CombatStack,
  outcome: DamageOutcome,
  events: CombatEvent[],
): void {
  if (outcome.blindBroken) {
    events.push({ type: 'effectExpired', stack: target.id, kind: 'blind' });
  }
  if (outcome.died) {
    events.push({ type: 'stackDied', stack: target.id });
  }
}

function expireEffects(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  for (const stack of combat.stacks) {
    if (!isStackAlive(stack)) continue;
    const kept: typeof stack.effects = [];
    for (const effect of stack.effects) {
      effect.rounds -= 1;
      let expired = effect.rounds <= 0;
      // bind holds only while a living enemy binder stands adjacent
      if (effect.kind === 'bind') {
        const binderAdjacent = livingStacks(combat, oppositeSide(stack.side)).some((enemy) => {
          const enemyCreature = requireCreature(data, enemy.creature);
          if (!hasSpecial(enemyCreature, 'bind')) return false;
          const enemyHexes = occupiedHexes(enemy, enemyCreature);
          const ownHexes = occupiedHexes(stack, requireCreature(data, stack.creature));
          return ownHexes.some((h) => enemyHexes.some((e) => hexDistance(h, e) === 1));
        });
        expired = !binderAdjacent;
        if (!expired) effect.rounds = 1;
      }
      if (expired) {
        events.push({ type: 'effectExpired', stack: stack.id, kind: effect.kind });
      } else {
        kept.push(effect);
      }
    }
    stack.effects = kept;
  }
}

function processRegeneration(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  for (const stack of livingStacks(combat)) {
    const creature = requireCreature(data, stack.creature);
    if (!hasSpecial(creature, 'regeneration')) continue;
    const maxHp = effectiveHp(stack, creature);
    const healed = healTopCreature(stack, maxHp, maxHp);
    if (healed > 0) {
      events.push({ type: 'stackHealed', stack: stack.id, amount: healed });
    }
  }
}

function processManaDrain(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  for (const stack of livingStacks(combat)) {
    const drain = specialValue(requireCreature(data, stack.creature), 'manaDrain');
    if (drain === undefined) continue;
    const enemySide = oppositeSide(stack.side);
    const enemyHero = heroInfoFor(combat, enemySide);
    const amount = Math.min(enemyHero.mana, drain);
    if (amount <= 0) continue;
    enemyHero.mana -= amount;
    events.push({ type: 'manaDrained', side: enemySide, amount, by: stack.id });
  }
}

function nearestEnemyToHex(
  combat: CombatState,
  side: CombatSideId,
  from: Hex,
  data: GameData,
): CombatStack | null {
  let best: CombatStack | null = null;
  let bestDistance = Infinity;
  for (const stack of livingStacks(combat, side)) {
    const distance = Math.min(
      ...occupiedHexes(stack, requireCreature(data, stack.creature)).map((h) =>
        hexDistance(from, h),
      ),
    );
    if (distance < bestDistance || (distance === bestDistance && best && stack.id < best.id)) {
      best = stack;
      bestDistance = distance;
    }
  }
  return best;
}

function processSiegeRoundStart(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  const siege = combat.siege;
  if (!siege) return;

  // attacker catapult: 50% to hit a random standing wall segment, 2 dmg on luck
  const targets = standingSegments(siege, false);
  if (targets.length > 0) {
    const [hit, afterHit] = rollChance(combat.rngState, CATAPULT_HIT_CHANCE);
    combat.rngState = afterHit;
    if (hit) {
      const [pick, afterPick] = rollRange(combat.rngState, 0, targets.length - 1);
      combat.rngState = afterPick;
      const segment = targets[pick];
      if (!segment) throw new Error('catapult segment pick out of range');
      let damage = 1;
      const luck = sideLuck(combat, 'attacker');
      if (luck > 0) {
        const [lucky, afterLuck] = rollChance(combat.rngState, luck / MORALE_LUCK_DIE);
        combat.rngState = afterLuck;
        if (lucky) damage = 2;
      }
      segment.hp = Math.max(0, segment.hp - damage);
      events.push({
        type: 'wallHit',
        segment: siege.segments.indexOf(segment),
        damage,
        hp: segment.hp,
        source: 'catapult',
      });
    }
  }

  // defender arrow towers shoot the nearest attacker stack
  const archer = requireCreature(data, TOWER_CREATURE);
  siege.towers.forEach((tower, index) => {
    const target = nearestEnemyToHex(combat, 'attacker', tower.pos, data);
    if (!target) return;
    const targetCreature = requireCreature(data, target.creature);
    const [base, afterBase] = rollBaseDamage(
      combat.rngState,
      archer.dmgMin,
      archer.dmgMax,
      tower.count,
    );
    combat.rngState = afterBase;
    const breakdown = computeDamage({
      base,
      attack: archer.attack + combat.defenderHero.attack,
      defense:
        effectiveDefense(target, targetCreature) +
        combat.attackerHero.defense +
        (target.defending ? Math.floor(targetCreature.defense * DEFEND_DEFENSE_BONUS) : 0),
      ranged: true,
      distancePenalty: hexDistance(tower.pos, target.pos) > RANGED_PENALTY_DISTANCE,
      armorerReduction: combat.attackerHero.armorerReduction,
    });
    const outcome = damageStack(target, targetCreature, breakdown.total);
    events.push({
      type: 'towerShot',
      tower: index,
      target: target.id,
      damage: breakdown.total,
      kills: outcome.kills,
    });
    pushDamageEvents(target, outcome, events);
  });

  // moat damages anything standing in it
  for (const stack of livingStacks(combat)) {
    if (!isMoatHex(siege, stack.pos)) continue;
    const creature = requireCreature(data, stack.creature);
    const outcome = damageStack(stack, creature, MOAT_DAMAGE);
    events.push({ type: 'moatDamage', stack: stack.id, damage: MOAT_DAMAGE });
    pushDamageEvents(stack, outcome, events);
  }
}

function startRound(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  combat.round += 1;
  events.push({ type: 'roundStarted', round: combat.round });
  expireEffects(combat, data, events);
  for (const stack of livingStacks(combat)) {
    stack.waited = false;
    stack.moraleSurged = false;
    stack.retaliationsLeft = retaliationsFor(requireCreature(data, stack.creature));
  }
  combat.castThisRound = { attacker: false, defender: false };
  processRegeneration(combat, data, events);
  processManaDrain(combat, data, events);
  processSiegeRoundStart(combat, data, events);
  combat.queue = orderStacks(livingStacks(combat), data, 'fastestFirst');
  combat.waitQueue = [];
}

function checkWinner(combat: CombatState): CombatSideId | null {
  if (livingStacks(combat, 'defender').length === 0) return 'attacker';
  if (livingStacks(combat, 'attacker').length === 0) return 'defender';
  return null;
}

// prune the queues, declare a winner, refill rounds, and skip disabled stacks
// until a stack that can act is at the front (or combat is over)
function normalizeQueue(combat: CombatState, data: GameData, events: CombatEvent[]): void {
  for (;;) {
    const alive = (id: string): boolean => isStackAlive(getCombatStack(combat, id));
    combat.queue = combat.queue.filter(alive);
    combat.waitQueue = combat.waitQueue.filter(alive);

    const winner = checkWinner(combat);
    if (winner !== null) {
      combat.winner = winner;
      combat.queue = [];
      combat.waitQueue = [];
      events.push({ type: 'combatEnded', winner });
      return;
    }

    const headId = combat.queue[0];
    if (headId === undefined) {
      if (combat.waitQueue.length > 0) {
        const waiting = combat.waitQueue.map((id) => getCombatStack(combat, id));
        combat.queue = orderStacks(waiting, data, 'slowestFirst');
        combat.waitQueue = [];
      } else {
        startRound(combat, data, events);
      }
      continue;
    }

    const head = getCombatStack(combat, headId);
    if (isBlinded(head)) {
      events.push({ type: 'stackSkipped', stack: headId, reason: 'blind' });
      combat.queue = combat.queue.slice(1);
      continue;
    }
    return;
  }
}

function finishTurn(
  combat: CombatState,
  actedId: string,
  data: GameData,
  events: CombatEvent[],
): void {
  combat.queue = combat.queue.filter((id) => id !== actedId);
  normalizeQueue(combat, data, events);
}

export function createCombat(
  setup: CombatSetup,
  data: GameData,
): { combat: CombatState; events: CombatEvent[] } {
  let rngState = setup.rng;
  let obstacles: Hex[];
  if (setup.obstacles) {
    obstacles = setup.obstacles;
  } else if (setup.siege) {
    obstacles = [];
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
    castThisRound: { attacker: false, defender: false },
    siege: setup.siege ? createSiege(setup.siege) : null,
    winner: null,
  };
  const events: CombatEvent[] = [{ type: 'combatStarted', obstacles }];
  startRound(combat, data, events);
  normalizeQueue(combat, data, events);
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
  if (isBound(stack)) return [];
  const creature = requireCreature(data, stack.creature);
  const speed = effectiveSpeed(stack, creature);
  const canStand = buildCanStand(combat, stack, creature, data);
  if (creature.flags.includes('flying')) {
    const out: Hex[] = [];
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      for (let x = 0; x < FIELD_WIDTH; x++) {
        const hex = { x, y };
        if (hexEquals(hex, stack.pos)) continue;
        if (hexDistance(stack.pos, hex) > speed) continue;
        if (canStand(hex)) out.push(hex);
      }
    }
    return out;
  }
  const siege = combat.siege;
  const stopAt = siege ? (h: Hex): boolean => isMoatHex(siege, h) : undefined;
  return bfsReachable(stack.pos, speed, canStand, stopAt);
}

function buildCanStand(
  combat: CombatState,
  stack: CombatStack,
  creature: Creature,
  data: GameData,
): (head: Hex) => boolean {
  const wide = creature.flags.includes('wide');
  const blocked = new Set<number>(combat.obstacles.map(hexKey));
  if (combat.siege) {
    for (const hex of siegeBlockedHexes(combat.siege, stack.side)) {
      blocked.add(hexKey(hex));
    }
  }
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

function hexesAdjacentToStack(
  head: Hex,
  attacker: CombatStack,
  wide: boolean,
  target: CombatStack,
  data: GameData,
): boolean {
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

interface StrikeOptions {
  ranged: boolean;
  retaliation: boolean;
  joustingHexes: number;
  wallPenalty?: boolean;
  retaliationPenaltyMult?: number;
}

const ON_HIT_EFFECTS = [
  { special: 'curse', kind: 'curse', skipUndead: true, value: 0 },
  { special: 'disease', kind: 'disease', skipUndead: false, value: 2 },
  { special: 'blind', kind: 'blind', skipUndead: true, value: 50 },
  { special: 'aging', kind: 'aging', skipUndead: false, value: 0 },
] as const;

function applyOnHitEffects(
  combat: CombatState,
  attackerCreature: Creature,
  target: CombatStack,
  targetCreature: Creature,
  events: CombatEvent[],
): void {
  const targetUndead = targetCreature.flags.includes('undead');
  for (const entry of ON_HIT_EFFECTS) {
    const chance = specialValue(attackerCreature, entry.special);
    if (chance === undefined) continue;
    if (entry.skipUndead && targetUndead) continue;
    const [hit, next] = rollChance(combat.rngState, chance / 100);
    combat.rngState = next;
    if (!hit) continue;
    addEffect(target, {
      kind: entry.kind,
      positive: false,
      rounds: ON_HIT_EFFECT_ROUNDS,
      value: entry.value,
    });
    if (entry.kind === 'aging') {
      // halving HP can shrink the current top-creature pool immediately
      target.firstHp = Math.min(target.firstHp, effectiveHp(target, targetCreature));
    }
    events.push({
      type: 'effectApplied',
      stack: target.id,
      kind: entry.kind,
      rounds: ON_HIT_EFFECT_ROUNDS,
      value: entry.value,
    });
  }
  if (hasSpecial(attackerCreature, 'bind') && !targetUndead) {
    // dendroids always bind; freshness tracked per round in expireEffects
    addEffect(target, { kind: 'bind', positive: false, rounds: 1, value: 0 });
    events.push({ type: 'effectApplied', stack: target.id, kind: 'bind', rounds: 1, value: 0 });
  }
}

// returns total damage dealt
function strike(
  combat: CombatState,
  attacker: CombatStack,
  target: CombatStack,
  opts: StrikeOptions,
  data: GameData,
  events: CombatEvent[],
): number {
  const attackerCreature = requireCreature(data, attacker.creature);
  const targetCreature = requireCreature(data, target.creature);
  const attackerHero = heroInfoFor(combat, attacker.side);
  const targetHero = heroInfoFor(combat, target.side);

  const attack = effectiveAttack(attacker, attackerCreature, !opts.ranged) + attackerHero.attack;
  let defense = effectiveDefense(target, targetCreature) + targetHero.defense;
  if (target.defending) {
    defense = Math.floor(defense * (1 + DEFEND_DEFENSE_BONUS));
  }

  // bless forces max damage, curse forces (reduced) min damage
  const curse = getEffect(attacker, 'curse');
  const bless = getEffect(attacker, 'bless');
  let base: number;
  if (curse) {
    base = attacker.count * attackerCreature.dmgMin * (1 - curse.value / 100);
  } else if (bless) {
    base = attacker.count * (attackerCreature.dmgMax + bless.value);
  } else {
    const [rolled, nextRng] = rollBaseDamage(
      combat.rngState,
      attackerCreature.dmgMin,
      attackerCreature.dmgMax,
      attacker.count,
    );
    combat.rngState = nextRng;
    base = rolled;
  }

  let lucky = false;
  const luck = sideLuck(combat, attacker.side);
  if (luck > 0) {
    const [rolledLucky, nextRng] = rollChance(combat.rngState, luck / MORALE_LUCK_DIE);
    combat.rngState = nextRng;
    lucky = rolledLucky;
    if (lucky) {
      events.push({ type: 'luck', stack: attacker.id });
    }
  }

  let doubled = false;
  const doubleChance = specialValue(attackerCreature, 'doubleDamage');
  if (doubleChance !== undefined) {
    const [rolledDouble, nextRng] = rollChance(combat.rngState, doubleChance / 100);
    combat.rngState = nextRng;
    doubled = rolledDouble;
    if (doubled) {
      events.push({ type: 'abilityTriggered', stack: attacker.id, ability: 'doubleDamage' });
    }
  }

  let effectMult = opts.retaliationPenaltyMult ?? 1;
  const shield = getEffect(target, 'shield');
  if (shield && !opts.ranged) {
    effectMult *= 1 - shield.value / 100;
  }
  if (opts.ranged) {
    const forget = getEffect(attacker, 'forgetfulness');
    if (forget && forget.value < 100) {
      effectMult *= 0.5;
    }
  }

  const isShooter = attackerCreature.shots !== undefined;
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
    wallPenalty: opts.wallPenalty ?? false,
    lucky,
    doubleDamage: doubled,
    effectMult,
    joustingHexes: opts.joustingHexes,
  };
  const breakdown = computeDamage(ctx);
  const outcome = damageStack(target, targetCreature, breakdown.total);
  events.push({
    type: 'stackAttacked',
    attacker: attacker.id,
    target: target.id,
    damage: breakdown.total,
    kills: outcome.kills,
    ranged: opts.ranged,
    retaliation: opts.retaliation,
  });
  pushDamageEvents(target, outcome, events);

  if (isStackAlive(target)) {
    applyOnHitEffects(combat, attackerCreature, target, targetCreature, events);
  }

  if (hasSpecial(attackerCreature, 'lifeDrain') && breakdown.total > 0 && isStackAlive(attacker)) {
    const revived = resurrectStack(
      attacker,
      effectiveHp(attacker, attackerCreature),
      breakdown.total,
    );
    events.push({ type: 'abilityTriggered', stack: attacker.id, ability: 'lifeDrain' });
    events.push({ type: 'stackResurrected', stack: attacker.id, revived });
  }

  return breakdown.total;
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
  if (isBound(stack)) {
    throw new CombatRuleError(`${stack.id} is bound in place`);
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

function breathStrike(
  combat: CombatState,
  attacker: CombatStack,
  target: CombatStack,
  data: GameData,
  events: CombatEvent[],
): void {
  const attackerCreature = requireCreature(data, attacker.creature);
  if (!hasSpecial(attackerCreature, 'breath')) return;
  // find the attacker cell adjacent to a target cell to define the direction
  const attackerCells = occupiedHexes(attacker, attackerCreature);
  const targetCells = occupiedHexes(target, requireCreature(data, target.creature));
  for (const from of attackerCells) {
    for (const through of targetCells) {
      if (hexDistance(from, through) !== 1) continue;
      const beyond = hexLineExtend(from, through);
      if (!beyond) continue;
      const victim = livingStacks(combat).find(
        (s) =>
          s.id !== attacker.id &&
          s.id !== target.id &&
          occupiedHexes(s, requireCreature(data, s.creature)).some((h) => hexEquals(h, beyond)),
      );
      if (!victim) continue;
      events.push({
        type: 'abilityTriggered',
        stack: attacker.id,
        ability: 'breath',
        target: victim.id,
      });
      strike(combat, attacker, victim, { ranged: false, retaliation: false, joustingHexes: 0 }, data, events);
      return;
    }
  }
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

  // capture blind state before the hit: damage wakes the target, which then
  // retaliates at the blind penalty (no retaliation at 100)
  const blind = getEffect(target, 'blind');
  const blindMult = blind ? (blind.value >= 100 ? 0 : 1 - blind.value / 100) : 1;

  const strikeOnce = (): void => {
    strike(combat, stack, target, { ranged: false, retaliation: false, joustingHexes }, data, events);
    breathStrike(combat, stack, target, data, events);
  };
  strikeOnce();

  const targetCreature = requireCreature(data, target.creature);
  const canRetaliate =
    isStackAlive(target) &&
    isStackAlive(stack) &&
    blindMult > 0 &&
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
      {
        ranged: false,
        retaliation: true,
        joustingHexes: 0,
        retaliationPenaltyMult: blindMult,
      },
      data,
      events,
    );
  }

  if (hasSpecial(creature, 'doubleAttack') && isStackAlive(stack) && isStackAlive(target)) {
    events.push({ type: 'abilityTriggered', stack: stack.id, ability: 'doubleAttack' });
    strikeOnce();
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
  const forget = getEffect(stack, 'forgetfulness');
  if (forget && forget.value >= 100) {
    throw new CombatRuleError(`${stack.id} forgot how to shoot`);
  }
  const target = requireEnemyTarget(combat, stack, action.target);

  const siege = combat.siege;
  const wallPenalty = (victim: CombatStack): boolean => {
    if (!siege || stack.side !== 'attacker' || wallsBreached(siege)) return false;
    return occupiedHexes(victim, requireCreature(data, victim.creature)).some(
      (h) => h.x > WALL_X,
    );
  };

  const shoot = (): void => {
    stack.shots -= 1;
    strike(
      combat,
      stack,
      target,
      { ranged: true, retaliation: false, joustingHexes: 0, wallPenalty: wallPenalty(target) },
      data,
      events,
    );
    // lich death cloud splashes living stacks around the target hex
    if (hasSpecial(creature, 'deathCloud')) {
      const splash = livingStacks(combat).filter((s) => {
        if (s.id === stack.id || s.id === target.id) return false;
        const sCreature = requireCreature(data, s.creature);
        if (sCreature.flags.includes('undead')) return false;
        return occupiedHexes(s, sCreature).some((h) => hexDistance(h, target.pos) === 1);
      });
      for (const victim of splash) {
        events.push({
          type: 'abilityTriggered',
          stack: stack.id,
          ability: 'deathCloud',
          target: victim.id,
        });
        strike(
          combat,
          stack,
          victim,
          { ranged: true, retaliation: false, joustingHexes: 0, wallPenalty: wallPenalty(victim) },
          data,
          events,
        );
      }
    }
  };

  shoot();
  if (
    hasSpecial(creature, 'doubleShot') &&
    stack.shots > 0 &&
    isStackAlive(target) &&
    isStackAlive(stack)
  ) {
    events.push({ type: 'abilityTriggered', stack: stack.id, ability: 'doubleShot' });
    shoot();
  }
}

function applyResurrect(
  combat: CombatState,
  stack: CombatStack,
  action: Extract<CombatAction, { type: 'resurrect' }>,
  data: GameData,
  events: CombatEvent[],
): void {
  const creature = requireCreature(data, stack.creature);
  const perCreature = specialValue(creature, 'resurrectOnce');
  if (perCreature === undefined) {
    throw new CombatRuleError(`${creature.id} cannot resurrect`);
  }
  if (stack.usedResurrect) {
    throw new CombatRuleError(`${stack.id} already resurrected this battle`);
  }
  const target = getCombatStack(combat, action.target);
  if (target.side !== stack.side || target.id === stack.id) {
    throw new CombatRuleError('can only resurrect another friendly stack');
  }
  const targetCreature = requireCreature(data, target.creature);
  const maxHp = effectiveHp(target, targetCreature);
  if (stackHpPool(target, maxHp) >= target.initialCount * maxHp) {
    throw new CombatRuleError(`${target.id} has no losses to resurrect`);
  }
  const revived = resurrectStack(target, maxHp, perCreature * stack.count);
  stack.usedResurrect = true;
  events.push({ type: 'abilityTriggered', stack: stack.id, ability: 'resurrectOnce', target: target.id });
  events.push({ type: 'stackResurrected', stack: target.id, revived });
}

function applyAttackWall(
  combat: CombatState,
  stack: CombatStack,
  action: Extract<CombatAction, { type: 'attackWall' }>,
  data: GameData,
  events: CombatEvent[],
): void {
  const siege = combat.siege;
  if (!siege) {
    throw new CombatRuleError('no walls to attack');
  }
  if (stack.side !== 'attacker') {
    throw new CombatRuleError('defenders cannot attack their own walls');
  }
  const segment = siege.segments[action.segment];
  if (!segment) {
    throw new CombatRuleError(`unknown wall segment ${String(action.segment)}`);
  }
  if (segment.hp <= 0) {
    throw new CombatRuleError('that wall segment is already destroyed');
  }
  if (!segment.isGate) {
    throw new CombatRuleError('only the gate can be attacked in melee');
  }
  const creature = requireCreature(data, stack.creature);
  const wide = creature.flags.includes('wide');
  const cells = wide
    ? [action.from, { x: action.from.x + tailOffset(stack.side), y: action.from.y }]
    : [action.from];
  if (!cells.some((c) => hexDistance(c, segment.pos) === 1)) {
    throw new CombatRuleError('not adjacent to the gate');
  }
  if (!hexEquals(action.from, stack.pos)) {
    applyMove(combat, stack, action.from, data, events);
  }
  segment.hp = Math.max(0, segment.hp - WALL_MELEE_DAMAGE);
  events.push({
    type: 'wallHit',
    segment: siege.segments.indexOf(segment),
    damage: WALL_MELEE_DAMAGE,
    hp: segment.hp,
    source: 'melee',
  });
}

export function combatAct(
  combat: CombatState,
  action: CombatAction,
  data: GameData,
): CombatEvent[] {
  if (combat.winner !== null) {
    throw new CombatRuleError('combat is over');
  }
  const events: CombatEvent[] = [];
  // skip stacks disabled since the last action (e.g. blinded by an effect)
  normalizeQueue(combat, data, events);
  const stack = activeCombatStack(combat);
  if (!stack) {
    // normalization can finish the combat (an empty queue means a winner)
    return events;
  }

  // a cast happens at the start of an own stack's action and doesn't use it up
  if (action.type === 'cast') {
    castCombatSpell(combat, stack.side, action, data, events);
    if (!isStackAlive(stack)) {
      finishTurn(combat, stack.id, data, events);
    } else {
      normalizeQueue(combat, data, events);
    }
    return events;
  }

  const morale = stackMorale(combat, stack, data);
  if (morale < 0) {
    const [frozen, nextRng] = rollChance(combat.rngState, -morale / MORALE_LUCK_DIE);
    combat.rngState = nextRng;
    if (frozen) {
      stack.defending = false;
      events.push({ type: 'moraleFreeze', stack: stack.id });
      finishTurn(combat, stack.id, data, events);
      return events;
    }
  }

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
    case 'resurrect':
      applyResurrect(combat, stack, action, data, events);
      break;
    case 'attackWall':
      applyAttackWall(combat, stack, action, data, events);
      break;
  }

  // positive morale: chance of an immediate extra action (once per round)
  const surgeEligible =
    action.type === 'move' || action.type === 'melee' || action.type === 'shoot';
  if (
    surgeEligible &&
    morale > 0 &&
    !stack.moraleSurged &&
    isStackAlive(stack) &&
    checkWinner(combat) === null
  ) {
    const [surged, nextRng] = rollChance(combat.rngState, morale / MORALE_LUCK_DIE);
    combat.rngState = nextRng;
    if (surged) {
      stack.moraleSurged = true;
      events.push({ type: 'moraleSurge', stack: stack.id });
      normalizeQueue(combat, data, events);
      return events;
    }
  }

  finishTurn(combat, stack.id, data, events);
  return events;
}
