import type { GameData } from '../data';
import type { ArtifactSlot, HeroClass, SkillRank } from '../data/schema';
import type { Pos } from '../maps/schema';
import { CommandRejectedError, type ArmyLocation, type Command, type GameEvent } from './commands';
import { nextFloat, rollRange } from './rng';
import {
  ARMY_SLOTS,
  artifactBonus,
  skillValue,
  type ArmySlots,
  type CreatureStack,
  type GameState,
  type Hero,
  type HeroId,
  type PendingChoice,
  type PlayerId,
  type Town,
} from './state';

export const BASE_MOVEMENT_POINTS = 1500;
export const MAX_SKILLS = 8;

export function maxMovementPoints(hero: Hero, data: GameData): number {
  const speeds = hero.army
    .filter((stack): stack is CreatureStack => stack !== null)
    .map((stack) => {
      const creature = data.creatures[stack.creature];
      if (!creature) {
        throw new Error(`unknown creature: ${stack.creature}`);
      }
      return creature.speed;
    });
  const slowest = speeds.length > 0 ? Math.min(...speeds) : 0;
  const logistics = skillValue(hero, 'logistics', data);
  const base = Math.floor((BASE_MOVEMENT_POINTS + 50 * slowest) * (1 + logistics / 100));
  return base + artifactBonus(hero, 'movement', data);
}

// --- experience and leveling ---

export type PrimaryStat = 'attack' | 'defense' | 'spellPower' | 'knowledge';

export function levelForXp(xp: number, thresholds: readonly number[]): number {
  let level = 1;
  for (const threshold of thresholds) {
    if (xp < threshold) break;
    level += 1;
  }
  return level;
}

export function xpForLevel(level: number, thresholds: readonly number[]): number {
  if (level <= 1) return 0;
  const threshold = thresholds[level - 2];
  if (threshold === undefined) {
    throw new Error(`no xp threshold for level ${String(level)}`);
  }
  return threshold;
}

type StatChances = HeroClass['levelUpChancesEarly'];

function rollPrimaryStat(state: GameState, chances: StatChances): PrimaryStat {
  const entries: [PrimaryStat, number][] = [
    ['attack', chances[0]],
    ['defense', chances[1]],
    ['spellPower', chances[2]],
    ['knowledge', chances[3]],
  ];
  const total = entries.reduce((sum, [, chance]) => sum + chance, 0);
  if (total <= 0) {
    throw new Error('level-up stat chances sum to zero');
  }
  const [roll, next] = rollRange(state.rngState, 0, total - 1);
  state.rngState = next;
  let acc = 0;
  for (const [stat, chance] of entries) {
    acc += chance;
    if (roll < acc) return stat;
  }
  return 'knowledge';
}

function weightedPick(
  state: GameState,
  entries: readonly (readonly [string, number])[],
): string | null {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return null;
  const [value, next] = nextFloat(state.rngState);
  state.rngState = next;
  const target = value * total;
  let acc = 0;
  let last: string | null = null;
  for (const [id, weight] of entries) {
    acc += weight;
    last = id;
    if (target < acc) return id;
  }
  return last;
}

function nextRank(rank: SkillRank): SkillRank {
  if (rank === 'basic') return 'advanced';
  if (rank === 'advanced') return 'expert';
  throw new Error('expert skill cannot be upgraded');
}

export function encodeSkillOption(skill: string, rank: SkillRank): string {
  return `${skill}:${rank}`;
}

export function parseSkillOption(encoded: string): { skill: string; rank: SkillRank } {
  const sep = encoded.indexOf(':');
  const skill = encoded.slice(0, sep);
  const rank = encoded.slice(sep + 1);
  if (sep <= 0 || (rank !== 'basic' && rank !== 'advanced' && rank !== 'expert')) {
    throw new Error(`malformed skill option '${encoded}'`);
  }
  return { skill, rank };
}

function levelUpSkillOptions(state: GameState, hero: Hero, heroClass: HeroClass): string[] {
  const upgradable: [string, number][] = hero.skills
    .filter((entry) => entry.rank !== 'expert')
    .map((entry) => [entry.skill, heroClass.skillWeights[entry.skill] ?? 1]);
  const held = new Set(hero.skills.map((entry) => entry.skill));
  const learnable: [string, number][] =
    hero.skills.length >= MAX_SKILLS
      ? []
      : Object.entries(heroClass.skillWeights).filter(([id]) => !held.has(id));

  const encodeUpgrade = (skill: string): string => {
    const entry = hero.skills.find((s) => s.skill === skill);
    if (!entry) {
      throw new Error(`hero ${hero.id} does not have skill ${skill}`);
    }
    return encodeSkillOption(skill, nextRank(entry.rank));
  };

  const upgrade = weightedPick(state, upgradable);
  const learn = weightedPick(state, learnable);
  if (upgrade !== null && learn !== null) {
    return [encodeUpgrade(upgrade), encodeSkillOption(learn, 'basic')];
  }
  if (learn !== null) {
    const second = weightedPick(
      state,
      learnable.filter(([id]) => id !== learn),
    );
    const first = encodeSkillOption(learn, 'basic');
    return second === null ? [first] : [first, encodeSkillOption(second, 'basic')];
  }
  if (upgrade !== null) {
    const second = weightedPick(
      state,
      upgradable.filter(([id]) => id !== upgrade),
    );
    return second === null
      ? [encodeUpgrade(upgrade)]
      : [encodeUpgrade(upgrade), encodeUpgrade(second)];
  }
  return [];
}

function levelUp(state: GameState, hero: Hero, data: GameData, events: GameEvent[]): void {
  const heroClass = data.heroClasses[hero.class];
  if (!heroClass) {
    throw new Error(`unknown hero class: ${hero.class}`);
  }
  hero.level += 1;
  const chances = hero.level <= 9 ? heroClass.levelUpChancesEarly : heroClass.levelUpChancesLate;
  const stat = rollPrimaryStat(state, chances);
  hero[stat] += 1;
  events.push({ type: 'heroLevelUp', hero: hero.id, level: hero.level, stat });

  // only one level-up choice per hero is pending at a time: offers computed
  // from the current skills would go stale once the earlier choice resolves
  // (duplicate picks, unresolvable 8-skill offers), so further level-ups are
  // queued on the pending choice and rolled lazily in applyLevelUpChoice
  const existing = state.pendingChoices.find(
    (c) => c.kind === 'levelUp' && c.hero === hero.id,
  );
  if (existing) {
    existing.remaining = (existing.remaining ?? 0) + 1;
    return;
  }
  const options = levelUpSkillOptions(state, hero, heroClass);
  if (options.length > 0) {
    state.pendingChoices.push({
      id: `levelup-${hero.id}-${String(hero.level)}`,
      player: hero.owner,
      kind: 'levelUp',
      hero: hero.id,
      options,
    });
  }
}

export function giveExperience(
  state: GameState,
  heroId: HeroId,
  amount: number,
  data: GameData,
  events: GameEvent[],
): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`invalid xp amount: ${String(amount)}`);
  }
  const hero = state.heroes[heroId];
  if (!hero) {
    throw new Error(`unknown hero: ${heroId}`);
  }
  hero.xp += amount;
  events.push({ type: 'heroXpGained', hero: heroId, amount, total: hero.xp });
  const maxLevel = data.xpThresholds.length + 1;
  while (hero.level < maxLevel && hero.xp >= xpForLevel(hero.level + 1, data.xpThresholds)) {
    levelUp(state, hero, data, events);
  }
}

export function applyLevelUpChoice(
  state: GameState,
  choice: PendingChoice,
  option: number,
  data: GameData,
): void {
  const heroId = choice.hero;
  const hero = heroId === undefined ? undefined : state.heroes[heroId];
  if (!hero) {
    throw new Error(`level-up choice ${choice.id} has no valid hero`);
  }
  const encoded = choice.options[option];
  if (encoded === undefined) {
    throw new Error(`choice ${choice.id}: option ${String(option)} out of range`);
  }
  const { skill, rank } = parseSkillOption(encoded);
  const existing = hero.skills.find((entry) => entry.skill === skill);
  if (existing) {
    existing.rank = rank;
  } else {
    if (hero.skills.length >= MAX_SKILLS) {
      throw new Error(`hero ${hero.id} already has ${String(MAX_SKILLS)} skills`);
    }
    hero.skills.push({ skill, rank });
  }
  queueDeferredLevelUpChoice(state, hero, choice, data);
}

// roll the next level-up offer for the levels deferred while this choice was
// pending — computed now, against the hero's up-to-date skills
function queueDeferredLevelUpChoice(
  state: GameState,
  hero: Hero,
  resolved: PendingChoice,
  data: GameData,
): void {
  const remaining = resolved.remaining ?? 0;
  if (remaining <= 0) return;
  const heroClass = data.heroClasses[hero.class];
  if (!heroClass) {
    throw new Error(`unknown hero class: ${hero.class}`);
  }
  const options = levelUpSkillOptions(state, hero, heroClass);
  if (options.length === 0) return;
  state.pendingChoices.push({
    id: `levelup-${hero.id}-${String(hero.level)}-${String(remaining)}`,
    player: hero.owner,
    kind: 'levelUp',
    hero: hero.id,
    options,
    remaining: remaining - 1,
  });
}

// --- army management ---

export interface ArmyRef {
  slots: ArmySlots;
  mustKeepStack: boolean;
}

export function heroArmy(hero: Hero): ArmyRef {
  return { slots: hero.army, mustKeepStack: true };
}

export function garrisonArmy(town: Town): ArmyRef {
  return { slots: town.garrison, mustKeepStack: false };
}

export function countStacks(slots: ArmySlots): number {
  return slots.filter((stack) => stack !== null).length;
}

function validateSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ARMY_SLOTS) {
    throw new Error(`invalid army slot ${String(slot)}`);
  }
}

export function transferStack(
  from: ArmyRef,
  fromSlot: number,
  to: ArmyRef,
  toSlot: number,
  count?: number,
): void {
  validateSlot(fromSlot);
  validateSlot(toSlot);
  const source = from.slots[fromSlot];
  if (!source) {
    throw new Error(`source slot ${String(fromSlot)} is empty`);
  }
  const sameArmy = from.slots === to.slots;
  if (sameArmy && fromSlot === toSlot) {
    throw new Error('cannot transfer a stack onto itself');
  }
  const moved = count ?? source.count;
  if (!Number.isInteger(moved) || moved < 1 || moved > source.count) {
    throw new Error(`invalid transfer count ${String(moved)} (stack has ${String(source.count)})`);
  }
  const target = to.slots[toSlot] ?? null;
  const movesWholeStack = moved === source.count;

  if (target && target.creature !== source.creature) {
    if (!movesWholeStack) {
      throw new Error('cannot split onto a stack of a different creature');
    }
    to.slots[toSlot] = source;
    from.slots[fromSlot] = target;
    return;
  }

  if (movesWholeStack && !sameArmy && from.mustKeepStack && countStacks(from.slots) === 1) {
    throw new Error('cannot leave a hero without an army');
  }

  if (target) {
    target.count += moved;
  } else {
    to.slots[toSlot] = { creature: source.creature, count: moved };
  }
  if (movesWholeStack) {
    from.slots[fromSlot] = null;
  } else {
    source.count -= moved;
  }
}

// --- army / artifact commands (dispatch-level wrappers) ---

export function requireOwnHero(state: GameState, heroId: HeroId, player: PlayerId): Hero {
  const hero = state.heroes[heroId];
  if (!hero) {
    throw new CommandRejectedError(`unknown hero: ${heroId}`);
  }
  if (hero.owner !== player) {
    throw new CommandRejectedError(`hero ${heroId} belongs to ${hero.owner}`);
  }
  return hero;
}

function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

function resolveArmyLocation(state: GameState, loc: ArmyLocation, player: PlayerId): ArmyRef {
  if (loc.kind === 'hero') {
    return heroArmy(requireOwnHero(state, loc.hero, player));
  }
  const town = state.towns[loc.town];
  if (!town) {
    throw new CommandRejectedError(`unknown town: ${loc.town}`);
  }
  if (town.owner !== player) {
    throw new CommandRejectedError(`town ${loc.town} is not owned by ${player}`);
  }
  return garrisonArmy(town);
}

function armiesColocated(state: GameState, a: ArmyLocation, b: ArmyLocation): boolean {
  if (a.kind === 'hero' && b.kind === 'hero') {
    if (a.hero === b.hero) return true;
    const heroA = state.heroes[a.hero];
    const heroB = state.heroes[b.hero];
    return heroA !== undefined && heroB !== undefined && chebyshev(heroA.pos, heroB.pos) <= 1;
  }
  if (a.kind === 'garrison' && b.kind === 'garrison') {
    return a.town === b.town;
  }
  const garrison = a.kind === 'garrison' ? a : b;
  const heroLoc = a.kind === 'hero' ? a : b;
  if (garrison.kind !== 'garrison' || heroLoc.kind !== 'hero') return false;
  return state.towns[garrison.town]?.visitingHero === heroLoc.hero;
}

export function moveArmyStack(
  state: GameState,
  command: Extract<Command, { type: 'moveStack' }>,
  events: GameEvent[],
): void {
  const from = resolveArmyLocation(state, command.from, command.player);
  const to = resolveArmyLocation(state, command.to, command.player);
  if (!armiesColocated(state, command.from, command.to)) {
    throw new CommandRejectedError('the two armies are not at the same place');
  }
  try {
    transferStack(from, command.fromSlot, to, command.toSlot, command.count);
  } catch (err) {
    throw new CommandRejectedError(err instanceof Error ? err.message : String(err));
  }
  events.push({ type: 'stackMoved', player: command.player });
}

export function equipArtifactCommand(
  state: GameState,
  command: Extract<Command, { type: 'equipArtifact' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const hero = requireOwnHero(state, command.hero, command.player);
  try {
    equipArtifact(hero, command.artifact, data);
  } catch (err) {
    throw new CommandRejectedError(err instanceof Error ? err.message : String(err));
  }
  events.push({ type: 'artifactEquipped', hero: hero.id, artifact: command.artifact });
}

export function unequipArtifactCommand(
  state: GameState,
  command: Extract<Command, { type: 'unequipArtifact' }>,
  events: GameEvent[],
): void {
  const hero = requireOwnHero(state, command.hero, command.player);
  try {
    unequipArtifact(hero, command.artifact);
  } catch (err) {
    throw new CommandRejectedError(err instanceof Error ? err.message : String(err));
  }
  events.push({ type: 'artifactUnequipped', hero: hero.id, artifact: command.artifact });
}

export function transferArtifactCommand(
  state: GameState,
  command: Extract<Command, { type: 'transferArtifact' }>,
  events: GameEvent[],
): void {
  if (command.from === command.to) {
    throw new CommandRejectedError('cannot transfer an artifact to the same hero');
  }
  const from = requireOwnHero(state, command.from, command.player);
  const to = requireOwnHero(state, command.to, command.player);
  if (chebyshev(from.pos, to.pos) > 1) {
    throw new CommandRejectedError('the two heroes are not adjacent');
  }
  const backpackIndex = from.backpack.indexOf(command.artifact);
  if (backpackIndex !== -1) {
    from.backpack.splice(backpackIndex, 1);
  } else {
    const equippedIndex = from.artifacts.indexOf(command.artifact);
    if (equippedIndex === -1) {
      throw new CommandRejectedError(`hero ${from.id} does not carry ${command.artifact}`);
    }
    from.artifacts.splice(equippedIndex, 1);
  }
  to.backpack.push(command.artifact);
  events.push({
    type: 'artifactTransferred',
    from: from.id,
    to: to.id,
    artifact: command.artifact,
  });
}

// --- artifacts ---

export const ARTIFACT_SLOT_CAPACITY: Record<ArtifactSlot, number> = {
  head: 1,
  neck: 1,
  torso: 1,
  weapon: 1,
  shield: 1,
  feet: 1,
  ring: 2,
  misc: 4,
};

function requireArtifact(artifactId: string, data: GameData) {
  const artifact = data.artifacts[artifactId];
  if (!artifact) {
    throw new Error(`unknown artifact: ${artifactId}`);
  }
  return artifact;
}

export function giveArtifact(hero: Hero, artifactId: string, data: GameData): void {
  requireArtifact(artifactId, data);
  hero.backpack.push(artifactId);
}

export function equipArtifact(hero: Hero, artifactId: string, data: GameData): void {
  const index = hero.backpack.indexOf(artifactId);
  if (index === -1) {
    throw new Error(`artifact ${artifactId} is not in the backpack`);
  }
  const artifact = requireArtifact(artifactId, data);
  const used = hero.artifacts.filter(
    (id) => requireArtifact(id, data).slot === artifact.slot,
  ).length;
  if (used >= ARTIFACT_SLOT_CAPACITY[artifact.slot]) {
    throw new Error(`slot ${artifact.slot} is full`);
  }
  hero.backpack.splice(index, 1);
  hero.artifacts.push(artifactId);
}

export function unequipArtifact(hero: Hero, artifactId: string): void {
  const index = hero.artifacts.indexOf(artifactId);
  if (index === -1) {
    throw new Error(`artifact ${artifactId} is not equipped`);
  }
  hero.artifacts.splice(index, 1);
  hero.backpack.push(artifactId);
}

export interface EffectiveStats {
  attack: number;
  defense: number;
  spellPower: number;
  knowledge: number;
  morale: number;
  luck: number;
}

export function effectiveStats(hero: Hero, data: GameData): EffectiveStats {
  return {
    attack: hero.attack + artifactBonus(hero, 'attack', data),
    defense: hero.defense + artifactBonus(hero, 'defense', data),
    spellPower: hero.spellPower + artifactBonus(hero, 'spellPower', data),
    knowledge: hero.knowledge + artifactBonus(hero, 'knowledge', data),
    morale: skillValue(hero, 'leadership', data) + artifactBonus(hero, 'morale', data),
    luck: skillValue(hero, 'luck', data) + artifactBonus(hero, 'luck', data),
  };
}
