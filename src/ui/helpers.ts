// Pure presentation-model helpers for the town/hero/dialog UI.
// No DOM access here — everything is unit-testable.

import type { GameData } from '../data';
import type { Building, Cost, Creature, ResourceId } from '../data/schema';
import { RESOURCE_IDS } from '../data/schema';
import { parseSkillOption, xpForLevel } from '../core/hero';
import { builtBuildings, GOLD_PER_RESOURCE, townBuildingCatalog, tradeRate } from '../core/town';
import type { CreatureStack, GameState, Hero, PendingChoice, Resources, Town } from '../core/state';

export function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}` : text;
}

// place a popup whose preferred top-left corner is (x, y) inside a
// boundsW×boundsH container: flip across the anchor when it overflows
// right/bottom, then clamp inside the bounds (pinned to 0 when larger)
export function clampPopupPosition(
  x: number,
  y: number,
  popupW: number,
  popupH: number,
  boundsW: number,
  boundsH: number,
): [number, number] {
  let px = x;
  let py = y;
  if (px + popupW > boundsW) px = x - popupW;
  if (py + popupH > boundsH) py = y - popupH;
  px = Math.min(Math.max(px, 0), Math.max(0, boundsW - popupW));
  py = Math.min(Math.max(py, 0), Math.max(0, boundsH - popupH));
  return [px, py];
}

export function costText(cost: Cost): string {
  const parts: string[] = [];
  for (const id of RESOURCE_IDS) {
    const amount = cost[id] ?? 0;
    if (amount > 0) parts.push(`${String(amount)} ${id}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'free';
}

// --- build availability ---

export type BuildAvailability =
  | { status: 'built' }
  | { status: 'locked'; reason: string }
  | { status: 'unaffordable'; reason: string }
  | { status: 'available' };

export function buildAvailability(
  state: GameState,
  town: Town,
  building: Building,
  data: GameData,
): BuildAvailability {
  if (town.buildings.includes(building.id)) {
    return { status: 'built' };
  }
  const catalog = townBuildingCatalog(town.faction, data);
  if (building.kind === 'hall') {
    const current = builtBuildings(town, data).find((b) => b.kind === 'hall');
    if (current && (current.income?.gold ?? 0) >= (building.income?.gold ?? 0)) {
      return { status: 'locked', reason: `superseded by ${current.name}` };
    }
  }
  const missing = building.prereqs.filter((id) => !town.buildings.includes(id));
  if (missing.length > 0) {
    const names = missing.map((id) => catalog.get(id)?.name ?? id);
    return { status: 'locked', reason: `requires ${names.join(', ')}` };
  }
  const faction = data.factions[town.faction];
  if (faction && building.guildLevel !== undefined && building.guildLevel > faction.maxGuildLevel) {
    return {
      status: 'locked',
      reason: `${faction.name} guild is capped at level ${String(faction.maxGuildLevel)}`,
    };
  }
  if (building.uniquePerPlayer === true && town.owner !== null) {
    for (const other of Object.values(state.towns)) {
      if (other.owner === town.owner && other.buildings.includes(building.id)) {
        return { status: 'locked', reason: 'already built in another town' };
      }
    }
  }
  if (town.builtToday) {
    return { status: 'locked', reason: 'already built today' };
  }
  const player = state.players.find((p) => p.id === town.owner);
  if (player) {
    const short = RESOURCE_IDS.filter((id) => player.resources[id] < (building.cost[id] ?? 0));
    if (short.length > 0) {
      return { status: 'unaffordable', reason: `not enough ${short.join(', ')}` };
    }
  }
  return { status: 'available' };
}

// --- recruiting ---

export function recruitMax(available: number, cost: Cost, resources: Resources): number {
  let max = available;
  for (const id of RESOURCE_IDS) {
    const per = cost[id] ?? 0;
    if (per > 0) max = Math.min(max, Math.floor(resources[id] / per));
  }
  return Math.max(0, max);
}

export function scaledCost(cost: Cost, count: number): Cost {
  const scaled: Cost = {};
  for (const id of RESOURCE_IDS) {
    const value = cost[id] ?? 0;
    if (value > 0) scaled[id] = value * count;
  }
  return scaled;
}

// --- stack upgrades (spec §5.2) ---

export interface UpgradeOffer {
  to: Creature;
  // total upgrade price: the per-creature cost difference times the count
  cost: Cost;
}

// the upgrade available for `stack` in `town`, or null when the creature has
// no upgrade or the upgraded creature's dwelling is not built here
export function stackUpgradeOffer(
  town: Town,
  stack: CreatureStack,
  data: GameData,
): UpgradeOffer | null {
  const base = data.creatures[stack.creature];
  if (!base) return null;
  const upgraded = Object.values(data.creatures).find((c) => c.upgradeOf === stack.creature);
  if (!upgraded) return null;
  const catalog = townBuildingCatalog(town.faction, data);
  const hasDwelling = town.buildings.some((id) => catalog.get(id)?.creature === upgraded.id);
  if (!hasDwelling) return null;
  const cost: Cost = {};
  for (const id of RESOURCE_IDS) {
    const delta = (upgraded.cost[id] ?? 0) - (base.cost[id] ?? 0);
    if (delta > 0) cost[id] = delta * stack.count;
  }
  return { to: upgraded, cost };
}

// --- marketplace trade render model ---

// one "trade unit" exchanges `giveStep` of give for `receiveStep` of receive
export interface TradeModel {
  rate: number;
  giveStep: number;
  receiveStep: number;
}

export function tradeModel(
  give: ResourceId,
  receive: ResourceId,
  marketplaces: number,
): TradeModel {
  const rate = tradeRate(marketplaces);
  if (give === receive) {
    throw new Error('cannot trade a resource for itself');
  }
  if (give === 'gold') {
    return { rate, giveStep: rate * GOLD_PER_RESOURCE, receiveStep: 1 };
  }
  if (receive === 'gold') {
    return { rate, giveStep: 1, receiveStep: Math.floor(GOLD_PER_RESOURCE / rate) };
  }
  return { rate, giveStep: rate, receiveStep: 1 };
}

export function maxTrades(model: TradeModel, have: number): number {
  return Math.max(0, Math.floor(have / model.giveStep));
}

// --- pending-choice option labels ---

export function choiceOptionLabel(choice: PendingChoice, option: string, data: GameData): string {
  if (choice.kind === 'levelUp') {
    const { skill, rank } = parseSkillOption(option);
    return `${capitalize(rank)} ${data.skills[skill]?.name ?? skill}`;
  }
  if (choice.kind === 'chest') {
    const sep = option.indexOf(':');
    const kind = option.slice(0, sep);
    const amount = option.slice(sep + 1);
    if (kind === 'gold') return `${amount} Gold`;
    if (kind === 'xp') return `${amount} Experience`;
  }
  return capitalize(option);
}

export function choiceTitle(choice: PendingChoice, state: GameState): string {
  if (choice.message !== undefined) return choice.message;
  if (choice.kind === 'levelUp') {
    const hero = choice.hero === undefined ? undefined : state.heroes[choice.hero];
    if (hero) {
      return `${hero.name} reaches level ${String(hero.level)} — choose a skill`;
    }
  }
  return choice.kind;
}

// --- hero screen models ---

export function xpProgressText(hero: Hero, data: GameData): string {
  const maxLevel = data.xpThresholds.length + 1;
  if (hero.level >= maxLevel) return `${String(hero.xp)} XP (max level)`;
  return `${String(hero.xp)} / ${String(xpForLevel(hero.level + 1, data.xpThresholds))} XP`;
}
