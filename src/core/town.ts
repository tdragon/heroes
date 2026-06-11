// Town economy: building construction, creature recruitment and upgrades,
// mage guild spell rolls, marketplace trading, tavern hero hiring, and the
// faction special-building effects (spec §5).

import type { GameData } from '../data';
import type { Building, Cost, FactionId, ResourceId } from '../data/schema';
import { RESOURCE_IDS } from '../data/schema';
import { CommandRejectedError, type Command, type GameEvent } from './commands';
import { learnGuildSpells } from './magic';
import { MAX_HEROES } from './objects';
import { rollRange } from './rng';
import { instantiateHero } from './setup';
import {
  addResources,
  ARMY_SLOTS,
  getPlayer,
  revealCircle,
  sightRadius,
  type ArmySlots,
  type GameState,
  type Hero,
  type PlayerId,
  type Resources,
  type Town,
  type TownId,
} from './state';

export const HERO_HIRE_COST = 2500;
export const TAVERN_OFFER_COUNT = 2;
export const STABLES_MOVEMENT_BONUS = 400;
export const NECROMANCY_AMPLIFIER_BONUS = 10;
export const SKELETON_CREATURE = 'skeleton';
export const GUILD_SPELL_COUNTS: readonly number[] = [5, 4, 3, 2, 1];
export const TRADE_RATES: readonly number[] = [10, 7, 5, 4, 3, 2];
export const GOLD_PER_RESOURCE = 250;
export const MYSTIC_POND_MIN = 1;
export const MYSTIC_POND_MAX = 4;
const RARE_RESOURCES: readonly ResourceId[] = ['mercury', 'sulfur', 'crystal', 'gems'];

// --- building catalog helpers ---

export function townBuildingCatalog(faction: FactionId, data: GameData): Map<string, Building> {
  const catalog = new Map<string, Building>(Object.entries(data.buildings));
  const factionData = data.factions[faction];
  if (factionData) {
    for (const building of [...factionData.dwellings, ...factionData.specialBuildings]) {
      catalog.set(building.id, building);
    }
  }
  return catalog;
}

export function builtBuildings(town: Town, data: GameData): Building[] {
  const catalog = townBuildingCatalog(town.faction, data);
  return town.buildings.map((id) => {
    const building = catalog.get(id);
    if (!building) {
      throw new Error(`town ${town.id}: unknown building ${id}`);
    }
    return building;
  });
}

export function growthMultiplier(town: Town, data: GameData): number {
  let multiplier = 1;
  for (const building of builtBuildings(town, data)) {
    if (building.growthMultiplier !== undefined && building.growthMultiplier > multiplier) {
      multiplier = building.growthMultiplier;
    }
  }
  return multiplier;
}

export function tavernMoraleBonus(town: Town): number {
  if (town.buildings.includes('brotherhood_of_the_sword')) return 2;
  return town.buildings.includes('tavern') ? 1 : 0;
}

export function defenderLuckBonus(town: Town): number {
  return town.buildings.includes('fountain_of_fortune') ? 2 : 0;
}

// --- cost helpers ---

function canAfford(resources: Resources, cost: Cost): boolean {
  return RESOURCE_IDS.every((id) => resources[id] >= (cost[id] ?? 0));
}

function payCost(resources: Resources, cost: Cost): void {
  for (const id of RESOURCE_IDS) {
    resources[id] -= cost[id] ?? 0;
  }
}

function scaleCost(cost: Cost, count: number): Cost {
  const scaled: Cost = {};
  for (const id of RESOURCE_IDS) {
    const value = cost[id] ?? 0;
    if (value > 0) scaled[id] = value * count;
  }
  return scaled;
}

function requireOwnTown(state: GameState, townId: TownId, player: PlayerId): Town {
  const town = state.towns[townId];
  if (!town) {
    throw new CommandRejectedError(`unknown town: ${townId}`);
  }
  if (town.owner !== player) {
    throw new CommandRejectedError(`town ${townId} is not owned by ${player}`);
  }
  return town;
}

// --- mage guild and tavern rolls ---

export function rollGuildSpells(
  state: GameState,
  town: Town,
  level: number,
  data: GameData,
): string[] {
  const faction = data.factions[town.faction];
  if (!faction) {
    throw new Error(`unknown faction: ${town.faction}`);
  }
  const pool = faction.spellPool.filter((id) => {
    const spell = data.spells[id];
    if (!spell) {
      throw new Error(`faction ${faction.id}: unknown spell ${id}`);
    }
    return spell.level === level && !town.guildSpells.includes(id);
  });
  const want = GUILD_SPELL_COUNTS[level - 1] ?? 0;
  const picked: string[] = [];
  while (picked.length < want && pool.length > 0) {
    const [index, next] = rollRange(state.rngState, 0, pool.length - 1);
    state.rngState = next;
    picked.push(...pool.splice(index, 1));
  }
  town.guildSpells.push(...picked);
  return picked;
}

export function rollTavernOffers(state: GameState, town: Town, data: GameData): void {
  const candidates = Object.keys(data.heroes).filter((id) => !(id in state.heroes));
  const offers: string[] = [];
  while (offers.length < TAVERN_OFFER_COUNT && candidates.length > 0) {
    const [index, next] = rollRange(state.rngState, 0, candidates.length - 1);
    state.rngState = next;
    offers.push(...candidates.splice(index, 1));
  }
  town.tavernHeroes = offers;
}

// --- build command ---

function visitingHeroOf(state: GameState, town: Town): Hero | null {
  if (town.visitingHero === null) return null;
  const hero = state.heroes[town.visitingHero];
  if (!hero) {
    throw new Error(`town ${town.id}: missing visiting hero ${town.visitingHero}`);
  }
  return hero;
}

function applyDwellingBuilt(
  town: Town,
  building: Building,
  catalog: Map<string, Building>,
  data: GameData,
): void {
  if (building.creature === undefined) {
    throw new Error(`dwelling ${building.id} has no creature`);
  }
  if (building.upgradeOf !== undefined) {
    // the upgrade converts the recruit pool to the upgraded creature
    const base = catalog.get(building.upgradeOf);
    const baseCreature = base?.creature;
    if (baseCreature !== undefined) {
      const pool = town.availableCreatures[baseCreature] ?? 0;
      town.availableCreatures[building.creature] =
        (town.availableCreatures[building.creature] ?? 0) + pool;
      town.availableCreatures[baseCreature] = 0;
    }
    return;
  }
  const creature = data.creatures[building.creature];
  if (!creature) {
    throw new Error(`dwelling ${building.id}: unknown creature ${building.creature}`);
  }
  const gain = Math.floor(creature.growth * growthMultiplier(town, data));
  town.availableCreatures[creature.id] = (town.availableCreatures[creature.id] ?? 0) + gain;
}

export function buildStructure(
  state: GameState,
  command: Extract<Command, { type: 'build' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const town = requireOwnTown(state, command.town, command.player);
  if (town.builtToday) {
    throw new CommandRejectedError(`town ${town.id} already built today`);
  }
  const catalog = townBuildingCatalog(town.faction, data);
  const building = catalog.get(command.building);
  if (!building) {
    throw new CommandRejectedError(`unknown building for ${town.faction}: ${command.building}`);
  }
  if (town.buildings.includes(building.id)) {
    throw new CommandRejectedError(`${building.id} is already built in ${town.id}`);
  }
  for (const prereq of building.prereqs) {
    if (!town.buildings.includes(prereq)) {
      throw new CommandRejectedError(`${building.id} requires ${prereq}`);
    }
  }
  const faction = data.factions[town.faction];
  if (!faction) {
    throw new Error(`unknown faction: ${town.faction}`);
  }
  if (building.guildLevel !== undefined && building.guildLevel > faction.maxGuildLevel) {
    throw new CommandRejectedError(
      `${faction.id} mage guild is capped at level ${String(faction.maxGuildLevel)}`,
    );
  }
  const built = builtBuildings(town, data);
  if (building.kind === 'hall') {
    const current = built.find((b) => b.kind === 'hall');
    if (current && (current.income?.gold ?? 0) >= (building.income?.gold ?? 0)) {
      throw new CommandRejectedError(`${town.id} already has ${current.id}`);
    }
  }
  if (building.uniquePerPlayer) {
    const player = getPlayer(state, command.player);
    for (const townId of player.towns) {
      if (state.towns[townId]?.buildings.includes(building.id)) {
        throw new CommandRejectedError(`${building.id} is unique per player`);
      }
    }
  }
  const player = getPlayer(state, command.player);
  if (!canAfford(player.resources, building.cost)) {
    throw new CommandRejectedError(`cannot afford ${building.id}`);
  }
  payCost(player.resources, building.cost);

  if (building.kind === 'hall') {
    // halls upgrade in place: the new hall replaces the previous one
    town.buildings = town.buildings.filter((id) => catalog.get(id)?.kind !== 'hall');
  }
  town.buildings.push(building.id);
  town.builtToday = true;
  events.push({ type: 'buildingBuilt', town: town.id, building: building.id });

  if (building.kind === 'dwelling') {
    applyDwellingBuilt(town, building, catalog, data);
  }
  if (building.guildLevel !== undefined) {
    const spells = rollGuildSpells(state, town, building.guildLevel, data);
    events.push({ type: 'guildSpellsRolled', town: town.id, level: building.guildLevel, spells });
    const visiting = visitingHeroOf(state, town);
    if (visiting) {
      const learned = learnGuildSpells(visiting, town, data);
      if (learned.length > 0) {
        events.push({ type: 'spellsLearned', hero: visiting.id, spells: learned });
      }
    }
  }
  if (building.kind === 'tavern') {
    rollTavernOffers(state, town, data);
    events.push({ type: 'tavernRefreshed', town: town.id, heroes: [...town.tavernHeroes] });
  }
  if (building.id === 'stables') {
    const visiting = visitingHeroOf(state, town);
    if (visiting) visiting.movementPoints += STABLES_MOVEMENT_BONUS;
  }
}

// --- recruiting ---

function armySlotsFor(
  state: GameState,
  town: Town,
  dest: 'garrison' | 'visitingHero',
  player: PlayerId,
): ArmySlots {
  if (dest === 'garrison') return town.garrison;
  const hero = visitingHeroOf(state, town);
  if (!hero) {
    throw new CommandRejectedError(`no visiting hero in ${town.id}`);
  }
  if (hero.owner !== player) {
    throw new CommandRejectedError(`hero ${hero.id} belongs to ${hero.owner}`);
  }
  return hero.army;
}

function canPlace(slots: ArmySlots, creature: string): boolean {
  return slots.some((s) => s?.creature === creature) || slots.includes(null);
}

function placeCreatures(slots: ArmySlots, creature: string, count: number): void {
  const existing = slots.find((s) => s?.creature === creature);
  if (existing) {
    existing.count += count;
    return;
  }
  const free = slots.indexOf(null);
  if (free === -1) {
    throw new Error('no free army slot');
  }
  slots[free] = { creature, count };
}

function payForCreatures(
  state: GameState,
  player: PlayerId,
  creatureId: string,
  count: number,
  data: GameData,
): void {
  const creature = data.creatures[creatureId];
  if (!creature) {
    throw new CommandRejectedError(`unknown creature: ${creatureId}`);
  }
  const cost = scaleCost(creature.cost, count);
  const resources = getPlayer(state, player).resources;
  if (!canAfford(resources, cost)) {
    throw new CommandRejectedError(`cannot afford ${String(count)} ${creatureId}`);
  }
  payCost(resources, cost);
}

function validateCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new CommandRejectedError(`invalid recruit count: ${String(count)}`);
  }
}

export function recruitCreatures(
  state: GameState,
  command: Extract<Command, { type: 'recruit' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const town = requireOwnTown(state, command.town, command.player);
  validateCount(command.count);
  const available = town.availableCreatures[command.creature] ?? 0;
  if (command.count > available) {
    throw new CommandRejectedError(
      `only ${String(available)} ${command.creature} available in ${town.id}`,
    );
  }
  const slots = armySlotsFor(state, town, command.dest, command.player);
  if (!canPlace(slots, command.creature)) {
    throw new CommandRejectedError('no free army slot');
  }
  payForCreatures(state, command.player, command.creature, command.count, data);
  placeCreatures(slots, command.creature, command.count);
  town.availableCreatures[command.creature] = available - command.count;
  events.push({
    type: 'creaturesRecruited',
    creature: command.creature,
    count: command.count,
    town: town.id,
    object: null,
  });
}

export function recruitFromDwelling(
  state: GameState,
  command: Extract<Command, { type: 'recruitDwelling' }>,
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
  const obj = state.map.objects.find((o) => o.id === command.object);
  if (!obj || obj.removed || obj.type !== 'dwelling') {
    throw new CommandRejectedError(`${command.object} is not a dwelling`);
  }
  if (obj.owner !== command.player) {
    throw new CommandRejectedError(`dwelling ${obj.id} is not flagged by ${command.player}`);
  }
  if (hero.pos[0] !== obj.at[0] || hero.pos[1] !== obj.at[1]) {
    throw new CommandRejectedError(`hero ${hero.id} must stand at the dwelling`);
  }
  if (obj.creature === undefined) {
    throw new Error(`dwelling ${obj.id} has no creature`);
  }
  validateCount(command.count);
  const available = obj.count ?? 0;
  if (command.count > available) {
    throw new CommandRejectedError(
      `only ${String(available)} ${obj.creature} available at ${obj.id}`,
    );
  }
  if (!canPlace(hero.army, obj.creature)) {
    throw new CommandRejectedError('no free army slot');
  }
  payForCreatures(state, command.player, obj.creature, command.count, data);
  placeCreatures(hero.army, obj.creature, command.count);
  obj.count = available - command.count;
  events.push({
    type: 'creaturesRecruited',
    creature: obj.creature,
    count: command.count,
    town: null,
    object: obj.id,
  });
}

export function upgradeArmyStack(
  state: GameState,
  command: Extract<Command, { type: 'upgradeStack' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const town = requireOwnTown(state, command.town, command.player);
  if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot >= ARMY_SLOTS) {
    throw new CommandRejectedError(`invalid army slot ${String(command.slot)}`);
  }
  const slots = armySlotsFor(state, town, command.dest, command.player);
  const stack = slots[command.slot];
  if (!stack) {
    throw new CommandRejectedError(`slot ${String(command.slot)} is empty`);
  }
  const base = data.creatures[stack.creature];
  if (!base) {
    throw new Error(`unknown creature: ${stack.creature}`);
  }
  const upgraded = Object.values(data.creatures).find((c) => c.upgradeOf === stack.creature);
  if (!upgraded) {
    throw new CommandRejectedError(`${stack.creature} has no upgrade`);
  }
  const catalog = townBuildingCatalog(town.faction, data);
  const hasUpgradedDwelling = town.buildings.some(
    (id) => catalog.get(id)?.creature === upgraded.id,
  );
  if (!hasUpgradedDwelling) {
    throw new CommandRejectedError(`upgrading to ${upgraded.id} requires its dwelling`);
  }
  const diff: Cost = {};
  for (const id of RESOURCE_IDS) {
    const delta = (upgraded.cost[id] ?? 0) - (base.cost[id] ?? 0);
    if (delta > 0) diff[id] = delta * stack.count;
  }
  const resources = getPlayer(state, command.player).resources;
  if (!canAfford(resources, diff)) {
    throw new CommandRejectedError(`cannot afford upgrading to ${upgraded.id}`);
  }
  payCost(resources, diff);
  events.push({
    type: 'stackUpgraded',
    town: town.id,
    from: stack.creature,
    to: upgraded.id,
    count: stack.count,
  });
  stack.creature = upgraded.id;
}

// --- marketplace ---

export function marketplaceCount(state: GameState, player: PlayerId): number {
  return Object.values(state.towns).filter(
    (town) => town.owner === player && town.buildings.includes('marketplace'),
  ).length;
}

export function tradeRate(marketplaces: number): number {
  if (marketplaces < 1) {
    throw new Error('trade rate requires at least one marketplace');
  }
  return TRADE_RATES[Math.min(marketplaces, TRADE_RATES.length) - 1] ?? 2;
}

// `amount` is units of `give` spent; returns units of `receive` gained
export function tradeReceived(
  give: ResourceId,
  receive: ResourceId,
  amount: number,
  rate: number,
): number {
  if (give === 'gold') return Math.floor(amount / (rate * GOLD_PER_RESOURCE));
  if (receive === 'gold') return amount * Math.floor(GOLD_PER_RESOURCE / rate);
  return Math.floor(amount / rate);
}

export function tradeResources(
  state: GameState,
  command: Extract<Command, { type: 'trade' }>,
  events: GameEvent[],
): void {
  const { give, receive, amount } = command;
  if (give === receive) {
    throw new CommandRejectedError('cannot trade a resource for itself');
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw new CommandRejectedError(`invalid trade amount: ${String(amount)}`);
  }
  const markets = marketplaceCount(state, command.player);
  if (markets < 1) {
    throw new CommandRejectedError(`${command.player} owns no marketplace`);
  }
  const received = tradeReceived(give, receive, amount, tradeRate(markets));
  if (received < 1) {
    throw new CommandRejectedError(`trading ${String(amount)} ${give} yields nothing`);
  }
  const resources = getPlayer(state, command.player).resources;
  if (resources[give] < amount) {
    throw new CommandRejectedError(`not enough ${give} to trade`);
  }
  resources[give] -= amount;
  resources[receive] += received;
  events.push({
    type: 'resourcesTraded',
    player: command.player,
    gave: give,
    gaveAmount: amount,
    received: receive,
    receivedAmount: received,
  });
}

// --- tavern hiring ---

export function hireHero(
  state: GameState,
  command: Extract<Command, { type: 'hireHero' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const town = requireOwnTown(state, command.town, command.player);
  if (!town.buildings.includes('tavern')) {
    throw new CommandRejectedError(`town ${town.id} has no tavern`);
  }
  if (!town.tavernHeroes.includes(command.hero)) {
    throw new CommandRejectedError(`${command.hero} is not offered in ${town.id}`);
  }
  if (town.visitingHero !== null) {
    throw new CommandRejectedError(`a hero already visits ${town.id}`);
  }
  const player = getPlayer(state, command.player);
  if (player.heroes.length >= MAX_HEROES) {
    throw new CommandRejectedError(
      `${command.player} already commands ${String(MAX_HEROES)} heroes`,
    );
  }
  if (player.resources.gold < HERO_HIRE_COST) {
    throw new CommandRejectedError(`hiring a hero costs ${String(HERO_HIRE_COST)} gold`);
  }
  if (command.hero in state.heroes) {
    throw new Error(`tavern hero ${command.hero} is already on the map`);
  }
  player.resources.gold -= HERO_HIRE_COST;
  const hero = instantiateHero(state, command.hero, command.player, town.pos, data);
  state.heroes[hero.id] = hero;
  player.heroes.push(hero.id);
  town.visitingHero = hero.id;
  revealCircle(player.explored, state.map.size, hero.pos, sightRadius(hero, data));
  state.tavernPool = state.tavernPool.filter((id) => id !== command.hero);
  for (const other of Object.values(state.towns)) {
    other.tavernHeroes = other.tavernHeroes.filter((id) => id !== command.hero);
  }
  events.push({ type: 'heroHired', hero: hero.id, town: town.id, player: command.player });
}

// --- skeleton transformer ---

export function transformToSkeletons(
  state: GameState,
  command: Extract<Command, { type: 'transformToSkeletons' }>,
  events: GameEvent[],
): void {
  const town = requireOwnTown(state, command.town, command.player);
  if (!town.buildings.includes('skeleton_transformer')) {
    throw new CommandRejectedError(`town ${town.id} has no skeleton transformer`);
  }
  const hero = visitingHeroOf(state, town);
  if (hero?.owner !== command.player) {
    throw new CommandRejectedError(`no own visiting hero in ${town.id}`);
  }
  if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot >= ARMY_SLOTS) {
    throw new CommandRejectedError(`invalid army slot ${String(command.slot)}`);
  }
  const stack = hero.army[command.slot];
  if (!stack) {
    throw new CommandRejectedError(`slot ${String(command.slot)} is empty`);
  }
  if (stack.creature === SKELETON_CREATURE) {
    throw new CommandRejectedError('the stack already consists of skeletons');
  }
  events.push({
    type: 'stackTransformed',
    hero: hero.id,
    slot: command.slot,
    from: stack.creature,
    count: stack.count,
  });
  hero.army[command.slot] = { creature: SKELETON_CREATURE, count: stack.count };
}

// --- daily / weekly hooks (called from the turn cycle) ---

// simplified from "+400 MP for the week": the bonus applies to the hero
// visiting a stables town at dawn (and once immediately on build)
export function applyStablesBonus(state: GameState): void {
  for (const town of Object.values(state.towns)) {
    if (!town.buildings.includes('stables') || town.visitingHero === null) continue;
    const hero = state.heroes[town.visitingHero];
    if (hero) hero.movementPoints += STABLES_MOVEMENT_BONUS;
  }
}

export function refreshTaverns(state: GameState, data: GameData, events: GameEvent[]): void {
  for (const town of Object.values(state.towns)) {
    if (!town.buildings.includes('tavern')) continue;
    rollTavernOffers(state, town, data);
    events.push({ type: 'tavernRefreshed', town: town.id, heroes: [...town.tavernHeroes] });
  }
}

export function applyMysticPonds(state: GameState, events: GameEvent[]): void {
  for (const town of Object.values(state.towns)) {
    if (town.owner === null || !town.buildings.includes('mystic_pond')) continue;
    const [pick, afterPick] = rollRange(state.rngState, 0, RARE_RESOURCES.length - 1);
    state.rngState = afterPick;
    const resource = RARE_RESOURCES[pick];
    if (!resource) {
      throw new Error('mystic pond resource pick out of range');
    }
    const [amount, afterAmount] = rollRange(state.rngState, MYSTIC_POND_MIN, MYSTIC_POND_MAX);
    state.rngState = afterAmount;
    addResources(getPlayer(state, town.owner).resources, { [resource]: amount });
    events.push({ type: 'mysticPondYield', town: town.id, resource, amount });
  }
}
