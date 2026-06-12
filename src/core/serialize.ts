import { z } from 'zod';
import { FactionIdSchema, ResourceIdSchema, SkillRankSchema } from '../data/schema';
import { GuardSchema, PlayerColorSchema, PosSchema } from '../maps/schema';
import { EFFECT_KINDS } from './combat/state';
import type { GameState } from './state';

export const SAVE_VERSION = 4;

// --- zod schema mirroring GameState (src/core/state.ts) ---
// SaveFile.state is typed as the schema's inferred output, so serializeGame
// fails to compile when GameState grows a field the schema types wrongly.

const CreatureStackSchema = z.object({ creature: z.string(), count: z.number() });
const ArmySlotsSchema = z.array(CreatureStackSchema.nullable());
const ResourcesSchema = z.record(ResourceIdSchema, z.number());

const HeroSchema = z.object({
  id: z.string(),
  template: z.string(),
  name: z.string(),
  class: z.string(),
  owner: PlayerColorSchema,
  pos: PosSchema,
  attack: z.number(),
  defense: z.number(),
  spellPower: z.number(),
  knowledge: z.number(),
  level: z.number(),
  xp: z.number(),
  skills: z.array(z.object({ skill: z.string(), rank: SkillRankSchema })),
  army: ArmySlotsSchema,
  artifacts: z.array(z.string()),
  backpack: z.array(z.string()),
  hasSpellbook: z.boolean(),
  spells: z.array(z.string()),
  mana: z.number(),
  movementPoints: z.number(),
  tempLuck: z.number(),
  tempMorale: z.number(),
  dimensionDoorCasts: z.number(),
});

const TownSchema = z.object({
  id: z.string(),
  name: z.string(),
  faction: FactionIdSchema,
  owner: PlayerColorSchema.nullable(),
  pos: PosSchema,
  buildings: z.array(z.string()),
  builtToday: z.boolean(),
  garrison: ArmySlotsSchema,
  visitingHero: z.string().nullable(),
  availableCreatures: z.record(z.string(), z.number()),
  guildSpells: z.array(z.string()),
  tavernHeroes: z.array(z.string()),
});

const MapObjectStateSchema = z.object({
  id: z.string(),
  type: z.string(),
  at: PosSchema,
  subtype: z.string().optional(),
  owner: PlayerColorSchema.nullable(),
  guard: GuardSchema.nullable(),
  amount: z.number().optional(),
  creature: z.string().optional(),
  count: z.number().optional(),
  artifact: z.string().optional(),
  message: z.string().optional(),
  pairId: z.string().optional(),
  hero: z.string().optional(),
  removed: z.boolean(),
  visitedBy: z.array(z.string()),
  lastResetDay: z.number(),
});

const MapStateSchema = z.object({
  id: z.string(),
  size: z.number(),
  terrain: z.string(),
  roads: z.string(),
  objects: z.array(MapObjectStateSchema),
});

const SeenObjectSchema = z.object({
  type: z.string(),
  at: PosSchema,
  owner: PlayerColorSchema.nullable(),
  removed: z.boolean(),
  subtype: z.string().optional(),
});

const PlayerSchema = z.object({
  id: PlayerColorSchema,
  color: PlayerColorSchema,
  faction: FactionIdSchema,
  isHuman: z.boolean(),
  resources: ResourcesSchema,
  heroes: z.array(z.string()),
  towns: z.array(z.string()),
  explored: z.array(z.boolean()),
  seenObjects: z.record(z.string(), SeenObjectSchema),
  daysWithoutTown: z.number(),
  defeated: z.boolean(),
});

const PendingChoiceSchema = z.object({
  id: z.string(),
  player: PlayerColorSchema,
  kind: z.string(),
  options: z.array(z.string()),
  hero: z.string().optional(),
  object: z.string().optional(),
  message: z.string().optional(),
  from: PosSchema.optional(),
  remaining: z.number().optional(),
});

const CombatSideSchema = z.enum(['attacker', 'defender']);
const HexSchema = z.object({ x: z.number(), y: z.number() });

const CombatHeroInfoSchema = z.object({
  hero: z.string().nullable(),
  player: z.string().nullable(),
  attack: z.number(),
  defense: z.number(),
  spellPower: z.number(),
  knowledge: z.number(),
  offenseBonus: z.number(),
  archeryBonus: z.number(),
  armorerReduction: z.number(),
  morale: z.number(),
  luck: z.number(),
  mana: z.number(),
  hasSpellbook: z.boolean(),
  spells: z.array(z.string()),
  schoolTiers: z.object({
    air: z.number(),
    earth: z.number(),
    fire: z.number(),
    water: z.number(),
  }),
});

const StackEffectSchema = z.object({
  kind: z.enum(EFFECT_KINDS),
  positive: z.boolean(),
  rounds: z.number(),
  value: z.number(),
  castBy: z.union([CombatSideSchema, z.literal('creature')]).optional(),
});

const CombatStackSchema = z.object({
  id: z.string(),
  side: CombatSideSchema,
  slot: z.number(),
  creature: z.string(),
  count: z.number(),
  initialCount: z.number(),
  firstHp: z.number(),
  pos: HexSchema,
  shots: z.number(),
  retaliationsLeft: z.number(),
  defending: z.boolean(),
  waited: z.boolean(),
  moraleSurged: z.boolean(),
  usedResurrect: z.boolean(),
  effects: z.array(StackEffectSchema),
});

const SiegeStateSchema = z.object({
  level: z.enum(['fort', 'citadel', 'castle']),
  segments: z.array(z.object({ pos: HexSchema, hp: z.number(), isGate: z.boolean() })),
  staticWalls: z.array(HexSchema),
  towers: z.array(z.object({ pos: HexSchema, count: z.number() })),
  moat: z.array(HexSchema),
});

const CombatStateSchema = z.object({
  round: z.number(),
  rngState: z.number(),
  attackerHero: CombatHeroInfoSchema,
  defenderHero: CombatHeroInfoSchema,
  stacks: z.array(CombatStackSchema),
  obstacles: z.array(HexSchema),
  queue: z.array(z.string()),
  waitQueue: z.array(z.string()),
  castThisRound: z.record(CombatSideSchema, z.boolean()),
  siege: SiegeStateSchema.nullable(),
  winner: CombatSideSchema.nullable(),
});

const ActiveCombatSchema = z.object({
  reason: z.enum(['guard', 'siege', 'field']),
  attackerHero: z.string(),
  attackerSlots: z.array(z.number()),
  defenderHero: z.string().nullable(),
  defenderTown: z.string().nullable(),
  defenderSlots: z.array(z.object({ source: z.enum(['garrison', 'hero']), index: z.number() })),
  object: z.string().nullable(),
  combat: CombatStateSchema,
});

const GameStateSchema = z.object({
  seed: z.number(),
  rngState: z.number(),
  day: z.number(),
  players: z.array(PlayerSchema),
  currentPlayer: PlayerColorSchema,
  map: MapStateSchema,
  heroes: z.record(z.string(), HeroSchema),
  towns: z.record(z.string(), TownSchema),
  combat: ActiveCombatSchema.nullable(),
  tavernPool: z.array(z.string()),
  pendingChoices: z.array(PendingChoiceSchema),
  status: z.union([z.literal('running'), z.object({ winner: PlayerColorSchema })]),
});

type SerializedGameState = z.infer<typeof GameStateSchema>;

interface SaveFile {
  version: number;
  // compile-time check: every valid GameState must satisfy the save schema
  state: SerializedGameState;
}

export function serializeGame(state: GameState): string {
  const save: SaveFile = { version: SAVE_VERSION, state };
  return JSON.stringify(save);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertGameState(value: unknown): asserts value is GameState {
  const result = GameStateSchema.safeParse(value);
  if (result.success) return;
  const issue = result.error.issues[0];
  const detail = issue ? ` (${issue.path.map(String).join('.') || '<root>'}: ${issue.message})` : '';
  throw new Error(`save file state is malformed${detail}`);
}

function integrityError(path: string, message: string): Error {
  return new Error(`save file state is inconsistent (${path}: ${message})`);
}

// the zod schema is structural only: a save can be well-formed yet reference
// heroes/towns/players that do not exist, which would crash much later (e.g.
// visitingHeroOf or endTurn). Reject such saves at load time with the path.
function assertReferentialIntegrity(state: GameState): void {
  const playerIds = new Set<string>(state.players.map((p) => p.id));
  if (!playerIds.has(state.currentPlayer)) {
    throw integrityError('currentPlayer', `unknown player ${state.currentPlayer}`);
  }
  for (const [id, hero] of Object.entries(state.heroes)) {
    if (!playerIds.has(hero.owner)) {
      throw integrityError(`heroes.${id}.owner`, `unknown player ${hero.owner}`);
    }
  }
  for (const [id, town] of Object.entries(state.towns)) {
    if (town.owner !== null && !playerIds.has(town.owner)) {
      throw integrityError(`towns.${id}.owner`, `unknown player ${town.owner}`);
    }
    if (town.visitingHero !== null && !(town.visitingHero in state.heroes)) {
      throw integrityError(`towns.${id}.visitingHero`, `unknown hero ${town.visitingHero}`);
    }
  }
  for (const player of state.players) {
    for (const heroId of player.heroes) {
      const hero = state.heroes[heroId];
      if (!hero) {
        throw integrityError(`players.${player.id}.heroes`, `unknown hero ${heroId}`);
      }
      if (hero.owner !== player.id) {
        throw integrityError(
          `players.${player.id}.heroes`,
          `hero ${heroId} is owned by ${hero.owner}`,
        );
      }
    }
    for (const townId of player.towns) {
      const town = state.towns[townId];
      if (!town) {
        throw integrityError(`players.${player.id}.towns`, `unknown town ${townId}`);
      }
      if (town.owner !== player.id) {
        throw integrityError(
          `players.${player.id}.towns`,
          `town ${townId} is owned by ${town.owner ?? 'nobody'}`,
        );
      }
    }
  }
  const objectIds = new Set(state.map.objects.map((o) => o.id));
  if (state.combat !== null) {
    if (!(state.combat.attackerHero in state.heroes)) {
      throw integrityError('combat.attackerHero', `unknown hero ${state.combat.attackerHero}`);
    }
    if (state.combat.defenderHero !== null && !(state.combat.defenderHero in state.heroes)) {
      throw integrityError('combat.defenderHero', `unknown hero ${state.combat.defenderHero}`);
    }
    if (state.combat.defenderTown !== null && !(state.combat.defenderTown in state.towns)) {
      throw integrityError('combat.defenderTown', `unknown town ${state.combat.defenderTown}`);
    }
    if (state.combat.object !== null && !objectIds.has(state.combat.object)) {
      throw integrityError('combat.object', `unknown object ${state.combat.object}`);
    }
  }
  state.pendingChoices.forEach((choice, index) => {
    if (!playerIds.has(choice.player)) {
      throw integrityError(`pendingChoices.${String(index)}.player`, `unknown player ${choice.player}`);
    }
    if (choice.hero !== undefined && !(choice.hero in state.heroes)) {
      throw integrityError(`pendingChoices.${String(index)}.hero`, `unknown hero ${choice.hero}`);
    }
    if (choice.object !== undefined && !objectIds.has(choice.object)) {
      throw integrityError(
        `pendingChoices.${String(index)}.object`,
        `unknown object ${choice.object}`,
      );
    }
  });
}

// migration hook: SAVE_MIGRATIONS[n] upgrades a raw version-n state to n+1;
// deserializeGame chains migrations until the state reaches SAVE_VERSION
export type SaveMigration = (state: unknown) => unknown;

export const SAVE_MIGRATIONS: Record<number, SaveMigration> = {};

export function deserializeGame(
  json: string,
  migrations: Record<number, SaveMigration> = SAVE_MIGRATIONS,
): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('save file is not valid JSON');
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') {
    throw new Error('save file has no version field');
  }
  if (parsed.version > SAVE_VERSION) {
    throw new Error(
      `save version ${String(parsed.version)} is not supported (newer than ${String(SAVE_VERSION)})`,
    );
  }
  let state = parsed.state;
  for (let v = parsed.version; v < SAVE_VERSION; v++) {
    const step = migrations[v];
    if (!step) {
      throw new Error(
        `save version ${String(parsed.version)} is not supported (no migration from ${String(v)} to ${String(v + 1)})`,
      );
    }
    state = step(state);
  }
  // a save without a combat field means "no battle in progress"
  if (isRecord(state) && state.combat === undefined) {
    state.combat = null;
  }
  assertGameState(state);
  assertReferentialIntegrity(state);
  return state;
}
