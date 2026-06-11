import type { GameData } from '../data';
import type { Pos } from '../maps/schema';
import { moveHero } from './movement';
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
  | { type: 'choiceResolved'; choiceId: string; option: number };

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
      resolveChoice(next, command, events);
      break;
  }
  return { state: next, events };
}
