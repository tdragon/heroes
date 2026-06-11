import type { Creature } from '../../data/schema';
import type { RngState } from '../rng';
import type { Hex } from './grid';

export type CombatSideId = 'attacker' | 'defender';

export function oppositeSide(side: CombatSideId): CombatSideId {
  return side === 'attacker' ? 'defender' : 'attacker';
}

// hero-derived combat modifiers; all-zero for heroless armies (map guards)
export interface CombatHeroInfo {
  hero: string | null;
  player: string | null;
  attack: number;
  defense: number;
  spellPower: number;
  knowledge: number;
  offenseBonus: number;
  archeryBonus: number;
  armorerReduction: number;
}

export function noHero(): CombatHeroInfo {
  return {
    hero: null,
    player: null,
    attack: 0,
    defense: 0,
    spellPower: 0,
    knowledge: 0,
    offenseBonus: 0,
    archeryBonus: 0,
    armorerReduction: 0,
  };
}

export interface CombatStack {
  id: string;
  side: CombatSideId;
  slot: number;
  creature: string;
  count: number;
  firstHp: number;
  pos: Hex;
  shots: number;
  retaliationsLeft: number;
  defending: boolean;
  waited: boolean;
}

export interface CombatState {
  round: number;
  rngState: RngState;
  attackerHero: CombatHeroInfo;
  defenderHero: CombatHeroInfo;
  stacks: CombatStack[];
  obstacles: Hex[];
  queue: string[];
  waitQueue: string[];
  winner: CombatSideId | null;
}

export function getCombatStack(combat: CombatState, id: string): CombatStack {
  const stack = combat.stacks.find((s) => s.id === id);
  if (!stack) {
    throw new Error(`unknown combat stack: ${id}`);
  }
  return stack;
}

export function isStackAlive(stack: CombatStack): boolean {
  return stack.count > 0;
}

export function livingStacks(combat: CombatState, side?: CombatSideId): CombatStack[] {
  return combat.stacks.filter((s) => isStackAlive(s) && (side === undefined || s.side === side));
}

export function heroInfoFor(combat: CombatState, side: CombatSideId): CombatHeroInfo {
  return side === 'attacker' ? combat.attackerHero : combat.defenderHero;
}

// wide creatures occupy the head hex plus the tail hex toward their own edge
export function tailOffset(side: CombatSideId): number {
  return side === 'attacker' ? -1 : 1;
}

export function occupiedHexes(stack: CombatStack, creature: Creature): Hex[] {
  if (!creature.flags.includes('wide')) {
    return [stack.pos];
  }
  return [stack.pos, { x: stack.pos.x + tailOffset(stack.side), y: stack.pos.y }];
}
