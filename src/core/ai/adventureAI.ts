// Adventure AI per spec sections 9.1-9.3: score visible opportunities as
// value/distance, gate guarded targets behind a 1.3x power ratio, march
// toward the best one, manage towns daily and resolve battles with the combat
// AI. The whole AI emits commands through the same dispatch API as the human
// player; `chooseAICommand` returns the next command for the current player.

import type { GameData } from '../../data';
import type { Pos } from '../../maps/schema';
import type { Command } from '../commands';
import { findPathInContext, buildMoveContext, stepCost } from '../movement';
import { liveGuard } from '../objects';
import {
  getPlayer,
  type ArmySlots,
  type GameState,
  type Hero,
  type Town,
} from '../state';
import { chooseCombatAction } from './combatAI';
import {
  chooseBuildCommand,
  chooseRecruitCommand,
  chooseTradeCommand,
  hasAffordableRecruits,
} from './economyAI';

export const ATTACK_POWER_RATIO = 1.3;
export const WEAK_HERO_RATIO = 0.8;

export const ENEMY_TOWN_VALUE = 200;
export const WEAK_HERO_VALUE = 150;
export const MINE_VALUE = 60;
export const OWN_TOWN_RECRUIT_VALUE = 60;
export const PICKUP_VALUE = 40;
export const DWELLING_VALUE = 30;
export const MONSTER_VALUE = 20;

export function armyPower(slots: ArmySlots, data: GameData): number {
  let power = 0;
  for (const stack of slots) {
    if (!stack) continue;
    power += stack.count * (data.creatures[stack.creature]?.aiValue ?? 0);
  }
  return power;
}

// garrison plus the visiting hero's army
export function townDefensePower(state: GameState, town: Town, data: GameData): number {
  let power = armyPower(town.garrison, data);
  if (town.visitingHero !== null) {
    const visiting = state.heroes[town.visitingHero];
    if (visiting) power += armyPower(visiting.army, data);
  }
  return power;
}

export interface Opportunity {
  at: Pos;
  score: number;
}

function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

const PICKUP_TYPES = new Set(['resource', 'treasure_chest', 'artifact']);

export function heroOpportunities(state: GameState, hero: Hero, data: GameData): Opportunity[] {
  const own = armyPower(hero.army, data);
  const out: Opportunity[] = [];
  const consider = (at: Pos, value: number): void => {
    if (value <= 0) return;
    if (at[0] === hero.pos[0] && at[1] === hero.pos[1]) return;
    out.push({ at, score: value / Math.max(1, chebyshev(hero.pos, at)) });
  };

  for (const town of Object.values(state.towns)) {
    if (town.owner === hero.owner) {
      if (hasAffordableRecruits(state, town, hero.owner, data)) {
        consider(town.pos, OWN_TOWN_RECRUIT_VALUE);
      }
      continue;
    }
    const defense = townDefensePower(state, town, data);
    if (defense === 0 || own >= ATTACK_POWER_RATIO * defense) {
      consider(town.pos, ENEMY_TOWN_VALUE);
    }
  }

  for (const enemy of Object.values(state.heroes)) {
    if (enemy.owner === hero.owner) continue;
    if (armyPower(enemy.army, data) < WEAK_HERO_RATIO * own) {
      consider(enemy.pos, WEAK_HERO_VALUE);
    }
  }

  for (const obj of state.map.objects) {
    if (obj.removed || obj.type === 'town') continue;
    let value = 0;
    if (obj.type === 'mine' && obj.owner !== hero.owner) value = MINE_VALUE;
    else if (obj.type === 'dwelling' && obj.owner !== hero.owner) value = DWELLING_VALUE;
    else if (PICKUP_TYPES.has(obj.type)) value = PICKUP_VALUE;
    else if (obj.type === 'monster') value = MONSTER_VALUE;
    if (value === 0) continue;
    const guard = liveGuard(obj);
    if (guard) {
      const guardPower = guard.count * (data.creatures[guard.creature]?.aiValue ?? 0);
      if (own < ATTACK_POWER_RATIO * guardPower) continue;
    }
    consider(obj.at, value);
  }

  return out.sort(
    (a, b) => b.score - a.score || a.at[1] - b.at[1] || a.at[0] - b.at[0],
  );
}

// the best move command for this hero, or null when it has nothing to do
export function chooseHeroCommand(
  state: GameState,
  hero: Hero,
  data: GameData,
): Command | null {
  if (hero.movementPoints <= 0) return null;
  const ctx = buildMoveContext(state, data, hero);
  for (const opportunity of heroOpportunities(state, hero, data)) {
    const path = findPathInContext(ctx, hero.pos, opportunity.at);
    if (!path || path.length === 0) continue;
    const first = path[0];
    if (!first || stepCost(ctx, hero.pos, first) > hero.movementPoints) continue;
    return { type: 'moveHero', player: hero.owner, hero: hero.id, path };
  }
  return null;
}

// next command for the current (AI) player; emits endTurn when nothing is left
export function chooseAICommand(state: GameState, data: GameData): Command {
  const playerId = state.currentPlayer;

  if (state.combat !== null) {
    return {
      type: 'combatAction',
      player: playerId,
      action: chooseCombatAction(state.combat.combat, data),
    };
  }

  // option 0 is always the aggressive/greedy pick: attack the guard, take the
  // gold, learn the first offered skill, train attack
  const choice = state.pendingChoices.find((c) => c.player === playerId);
  if (choice) {
    return { type: 'resolveChoice', player: playerId, choiceId: choice.id, option: 0 };
  }

  const build = chooseBuildCommand(state, playerId, data);
  if (build) return build;

  const recruit = chooseRecruitCommand(state, playerId, data);
  if (recruit) return recruit;

  const trade = chooseTradeCommand(state, playerId, data);
  if (trade) return trade;

  for (const heroId of getPlayer(state, playerId).heroes) {
    const hero = state.heroes[heroId];
    if (!hero) continue;
    const command = chooseHeroCommand(state, hero, data);
    if (command) return command;
  }

  return { type: 'endTurn', player: playerId };
}
