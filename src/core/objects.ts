import type { GameData } from '../data';
import type { ResourceId } from '../data/schema';
import { objectFootprint } from '../maps/dsl';
import { NO_ROAD_CHAR, type Guard, type Pos } from '../maps/schema';
import { captureTown, startGuardCombat, startSiegeCombat } from './combat/resolve';
import { CommandRejectedError, type GameEvent } from './commands';
import { revealFor, sightRadius } from './fog';
import { giveArtifact, giveExperience } from './hero';
import { learnGuildSpells } from './magic';
import { rollRange } from './rng';
import { instantiateHero, townIdAt } from './setup';
import {
  addResources,
  getPlayer,
  isWeekStart,
  maxMana,
  weekOf,
  type GameState,
  type Hero,
  type MapObjectState,
  type ObjectId,
  type PendingChoice,
  type Town,
} from './state';

export const MAX_HEROES = 8;
export const SCHOOL_OF_WAR_COST = 1000;

const STRENGTH_BANDS: readonly (readonly [number, string])[] = [
  [1000, 'A legion'],
  [500, 'Zounds'],
  [250, 'A swarm'],
  [100, 'A throng'],
  [50, 'A horde'],
  [20, 'Lots'],
  [10, 'A pack'],
  [5, 'Several'],
];

export function guardStrengthText(guard: Guard, data: GameData): string {
  const creature = data.creatures[guard.creature];
  if (!creature) {
    throw new Error(`unknown guard creature: ${guard.creature}`);
  }
  const band = STRENGTH_BANDS.find(([min]) => guard.count >= min)?.[1] ?? 'A few';
  const plural = creature.name.endsWith('s') ? creature.name : `${creature.name}s`;
  return `${band} of ${plural}`;
}

function requireObject(state: GameState, id: ObjectId): MapObjectState {
  const obj = state.map.objects.find((o) => o.id === id);
  if (!obj) {
    throw new Error(`unknown map object: ${id}`);
  }
  return obj;
}

export function liveGuard(obj: MapObjectState): Guard | null {
  if (obj.guard && obj.guard.count > 0) return obj.guard;
  if (obj.type === 'monster' && obj.creature !== undefined && (obj.count ?? 0) > 0) {
    return { creature: obj.creature, count: obj.count ?? 0 };
  }
  return null;
}

function offerGuardFight(
  state: GameState,
  hero: Hero,
  from: Pos,
  obj: MapObjectState,
  guard: Guard,
  data: GameData,
): void {
  state.pendingChoices.push({
    id: `guard-${obj.id}`,
    player: hero.owner,
    kind: 'guardAttack',
    hero: hero.id,
    object: obj.id,
    message: `${guardStrengthText(guard, data)} — would you like to attack?`,
    options: ['attack', 'retreat'],
    from: [...from],
  });
}

function townAtObject(state: GameState, obj: MapObjectState): Town {
  const town = state.towns[townIdAt(obj.at)];
  if (!town) {
    throw new Error(`no town behind object ${obj.id}`);
  }
  return town;
}

function enterTown(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const town = townAtObject(state, obj);
  if (town.owner === hero.owner) {
    town.visitingHero ??= hero.id;
    events.push({ type: 'objectVisited', hero: hero.id, object: obj.id, effect: true });
    const learned = learnGuildSpells(hero, town, data);
    if (learned.length > 0) {
      events.push({ type: 'spellsLearned', hero: hero.id, spells: learned });
    }
    return;
  }
  if (town.garrison.some((stack) => stack !== null) || town.visitingHero !== null) {
    startSiegeCombat(state, hero, obj, town, data, events);
    return;
  }
  captureTown(state, hero, obj, town, data, events);
}

function flagObject(hero: Hero, obj: MapObjectState, events: GameEvent[]): void {
  if (obj.owner === hero.owner) {
    events.push({ type: 'objectVisited', hero: hero.id, object: obj.id, effect: false });
    return;
  }
  obj.owner = hero.owner;
  events.push({ type: 'objectFlagged', object: obj.id, player: hero.owner });
}

function pickUpResource(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  events: GameEvent[],
): void {
  if (obj.subtype === undefined || obj.amount === undefined) {
    throw new Error(`resource object ${obj.id} is missing subtype or amount`);
  }
  const amounts = { [obj.subtype]: obj.amount };
  addResources(getPlayer(state, hero.owner).resources, amounts);
  obj.removed = true;
  events.push({ type: 'resourcesGained', player: hero.owner, amounts, source: obj.id });
  events.push({ type: 'objectRemoved', object: obj.id });
}

function offerChest(state: GameState, hero: Hero, obj: MapObjectState, data: GameData): void {
  const options = data.objectTypes[obj.type]?.chestOptions ?? [];
  if (options.length === 0) {
    throw new Error(`object type ${obj.type} has no chest options`);
  }
  const [tier, next] = rollRange(state.rngState, 0, options.length - 1);
  state.rngState = next;
  const picked = options[tier];
  if (!picked) {
    throw new Error(`chest tier ${String(tier)} out of range`);
  }
  state.pendingChoices.push({
    id: `chest-${obj.id}`,
    player: hero.owner,
    kind: 'chest',
    hero: hero.id,
    object: obj.id,
    message: `Treasure chest: take ${String(picked.gold)} gold or ${String(picked.xp)} experience?`,
    options: [`gold:${String(picked.gold)}`, `xp:${String(picked.xp)}`],
  });
}

function pickUpArtifact(
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  if (obj.artifact === undefined) {
    throw new Error(`artifact object ${obj.id} has no artifact id`);
  }
  giveArtifact(hero, obj.artifact, data);
  obj.removed = true;
  events.push({ type: 'artifactPickedUp', hero: hero.id, artifact: obj.artifact });
  events.push({ type: 'objectRemoved', object: obj.id });
}

function rollAmountReward(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const ranges = data.objectTypes[obj.type]?.amountRanges ?? {};
  const entries = Object.entries(ranges) as [ResourceId, [number, number]][];
  if (entries.length === 0) {
    throw new Error(`object type ${obj.type} has no amount ranges`);
  }
  const [pick, afterPick] = rollRange(state.rngState, 0, entries.length - 1);
  state.rngState = afterPick;
  const entry = entries[pick];
  if (!entry) {
    throw new Error(`amount range pick ${String(pick)} out of range`);
  }
  const [resource, [min, max]] = entry;
  const [amount, afterAmount] = rollRange(state.rngState, min, max);
  state.rngState = afterAmount;
  addResources(getPlayer(state, hero.owner).resources, { [resource]: amount });
  obj.visitedBy.push(hero.id);
  events.push({
    type: 'resourcesGained',
    player: hero.owner,
    amounts: { [resource]: amount },
    source: obj.id,
  });
}

function visitWaterWheel(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const reward = data.objectTypes[obj.type]?.reward;
  const gold = weekOf(state.day) === 1 ? (reward?.firstWeekGold ?? 1000) : (reward?.gold ?? 500);
  addResources(getPlayer(state, hero.owner).resources, { gold });
  obj.visitedBy.push(hero.id);
  events.push({ type: 'resourcesGained', player: hero.owner, amounts: { gold }, source: obj.id });
}

function visitMagicWell(
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  obj.visitedBy.push(hero.id);
  hero.mana = maxMana(hero, data);
  events.push({ type: 'manaRestored', hero: hero.id, mana: hero.mana });
}

function visitBlessing(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const reward = data.objectTypes[obj.type]?.reward;
  let luck = 0;
  if (reward?.luck) {
    const [rolled, next] = rollRange(state.rngState, reward.luck[0], reward.luck[1]);
    state.rngState = next;
    luck = rolled;
  }
  const morale = reward?.morale ?? 0;
  hero.tempLuck = Math.max(hero.tempLuck, luck);
  hero.tempMorale = Math.max(hero.tempMorale, morale);
  events.push({ type: 'blessingGained', hero: hero.id, luck, morale });
}

function visitLearningStone(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const xp = data.objectTypes[obj.type]?.reward?.xp ?? 1000;
  obj.visitedBy.push(hero.id);
  giveExperience(state, hero.id, xp, data, events);
}

function offerSchoolOfWar(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const cost = data.objectTypes[obj.type]?.reward?.goldCost ?? SCHOOL_OF_WAR_COST;
  const player = getPlayer(state, hero.owner);
  if (player.resources.gold < cost) {
    events.push({
      type: 'messageShown',
      object: obj.id,
      message: `School of War: training costs ${String(cost)} gold — you cannot afford it.`,
    });
    return;
  }
  state.pendingChoices.push({
    id: `school-${obj.id}-${hero.id}`,
    player: hero.owner,
    kind: 'schoolOfWar',
    hero: hero.id,
    object: obj.id,
    message: `Pay ${String(cost)} gold to train +1 Attack or +1 Defense?`,
    options: ['attack', 'defense', 'decline'],
  });
}

function visitObservatory(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const radius = data.objectTypes[obj.type]?.reward?.revealRadius ?? 20;
  const player = getPlayer(state, hero.owner);
  revealFor(state, player, obj.at, radius);
  // the reveal is per player, so consumption is tracked per player: the
  // observatory's visitedBy stores player ids (see 'oncePerPlayer' reset)
  obj.visitedBy.push(hero.owner);
  events.push({ type: 'areaRevealed', object: obj.id, player: hero.owner });
}

function heroAt(state: GameState, pos: Pos): Hero | null {
  for (const hero of Object.values(state.heroes)) {
    if (hero.pos[0] === pos[0] && hero.pos[1] === pos[1]) return hero;
  }
  return null;
}

// trigger tiles are enterable whenever their road/terrain is passable —
// mirrors buildMoveContext, where a trigger unblocks its own footprint tile
function triggerTileEnterable(state: GameState, data: GameData, pos: Pos): boolean {
  const { size, terrain, roads } = state.map;
  const [x, y] = pos;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  if ((roads[y * size + x] ?? NO_ROAD_CHAR) !== NO_ROAD_CHAR) return true;
  const char = terrain[y * size + x] ?? '';
  const t = Object.values(data.terrains).find((entry) => entry.char === char);
  return t?.moveCost != null;
}

function visitMonolith(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  const pair = state.map.objects.find(
    (o) => o.type === 'monolith' && o.id !== obj.id && o.pairId === obj.pairId && !o.removed,
  );
  if (!pair) {
    throw new Error(`monolith ${obj.id} has no pair '${obj.pairId ?? ''}'`);
  }
  if (!triggerTileEnterable(state, data, pair.at)) {
    events.push({ type: 'messageShown', object: obj.id, message: 'The portal exit is blocked.' });
    events.push({ type: 'objectVisited', hero: hero.id, object: obj.id, effect: false });
    return;
  }
  if (heroAt(state, pair.at)) {
    events.push({ type: 'objectVisited', hero: hero.id, object: obj.id, effect: false });
    return;
  }
  const from: Pos = [...hero.pos];
  hero.pos = [...pair.at];
  const player = getPlayer(state, hero.owner);
  revealFor(state, player, hero.pos, sightRadius(hero, data));
  events.push({ type: 'heroTeleported', hero: hero.id, from, to: [...pair.at] });
}

function isTilePassable(state: GameState, data: GameData, pos: Pos): boolean {
  const { size, terrain } = state.map;
  const [x, y] = pos;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const char = terrain[y * size + x] ?? '';
  const t = Object.values(data.terrains).find((entry) => entry.char === char);
  if (t?.moveCost == null) return false;
  for (const obj of state.map.objects) {
    if (obj.removed) continue;
    for (const [fx, fy] of objectFootprint(obj.type, obj.at)) {
      if (fx === x && fy === y) return false;
    }
  }
  return heroAt(state, pos) === null;
}

const ADJACENT_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function visitPrison(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  if (obj.hero === undefined) {
    throw new Error(`prison ${obj.id} has no stored hero`);
  }
  // a save from before prison heroes were excluded from tavern offers can
  // have the prisoner already on the map: clear the stale prison gracefully
  if (obj.hero in state.heroes) {
    obj.removed = true;
    events.push({ type: 'messageShown', object: obj.id, message: 'The prison stands empty.' });
    events.push({ type: 'objectRemoved', object: obj.id });
    return;
  }
  const player = getPlayer(state, hero.owner);
  if (player.heroes.length >= MAX_HEROES) {
    events.push({
      type: 'messageShown',
      object: obj.id,
      message: 'The prisoner would join you, but you already command the maximum number of heroes.',
    });
    return;
  }
  const spot = ADJACENT_OFFSETS.map(([dx, dy]): Pos => [obj.at[0] + dx, obj.at[1] + dy]).find(
    (pos) => isTilePassable(state, data, pos),
  );
  if (!spot) {
    events.push({
      type: 'messageShown',
      object: obj.id,
      message: 'There is no room for the freed prisoner to stand.',
    });
    return;
  }
  const freed = instantiateHero(state, obj.hero, hero.owner, spot, data);
  state.heroes[freed.id] = freed;
  player.heroes.push(freed.id);
  revealFor(state, player, freed.pos, sightRadius(freed, data));
  obj.removed = true;
  events.push({ type: 'heroReleased', hero: freed.id, player: hero.owner });
  events.push({ type: 'objectRemoved', object: obj.id });
}

function alreadyConsumed(hero: Hero, obj: MapObjectState, data: GameData): boolean {
  const reset = data.objectTypes[obj.type]?.reset ?? 'none';
  switch (reset) {
    case 'oncePerHero':
    case 'daily':
      return obj.visitedBy.includes(hero.id);
    case 'oncePerPlayer':
      // visitedBy holds player ids for these objects (e.g. observatory)
      return obj.visitedBy.includes(hero.owner);
    case 'weekly':
    case 'once':
      return obj.visitedBy.length > 0;
    case 'none':
      return false;
  }
}

export function applyObjectReward(
  state: GameState,
  hero: Hero,
  obj: MapObjectState,
  data: GameData,
  events: GameEvent[],
): void {
  if (alreadyConsumed(hero, obj, data)) {
    events.push({ type: 'objectVisited', hero: hero.id, object: obj.id, effect: false });
    return;
  }
  switch (obj.type) {
    case 'town':
      enterTown(state, hero, obj, data, events);
      break;
    case 'mine':
    case 'dwelling':
      flagObject(hero, obj, events);
      break;
    case 'resource':
      pickUpResource(state, hero, obj, events);
      break;
    case 'treasure_chest':
      offerChest(state, hero, obj, data);
      break;
    case 'artifact':
      pickUpArtifact(hero, obj, data, events);
      break;
    case 'monster':
      // a monster with no living guard left is just cleared off the map
      obj.removed = true;
      events.push({ type: 'objectRemoved', object: obj.id });
      break;
    case 'windmill':
    case 'mystical_garden':
      rollAmountReward(state, hero, obj, data, events);
      break;
    case 'water_wheel':
      visitWaterWheel(state, hero, obj, data, events);
      break;
    case 'magic_well':
      visitMagicWell(hero, obj, data, events);
      break;
    case 'fountain_of_fortune':
    case 'rally_flag':
      visitBlessing(state, hero, obj, data, events);
      break;
    case 'learning_stone':
      visitLearningStone(state, hero, obj, data, events);
      break;
    case 'school_of_war':
      offerSchoolOfWar(state, hero, obj, data, events);
      break;
    case 'observatory':
      visitObservatory(state, hero, obj, data, events);
      break;
    case 'sign':
      events.push({ type: 'messageShown', object: obj.id, message: obj.message ?? '' });
      break;
    case 'monolith':
      visitMonolith(state, hero, obj, data, events);
      break;
    case 'prison':
      visitPrison(state, hero, obj, data, events);
      break;
    case 'obelisk':
      obj.visitedBy.push(hero.id);
      events.push({ type: 'messageShown', object: obj.id, message: '?' });
      break;
    default:
      throw new Error(`unhandled object type: ${obj.type}`);
  }
}

export function handleObjectTrigger(
  state: GameState,
  hero: Hero,
  from: Pos,
  objectId: ObjectId,
  data: GameData,
  events: GameEvent[],
): void {
  const obj = requireObject(state, objectId);
  if (obj.removed) return;
  const guard = liveGuard(obj);
  if (guard) {
    offerGuardFight(state, hero, from, obj, guard, data);
    return;
  }
  applyObjectReward(state, hero, obj, data, events);
}

function choiceContext(
  state: GameState,
  choice: PendingChoice,
): { hero: Hero; obj: MapObjectState } {
  const hero = choice.hero === undefined ? undefined : state.heroes[choice.hero];
  if (!hero) {
    throw new Error(`choice ${choice.id} has no valid hero`);
  }
  if (choice.object === undefined) {
    throw new Error(`choice ${choice.id} has no object`);
  }
  return { hero, obj: requireObject(state, choice.object) };
}

function resolveChestChoice(
  state: GameState,
  choice: PendingChoice,
  option: number,
  data: GameData,
  events: GameEvent[],
): void {
  const { hero, obj } = choiceContext(state, choice);
  const encoded = choice.options[option];
  if (encoded === undefined) {
    throw new Error(`choice ${choice.id}: option ${String(option)} out of range`);
  }
  const sep = encoded.indexOf(':');
  const kind = encoded.slice(0, sep);
  const amount = Number(encoded.slice(sep + 1));
  if (!Number.isInteger(amount) || (kind !== 'gold' && kind !== 'xp')) {
    throw new Error(`malformed chest option '${encoded}'`);
  }
  if (kind === 'gold') {
    addResources(getPlayer(state, hero.owner).resources, { gold: amount });
    events.push({
      type: 'resourcesGained',
      player: hero.owner,
      amounts: { gold: amount },
      source: obj.id,
    });
  } else {
    giveExperience(state, hero.id, amount, data, events);
  }
  obj.removed = true;
  events.push({ type: 'objectRemoved', object: obj.id });
}

function resolveSchoolOfWarChoice(
  state: GameState,
  choice: PendingChoice,
  option: number,
  data: GameData,
  events: GameEvent[],
): void {
  const { hero, obj } = choiceContext(state, choice);
  const picked = choice.options[option];
  if (picked === 'decline' || picked === undefined) return;
  if (picked !== 'attack' && picked !== 'defense') {
    throw new Error(`malformed school of war option '${picked}'`);
  }
  const cost = data.objectTypes[obj.type]?.reward?.goldCost ?? SCHOOL_OF_WAR_COST;
  const player = getPlayer(state, hero.owner);
  if (player.resources.gold < cost) {
    throw new CommandRejectedError(`not enough gold to train (${String(cost)} needed)`);
  }
  player.resources.gold -= cost;
  hero[picked] += 1;
  obj.visitedBy.push(hero.id);
  events.push({ type: 'statTrained', hero: hero.id, stat: picked });
}

function resolveGuardChoice(
  state: GameState,
  choice: PendingChoice,
  option: number,
  data: GameData,
  events: GameEvent[],
): void {
  const { hero, obj } = choiceContext(state, choice);
  if (choice.options[option] !== 'attack') {
    retreatFromGuard(state, hero, choice, events);
    return;
  }
  const guard = liveGuard(obj);
  if (!guard) {
    throw new Error(`guard choice ${choice.id} has no living guard`);
  }
  startGuardCombat(state, hero, obj, guard, data, events);
}

// HoMM3-style retreat: the hero returns to the tile they came from, so a
// guard can never be bypassed by stepping on and walking off the far side
// (the movement points spent on the step are not refunded)
function retreatFromGuard(
  state: GameState,
  hero: Hero,
  choice: PendingChoice,
  events: GameEvent[],
): void {
  const from = choice.from;
  if (!from || (from[0] === hero.pos[0] && from[1] === hero.pos[1])) return;
  const left: Pos = [...hero.pos];
  hero.pos = [...from];
  for (const town of Object.values(state.towns)) {
    if (town.pos[0] === from[0] && town.pos[1] === from[1] && town.owner === hero.owner) {
      town.visitingHero ??= hero.id;
    }
  }
  events.push({
    type: 'heroMoved',
    hero: hero.id,
    from: left,
    to: [...from],
    mpLeft: hero.movementPoints,
  });
}

export const OBJECT_CHOICE_KINDS = ['chest', 'schoolOfWar', 'guardAttack'] as const;

export function resolveObjectChoice(
  state: GameState,
  choice: PendingChoice,
  option: number,
  data: GameData,
  events: GameEvent[],
): void {
  switch (choice.kind) {
    case 'chest':
      resolveChestChoice(state, choice, option, data, events);
      break;
    case 'schoolOfWar':
      resolveSchoolOfWarChoice(state, choice, option, data, events);
      break;
    case 'guardAttack':
      resolveGuardChoice(state, choice, option, data, events);
      break;
    default:
      throw new Error(`unhandled object choice kind: ${choice.kind}`);
  }
}

export function applyDailyObjectResets(state: GameState, data: GameData): void {
  for (const obj of state.map.objects) {
    if (obj.removed) continue;
    if (data.objectTypes[obj.type]?.reset === 'daily') {
      obj.visitedBy = [];
      obj.lastResetDay = state.day;
    }
  }
}

export const GUARD_GROWTH_FACTOR = 1.1;

export function applyWeeklyObjectResets(state: GameState, data: GameData): void {
  if (!isWeekStart(state.day)) return;
  for (const obj of state.map.objects) {
    if (obj.removed) continue;
    if (data.objectTypes[obj.type]?.reset === 'weekly') {
      obj.visitedBy = [];
      obj.lastResetDay = state.day;
    }
    if (obj.guard && obj.guard.count > 0) {
      obj.guard.count = Math.ceil(obj.guard.count * GUARD_GROWTH_FACTOR);
    }
    if (obj.type === 'monster' && obj.count !== undefined && obj.count > 0) {
      obj.count = Math.ceil(obj.count * GUARD_GROWTH_FACTOR);
    }
    if (obj.type === 'dwelling' && obj.creature !== undefined) {
      const creature = data.creatures[obj.creature];
      if (!creature) {
        throw new Error(`dwelling ${obj.id}: unknown creature ${obj.creature}`);
      }
      obj.count = (obj.count ?? 0) + creature.growth;
    }
  }
}
