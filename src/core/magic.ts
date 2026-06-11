// Magic system: spell learning on the adventure side and spell casting inside
// combat. The hero casts at most one spell per combat round; school skills
// raise the effect tier (none/basic/advanced/expert).

import type { GameData } from '../data';
import type { Spell, SpellTier } from '../data/schema';
import type { Pos } from '../maps/schema';
import { CommandRejectedError, type Command, type GameEvent } from './commands';
import { isExplored, revealFor, sightRadius } from './fog';
import { buildMoveContext, isEnterable } from './movement';
import {
  addEffect,
  damageStack,
  effectiveHp,
  healTopCreature,
  magicResistChance,
  requireCreature,
  resurrectStack,
  specialValue,
} from './combat/abilities';
import { hexDistance, hexNeighbors, inField, type Hex } from './combat/grid';
import {
  CombatRuleError,
  getCombatStack,
  heroInfoFor,
  isStackAlive,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  type CombatEvent,
  type CombatHeroInfo,
  type CombatSideId,
  type CombatStack,
  type CombatState,
  type EffectKind,
} from './combat/state';
import { rollChance } from './rng';
import { getPlayer, skillValue, type GameState, type Hero, type Town } from './state';

export const SPELLBOOK_COST = 500;
export const BASE_LEARNABLE_LEVEL = 2;

// --- learning ---

export function maxLearnableSpellLevel(hero: Hero, data: GameData): number {
  return Math.max(BASE_LEARNABLE_LEVEL, skillValue(hero, 'wisdom', data));
}

export function canLearnSpell(hero: Hero, spell: Spell, data: GameData): boolean {
  return hero.hasSpellbook && spell.level <= maxLearnableSpellLevel(hero, data);
}

// visiting a town with a mage guild teaches all learnable guild spells
export function learnGuildSpells(hero: Hero, town: Town, data: GameData): string[] {
  const learned: string[] = [];
  for (const spellId of town.guildSpells) {
    if (hero.spells.includes(spellId)) continue;
    const spell = data.spells[spellId];
    if (!spell) {
      throw new Error(`town ${town.id}: unknown guild spell ${spellId}`);
    }
    if (!canLearnSpell(hero, spell, data)) continue;
    hero.spells.push(spellId);
    learned.push(spellId);
  }
  return learned;
}

export function buySpellbook(state: GameState, hero: Hero, town: Town, data: GameData): void {
  if (hero.hasSpellbook) {
    throw new CombatRuleError(`${hero.id} already owns a spellbook`);
  }
  if (town.owner !== hero.owner) {
    throw new CombatRuleError('can only buy a spellbook in an own town');
  }
  if (!town.buildings.includes('mage_guild_1')) {
    throw new CombatRuleError('the town has no mage guild');
  }
  const player = getPlayer(state, hero.owner);
  if (player.resources.gold < SPELLBOOK_COST) {
    throw new CombatRuleError(`a spellbook costs ${String(SPELLBOOK_COST)} gold`);
  }
  player.resources.gold -= SPELLBOOK_COST;
  hero.hasSpellbook = true;
  learnGuildSpells(hero, town, data);
}

// --- combat casting ---

export interface CastAction {
  spell: string;
  target?: string;
  hex?: Hex;
}

const UNDEAD_IMMUNE_SPELLS = new Set([
  'blind',
  'bless',
  'curse',
  'death_ripple',
  'resurrection',
]);

const SPELL_EFFECT_KINDS: Partial<Record<string, EffectKind>> = {
  haste: 'haste',
  slow: 'slow',
  shield: 'shield',
  stone_skin: 'stone_skin',
  bless: 'bless',
  curse: 'curse',
  bloodlust: 'bloodlust',
  weakness: 'weakness',
  blind: 'blind',
  forgetfulness: 'forgetfulness',
};

export function schoolTier(hero: CombatHeroInfo, spell: Spell): number {
  const tiers = hero.schoolTiers;
  const tier =
    spell.school === 'all'
      ? Math.max(tiers.air, tiers.earth, tiers.fire, tiers.water)
      : tiers[spell.school];
  return Math.max(0, Math.min(3, tier));
}

export function enemySpellCostAura(
  combat: CombatState,
  side: CombatSideId,
  data: GameData,
): number {
  let extra = 0;
  for (const stack of livingStacks(combat, oppositeSide(side))) {
    extra = Math.max(extra, specialValue(requireCreature(data, stack.creature), 'spellCostAura') ?? 0);
  }
  return extra;
}

export function spellCost(combat: CombatState, side: CombatSideId, spell: Spell, data: GameData): number {
  return spell.manaCost + enemySpellCostAura(combat, side, data);
}

export function isSpellImmune(target: CombatStack, spell: Spell, data: GameData): boolean {
  const creature = requireCreature(data, target.creature);
  const levelImmunity = specialValue(creature, 'spellImmunityToLevel');
  if (levelImmunity !== undefined && spell.level <= levelImmunity) return true;
  if (creature.flags.includes('undead')) {
    if (UNDEAD_IMMUNE_SPELLS.has(spell.id)) return true;
  } else if (spell.id === 'animate_dead') {
    return true;
  }
  return false;
}

function isHostile(spell: Spell): boolean {
  return spell.kind === 'damage' || spell.kind === 'debuff' || spell.kind === 'disable';
}

function requireTier(spell: Spell, tier: number): SpellTier {
  const tierData = spell.tiers[tier];
  if (!tierData) {
    throw new Error(`spell ${spell.id}: missing tier ${String(tier)}`);
  }
  return tierData;
}

function magnitude(tierData: SpellTier, spellPower: number): number {
  return Math.floor((tierData.base ?? 0) + (tierData.spCoef ?? 0) * spellPower);
}

function requireSpell(data: GameData, id: string): Spell {
  const spell = data.spells[id];
  if (!spell) {
    throw new CombatRuleError(`unknown spell: ${id}`);
  }
  return spell;
}

function requireTargetStack(combat: CombatState, action: CastAction): CombatStack {
  if (action.target === undefined) {
    throw new CombatRuleError(`spell ${action.spell} needs a target stack`);
  }
  return getCombatStack(combat, action.target);
}

function stacksInArea(combat: CombatState, center: Hex, data: GameData): CombatStack[] {
  const area = [center, ...hexNeighbors(center)];
  return livingStacks(combat).filter((stack) =>
    occupiedHexes(stack, requireCreature(data, stack.creature)).some((h) =>
      area.some((a) => h.x === a.x && h.y === a.y),
    ),
  );
}

// resolve which stacks the cast tries to affect (before immunity/resistance)
function resolveTargets(
  combat: CombatState,
  side: CombatSideId,
  spell: Spell,
  tierData: SpellTier,
  action: CastAction,
  data: GameData,
): CombatStack[] {
  switch (spell.target) {
    case 'battlefield':
      return livingStacks(combat);
    case 'area': {
      if (!action.hex || !inField(action.hex)) {
        throw new CombatRuleError(`spell ${spell.id} needs a target hex`);
      }
      return stacksInArea(combat, action.hex, data);
    }
    case 'friendlyStack': {
      if (tierData.mass) {
        return livingStacks(combat, side);
      }
      const target = requireTargetStack(combat, action);
      if (target.side !== side) {
        throw new CombatRuleError(`spell ${spell.id} targets a friendly stack`);
      }
      if (spell.kind !== 'resurrect' && !isStackAlive(target)) {
        throw new CombatRuleError(`target ${target.id} is dead`);
      }
      return [target];
    }
    case 'enemyStack': {
      const shootersOnly = spell.id === 'forgetfulness';
      if (tierData.mass) {
        const enemies = livingStacks(combat, oppositeSide(side));
        return shootersOnly
          ? enemies.filter((s) => requireCreature(data, s.creature).shots !== undefined)
          : enemies;
      }
      const target = requireTargetStack(combat, action);
      if (target.side === side) {
        throw new CombatRuleError(`spell ${spell.id} targets an enemy stack`);
      }
      if (!isStackAlive(target)) {
        throw new CombatRuleError(`target ${target.id} is dead`);
      }
      if (shootersOnly && requireCreature(data, target.creature).shots === undefined) {
        throw new CombatRuleError('forgetfulness only affects shooters');
      }
      return [target];
    }
    case 'anyStack': {
      if (tierData.mass) {
        return livingStacks(combat);
      }
      const target = requireTargetStack(combat, action);
      if (!isStackAlive(target)) {
        throw new CombatRuleError(`target ${target.id} is dead`);
      }
      return [target];
    }
    case 'adventure':
      throw new CombatRuleError(`${spell.id} cannot be cast in combat`);
  }
}

function applyDamageSpell(
  target: CombatStack,
  spell: Spell,
  damage: number,
  data: GameData,
  events: CombatEvent[],
): void {
  const creature = requireCreature(data, target.creature);
  // death ripple harms only the living
  if (spell.id === 'death_ripple' && creature.flags.includes('undead')) return;
  const outcome = damageStack(target, creature, damage);
  events.push({ type: 'spellDamage', stack: target.id, spell: spell.id, damage, kills: outcome.kills });
  if (outcome.blindBroken) {
    events.push({ type: 'effectExpired', stack: target.id, kind: 'blind' });
  }
  if (outcome.died) {
    events.push({ type: 'stackDied', stack: target.id });
  }
}

function applyChainLightning(
  combat: CombatState,
  side: CombatSideId,
  spell: Spell,
  tierData: SpellTier,
  action: CastAction,
  spellPower: number,
  data: GameData,
  events: CombatEvent[],
): void {
  const first = requireTargetStack(combat, action);
  if (!isStackAlive(first)) {
    throw new CombatRuleError(`target ${first.id} is dead`);
  }
  let damage = magnitude(tierData, spellPower);
  const jumps = tierData.jumps ?? 0;
  const hit = new Set<string>();
  let current: CombatStack | null = first;
  for (let i = 0; i <= jumps && current; i++) {
    hit.add(current.id);
    if (!resistOrImmune(combat, side, current, spell, data, events)) {
      applyDamageSpell(current, spell, damage, data, events);
    }
    damage = Math.floor(damage / 2);
    const last = current;
    current = null;
    let bestDistance = Infinity;
    for (const candidate of livingStacks(combat)) {
      if (hit.has(candidate.id)) continue;
      const distance = hexDistance(last.pos, candidate.pos);
      if (
        distance < bestDistance ||
        (distance === bestDistance && current !== null && candidate.id < current.id)
      ) {
        current = candidate;
        bestDistance = distance;
      }
    }
  }
}

// returns true when the spell does not affect this stack; rolls resistance for
// hostile spells and emits the matching event
function resistOrImmune(
  combat: CombatState,
  side: CombatSideId,
  target: CombatStack,
  spell: Spell,
  data: GameData,
  events: CombatEvent[],
): boolean {
  if (isSpellImmune(target, spell, data)) {
    events.push({ type: 'spellResisted', stack: target.id, spell: spell.id, reason: 'immune' });
    return true;
  }
  if (isHostile(spell) && target.side !== side) {
    const chance = magicResistChance(combat, target, data);
    if (chance > 0) {
      const [resisted, next] = rollChance(combat.rngState, chance / 100);
      combat.rngState = next;
      if (resisted) {
        events.push({
          type: 'spellResisted',
          stack: target.id,
          spell: spell.id,
          reason: 'resisted',
        });
        return true;
      }
    }
  }
  return false;
}

function applySpellToTarget(
  target: CombatStack,
  spell: Spell,
  tierData: SpellTier,
  spellPower: number,
  data: GameData,
  events: CombatEvent[],
): void {
  const creature = requireCreature(data, target.creature);
  const rounds = Math.max(1, spellPower);
  switch (spell.kind) {
    case 'damage':
      applyDamageSpell(target, spell, magnitude(tierData, spellPower), data, events);
      break;
    case 'buff':
    case 'debuff':
    case 'disable': {
      const kind = SPELL_EFFECT_KINDS[spell.id];
      if (kind === undefined) {
        throw new Error(`spell ${spell.id} has no effect mapping`);
      }
      const value = tierData.base ?? 0;
      addEffect(target, { kind, positive: spell.kind === 'buff', rounds, value });
      events.push({ type: 'effectApplied', stack: target.id, kind, rounds, value });
      break;
    }
    case 'heal': {
      const healed = healTopCreature(target, effectiveHp(target, creature), magnitude(tierData, spellPower));
      const removed = target.effects.filter((e) => !e.positive);
      target.effects = target.effects.filter((e) => e.positive);
      for (const effect of removed) {
        events.push({ type: 'effectExpired', stack: target.id, kind: effect.kind });
      }
      events.push({ type: 'stackHealed', stack: target.id, amount: healed });
      break;
    }
    case 'resurrect': {
      const revived = resurrectStack(
        target,
        effectiveHp(target, creature),
        magnitude(tierData, spellPower),
      );
      events.push({ type: 'stackResurrected', stack: target.id, revived });
      break;
    }
    case 'dispel': {
      const removed = [...target.effects];
      target.effects = [];
      for (const effect of removed) {
        events.push({ type: 'effectExpired', stack: target.id, kind: effect.kind });
      }
      break;
    }
    case 'adventure':
      throw new CombatRuleError(`${spell.id} cannot be cast in combat`);
  }
}

export function castCombatSpell(
  combat: CombatState,
  side: CombatSideId,
  action: CastAction,
  data: GameData,
  events: CombatEvent[],
): void {
  const hero = heroInfoFor(combat, side);
  if (hero.hero === null) {
    throw new CombatRuleError('this side has no hero to cast spells');
  }
  if (!hero.hasSpellbook) {
    throw new CombatRuleError('the hero has no spellbook');
  }
  if (!hero.spells.includes(action.spell)) {
    throw new CombatRuleError(`the hero does not know ${action.spell}`);
  }
  if (combat.castThisRound[side]) {
    throw new CombatRuleError('already cast a spell this round');
  }
  const spell = requireSpell(data, action.spell);
  const cost = spellCost(combat, side, spell, data);
  if (hero.mana < cost) {
    throw new CombatRuleError(
      `${spell.id} costs ${String(cost)} mana, only ${String(hero.mana)} left`,
    );
  }
  const tier = schoolTier(hero, spell);
  const tierData = requireTier(spell, tier);

  if (spell.id === 'chain_lightning') {
    // validate the primary target before paying mana
    requireTargetStack(combat, action);
  }
  const targets =
    spell.id === 'chain_lightning'
      ? []
      : resolveTargets(combat, side, spell, tierData, action, data);

  hero.mana -= cost;
  combat.castThisRound[side] = true;
  events.push({
    type: 'spellCast',
    side,
    spell: spell.id,
    targets: targets.map((t) => t.id),
  });

  if (spell.id === 'chain_lightning') {
    applyChainLightning(combat, side, spell, tierData, action, hero.spellPower, data, events);
    return;
  }
  for (const target of targets) {
    if (resistOrImmune(combat, side, target, spell, data, events)) continue;
    applySpellToTarget(target, spell, tierData, hero.spellPower, data, events);
  }
}

// --- adventure casting ---

export const ADVENTURE_SPELL_MP_COST = 300;
export const DIMENSION_DOOR_RADIUS = 8;
export const DIMENSION_DOOR_DAILY_LIMIT = 2;

const SCHOOL_SKILLS = {
  air: 'air_magic',
  earth: 'earth_magic',
  fire: 'fire_magic',
  water: 'water_magic',
} as const;

export function adventureSchoolTier(hero: Hero, spell: Spell, data: GameData): number {
  if (spell.school === 'all') {
    return Math.max(
      ...Object.values(SCHOOL_SKILLS).map((skill) => skillValue(hero, skill, data)),
    );
  }
  return skillValue(hero, SCHOOL_SKILLS[spell.school], data);
}

export type CastAdventureSpellCommand = Extract<Command, { type: 'castAdventureSpell' }>;

function payAdventureCast(hero: Hero, spell: Spell): void {
  hero.mana -= spell.manaCost;
  hero.movementPoints -= ADVENTURE_SPELL_MP_COST;
}

function leaveVisitedTown(state: GameState, hero: Hero): void {
  for (const town of Object.values(state.towns)) {
    if (town.visitingHero === hero.id) town.visitingHero = null;
  }
}

function castTownPortal(
  state: GameState,
  hero: Hero,
  spell: Spell,
  townId: string | undefined,
  data: GameData,
  events: GameEvent[],
): void {
  const player = getPlayer(state, hero.owner);
  const ownTowns = player.towns
    .map((id) => state.towns[id])
    .filter((town): town is Town => town !== undefined);
  if (ownTowns.length === 0) {
    throw new CommandRejectedError('town portal requires at least one own town');
  }
  let target: Town;
  if (townId !== undefined) {
    if (adventureSchoolTier(hero, spell, data) < 2) {
      throw new CommandRejectedError('choosing the destination town requires advanced earth magic');
    }
    const chosen = ownTowns.find((town) => town.id === townId);
    if (!chosen) {
      throw new CommandRejectedError(`${townId} is not an own town`);
    }
    target = chosen;
  } else {
    target = ownTowns.reduce((best, town) => {
      const d = (t: Town): number =>
        (t.pos[0] - hero.pos[0]) ** 2 + (t.pos[1] - hero.pos[1]) ** 2;
      return d(town) < d(best) ? town : best;
    });
  }
  if (target.visitingHero !== null && target.visitingHero !== hero.id) {
    throw new CommandRejectedError(`a hero already visits ${target.id}`);
  }
  payAdventureCast(hero, spell);
  const from: Pos = [...hero.pos];
  leaveVisitedTown(state, hero);
  hero.pos = [...target.pos];
  target.visitingHero = hero.id;
  revealFor(state, player, hero.pos, sightRadius(hero, data));
  events.push({ type: 'adventureSpellCast', hero: hero.id, spell: spell.id });
  events.push({ type: 'heroTeleported', hero: hero.id, from, to: [...hero.pos] });
  const learned = learnGuildSpells(hero, target, data);
  if (learned.length > 0) {
    events.push({ type: 'spellsLearned', hero: hero.id, spells: learned });
  }
}

function castDimensionDoor(
  state: GameState,
  hero: Hero,
  spell: Spell,
  dest: Pos | undefined,
  data: GameData,
  events: GameEvent[],
): void {
  if (!dest) {
    throw new CommandRejectedError('dimension door needs a destination tile');
  }
  if (hero.dimensionDoorCasts >= DIMENSION_DOOR_DAILY_LIMIT) {
    throw new CommandRejectedError(
      `dimension door can be cast ${String(DIMENSION_DOOR_DAILY_LIMIT)} times per day`,
    );
  }
  const distance = Math.max(Math.abs(dest[0] - hero.pos[0]), Math.abs(dest[1] - hero.pos[1]));
  if (distance > DIMENSION_DOOR_RADIUS) {
    throw new CommandRejectedError(
      `dimension door reaches at most ${String(DIMENSION_DOOR_RADIUS)} tiles`,
    );
  }
  const player = getPlayer(state, hero.owner);
  if (!isExplored(player, state.map.size, dest)) {
    throw new CommandRejectedError('cannot teleport into the shroud');
  }
  const ctx = buildMoveContext(state, data, hero);
  if (!isEnterable(ctx, dest) || ctx.triggers[dest[1] * ctx.size + dest[0]] !== null) {
    throw new CommandRejectedError('the destination tile is not free');
  }
  payAdventureCast(hero, spell);
  hero.dimensionDoorCasts += 1;
  const from: Pos = [...hero.pos];
  leaveVisitedTown(state, hero);
  hero.pos = [...dest];
  revealFor(state, player, hero.pos, sightRadius(hero, data));
  events.push({ type: 'adventureSpellCast', hero: hero.id, spell: spell.id });
  events.push({ type: 'heroTeleported', hero: hero.id, from, to: [...hero.pos] });
}

export function castAdventureSpell(
  state: GameState,
  command: CastAdventureSpellCommand,
  data: GameData,
  events: GameEvent[],
): void {
  const hero = state.heroes[command.hero];
  if (!hero) {
    throw new CommandRejectedError(`unknown hero: ${command.hero}`);
  }
  if (hero.owner !== command.player) {
    throw new CommandRejectedError(`hero ${hero.id} belongs to ${hero.owner}`);
  }
  const spell = data.spells[command.spell];
  if (!spell) {
    throw new CommandRejectedError(`unknown spell: ${command.spell}`);
  }
  if (spell.kind !== 'adventure') {
    throw new CommandRejectedError(`${spell.id} is not an adventure spell`);
  }
  if (!hero.hasSpellbook || !hero.spells.includes(spell.id)) {
    throw new CommandRejectedError(`the hero does not know ${spell.id}`);
  }
  if (hero.mana < spell.manaCost) {
    throw new CommandRejectedError(
      `${spell.id} costs ${String(spell.manaCost)} mana, only ${String(hero.mana)} left`,
    );
  }
  if (hero.movementPoints < ADVENTURE_SPELL_MP_COST) {
    throw new CommandRejectedError(
      `adventure spells require ${String(ADVENTURE_SPELL_MP_COST)} movement points`,
    );
  }
  if (spell.id === 'town_portal') {
    castTownPortal(state, hero, spell, command.town, data, events);
  } else if (spell.id === 'dimension_door') {
    castDimensionDoor(state, hero, spell, command.dest, data, events);
  } else {
    throw new CommandRejectedError(`unsupported adventure spell: ${spell.id}`);
  }
}
