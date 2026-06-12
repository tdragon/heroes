import type { GameData } from '../data';
import type { ResourceId } from '../data/schema';
import type { Pos } from '../maps/schema';
import { applyCombatAction, type GameCombatAction } from './combat/resolve';
import type { CombatEvent } from './combat/state';
import {
  applyLevelUpChoice,
  dismissHeroCommand,
  equipArtifactCommand,
  moveArmyStack,
  transferArtifactCommand,
  unequipArtifactCommand,
  type PrimaryStat,
} from './hero';
import { buySpellbookCommand, castAdventureSpell } from './magic';
import { moveHero, visitObject } from './movement';
import { applyObjectReward, OBJECT_CHOICE_KINDS, resolveObjectChoice } from './objects';
import {
  buildStructure,
  hireHero,
  recruitCreatures,
  recruitFromDwelling,
  tradeResources,
  transformToSkeletons,
  upgradeArmyStack,
} from './town';
import { endTurn } from './turn';
import { evaluateVictory } from './victory';
import type {
  CombatReason,
  GameState,
  HeroId,
  ObjectId,
  PlayerId,
  Resources,
  TownId,
} from './state';

export type ArmyDest = 'garrison' | 'visitingHero';

export type ArmyLocation = { kind: 'hero'; hero: HeroId } | { kind: 'garrison'; town: TownId };

export type Command =
  | { type: 'endTurn'; player: PlayerId }
  | { type: 'moveHero'; player: PlayerId; hero: HeroId; path: Pos[] }
  | { type: 'visitObject'; player: PlayerId; hero: HeroId }
  | { type: 'resolveChoice'; player: PlayerId; choiceId: string; option: number }
  | { type: 'combatAction'; player: PlayerId; action: GameCombatAction }
  | { type: 'build'; player: PlayerId; town: TownId; building: string }
  | {
      type: 'recruit';
      player: PlayerId;
      town: TownId;
      dest: ArmyDest;
      creature: string;
      count: number;
    }
  | { type: 'recruitDwelling'; player: PlayerId; object: ObjectId; hero: HeroId; count: number }
  | { type: 'upgradeStack'; player: PlayerId; town: TownId; dest: ArmyDest; slot: number }
  | { type: 'trade'; player: PlayerId; give: ResourceId; receive: ResourceId; amount: number }
  | { type: 'hireHero'; player: PlayerId; town: TownId; hero: string }
  | { type: 'transformToSkeletons'; player: PlayerId; town: TownId; slot: number }
  | {
      type: 'moveStack';
      player: PlayerId;
      from: ArmyLocation;
      fromSlot: number;
      to: ArmyLocation;
      toSlot: number;
      count?: number;
    }
  | { type: 'equipArtifact'; player: PlayerId; hero: HeroId; artifact: string }
  | { type: 'unequipArtifact'; player: PlayerId; hero: HeroId; artifact: string }
  | { type: 'transferArtifact'; player: PlayerId; from: HeroId; to: HeroId; artifact: string }
  | { type: 'buySpellbook'; player: PlayerId; hero: HeroId; town: TownId }
  | { type: 'dismissHero'; player: PlayerId; hero: HeroId }
  | {
      type: 'castAdventureSpell';
      player: PlayerId;
      hero: HeroId;
      spell: string;
      town?: TownId;
      dest?: Pos;
    };

export type GameEvent =
  | { type: 'turnStarted'; player: PlayerId }
  | { type: 'dayStarted'; day: number }
  | { type: 'weekStarted'; week: number }
  | { type: 'monthStarted'; month: number }
  | { type: 'income'; player: PlayerId; amounts: Partial<Resources> }
  | { type: 'growth'; town: TownId }
  | { type: 'heroMoved'; hero: HeroId; from: Pos; to: Pos; mpLeft: number }
  | { type: 'objectTriggered'; hero: HeroId; object: ObjectId }
  | { type: 'heroXpGained'; hero: HeroId; amount: number; total: number }
  | { type: 'heroLevelUp'; hero: HeroId; level: number; stat: PrimaryStat }
  | { type: 'choiceResolved'; choiceId: string; option: number }
  | { type: 'objectVisited'; hero: HeroId; object: ObjectId; effect: boolean }
  | { type: 'resourcesGained'; player: PlayerId; amounts: Partial<Resources>; source: ObjectId }
  | { type: 'objectFlagged'; object: ObjectId; player: PlayerId }
  | { type: 'objectRemoved'; object: ObjectId }
  | { type: 'artifactPickedUp'; hero: HeroId; artifact: string }
  | { type: 'messageShown'; object: ObjectId; message: string }
  | { type: 'heroTeleported'; hero: HeroId; from: Pos; to: Pos }
  | { type: 'manaRestored'; hero: HeroId; mana: number }
  | { type: 'blessingGained'; hero: HeroId; luck: number; morale: number }
  | { type: 'statTrained'; hero: HeroId; stat: 'attack' | 'defense' }
  | { type: 'areaRevealed'; object: ObjectId; player: PlayerId }
  | { type: 'heroReleased'; hero: HeroId; player: PlayerId }
  | { type: 'townCaptured'; town: TownId; player: PlayerId; previousOwner: PlayerId | null }
  | { type: 'capitolDowngraded'; town: TownId }
  | {
      type: 'combatStarted';
      attacker: HeroId;
      defender: HeroId | null;
      object: ObjectId | null;
      reason: CombatReason;
    }
  | { type: 'combat'; event: CombatEvent }
  | {
      type: 'combatResolved';
      outcome: 'attacker' | 'defender' | 'fled';
      attacker: HeroId;
      defender: HeroId | null;
    }
  | { type: 'heroDefeated'; hero: HeroId; player: PlayerId }
  | { type: 'heroFled'; hero: HeroId; player: PlayerId }
  | { type: 'heroDismissed'; hero: HeroId; player: PlayerId }
  | { type: 'necromancyRaised'; hero: HeroId; count: number }
  | { type: 'artifactsSeized'; hero: HeroId; artifacts: string[] }
  | { type: 'spellsLearned'; hero: HeroId; spells: string[] }
  | { type: 'spellbookBought'; hero: HeroId; town: TownId }
  | { type: 'buildingBuilt'; town: TownId; building: string }
  | { type: 'guildSpellsRolled'; town: TownId; level: number; spells: string[] }
  | {
      type: 'creaturesRecruited';
      creature: string;
      count: number;
      town: TownId | null;
      object: ObjectId | null;
    }
  | { type: 'stackUpgraded'; town: TownId; from: string; to: string; count: number }
  | {
      type: 'resourcesTraded';
      player: PlayerId;
      gave: ResourceId;
      gaveAmount: number;
      received: ResourceId;
      receivedAmount: number;
    }
  | { type: 'heroHired'; hero: HeroId; town: TownId; player: PlayerId }
  | { type: 'tavernRefreshed'; town: TownId; heroes: string[] }
  | { type: 'stackTransformed'; hero: HeroId; slot: number; from: string; count: number }
  | { type: 'mysticPondYield'; town: TownId; resource: ResourceId; amount: number }
  | { type: 'adventureSpellCast'; hero: HeroId; spell: string }
  | { type: 'stackMoved'; player: PlayerId }
  | { type: 'artifactEquipped'; hero: HeroId; artifact: string }
  | { type: 'artifactUnequipped'; hero: HeroId; artifact: string }
  | { type: 'artifactTransferred'; from: HeroId; to: HeroId; artifact: string }
  | { type: 'playerDefeated'; player: PlayerId }
  | { type: 'gameOver'; winner: PlayerId };

export interface DispatchResult {
  state: GameState;
  events: GameEvent[];
}

export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

function resolveChoice(
  state: GameState,
  command: Extract<Command, { type: 'resolveChoice' }>,
  data: GameData,
  events: GameEvent[],
): void {
  const choice = state.pendingChoices.find((c) => c.id === command.choiceId);
  if (!choice) {
    throw new CommandRejectedError(`unknown choice: ${command.choiceId}`);
  }
  if (choice.player !== command.player) {
    throw new CommandRejectedError(`choice ${choice.id} belongs to ${choice.player}`);
  }
  if (
    !Number.isInteger(command.option) ||
    command.option < 0 ||
    command.option >= choice.options.length
  ) {
    throw new CommandRejectedError(
      `choice ${choice.id}: option ${String(command.option)} out of range`,
    );
  }
  state.pendingChoices = state.pendingChoices.filter((c) => c.id !== choice.id);
  if (choice.kind === 'levelUp') {
    applyLevelUpChoice(state, choice, command.option, data);
  } else if ((OBJECT_CHOICE_KINDS as readonly string[]).includes(choice.kind)) {
    resolveObjectChoice(state, choice, command.option, data, events);
  }
  events.push({ type: 'choiceResolved', choiceId: choice.id, option: command.option });
}

export function dispatch(state: GameState, command: Command, data: GameData): DispatchResult {
  if (state.status !== 'running') {
    throw new CommandRejectedError('game is over');
  }
  // a pending choice may be resolved by its owner even off-turn (e.g. the
  // defender of an AI attack picking a level-up skill during the AI's turn)
  const resolvesOwnChoice =
    command.type === 'resolveChoice' &&
    state.pendingChoices.some((c) => c.id === command.choiceId && c.player === command.player);
  // a player whose hero fights in the active combat may act in it even
  // off-turn (e.g. the human defender of an AI attack, hotseat battles)
  const actsInOwnCombat =
    command.type === 'combatAction' &&
    state.combat !== null &&
    (state.combat.combat.attackerHero.player === command.player ||
      state.combat.combat.defenderHero.player === command.player);
  if (command.player !== state.currentPlayer && !resolvesOwnChoice && !actsInOwnCombat) {
    throw new CommandRejectedError(
      `command from ${command.player}, but current player is ${state.currentPlayer}`,
    );
  }
  if (state.combat !== null && command.type !== 'combatAction') {
    throw new CommandRejectedError('a combat must be resolved first');
  }
  if (state.combat === null && command.type === 'combatAction') {
    throw new CommandRejectedError('no combat in progress');
  }
  if (state.pendingChoices.length > 0 && command.type !== 'resolveChoice') {
    throw new CommandRejectedError('a pending choice must be resolved first');
  }

  const next = structuredClone(state);
  const events: GameEvent[] = [];
  switch (command.type) {
    case 'endTurn':
      endTurn(next, data, events);
      break;
    case 'moveHero':
      moveHero(next, command, data, events);
      break;
    case 'visitObject':
      visitObject(next, command, data, events);
      break;
    case 'resolveChoice':
      resolveChoice(next, command, data, events);
      break;
    case 'combatAction':
      applyCombatAction(
        next,
        command.player,
        command.action,
        data,
        events,
        (s, hero, obj, evts) => {
          applyObjectReward(s, hero, obj, data, evts);
        },
      );
      break;
    case 'build':
      buildStructure(next, command, data, events);
      break;
    case 'recruit':
      recruitCreatures(next, command, data, events);
      break;
    case 'recruitDwelling':
      recruitFromDwelling(next, command, data, events);
      break;
    case 'upgradeStack':
      upgradeArmyStack(next, command, data, events);
      break;
    case 'trade':
      tradeResources(next, command, events);
      break;
    case 'hireHero':
      hireHero(next, command, data, events);
      break;
    case 'transformToSkeletons':
      transformToSkeletons(next, command, events);
      break;
    case 'moveStack':
      moveArmyStack(next, command, events);
      break;
    case 'equipArtifact':
      equipArtifactCommand(next, command, data, events);
      break;
    case 'unequipArtifact':
      unequipArtifactCommand(next, command, events);
      break;
    case 'transferArtifact':
      transferArtifactCommand(next, command, events);
      break;
    case 'buySpellbook':
      buySpellbookCommand(next, command, data, events);
      break;
    case 'castAdventureSpell':
      castAdventureSpell(next, command, data, events);
      break;
    case 'dismissHero':
      dismissHeroCommand(next, command, events);
      break;
  }
  evaluateVictory(next, data, events);
  return { state: next, events };
}
