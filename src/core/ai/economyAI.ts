// Economy AI per spec section 9.3: build priority is the City Hall track,
// then the Castle track, then the highest-tier affordable dwelling, then mage
// guild levels; creatures are recruited en masse to a visiting hero.

import type { GameData } from '../../data';
import { RESOURCE_IDS, type Building, type Cost, type ResourceId } from '../../data/schema';
import type { Command } from '../commands';
import {
  buildRejection,
  canPlace,
  GOLD_PER_RESOURCE,
  HERO_HIRE_COST,
  marketplaceCount,
  townBuildingCatalog,
  tradeRate,
} from '../town';
import { getPlayer, type GameState, type PlayerId, type Town } from '../state';

// gold/infrastructure first (each entry's prereqs appear later in the list,
// so walking it daily climbs the tracks bottom-up), then army growth
const HALL_TRACK: readonly string[] = [
  'capitol',
  'city_hall',
  'town_hall',
  'tavern',
  'marketplace',
  'blacksmith',
  'mage_guild_1',
];
const CASTLE_TRACK: readonly string[] = ['castle', 'citadel', 'fort'];
const GUILD_TRACK: readonly string[] = [
  'mage_guild_2',
  'mage_guild_3',
  'mage_guild_4',
  'mage_guild_5',
];

function dwellingTier(building: Building, data: GameData): number {
  if (building.creature === undefined) return 0;
  return data.creatures[building.creature]?.tier ?? 0;
}

export function buildPriority(town: Town, data: GameData): string[] {
  const dwellings = [...townBuildingCatalog(town.faction, data).values()]
    .filter((b) => b.kind === 'dwelling')
    .sort((a, b) => {
      const tierDiff = dwellingTier(b, data) - dwellingTier(a, data);
      if (tierDiff !== 0) return tierDiff;
      const upgradeDiff = (a.upgradeOf === undefined ? 0 : 1) - (b.upgradeOf === undefined ? 0 : 1);
      if (upgradeDiff !== 0) return upgradeDiff;
      return a.id < b.id ? -1 : 1;
    })
    .map((b) => b.id);
  return [...HALL_TRACK, ...CASTLE_TRACK, ...dwellings, ...GUILD_TRACK];
}

function ownTowns(state: GameState, playerId: PlayerId): Town[] {
  return getPlayer(state, playerId)
    .towns.map((id) => state.towns[id])
    .filter((town): town is Town => town !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function chooseBuildCommand(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
): Command | null {
  for (const town of ownTowns(state, playerId)) {
    if (town.builtToday) continue;
    for (const buildingId of buildPriority(town, data)) {
      if (buildRejection(state, playerId, town, buildingId, data) === null) {
        return { type: 'build', player: playerId, town: town.id, building: buildingId };
      }
    }
  }
  return null;
}

// trade surplus gold for the resource blocking the next priority building
// (maps without mines for every resource would otherwise stall the AI)
export function chooseTradeCommand(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
): Command | null {
  const markets = marketplaceCount(state, playerId);
  if (markets < 1) return null;
  const player = getPlayer(state, playerId);
  const goldPerUnit = tradeRate(markets) * GOLD_PER_RESOURCE;
  for (const town of ownTowns(state, playerId)) {
    if (town.builtToday) continue;
    const catalog = townBuildingCatalog(town.faction, data);
    for (const buildingId of buildPriority(town, data)) {
      const building = catalog.get(buildingId);
      if (!building || town.buildings.includes(buildingId)) continue;
      if (!building.prereqs.every((p) => town.buildings.includes(p))) continue;
      const rejection = buildRejection(state, playerId, town, buildingId, data);
      if (rejection === null) return null; // buildable — no trade needed
      if (!rejection.startsWith('cannot afford')) continue;
      const missing: [ResourceId, number][] = [];
      for (const id of RESOURCE_IDS) {
        if (id === 'gold') continue;
        const short = (building.cost[id] ?? 0) - player.resources[id];
        if (short > 0) missing.push([id, short]);
      }
      // short on gold itself: keep saving instead of trading
      if (missing.length === 0) return null;
      const tradeGold = missing.reduce((sum, [, short]) => sum + short * goldPerUnit, 0);
      if (player.resources.gold < (building.cost.gold ?? 0) + tradeGold) return null;
      const [resource, short] = missing[0] ?? ['wood', 0];
      if (short < 1) return null;
      return {
        type: 'trade',
        player: playerId,
        give: 'gold',
        receive: resource,
        amount: short * goldPerUnit,
      };
    }
  }
  return null;
}

export function maxAffordable(resources: Readonly<Cost>, cost: Cost, pool: number): number {
  let max = pool;
  for (const id of RESOURCE_IDS) {
    const per = cost[id] ?? 0;
    if (per > 0) max = Math.min(max, Math.floor((resources[id] ?? 0) / per));
  }
  return Math.max(0, max);
}

// strongest affordable creature first, one recruit command at a time
export function chooseRecruitCommand(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
): Command | null {
  const resources = getPlayer(state, playerId).resources;
  for (const town of ownTowns(state, playerId)) {
    const hero = town.visitingHero === null ? null : state.heroes[town.visitingHero];
    if (hero?.owner !== playerId) continue;
    const entries = Object.entries(town.availableCreatures)
      .filter(([, pool]) => pool > 0)
      .sort(([aId], [bId]) => {
        const tierDiff = (data.creatures[bId]?.tier ?? 0) - (data.creatures[aId]?.tier ?? 0);
        if (tierDiff !== 0) return tierDiff;
        return aId < bId ? -1 : 1;
      });
    for (const [creatureId, pool] of entries) {
      const creature = data.creatures[creatureId];
      if (!creature || !canPlace(hero.army, creatureId)) continue;
      const count = maxAffordable(resources, creature.cost, pool);
      if (count >= 1) {
        return {
          type: 'recruit',
          player: playerId,
          town: town.id,
          dest: 'visitingHero',
          creature: creatureId,
          count,
        };
      }
    }
  }
  return null;
}

// recruit from an owned external dwelling a hero is standing on (spec §8.3):
// max affordable in one command, so the weekly growth never piles up unused
export function chooseDwellingRecruitCommand(
  state: GameState,
  playerId: PlayerId,
  data: GameData,
): Command | null {
  const player = getPlayer(state, playerId);
  for (const heroId of player.heroes) {
    const hero = state.heroes[heroId];
    if (!hero) continue;
    for (const obj of state.map.objects) {
      if (obj.removed || obj.type !== 'dwelling' || obj.owner !== playerId) continue;
      if (obj.at[0] !== hero.pos[0] || obj.at[1] !== hero.pos[1]) continue;
      if (obj.creature === undefined) continue;
      const creature = data.creatures[obj.creature];
      if (!creature || !canPlace(hero.army, obj.creature)) continue;
      const count = maxAffordable(player.resources, creature.cost, obj.count ?? 0);
      if (count >= 1) {
        return { type: 'recruitDwelling', player: playerId, object: obj.id, hero: hero.id, count };
      }
    }
  }
  return null;
}

// a heroless AI can neither expand nor attack — rehire from any tavern offer
// (without this, two heroless AIs end-turn forever and the game never ends)
export function chooseHireCommand(state: GameState, playerId: PlayerId): Command | null {
  const player = getPlayer(state, playerId);
  if (player.heroes.length > 0) return null;
  if (player.resources.gold < HERO_HIRE_COST) return null;
  for (const town of ownTowns(state, playerId)) {
    if (!town.buildings.includes('tavern') || town.visitingHero !== null) continue;
    const offer = town.tavernHeroes.find((id) => !(id in state.heroes));
    if (offer !== undefined) {
      return { type: 'hireHero', player: playerId, town: town.id, hero: offer };
    }
  }
  return null;
}

// does the town hold any creature the player could recruit right now?
export function hasAffordableRecruits(
  state: GameState,
  town: Town,
  playerId: PlayerId,
  data: GameData,
): boolean {
  const resources = getPlayer(state, playerId).resources;
  return Object.entries(town.availableCreatures).some(([creatureId, pool]) => {
    if (pool < 1) return false;
    const creature = data.creatures[creatureId];
    return creature !== undefined && maxAffordable(resources, creature.cost, pool) >= 1;
  });
}
