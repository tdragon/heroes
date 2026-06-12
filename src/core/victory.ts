// Victory and loss evaluation, run after every command: a player is
// eliminated on losing all towns and heroes, or after holding zero towns for
// 7 consecutive days; the last active player wins.

import type { GameData } from '../data';
import type { GameEvent } from './commands';
import { advanceDay } from './turn';
import type { GameState, Player } from './state';

export const TOWNLESS_DEFEAT_DAYS = 7;

export function isEliminated(player: Player): boolean {
  if (player.towns.length > 0) return false;
  if (player.heroes.length === 0) return true;
  return player.daysWithoutTown >= TOWNLESS_DEFEAT_DAYS;
}

function eliminatePlayer(state: GameState, player: Player, events: GameEvent[]): void {
  player.defeated = true;
  const removed = new Set(player.heroes);
  for (const heroId of player.heroes) {
    const hero = state.heroes[heroId];
    if (hero) {
      state.tavernPool.push(hero.template);
    }
    for (const town of Object.values(state.towns)) {
      if (town.visitingHero === heroId) town.visitingHero = null;
    }
  }
  state.heroes = Object.fromEntries(
    Object.entries(state.heroes).filter(([id]) => !removed.has(id)),
  );
  player.heroes = [];
  state.pendingChoices = state.pendingChoices.filter((choice) => choice.player !== player.id);
  events.push({ type: 'playerDefeated', player: player.id });
}

// the current player can defeat themselves (e.g. fleeing the last battle);
// hand the turn to the next active player, advancing the day when wrapping
function passTurnFromDefeated(state: GameState, data: GameData, events: GameEvent[]): void {
  const index = state.players.findIndex((p) => p.id === state.currentPlayer);
  if (index === -1) {
    throw new Error(`current player ${state.currentPlayer} is unknown`);
  }
  for (let step = 1; step <= state.players.length; step++) {
    const candidate = state.players[(index + step) % state.players.length];
    if (!candidate || candidate.defeated) continue;
    if (index + step >= state.players.length) {
      advanceDay(state, data, events);
    }
    state.currentPlayer = candidate.id;
    events.push({ type: 'turnStarted', player: candidate.id });
    return;
  }
}

export function evaluateVictory(state: GameState, data: GameData, events: GameEvent[]): void {
  if (state.status !== 'running' || state.combat !== null) return;
  // eliminate in play chronology: the current player falls during their own
  // turn (mid-command, e.g. fleeing the last battle), every other player
  // would fall as the rotation reached them, wrapping around the seating
  const start = Math.max(
    0,
    state.players.findIndex((p) => p.id === state.currentPlayer),
  );
  const eliminatedNow: Player[] = [];
  for (let step = 0; step < state.players.length; step++) {
    const player = state.players[(start + step) % state.players.length];
    if (player && !player.defeated && isEliminated(player)) {
      eliminatePlayer(state, player, events);
      eliminatedNow.push(player);
    }
  }
  const active = state.players.filter((p) => !p.defeated);
  // simultaneous elimination (every remaining player hits the 7-day townless
  // limit on the same pass) must not leave the game running with no active
  // player: rule — the player the rotation would reach last (the seat just
  // before the current player) wins the mutual destruction, as the
  // deterministic tie-break
  if (active.length === 0) {
    const winner = eliminatedNow[eliminatedNow.length - 1];
    if (!winner) return;
    state.status = { winner: winner.id };
    events.push({ type: 'gameOver', winner: winner.id });
    return;
  }
  if (active.length === 1 && state.players.length > 1) {
    const winner = active[0];
    if (!winner) return;
    state.status = { winner: winner.id };
    events.push({ type: 'gameOver', winner: winner.id });
    return;
  }
  if (active.length > 0 && !active.some((p) => p.id === state.currentPlayer)) {
    passTurnFromDefeated(state, data, events);
  }
}
