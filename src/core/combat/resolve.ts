// Game-level combat lifecycle: building battles from heroes/guards/garrisons,
// routing combat commands, and applying the outcome back to the adventure
// state (XP, artifacts, necromancy, town capture, hero removal, flee).

import type { GameData } from '../../data';
import type { Guard } from '../../maps/schema';
import type { GameEvent } from '../commands';
import { giveExperience } from '../hero';
import { learnGuildSpells } from '../magic';
import {
  getPlayer,
  revealCircle,
  skillValue,
  type ActiveCombat,
  type ArmySlots,
  type DefenderSlotRef,
  type GameState,
  type Hero,
  type MapObjectState,
  type ObjectId,
  type Town,
} from '../state';
import { requireCreature } from './abilities';
import {
  combatAct,
  createCombat,
  heroCombatInfo,
  type CombatAction,
  type CombatArmyStack,
} from './engine';
import { siegeLevelFromBuildings } from './siege';
import {
  CombatRuleError,
  noHero,
  type CombatSideId,
  type CombatStack,
  type CombatState,
} from './state';

export type GameCombatAction = CombatAction | { type: 'flee' };

export type GuardVictoryHandler = (
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  events: GameEvent[],
) => void;

export const ARMY_SLOT_LIMIT = 7;

function armyToCombatStacks(army: ArmySlots): { stacks: CombatArmyStack[]; slots: number[] } {
  const stacks: CombatArmyStack[] = [];
  const slots: number[] = [];
  army.forEach((stack, index) => {
    if (!stack) return;
    stacks.push({ creature: stack.creature, count: stack.count });
    slots.push(index);
  });
  return { stacks, slots };
}

function requireObject(state: GameState, id: ObjectId): MapObjectState {
  const obj = state.map.objects.find((o) => o.id === id);
  if (!obj) {
    throw new Error(`unknown map object: ${id}`);
  }
  return obj;
}

function pushCombatEvents(
  events: GameEvent[],
  combatEvents: ReturnType<typeof combatAct>,
): void {
  for (const event of combatEvents) {
    events.push({ type: 'combat', event });
  }
}

export function captureTown(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  town: Town,
  data: GameData,
  events: GameEvent[],
): void {
  const previousOwner = town.owner;
  if (previousOwner !== null) {
    const prev = getPlayer(state, previousOwner);
    prev.towns = prev.towns.filter((id) => id !== town.id);
  }
  const player = getPlayer(state, hero.owner);
  if (!player.towns.includes(town.id)) {
    player.towns.push(town.id);
  }
  town.owner = hero.owner;
  obj.owner = hero.owner;
  town.visitingHero = hero.id;
  revealCircle(player.explored, state.map.size, town.pos, 5);
  events.push({ type: 'townCaptured', town: town.id, player: hero.owner, previousOwner });
  const learned = learnGuildSpells(hero, town, data);
  if (learned.length > 0) {
    events.push({ type: 'spellsLearned', hero: hero.id, spells: learned });
  }
}

function beginCombat(
  state: GameState,
  active: Omit<ActiveCombat, 'combat'>,
  setupArgs: Parameters<typeof createCombat>[0],
  data: GameData,
  events: GameEvent[],
): void {
  if (state.combat !== null) {
    throw new Error('a combat is already in progress');
  }
  const { combat, events: combatEvents } = createCombat(setupArgs, data);
  state.combat = { ...active, combat };
  events.push({
    type: 'combatStarted',
    attacker: active.attackerHero,
    defender: active.defenderHero,
    object: active.object,
    reason: active.reason,
  });
  pushCombatEvents(events, combatEvents);
}

export function startGuardCombat(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  guard: Guard,
  data: GameData,
  events: GameEvent[],
): void {
  const attacker = armyToCombatStacks(hero.army);
  beginCombat(
    state,
    {
      reason: 'guard',
      attackerHero: hero.id,
      attackerSlots: attacker.slots,
      defenderHero: null,
      defenderTown: null,
      defenderSlots: [],
      object: obj.id,
    },
    {
      attacker: { hero: heroCombatInfo(hero, data), stacks: attacker.stacks },
      defender: { hero: noHero(), stacks: [{ creature: guard.creature, count: guard.count }] },
      rng: state.rngState,
    },
    data,
    events,
  );
}

export function startSiegeCombat(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  town: Town,
  data: GameData,
  events: GameEvent[],
): void {
  const attacker = armyToCombatStacks(hero.army);
  const visiting = town.visitingHero === null ? null : state.heroes[town.visitingHero];

  const defenderStacks: CombatArmyStack[] = [];
  const defenderSlots: DefenderSlotRef[] = [];
  town.garrison.forEach((stack, index) => {
    if (!stack || defenderStacks.length >= ARMY_SLOT_LIMIT) return;
    defenderStacks.push({ creature: stack.creature, count: stack.count });
    defenderSlots.push({ source: 'garrison', index });
  });
  if (visiting) {
    visiting.army.forEach((stack, index) => {
      if (!stack || defenderStacks.length >= ARMY_SLOT_LIMIT) return;
      defenderStacks.push({ creature: stack.creature, count: stack.count });
      defenderSlots.push({ source: 'hero', index });
    });
  }
  if (defenderStacks.length === 0) {
    throw new Error(`siege of ${town.id} without defenders`);
  }

  const siegeLevel = siegeLevelFromBuildings(town.buildings);
  beginCombat(
    state,
    {
      reason: 'siege',
      attackerHero: hero.id,
      attackerSlots: attacker.slots,
      defenderHero: visiting?.id ?? null,
      defenderTown: town.id,
      defenderSlots,
      object: obj.id,
    },
    {
      attacker: { hero: heroCombatInfo(hero, data), stacks: attacker.stacks },
      defender: {
        hero: visiting ? heroCombatInfo(visiting, data) : noHero(),
        stacks: defenderStacks,
      },
      rng: state.rngState,
      ...(siegeLevel ? { siege: siegeLevel } : {}),
    },
    data,
    events,
  );
}

function sideStacks(combat: CombatState, side: CombatSideId): CombatStack[] {
  return combat.stacks.filter((s) => s.side === side);
}

function syncAttackerArmy(hero: Hero, active: ActiveCombat): void {
  for (const stack of sideStacks(active.combat, 'attacker')) {
    const armyIndex = active.attackerSlots[stack.slot];
    if (armyIndex === undefined) {
      throw new Error(`no army slot mapping for combat slot ${String(stack.slot)}`);
    }
    hero.army[armyIndex] = stack.count > 0 ? { creature: stack.creature, count: stack.count } : null;
  }
}

function syncDefenders(state: GameState, active: ActiveCombat): void {
  if (active.reason === 'guard') {
    if (active.object === null) {
      throw new Error('guard combat without an object');
    }
    const obj = requireObject(state, active.object);
    const survivor = sideStacks(active.combat, 'defender')[0];
    const count = survivor?.count ?? 0;
    if (obj.guard) {
      obj.guard = count > 0 ? { ...obj.guard, count } : null;
    }
    if (obj.type === 'monster') {
      obj.count = count;
    }
    return;
  }

  const town = active.defenderTown === null ? null : state.towns[active.defenderTown];
  const visiting = active.defenderHero === null ? null : state.heroes[active.defenderHero];
  for (const stack of sideStacks(active.combat, 'defender')) {
    const ref = active.defenderSlots[stack.slot];
    if (!ref) {
      throw new Error(`no defender slot mapping for combat slot ${String(stack.slot)}`);
    }
    const value = stack.count > 0 ? { creature: stack.creature, count: stack.count } : null;
    if (ref.source === 'garrison') {
      if (!town) throw new Error('garrison defender without a town');
      town.garrison[ref.index] = value;
    } else {
      if (!visiting) throw new Error('hero defender without a hero');
      visiting.army[ref.index] = value;
    }
  }
}

interface SideLosses {
  xp: number;
  hpLost: number;
}

function sideLosses(combat: CombatState, side: CombatSideId, data: GameData): SideLosses {
  let xp = 0;
  let hpLost = 0;
  for (const stack of sideStacks(combat, side)) {
    const killed = Math.max(0, stack.initialCount - stack.count);
    if (killed === 0) continue;
    const creature = requireCreature(data, stack.creature);
    xp += killed * creature.aiValue;
    hpLost += killed * creature.hp;
  }
  return { xp, hpLost };
}

function transferArtifacts(from: Hero, to: Hero, events: GameEvent[]): void {
  const artifacts = [...from.artifacts, ...from.backpack];
  if (artifacts.length === 0) return;
  to.backpack.push(...artifacts);
  from.artifacts = [];
  from.backpack = [];
  events.push({ type: 'artifactsSeized', hero: to.id, artifacts });
}

function removeHero(
  state: GameState,
  hero: Hero,
  outcome: 'defeated' | 'fled',
  events: GameEvent[],
): void {
  const player = getPlayer(state, hero.owner);
  player.heroes = player.heroes.filter((id) => id !== hero.id);
  for (const town of Object.values(state.towns)) {
    if (town.visitingHero === hero.id) {
      town.visitingHero = null;
    }
  }
  state.heroes = Object.fromEntries(
    Object.entries(state.heroes).filter(([id]) => id !== hero.id),
  );
  state.tavernPool.push(hero.template);
  events.push({
    type: outcome === 'fled' ? 'heroFled' : 'heroDefeated',
    hero: hero.id,
    player: hero.owner,
  });
}

export const NECROMANCY_CREATURE = 'skeleton';

function applyNecromancy(
  hero: Hero,
  enemyHpLost: number,
  data: GameData,
  events: GameEvent[],
): void {
  const pct = skillValue(hero, 'necromancy', data);
  if (pct <= 0 || enemyHpLost <= 0) return;
  const skeleton = requireCreature(data, NECROMANCY_CREATURE);
  const count = Math.floor(((pct / 100) * enemyHpLost) / skeleton.hp);
  if (count < 1) return;
  const existing = hero.army.find((s) => s?.creature === NECROMANCY_CREATURE);
  if (existing) {
    existing.count += count;
  } else {
    const free = hero.army.findIndex((s) => s === null);
    if (free === -1) return;
    hero.army[free] = { creature: NECROMANCY_CREATURE, count };
  }
  events.push({ type: 'necromancyRaised', hero: hero.id, count });
}

function finishCombat(
  state: GameState,
  fled: boolean,
  data: GameData,
  events: GameEvent[],
  onGuardVictory: GuardVictoryHandler,
): void {
  const active = state.combat;
  if (!active) {
    throw new Error('no combat to finish');
  }
  const battle = active.combat;
  const attacker = state.heroes[active.attackerHero];
  if (!attacker) {
    throw new Error(`combat attacker ${active.attackerHero} is missing`);
  }
  const defenderHero =
    active.defenderHero === null ? null : (state.heroes[active.defenderHero] ?? null);

  state.rngState = battle.rngState;
  syncAttackerArmy(attacker, active);
  syncDefenders(state, active);

  attacker.mana = battle.attackerHero.mana;
  attacker.tempLuck = 0;
  attacker.tempMorale = 0;
  if (defenderHero) {
    defenderHero.mana = battle.defenderHero.mana;
    defenderHero.tempLuck = 0;
    defenderHero.tempMorale = 0;
  }

  const winner: CombatSideId = fled ? 'defender' : (battle.winner ?? 'defender');
  state.combat = null;

  if (fled) {
    removeHero(state, attacker, 'fled', events);
    events.push({
      type: 'combatResolved',
      outcome: 'fled',
      attacker: attacker.id,
      defender: defenderHero?.id ?? null,
    });
    return;
  }

  if (winner === 'attacker') {
    const losses = sideLosses(battle, 'defender', data);
    if (defenderHero) {
      transferArtifacts(defenderHero, attacker, events);
      removeHero(state, defenderHero, 'defeated', events);
    }
    applyNecromancy(attacker, losses.hpLost, data, events);
    giveExperience(state, attacker.id, losses.xp, data, events);
    if (active.reason === 'siege') {
      const town = active.defenderTown === null ? null : state.towns[active.defenderTown];
      const obj = active.object === null ? null : requireObject(state, active.object);
      if (!town || !obj) {
        throw new Error('siege combat without town or object');
      }
      captureTown(state, attacker, obj, town, data, events);
    } else if (active.object !== null) {
      onGuardVictory(state, attacker, requireObject(state, active.object), events);
    }
  } else {
    const losses = sideLosses(battle, 'attacker', data);
    if (defenderHero) {
      transferArtifacts(attacker, defenderHero, events);
      applyNecromancy(defenderHero, losses.hpLost, data, events);
      giveExperience(state, defenderHero.id, losses.xp, data, events);
    }
    removeHero(state, attacker, 'defeated', events);
  }

  events.push({
    type: 'combatResolved',
    outcome: winner,
    attacker: attacker.id,
    defender: defenderHero?.id ?? null,
  });
}

export function applyCombatAction(
  state: GameState,
  action: GameCombatAction,
  data: GameData,
  events: GameEvent[],
  onGuardVictory: GuardVictoryHandler,
): void {
  const active = state.combat;
  if (!active) {
    throw new CombatRuleError('no combat in progress');
  }
  if (action.type === 'flee') {
    finishCombat(state, true, data, events, onGuardVictory);
    return;
  }
  const combatEvents = combatAct(active.combat, action, data);
  pushCombatEvents(events, combatEvents);
  if (active.combat.winner !== null) {
    finishCombat(state, false, data, events, onGuardVictory);
  }
}
