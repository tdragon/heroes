// Slow balance simulation — excluded from the default vitest run, executed
// via `npm run test:balance` (vitest.balance.config.ts). Plays full AI-vs-AI
// games on both real maps over 10 seeds each with rotating faction matchups,
// asserts every game terminates, and checks the crude balance signal that no
// faction wins more than 80% of its (mirrorless) matches.

import { describe, expect, it } from 'vitest';
import { configureMap, type PlayerSetup } from '../app/newGameSetup';
import type { FactionId } from '../data/schema';
import { loadGameData } from '../data';
import { loadMaps } from '../maps';
import { chooseAICommand } from './ai/adventureAI';
import { dispatch, type Command } from './commands';
import { newGame } from './setup';
import type { GameState } from './state';

const data = loadGameData();

const FACTIONS: readonly FactionId[] = ['castle', 'rampart', 'necropolis'];
const SEEDS_PER_MAP = 10;
const MAX_DAYS = 168; // 6 months — generous bound for "the game ends"
const MAX_COMMANDS = 400_000;
const MAX_FACTION_WIN_RATE = 0.8;

// resolve a pending choice (off-turn owners allowed), otherwise let the AI act
function nextAiCommand(state: GameState): Command {
  const offTurn = state.pendingChoices.find((c) => c.player !== state.currentPlayer);
  if (offTurn) {
    return { type: 'resolveChoice', player: offTurn.player, choiceId: offTurn.id, option: 0 };
  }
  return chooseAICommand(state, data);
}

interface MatchResult {
  map: string;
  seed: number;
  factions: FactionId[];
  winner: FactionId;
  days: number;
}

function runMatch(mapId: string, seed: number): MatchResult {
  const map = loadMaps().find((m) => m.id === mapId);
  if (!map) throw new Error(`unknown map: ${mapId}`);
  const rotation = seed % FACTIONS.length;
  const setups: PlayerSetup[] = map.players.map((player, i) => {
    const faction = FACTIONS[(i + rotation) % FACTIONS.length];
    if (faction === undefined) throw new Error('faction rotation out of range');
    return { color: player.color, faction, isHuman: false };
  });
  const configured = configureMap(map, data, setups);
  let state = newGame(configured, {}, seed, data);
  let commands = 0;
  while (state.status === 'running') {
    if (commands++ > MAX_COMMANDS) {
      throw new Error(`${mapId} seed ${String(seed)}: command limit reached, game looks hung`);
    }
    if (state.day > MAX_DAYS) {
      throw new Error(`${mapId} seed ${String(seed)}: no winner after ${String(MAX_DAYS)} days`);
    }
    state = dispatch(state, nextAiCommand(state), data).state;
  }
  const winnerId = state.status.winner;
  const winner = state.players.find((p) => p.id === winnerId)?.faction;
  if (winner === undefined) {
    throw new Error(`${mapId} seed ${String(seed)}: winner ${winnerId} has no faction`);
  }
  return {
    map: mapId,
    seed,
    factions: setups.map((s) => s.faction),
    winner,
    days: state.day,
  };
}

function winRateTable(results: MatchResult[]): string {
  const lines = ['faction      | games | wins | win rate'];
  for (const faction of FACTIONS) {
    const games = results.filter((r) => r.factions.includes(faction)).length;
    const wins = results.filter((r) => r.winner === faction).length;
    const rate = games > 0 ? wins / games : 0;
    lines.push(
      `${faction.padEnd(12)} | ${String(games).padStart(5)} | ${String(wins).padStart(4)} | ${(rate * 100).toFixed(0)}%`,
    );
  }
  return lines.join('\n');
}

describe('balance simulation (slow, npm run test:balance)', () => {
  it('AI-vs-AI games on both real maps terminate and no faction dominates', () => {
    const results: MatchResult[] = [];
    for (const mapId of ['tutorial-valley', 'contested-river']) {
      for (let seed = 1; seed <= SEEDS_PER_MAP; seed++) {
        const result = runMatch(mapId, seed);
        results.push(result);
        console.log(
          `${result.map} seed ${String(result.seed)}: ${result.winner} wins on day ${String(result.days)} (${result.factions.join(' vs ')})`,
        );
      }
    }
    console.log(winRateTable(results));

    expect(results).toHaveLength(2 * SEEDS_PER_MAP);
    // every match is mirrorless by construction (rotation assigns distinct factions)
    for (const result of results) {
      expect(new Set(result.factions).size).toBe(result.factions.length);
    }
    for (const faction of FACTIONS) {
      const games = results.filter((r) => r.factions.includes(faction)).length;
      const wins = results.filter((r) => r.winner === faction).length;
      expect(games).toBeGreaterThan(0);
      expect(wins / games, `${faction} win rate`).toBeLessThanOrEqual(MAX_FACTION_WIN_RATE);
    }
  });
});
