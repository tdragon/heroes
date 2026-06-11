// Golden replay harness: runs a scripted command sequence against a map and
// returns the resulting deterministic state. Script steps may be literal
// commands, pure generators over the current state (for paths, choice ids,
// combat actions), bounded until-loops, or assertion checkpoints.

import type { GameData } from '../data';
import type { GameMap } from '../maps/schema';
import { dispatch, type Command, type GameEvent } from './commands';
import { deserializeGame, serializeGame } from './serialize';
import { newGame, type NewGameConfig } from './setup';
import type { GameState } from './state';

export type StepGenerator = (state: GameState, data: GameData) => Command | Command[] | null;

export type ScriptStep =
  | Command
  | StepGenerator
  | { until: (state: GameState) => boolean; step: StepGenerator; max?: number }
  | { assert: (state: GameState) => void; label: string };

export interface RunScriptOptions {
  config?: NewGameConfig;
  afterCommand?: (state: GameState, command: Command, events: GameEvent[]) => void;
}

export interface ReplayResult {
  state: GameState;
  events: GameEvent[];
  commandCount: number;
}

export const DEFAULT_UNTIL_MAX = 500;

export function runScript(
  map: GameMap,
  seed: number,
  script: readonly ScriptStep[],
  data: GameData,
  options: RunScriptOptions = {},
): ReplayResult {
  let state = newGame(map, options.config ?? {}, seed, data);
  const events: GameEvent[] = [];
  let commandCount = 0;

  const apply = (command: Command): void => {
    const result = dispatch(state, command, data);
    state = result.state;
    events.push(...result.events);
    commandCount += 1;
    options.afterCommand?.(state, command, result.events);
  };

  const applyGenerated = (generated: Command | Command[] | null): void => {
    if (generated === null) return;
    for (const command of Array.isArray(generated) ? generated : [generated]) {
      apply(command);
    }
  };

  script.forEach((step, index) => {
    if (typeof step === 'function') {
      applyGenerated(step(state, data));
      return;
    }
    if ('until' in step) {
      const max = step.max ?? DEFAULT_UNTIL_MAX;
      let iterations = 0;
      while (!step.until(state)) {
        if (iterations >= max) {
          throw new Error(
            `script step ${String(index)}: until-loop exceeded ${String(max)} iterations`,
          );
        }
        iterations += 1;
        applyGenerated(step.step(state, data));
      }
      return;
    }
    if ('assert' in step) {
      try {
        step.assert(state);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`checkpoint '${step.label}' failed: ${reason}`, { cause: error });
      }
      return;
    }
    apply(step);
  });

  return { state, events, commandCount };
}

// canonical JSON: object keys sorted recursively, so the hash does not depend
// on property insertion order
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stateHash(state: GameState): string {
  return fnv1a(canonicalJson(state)).toString(16).padStart(8, '0');
}

export function checkInvariants(state: GameState): string[] {
  const problems: string[] = [];
  if (state.day < 1) {
    problems.push(`day ${String(state.day)} < 1`);
  }
  for (const player of state.players) {
    for (const [resource, amount] of Object.entries(player.resources)) {
      if (amount < 0) {
        problems.push(`player ${player.id}: ${resource} = ${String(amount)} < 0`);
      }
    }
  }
  for (const hero of Object.values(state.heroes)) {
    if (hero.movementPoints < 0) {
      problems.push(`hero ${hero.id}: movementPoints ${String(hero.movementPoints)} < 0`);
    }
    if (hero.mana < 0) {
      problems.push(`hero ${hero.id}: mana ${String(hero.mana)} < 0`);
    }
    if (hero.xp < 0) {
      problems.push(`hero ${hero.id}: xp ${String(hero.xp)} < 0`);
    }
    for (const stack of hero.army) {
      if (stack && stack.count <= 0) {
        problems.push(`hero ${hero.id}: stack of ${stack.creature} has count <= 0`);
      }
    }
  }
  for (const town of Object.values(state.towns)) {
    for (const stack of town.garrison) {
      if (stack && stack.count <= 0) {
        problems.push(`town ${town.id}: garrison stack of ${stack.creature} has count <= 0`);
      }
    }
    for (const [creature, pool] of Object.entries(town.availableCreatures)) {
      if (pool < 0) {
        problems.push(`town ${town.id}: pool of ${creature} = ${String(pool)} < 0`);
      }
    }
  }
  for (const obj of state.map.objects) {
    if (obj.guard && obj.guard.count < 0) {
      problems.push(`object ${obj.id}: guard count ${String(obj.guard.count)} < 0`);
    }
  }
  if (state.combat) {
    for (const stack of state.combat.combat.stacks) {
      if (stack.count < 0) {
        problems.push(`combat stack ${stack.id}: count ${String(stack.count)} < 0`);
      }
    }
  }
  const roundTrip = deserializeGame(serializeGame(state));
  if (canonicalJson(roundTrip) !== canonicalJson(state)) {
    problems.push('state does not survive a serialize/deserialize round-trip');
  }
  return problems;
}
