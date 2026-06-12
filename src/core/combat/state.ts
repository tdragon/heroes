import type { Creature, SpecialType } from '../../data/schema';
import type { RngState } from '../rng';
import type { Hex } from './grid';
import type { SiegeState } from './siege';

export type CombatSideId = 'attacker' | 'defender';

export class CombatRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CombatRuleError';
  }
}

export function oppositeSide(side: CombatSideId): CombatSideId {
  return side === 'attacker' ? 'defender' : 'attacker';
}

export interface SchoolTiers {
  air: number;
  earth: number;
  fire: number;
  water: number;
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
  morale: number;
  luck: number;
  mana: number;
  hasSpellbook: boolean;
  spells: string[];
  schoolTiers: SchoolTiers;
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
    morale: 0,
    luck: 0,
    mana: 0,
    hasSpellbook: false,
    spells: [],
    schoolTiers: { air: 0, earth: 0, fire: 0, water: 0 },
  };
}

export const EFFECT_KINDS = [
  'haste',
  'slow',
  'shield',
  'stone_skin',
  'bless',
  'curse',
  'bloodlust',
  'weakness',
  'blind',
  'forgetfulness',
  'disease',
  'aging',
  'bind',
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

export interface StackEffect {
  kind: EffectKind;
  positive: boolean;
  rounds: number;
  value: number;
  // who applied the effect: a hero side, or a creature on-hit special;
  // basic-tier Dispel only removes effects cast by the dispelling side
  castBy?: CombatSideId | 'creature';
}

export interface CombatStack {
  id: string;
  side: CombatSideId;
  slot: number;
  creature: string;
  count: number;
  initialCount: number;
  firstHp: number;
  pos: Hex;
  shots: number;
  retaliationsLeft: number;
  defending: boolean;
  waited: boolean;
  moraleSurged: boolean;
  usedResurrect: boolean;
  effects: StackEffect[];
}

export type CombatEvent =
  | { type: 'combatStarted'; obstacles: Hex[] }
  | { type: 'roundStarted'; round: number }
  | { type: 'stackMoved'; stack: string; from: Hex; to: Hex }
  | {
      type: 'stackAttacked';
      attacker: string;
      target: string;
      damage: number;
      kills: number;
      ranged: boolean;
      retaliation: boolean;
    }
  | { type: 'stackDied'; stack: string }
  | { type: 'stackWaited'; stack: string }
  | { type: 'stackDefended'; stack: string }
  | { type: 'stackSkipped'; stack: string; reason: 'blind' }
  | { type: 'moraleSurge'; stack: string }
  | { type: 'moraleFreeze'; stack: string }
  | { type: 'luck'; stack: string }
  | { type: 'abilityTriggered'; stack: string; ability: SpecialType; target?: string }
  | { type: 'effectApplied'; stack: string; kind: EffectKind; rounds: number; value: number }
  | { type: 'effectExpired'; stack: string; kind: EffectKind }
  | { type: 'stackHealed'; stack: string; amount: number }
  | { type: 'stackResurrected'; stack: string; revived: number }
  | { type: 'manaDrained'; side: CombatSideId; amount: number; by: string }
  | { type: 'spellCast'; side: CombatSideId; spell: string; targets: string[] }
  | { type: 'spellResisted'; stack: string; spell: string; reason: 'immune' | 'resisted' }
  | { type: 'spellDamage'; stack: string; spell: string; damage: number; kills: number }
  | { type: 'wallHit'; segment: number; damage: number; hp: number; source: 'catapult' | 'melee' }
  | { type: 'towerShot'; tower: number; target: string; damage: number; kills: number }
  | { type: 'moatDamage'; stack: string; damage: number }
  | { type: 'combatEnded'; winner: CombatSideId };

export interface CombatState {
  round: number;
  rngState: RngState;
  attackerHero: CombatHeroInfo;
  defenderHero: CombatHeroInfo;
  stacks: CombatStack[];
  obstacles: Hex[];
  queue: string[];
  waitQueue: string[];
  castThisRound: Record<CombatSideId, boolean>;
  siege: SiegeState | null;
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
