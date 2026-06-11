import type { GameData } from '../data';
import type { HeroTemplate } from '../data/schema';
import type { GameMap, MapObject, MapPlayer } from '../maps/schema';
import { rollRange, seedRng } from './rng';
import {
  ARMY_SLOTS,
  emptyResources,
  maxMana,
  maxMovementPoints,
  revealCircle,
  sightRadius,
  type ArmySlots,
  type GameState,
  type Hero,
  type MapObjectState,
  type Player,
  type Resources,
  type Town,
} from './state';

export interface NewGameConfig {
  startingResources?: Partial<Resources>;
}

const DEFAULT_STARTING_RESOURCES: Resources = {
  gold: 20000,
  wood: 20,
  ore: 20,
  mercury: 5,
  sulfur: 5,
  crystal: 5,
  gems: 5,
};

function rollStartArmy(state: GameState, template: HeroTemplate): ArmySlots {
  if (template.startArmy.length > ARMY_SLOTS) {
    throw new Error(`hero ${template.id}: start army exceeds ${String(ARMY_SLOTS)} slots`);
  }
  const army: ArmySlots = Array.from({ length: ARMY_SLOTS }, () => null);
  template.startArmy.forEach((stack, i) => {
    const [count, next] = rollRange(state.rngState, stack.min, stack.max);
    state.rngState = next;
    army[i] = { creature: stack.creature, count };
  });
  return army;
}

function createHero(state: GameState, mapPlayer: MapPlayer, data: GameData): Hero {
  const template = data.heroes[mapPlayer.startHero];
  if (!template) {
    throw new Error(`unknown start hero: ${mapPlayer.startHero}`);
  }
  const heroClass = data.heroClasses[template.class];
  if (!heroClass) {
    throw new Error(`unknown hero class: ${template.class}`);
  }
  const hero: Hero = {
    id: template.id,
    template: template.id,
    name: template.name,
    class: heroClass.id,
    owner: mapPlayer.color,
    pos: [...mapPlayer.startTownAt],
    attack: heroClass.startStats.attack,
    defense: heroClass.startStats.defense,
    spellPower: heroClass.startStats.spellPower,
    knowledge: heroClass.startStats.knowledge,
    level: 1,
    xp: 0,
    skills: template.startSkills.map((s) => ({ skill: s.skill, rank: s.rank })),
    army: rollStartArmy(state, template),
    artifacts: [],
    hasSpellbook: heroClass.hasSpellbook,
    spells: template.startSpell !== undefined ? [template.startSpell] : [],
    mana: 0,
    movementPoints: 0,
  };
  hero.mana = maxMana(hero, data);
  hero.movementPoints = maxMovementPoints(hero, data);
  return hero;
}

export function townIdAt(pos: readonly [number, number]): string {
  return `town-${String(pos[0])}-${String(pos[1])}`;
}

function createTown(obj: MapObject, map: GameMap): Town {
  const owner = map.players.find((p) => p.color === obj.owner);
  const faction = owner?.faction ?? 'castle';
  return {
    id: townIdAt(obj.at),
    name: `${faction[0]?.toUpperCase() ?? ''}${faction.slice(1)} Town`,
    faction,
    owner: obj.owner ?? null,
    pos: [...obj.at],
    buildings: ['village_hall'],
    builtToday: false,
    garrison: Array.from({ length: ARMY_SLOTS }, () => null),
    visitingHero: null,
    availableCreatures: {},
    guildSpells: [],
  };
}

function createObjectState(
  state: GameState,
  obj: MapObject,
  index: number,
  data: GameData,
): MapObjectState {
  const objectState: MapObjectState = {
    id: `obj-${String(index)}`,
    type: obj.type,
    at: [...obj.at],
    owner: obj.owner ?? null,
    guard: obj.guard ? { ...obj.guard } : null,
    removed: false,
    visitedBy: [],
    lastResetDay: 0,
  };
  if (obj.subtype !== undefined) objectState.subtype = obj.subtype;
  if (obj.creature !== undefined) objectState.creature = obj.creature;
  if (obj.count !== undefined) objectState.count = obj.count;
  if (obj.artifact !== undefined) objectState.artifact = obj.artifact;
  if (obj.message !== undefined) objectState.message = obj.message;
  if (obj.pairId !== undefined) objectState.pairId = obj.pairId;
  if (obj.hero !== undefined) objectState.hero = obj.hero;

  if (obj.amount !== undefined) {
    objectState.amount = obj.amount;
  } else if (obj.type === 'resource' && obj.subtype !== undefined) {
    const range = data.objectTypes.resource?.amountRanges?.[obj.subtype as keyof Resources];
    if (range) {
      const [amount, next] = rollRange(state.rngState, range[0], range[1]);
      state.rngState = next;
      objectState.amount = amount;
    }
  }
  return objectState;
}

export function newGame(
  map: GameMap,
  config: NewGameConfig,
  seed: number,
  data: GameData,
): GameState {
  const startingResources: Resources = {
    ...DEFAULT_STARTING_RESOURCES,
    ...config.startingResources,
  };

  const state: GameState = {
    seed,
    rngState: seedRng(seed),
    day: 1,
    players: [],
    currentPlayer: map.players[0]?.color ?? 'red',
    map: {
      id: map.id,
      size: map.size,
      terrain: map.terrain,
      roads: map.roads,
      objects: [],
    },
    heroes: {},
    towns: {},
    combat: null,
    pendingChoices: [],
    status: 'running',
  };

  map.objects.forEach((obj, i) => {
    if (obj.type === 'town') {
      const town = createTown(obj, map);
      state.towns[town.id] = town;
    }
    state.map.objects.push(createObjectState(state, obj, i, data));
  });

  for (const mapPlayer of map.players) {
    const hero = createHero(state, mapPlayer, data);
    state.heroes[hero.id] = hero;

    const townId = townIdAt(mapPlayer.startTownAt);
    const town = state.towns[townId];
    if (!town) {
      throw new Error(`player ${mapPlayer.color}: no town at ${townId}`);
    }
    town.visitingHero = hero.id;

    const player: Player = {
      id: mapPlayer.color,
      color: mapPlayer.color,
      faction: mapPlayer.faction,
      isHuman: mapPlayer.isHuman,
      resources: { ...emptyResources(), ...startingResources },
      heroes: [hero.id],
      towns: [townId],
      explored: Array.from({ length: map.size * map.size }, () => false),
      daysWithoutTown: 0,
      defeated: false,
    };
    revealCircle(player.explored, map.size, hero.pos, sightRadius(hero, data));
    revealCircle(player.explored, map.size, town.pos, 5);
    state.players.push(player);
  }

  return state;
}
