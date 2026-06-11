import type { GameData } from '../data';
import type { Pos } from '../maps/schema';
import { applyLevelUpChoice, type PrimaryStat } from './hero';
import { moveHero } from './movement';
import { OBJECT_CHOICE_KINDS, resolveObjectChoice } from './objects';
import { endTurn } from './turn';
import type { GameState, HeroId, ObjectId, PlayerId, Resources, TownId } from './state';

export type Command =
  | { type: 'endTurn'; player: PlayerId }
  | { type: 'moveHero'; player: PlayerId; hero: HeroId; path: Pos[] }
  | { type: 'resolveChoice'; player: PlayerId; choiceId: string; option: number };

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
  | { type: 'combatQueued'; attacker: HeroId; object: ObjectId };

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
    applyLevelUpChoice(state, choice, command.option);
  } else if ((OBJECT_CHOICE_KINDS as readonly string[]).includes(choice.kind)) {
    resolveObjectChoice(state, choice, command.option, data, events);
  }
  events.push({ type: 'choiceResolved', choiceId: choice.id, option: command.option });
}

export function dispatch(state: GameState, command: Command, data: GameData): DispatchResult {
  if (state.status !== 'running') {
    throw new CommandRejectedError('game is over');
  }
  if (command.player !== state.currentPlayer) {
    throw new CommandRejectedError(
      `command from ${command.player}, but current player is ${state.currentPlayer}`,
    );
  }
  if (state.combat !== null) {
    // TODO(Task 8): combat commands will be accepted here once the combat engine lands
    throw new CommandRejectedError('a combat is pending resolution');
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
    case 'resolveChoice':
      resolveChoice(next, command, data, events);
      break;
  }
  return { state: next, events };
}
