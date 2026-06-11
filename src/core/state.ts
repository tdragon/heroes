import type { GameData } from '../data';
import {
  RESOURCE_IDS,
  type Artifact,
  type FactionId,
  type ResourceId,
  type SkillRank,
} from '../data/schema';
import type { Guard, PlayerColor, Pos } from '../maps/schema';
import type { RngState } from './rng';

export type PlayerId = PlayerColor;
export type HeroId = string;
export type TownId = string;
export type ObjectId = string;

export type Resources = Record<ResourceId, number>;

export interface CreatureStack {
  creature: string;
  count: number;
}

export type ArmySlots = (CreatureStack | null)[];

export const ARMY_SLOTS = 7;

export interface HeroSkill {
  skill: string;
  rank: SkillRank;
}

export interface Hero {
  id: HeroId;
  template: string;
  name: string;
  class: string;
  owner: PlayerId;
  pos: Pos;
  attack: number;
  defense: number;
  spellPower: number;
  knowledge: number;
  level: number;
  xp: number;
  skills: HeroSkill[];
  army: ArmySlots;
  artifacts: string[];
  backpack: string[];
  hasSpellbook: boolean;
  spells: string[];
  mana: number;
  movementPoints: number;
}

export interface Town {
  id: TownId;
  name: string;
  faction: FactionId;
  owner: PlayerId | null;
  pos: Pos;
  buildings: string[];
  builtToday: boolean;
  garrison: ArmySlots;
  visitingHero: HeroId | null;
  availableCreatures: Record<string, number>;
  guildSpells: string[];
}

export interface MapObjectState {
  id: ObjectId;
  type: string;
  at: Pos;
  subtype?: string;
  owner: PlayerId | null;
  guard: Guard | null;
  amount?: number;
  creature?: string;
  count?: number;
  artifact?: string;
  message?: string;
  pairId?: string;
  hero?: string;
  removed: boolean;
  visitedBy: HeroId[];
  lastResetDay: number;
}

export interface MapState {
  id: string;
  size: number;
  terrain: string;
  roads: string;
  objects: MapObjectState[];
}

export interface Player {
  id: PlayerId;
  color: PlayerColor;
  faction: FactionId;
  isHuman: boolean;
  resources: Resources;
  heroes: HeroId[];
  towns: TownId[];
  explored: boolean[];
  daysWithoutTown: number;
  defeated: boolean;
}

export interface PendingChoice {
  id: string;
  player: PlayerId;
  kind: string;
  options: string[];
  hero?: HeroId;
}

export type CombatState = Record<string, unknown>;

export type GameStatus = 'running' | { winner: PlayerId };

export interface GameState {
  seed: number;
  rngState: RngState;
  day: number;
  players: Player[];
  currentPlayer: PlayerId;
  map: MapState;
  heroes: Record<HeroId, Hero>;
  towns: Record<TownId, Town>;
  combat: CombatState | null;
  pendingChoices: PendingChoice[];
  status: GameStatus;
}

export function weekOf(day: number): number {
  return Math.ceil(day / 7);
}

export function monthOf(day: number): number {
  return Math.ceil(day / 28);
}

export function isWeekStart(day: number): boolean {
  return day % 7 === 1;
}

export function isMonthStart(day: number): boolean {
  return day % 28 === 1;
}

export function emptyResources(): Resources {
  return { gold: 0, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0 };
}

export function addResources(target: Resources, amounts: Partial<Resources>): void {
  for (const id of RESOURCE_IDS) {
    target[id] += amounts[id] ?? 0;
  }
}

export function getPlayer(state: GameState, id: PlayerId): Player {
  const player = state.players.find((p) => p.id === id);
  if (!player) {
    throw new Error(`unknown player: ${id}`);
  }
  return player;
}

const RANK_INDEX: Record<SkillRank, number> = { basic: 0, advanced: 1, expert: 2 };

export function skillValue(hero: Hero, skillId: string, data: GameData): number {
  const entry = hero.skills.find((s) => s.skill === skillId);
  if (!entry) return 0;
  const skill = data.skills[skillId];
  if (!skill) {
    throw new Error(`unknown skill: ${skillId}`);
  }
  return skill.values[RANK_INDEX[entry.rank]] ?? 0;
}

export type ArtifactBonusKey = keyof Artifact['bonuses'];

export function artifactBonus(hero: Hero, key: ArtifactBonusKey, data: GameData): number {
  let total = 0;
  for (const id of hero.artifacts) {
    const artifact = data.artifacts[id];
    if (!artifact) {
      throw new Error(`unknown artifact: ${id}`);
    }
    total += artifact.bonuses[key] ?? 0;
  }
  return total;
}

export function maxMana(hero: Hero, data: GameData): number {
  const intelligence = skillValue(hero, 'intelligence', data);
  const knowledge = hero.knowledge + artifactBonus(hero, 'knowledge', data);
  return Math.floor(knowledge * 10 * (1 + intelligence / 100));
}

export function manaRegenPerDay(hero: Hero, data: GameData): number {
  const mysticism = skillValue(hero, 'mysticism', data);
  return Math.max(1, mysticism) + artifactBonus(hero, 'manaRegen', data);
}

export function sightRadius(hero: Hero, data: GameData): number {
  return 5 + skillValue(hero, 'scouting', data) + artifactBonus(hero, 'sightRadius', data);
}

export function revealCircle(explored: boolean[], size: number, center: Pos, radius: number): void {
  const [cx, cy] = center;
  const r2 = radius * radius;
  const minY = Math.max(0, cy - radius);
  const maxY = Math.min(size - 1, cy + radius);
  const minX = Math.max(0, cx - radius);
  const maxX = Math.min(size - 1, cx + radius);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        explored[y * size + x] = true;
      }
    }
  }
}

export function isExplored(player: Player, size: number, pos: Pos): boolean {
  return player.explored[pos[1] * size + pos[0]] ?? false;
}
