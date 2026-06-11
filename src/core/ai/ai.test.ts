import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data';
import { compileMap } from '../../maps/dsl';
import { tinyMapSource } from '../../maps/fixtures/tiny.dsl';
import { combatAct, createCombat, type CombatArmyStack } from '../combat/engine';
import { noHero, type CombatHeroInfo, type CombatState } from '../combat/state';
import { dispatch, type Command, type GameEvent } from '../commands';
import { newGame } from '../setup';
import { rollRange, seedRng, type RngState } from '../rng';
import type { GameState } from '../state';
import { chooseAICommand, chooseHeroCommand, heroOpportunities, armyPower } from './adventureAI';
import { chooseCombatAction } from './combatAI';
import { chooseBuildCommand, chooseRecruitCommand, maxAffordable } from './economyAI';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

// --- combat AI fuzz: never an illegal action ---

const FUZZ_SEEDS = 200;
const FUZZ_ACTION_CAP = 600;
const FUZZ_SPELLS = ['magic_arrow', 'lightning_bolt', 'ice_bolt', 'implosion'];

const allCreatureIds = Object.keys(data.creatures).sort();

function randomArmy(rng: RngState): [CombatArmyStack[], RngState] {
  let state = rng;
  const [stackCount, afterCount] = rollRange(state, 1, 4);
  state = afterCount;
  const stacks: CombatArmyStack[] = [];
  for (let i = 0; i < stackCount; i++) {
    const [pick, afterPick] = rollRange(state, 0, allCreatureIds.length - 1);
    const [count, afterAmount] = rollRange(afterPick, 1, 30);
    state = afterAmount;
    const creature = allCreatureIds[pick];
    if (creature === undefined) throw new Error('creature pick out of range');
    stacks.push({ creature, count });
  }
  return [stacks, state];
}

function randomHero(rng: RngState, name: string): [CombatHeroInfo, RngState] {
  let state = rng;
  const [hasHero, afterHas] = rollRange(state, 0, 1);
  state = afterHas;
  if (hasHero === 0) return [noHero(), state];
  const roll = (min: number, max: number): number => {
    const [value, next] = rollRange(state, min, max);
    state = next;
    return value;
  };
  const hero: CombatHeroInfo = {
    ...noHero(),
    hero: name,
    player: name,
    attack: roll(0, 6),
    defense: roll(0, 6),
    spellPower: roll(0, 6),
    knowledge: roll(0, 6),
    mana: roll(0, 40),
    hasSpellbook: roll(0, 1) === 1,
    spells: FUZZ_SPELLS.slice(0, roll(0, FUZZ_SPELLS.length)),
  };
  return [hero, state];
}

function buildRandomCombat(seed: number): CombatState {
  let rng = seedRng(seed);
  const [attackerStacks, afterAttacker] = randomArmy(rng);
  rng = afterAttacker;
  const [defenderStacks, afterDefender] = randomArmy(rng);
  rng = afterDefender;
  const [attackerHero, afterHeroA] = randomHero(rng, 'att');
  rng = afterHeroA;
  const [defenderHero, afterHeroD] = randomHero(rng, 'def');
  rng = afterHeroD;
  return createCombat(
    {
      attacker: { hero: attackerHero, stacks: attackerStacks },
      defender: { hero: defenderHero, stacks: defenderStacks },
      rng,
    },
    data,
  ).combat;
}

describe('combat AI', () => {
  it('never returns an illegal action over 200 seeded random combats', () => {
    let finished = 0;
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      const combat = buildRandomCombat(seed);
      for (let action = 0; action < FUZZ_ACTION_CAP && combat.winner === null; action++) {
        const chosen = chooseCombatAction(combat, data);
        // combatAct throws CombatRuleError on any illegal action
        expect(() => combatAct(combat, chosen, data), `seed ${String(seed)}`).not.toThrow();
      }
      if (combat.winner !== null) finished++;
    }
    // the AI should also actually finish (almost) every battle it plays
    expect(finished).toBeGreaterThan(FUZZ_SEEDS * 0.9);
  });

  it('casts the best affordable damage spell at the biggest enemy stack', () => {
    const hero: CombatHeroInfo = {
      ...noHero(),
      hero: 'caster',
      player: 'red',
      spellPower: 3,
      mana: 30,
      hasSpellbook: true,
      spells: ['magic_arrow', 'lightning_bolt'],
    };
    const { combat } = createCombat(
      {
        // griffin speed ties the wolves; the attacker acts first
        attacker: { hero, stacks: [{ creature: 'griffin', count: 10 }] },
        defender: {
          hero: noHero(),
          stacks: [
            { creature: 'wolf', count: 2 },
            { creature: 'wolf', count: 9 },
          ],
        },
        rng: seedRng(5),
        obstacles: [],
      },
      data,
    );
    const action = chooseCombatAction(combat, data);
    expect(action).toEqual({ type: 'cast', spell: 'lightning_bolt', target: 'd1' });
  });

  it('shooters shoot the biggest threat instead of advancing', () => {
    const { combat } = createCombat(
      {
        attacker: { hero: noHero(), stacks: [{ creature: 'archer', count: 10 }] },
        defender: {
          hero: noHero(),
          stacks: [
            { creature: 'pikeman', count: 1 },
            { creature: 'pikeman', count: 20 },
          ],
        },
        rng: seedRng(5),
        obstacles: [],
      },
      data,
    );
    // archer (speed 4) acts first; it should shoot the 20-pikeman stack
    const action = chooseCombatAction(combat, data);
    expect(action).toEqual({ type: 'shoot', target: 'd1' });
  });
});

// --- shared game-loop drivers ---

// resolve a pending choice (off-turn owners allowed), otherwise let the AI act
function nextAiDrivenCommand(state: GameState): Command {
  const offTurn = state.pendingChoices.find((c) => c.player !== state.currentPlayer);
  if (offTurn) {
    return { type: 'resolveChoice', player: offTurn.player, choiceId: offTurn.id, option: 0 };
  }
  return chooseAICommand(state, data);
}

describe('adventure AI', () => {
  it('scores opportunities and gates guarded targets by power ratio', () => {
    const state = newGame(tinyMap, {}, 11, data);
    const edric = state.heroes.edric;
    if (!edric) throw new Error('edric missing');
    const opportunities = heroOpportunities(state, edric, data);
    expect(opportunities.length).toBeGreaterThan(0);
    // wood pile, gold pile, chest, mine and monster are all on the tiny map
    const targets = opportunities.map((o) => `${String(o.at[0])},${String(o.at[1])}`);
    expect(targets).toContain('4,4');
    expect(targets).toContain('6,2');

    // an over-powered guard hides its object from the AI
    const mine = state.map.objects.find((o) => o.type === 'mine');
    if (!mine?.guard) throw new Error('mine guard missing');
    mine.guard.count = 1000;
    const gated = heroOpportunities(state, edric, data);
    expect(gated.some((o) => o.at[0] === 6 && o.at[1] === 2)).toBe(false);
  });

  it('moves its hero toward the best opportunity', () => {
    const state = newGame(tinyMap, {}, 11, data);
    const edric = state.heroes.edric;
    if (!edric) throw new Error('edric missing');
    const command = chooseHeroCommand(state, edric, data);
    expect(command?.type).toBe('moveHero');
  });

  it('triggers a hero-vs-hero field battle when moving onto an enemy hero', () => {
    let state = newGame(tinyMap, {}, 11, data);
    state = dispatch(state, { type: 'endTurn', player: 'red' }, data).state;
    // blue walks into the open (south, around the town footprint)
    const blueMove: Command = {
      type: 'moveHero',
      player: 'blue',
      hero: 'mortus',
      path: [
        [9, 10],
        [8, 10],
      ],
    };
    state = dispatch(state, blueMove, data).state;
    state = dispatch(state, { type: 'endTurn', player: 'blue' }, data).state;

    // red attacks the tile mortus stands on
    const path: [number, number][] = [
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 7],
      [7, 8],
      [7, 9],
      [8, 10],
    ];
    // remove map objects along the way so the path stays interaction-free
    for (const obj of state.map.objects) {
      if (obj.type === 'resource' || obj.type === 'monster' || obj.type === 'treasure_chest') {
        obj.removed = true;
      }
    }
    const before = state.heroes.edric?.pos;
    const result = dispatch(
      state,
      { type: 'moveHero', player: 'red', hero: 'edric', path },
      data,
    );
    state = result.state;
    expect(state.combat?.reason).toBe('field');
    expect(state.combat?.defenderHero).toBe('mortus');
    // the attacker never enters the defender's tile
    expect(state.heroes.edric?.pos).not.toEqual(before);
    expect(state.heroes.edric?.pos).toEqual([7, 9]);
    expect(
      result.events.some((e) => e.type === 'combatStarted' && e.reason === 'field'),
    ).toBe(true);

    // play the battle out with the combat AI; exactly one hero survives
    let guard = 0;
    while (state.combat !== null && guard++ < 300) {
      state = dispatch(
        state,
        {
          type: 'combatAction',
          player: 'red',
          action: chooseCombatAction(state.combat.combat, data),
        },
        data,
      ).state;
    }
    expect(state.combat).toBeNull();
    expect(('edric' in state.heroes) !== ('mortus' in state.heroes)).toBe(true);
  });

  it('lets a choice owner resolve it off-turn, but nobody else', () => {
    const state = newGame(tinyMap, {}, 11, data);
    state.pendingChoices.push({
      id: 'test-choice',
      player: 'blue',
      kind: 'levelUp',
      hero: 'mortus',
      options: ['logistics:basic'],
    });
    // red (current player) does not own the choice
    expect(() =>
      dispatch(
        state,
        { type: 'resolveChoice', player: 'red', choiceId: 'test-choice', option: 0 },
        data,
      ),
    ).toThrow(/belongs to blue/);
    // blue resolves it although it is red's turn
    const result = dispatch(
      state,
      { type: 'resolveChoice', player: 'blue', choiceId: 'test-choice', option: 0 },
      data,
    );
    expect(result.state.pendingChoices).toHaveLength(0);
    expect(result.state.heroes.mortus?.skills.some((s) => s.skill === 'logistics')).toBe(true);
  });
});

describe('economy AI', () => {
  const richResources = {
    gold: 500000,
    wood: 500,
    ore: 500,
    mercury: 200,
    sulfur: 200,
    crystal: 200,
    gems: 200,
  };

  it('builds the capitol track in valid order', () => {
    let state = newGame(tinyMap, { startingResources: richResources }, 3, data);
    const built: string[] = [];
    for (let day = 0; day < 40 && !built.includes('capitol'); day++) {
      const command = chooseBuildCommand(state, 'red', data);
      if (command) {
        if (command.type !== 'build') throw new Error('expected a build command');
        built.push(command.building);
        // dispatch enforces prereqs, so an out-of-order pick would throw here
        state = dispatch(state, command, data).state;
      }
      state = dispatch(state, { type: 'endTurn', player: 'red' }, data).state;
      state = dispatch(state, { type: 'endTurn', player: 'blue' }, data).state;
    }
    expect(built.slice(0, 10)).toEqual([
      'tavern',
      'town_hall',
      'marketplace',
      'blacksmith',
      'mage_guild_1',
      'city_hall',
      'fort',
      'citadel',
      'castle',
      'capitol',
    ]);
  });

  it('recruits everything affordable to the visiting hero', () => {
    let state = newGame(tinyMap, { startingResources: richResources }, 3, data);
    // hand-build the tier-1 dwelling so the pool is non-empty
    for (const building of ['fort', 'castle_dwelling_1']) {
      state = dispatch(state, { type: 'build', player: 'red', town: 'town-2-2', building }, data)
        .state;
      const town = state.towns['town-2-2'];
      if (!town) throw new Error('red town missing');
      town.builtToday = false;
    }
    const before = armyPower(state.heroes.edric?.army ?? [], data);
    let command = chooseRecruitCommand(state, 'red', data);
    let guard = 0;
    while (command && guard++ < 10) {
      state = dispatch(state, command, data).state;
      command = chooseRecruitCommand(state, 'red', data);
    }
    expect(state.towns['town-2-2']?.availableCreatures.pikeman).toBe(0);
    expect(armyPower(state.heroes.edric?.army ?? [], data)).toBeGreaterThan(before);
  });

  it('caps recruit counts by both pool and resources', () => {
    expect(maxAffordable({ gold: 1000 }, { gold: 60 }, 99)).toBe(16);
    expect(maxAffordable({ gold: 100000 }, { gold: 60 }, 14)).toBe(14);
    expect(maxAffordable({ gold: 30 }, { gold: 60 }, 14)).toBe(0);
  });
});

describe('full AI games', () => {
  it('beats an idle player on the tiny map within 4 weeks', () => {
    let state = newGame(tinyMap, {}, 21, data);
    let commands = 0;
    while (state.status === 'running' && state.day <= 28) {
      if (commands++ > 20000) throw new Error('AI game did not progress');
      const idleRedTurn =
        state.currentPlayer === 'red' &&
        state.combat === null &&
        state.pendingChoices.length === 0;
      const command: Command = idleRedTurn
        ? { type: 'endTurn', player: 'red' }
        : nextAiDrivenCommand(state);
      state = dispatch(state, command, data).state;
    }
    expect(state.status).toEqual({ winner: 'blue' });
    expect(state.day).toBeLessThanOrEqual(28);
  });

  it('terminates an AI-vs-AI game on the tiny map in under 3 months', () => {
    let state = newGame(tinyMap, {}, 9, data);
    let commands = 0;
    const events: GameEvent[] = [];
    while (state.status === 'running') {
      if (commands++ > 40000) throw new Error('AI-vs-AI game looks hung');
      if (state.day >= 84) throw new Error('AI-vs-AI game exceeded 3 months');
      const result = dispatch(state, nextAiDrivenCommand(state), data);
      state = result.state;
      events.push(...result.events);
    }
    expect(typeof state.status === 'object' && 'winner' in state.status).toBe(true);
    expect(state.day).toBeLessThan(84);
    expect(events.some((e) => e.type === 'gameOver')).toBe(true);
  });
});
