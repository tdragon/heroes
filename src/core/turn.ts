import type { GameData } from '../data';
import type { GameEvent } from './commands';
import { maxMovementPoints } from './hero';
import { applyDailyObjectResets, applyWeeklyObjectResets } from './objects';
import {
  applyMysticPonds,
  applyStablesBonus,
  builtBuildings,
  growthMultiplier,
  refreshTaverns,
} from './town';
import {
  addResources,
  emptyResources,
  isMonthStart,
  isWeekStart,
  manaRegenPerDay,
  maxMana,
  monthOf,
  weekOf,
  type GameState,
  type PlayerId,
  type Resources,
} from './state';

export function dailyIncome(state: GameState, playerId: PlayerId, data: GameData): Resources {
  const income = emptyResources();
  for (const town of Object.values(state.towns)) {
    if (town.owner !== playerId) continue;
    for (const building of builtBuildings(town, data)) {
      if (building.income) {
        addResources(income, building.income);
      }
    }
  }
  for (const obj of state.map.objects) {
    if (obj.type !== 'mine' || obj.owner !== playerId || obj.removed) continue;
    const subtype = data.objectTypes.mine?.subtypes?.find((s) => s.id === obj.subtype);
    if (subtype?.income) {
      addResources(income, subtype.income);
    }
  }
  return income;
}

function applyWeeklyGrowth(state: GameState, data: GameData, events: GameEvent[]): void {
  for (const town of Object.values(state.towns)) {
    const buildings = builtBuildings(town, data);
    const builtIds = new Set(town.buildings);
    const multiplier = growthMultiplier(town, data);
    let grew = false;
    for (const building of buildings) {
      if (building.kind !== 'dwelling' || building.creature === undefined) continue;
      const upgraded = buildings.some((b) => b.upgradeOf === building.id && builtIds.has(b.id));
      if (upgraded) continue;
      const creature = data.creatures[building.creature];
      if (!creature) {
        throw new Error(`building ${building.id}: unknown creature ${building.creature}`);
      }
      const gain = Math.floor(creature.growth * multiplier);
      town.availableCreatures[creature.id] = (town.availableCreatures[creature.id] ?? 0) + gain;
      grew = true;
    }
    for (const building of buildings) {
      if (building.growthBonus === undefined) continue;
      // credit the upgraded creature when its dwelling has been upgraded
      let creatureId = building.growthBonus.creature;
      const baseDwelling = buildings.find(
        (b) => b.kind === 'dwelling' && b.creature === creatureId && b.upgradeOf === undefined,
      );
      if (baseDwelling) {
        const upgrade = buildings.find((b) => b.upgradeOf === baseDwelling.id);
        if (upgrade?.creature !== undefined) creatureId = upgrade.creature;
      }
      town.availableCreatures[creatureId] =
        (town.availableCreatures[creatureId] ?? 0) + building.growthBonus.amount;
      grew = true;
    }
    if (grew) {
      events.push({ type: 'growth', town: town.id });
    }
  }
}

function regenerateHeroes(state: GameState, data: GameData): void {
  for (const hero of Object.values(state.heroes)) {
    hero.movementPoints = maxMovementPoints(hero, data);
    hero.mana = Math.min(maxMana(hero, data), hero.mana + manaRegenPerDay(hero, data));
  }
}

function advanceDay(state: GameState, data: GameData, events: GameEvent[]): void {
  state.day += 1;
  events.push({ type: 'dayStarted', day: state.day });
  if (isWeekStart(state.day)) {
    events.push({ type: 'weekStarted', week: weekOf(state.day) });
    applyWeeklyGrowth(state, data, events);
    applyWeeklyObjectResets(state, data);
    refreshTaverns(state, data, events);
    applyMysticPonds(state, events);
  }
  applyDailyObjectResets(state, data);
  if (isMonthStart(state.day)) {
    events.push({ type: 'monthStarted', month: monthOf(state.day) });
  }

  for (const player of state.players) {
    if (player.defeated) continue;
    const income = dailyIncome(state, player.id, data);
    addResources(player.resources, income);
    events.push({ type: 'income', player: player.id, amounts: income });
    player.daysWithoutTown = player.towns.length === 0 ? player.daysWithoutTown + 1 : 0;
  }

  regenerateHeroes(state, data);
  applyStablesBonus(state);

  for (const town of Object.values(state.towns)) {
    town.builtToday = false;
  }
}

export function endTurn(state: GameState, data: GameData, events: GameEvent[]): void {
  const order = state.players.filter((p) => !p.defeated);
  if (order.length === 0) {
    throw new Error('no active players left');
  }
  const index = order.findIndex((p) => p.id === state.currentPlayer);
  if (index === -1) {
    throw new Error(`current player ${state.currentPlayer} is not active`);
  }
  const isLast = index === order.length - 1;
  if (isLast) {
    advanceDay(state, data, events);
  }
  const next = isLast ? order[0] : order[index + 1];
  if (!next) {
    throw new Error('failed to determine next player');
  }
  state.currentPlayer = next.id;
  events.push({ type: 'turnStarted', player: next.id });
}
