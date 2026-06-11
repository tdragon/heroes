import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap, type MapSource } from '../maps/dsl';
import type { Pos } from '../maps/schema';
import { CommandRejectedError, dispatch, type GameEvent } from './commands';
import {
  applyWeeklyObjectResets,
  guardStrengthText,
  handleObjectTrigger,
  liveGuard,
  MAX_HEROES,
  resolveObjectChoice,
} from './objects';
import { dailyIncome } from './turn';
import { newGame, townIdAt } from './setup';
import {
  isExplored,
  type GameState,
  type Hero,
  type MapObjectState,
  type PendingChoice,
} from './state';

const data = loadGameData();

const SIZE = 16;
const objectParkSource: MapSource = {
  id: 'object-park',
  name: 'Object Park',
  terrain: Array.from({ length: SIZE }, () => 'g'.repeat(SIZE)),
  players: [
    { color: 'red', faction: 'castle', isHuman: true, startTownAt: [2, 2], startHero: 'edric' },
    {
      color: 'blue',
      faction: 'necropolis',
      isHuman: false,
      startTownAt: [13, 13],
      startHero: 'mortus',
    },
  ],
  objects: [
    { type: 'town', at: [2, 2], owner: 'red' },
    { type: 'town', at: [13, 13], owner: 'blue' },
    { type: 'mine', subtype: 'sawmill', at: [5, 1] },
    { type: 'mine', subtype: 'ore_pit', at: [7, 1], guard: { creature: 'wolf', count: 4 } },
    { type: 'dwelling', creature: 'wolf', at: [9, 1] },
    { type: 'resource', subtype: 'wood', amount: 6, at: [11, 1] },
    { type: 'resource', subtype: 'gold', amount: 600, at: [13, 1] },
    { type: 'resource', subtype: 'ore', amount: 5, at: [4, 3] },
    { type: 'treasure_chest', at: [1, 4] },
    { type: 'artifact', artifact: 'iron_sword', at: [3, 4] },
    { type: 'monster', creature: 'wolf', count: 6, at: [5, 4] },
    { type: 'windmill', at: [7, 4] },
    { type: 'water_wheel', at: [9, 4] },
    { type: 'mystical_garden', at: [11, 4] },
    { type: 'magic_well', at: [13, 4] },
    { type: 'fountain_of_fortune', at: [1, 6] },
    { type: 'rally_flag', at: [3, 6] },
    { type: 'learning_stone', at: [5, 6] },
    { type: 'school_of_war', at: [7, 6] },
    { type: 'observatory', at: [9, 6] },
    { type: 'sign', message: 'beware of wolves', at: [11, 6] },
    { type: 'monolith', pairId: 'm1', at: [13, 6] },
    { type: 'monolith', pairId: 'm1', at: [1, 8] },
    { type: 'prison', hero: 'gareth', at: [3, 8] },
    { type: 'obelisk', at: [5, 8] },
  ],
};
const parkMap = compileMap(objectParkSource, data);

function makeGame(seed = 7): GameState {
  return newGame(parkMap, {}, seed, data);
}

function findObject(state: GameState, type: string, at?: Pos): MapObjectState {
  const obj = state.map.objects.find(
    (o) => o.type === type && (at === undefined || (o.at[0] === at[0] && o.at[1] === at[1])),
  );
  if (!obj) throw new Error(`fixture object not found: ${type}`);
  return obj;
}

function getHero(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) throw new Error(`missing hero ${id}`);
  return hero;
}

function visit(state: GameState, heroId: string, type: string, at?: Pos): GameEvent[] {
  const events: GameEvent[] = [];
  handleObjectTrigger(state, getHero(state, heroId), findObject(state, type, at).id, data, events);
  return events;
}

function lastChoice(state: GameState): PendingChoice {
  const choice = state.pendingChoices[state.pendingChoices.length - 1];
  if (!choice) throw new Error('no pending choice');
  return choice;
}

function resolveLast(state: GameState, option: number): GameEvent[] {
  const events: GameEvent[] = [];
  const choice = lastChoice(state);
  state.pendingChoices = state.pendingChoices.filter((c) => c.id !== choice.id);
  resolveObjectChoice(state, choice, option, data, events);
  return events;
}

describe('pickups', () => {
  it('adds a resource pile to player resources and removes the object', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'resource', [11, 1]);
    expect(state.players[0]?.resources.wood).toBe(26);
    expect(findObject(state, 'resource', [11, 1]).removed).toBe(true);
    expect(events).toContainEqual({
      type: 'resourcesGained',
      player: 'red',
      amounts: { wood: 6 },
      source: findObject(state, 'resource', [11, 1]).id,
    });
    expect(events).toContainEqual({
      type: 'objectRemoved',
      object: findObject(state, 'resource', [11, 1]).id,
    });
  });

  it('picks up gold piles', () => {
    const state = makeGame();
    visit(state, 'edric', 'resource', [13, 1]);
    expect(state.players[0]?.resources.gold).toBe(20600);
  });

  it('picks up a resource through the moveHero command', () => {
    const state = makeGame();
    const result = dispatch(
      state,
      {
        type: 'moveHero',
        player: 'red',
        hero: 'edric',
        path: [
          [3, 3],
          [4, 3],
        ],
      },
      data,
    );
    expect(result.state.players[0]?.resources.ore).toBe(25);
    expect(result.state.heroes.edric?.pos).toEqual([4, 3]);
    expect(result.events.some((e) => e.type === 'resourcesGained')).toBe(true);
  });

  it('puts a map artifact into the hero backpack and removes it', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'artifact');
    expect(getHero(state, 'edric').backpack).toContain('iron_sword');
    expect(findObject(state, 'artifact').removed).toBe(true);
    expect(events).toContainEqual({ type: 'artifactPickedUp', hero: 'edric', artifact: 'iron_sword' });
  });
});

describe('treasure chest', () => {
  it('offers a gold-or-xp choice with rolled tier amounts', () => {
    const state = makeGame();
    visit(state, 'edric', 'treasure_chest');
    const choice = lastChoice(state);
    expect(choice.kind).toBe('chest');
    expect(choice.options).toHaveLength(2);
    const gold = Number(choice.options[0]?.split(':')[1]);
    const xp = Number(choice.options[1]?.split(':')[1]);
    expect([1000, 1500, 2000]).toContain(gold);
    expect([500, 1000, 1500]).toContain(xp);
  });

  it('grants gold and removes the chest when gold is picked', () => {
    const state = makeGame();
    visit(state, 'edric', 'treasure_chest');
    const gold = Number(lastChoice(state).options[0]?.split(':')[1]);
    resolveLast(state, 0);
    expect(state.players[0]?.resources.gold).toBe(20000 + gold);
    expect(findObject(state, 'treasure_chest').removed).toBe(true);
  });

  it('grants experience when xp is picked', () => {
    const state = makeGame();
    visit(state, 'edric', 'treasure_chest');
    const xp = Number(lastChoice(state).options[1]?.split(':')[1]);
    resolveLast(state, 1);
    expect(getHero(state, 'edric').xp).toBe(xp);
  });

  it('resolves the chest through the dispatch command flow', () => {
    const state = makeGame();
    const moved = dispatch(
      state,
      {
        type: 'moveHero',
        player: 'red',
        hero: 'edric',
        path: [
          [1, 3],
          [1, 4],
        ],
      },
      data,
    );
    const choice = moved.state.pendingChoices[0];
    expect(choice?.kind).toBe('chest');
    const gold = Number(choice?.options[0]?.split(':')[1]);
    const resolved = dispatch(
      moved.state,
      { type: 'resolveChoice', player: 'red', choiceId: choice?.id ?? '', option: 0 },
      data,
    );
    expect(resolved.state.players[0]?.resources.gold).toBe(20000 + gold);
    expect(resolved.state.pendingChoices).toHaveLength(0);
  });
});

describe('flaggables', () => {
  it('flags an unguarded mine and pays income', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'mine', [5, 1]);
    const mine = findObject(state, 'mine', [5, 1]);
    expect(mine.owner).toBe('red');
    expect(events).toContainEqual({ type: 'objectFlagged', object: mine.id, player: 'red' });
    expect(dailyIncome(state, 'red', data).wood).toBe(2);
  });

  it('revisiting an own mine changes nothing', () => {
    const state = makeGame();
    visit(state, 'edric', 'mine', [5, 1]);
    const events = visit(state, 'edric', 'mine', [5, 1]);
    expect(events).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'mine', [5, 1]).id,
      effect: false,
    });
  });

  it('flags an external dwelling and grows its pool weekly', () => {
    const state = makeGame();
    visit(state, 'edric', 'dwelling');
    const dwelling = findObject(state, 'dwelling');
    expect(dwelling.owner).toBe('red');
    state.day = 8;
    applyWeeklyObjectResets(state, data);
    expect(dwelling.count).toBe(8); // wolf growth
    state.day = 15;
    applyWeeklyObjectResets(state, data);
    expect(dwelling.count).toBe(16);
  });
});

describe('guards', () => {
  it('describes guard strength by count band', () => {
    const text = (count: number): string =>
      guardStrengthText({ creature: 'wolf', count }, data);
    expect(text(3)).toBe('A few of Wolfs');
    expect(text(7)).toBe('Several of Wolfs');
    expect(text(12)).toBe('A pack of Wolfs');
    expect(text(30)).toBe('Lots of Wolfs');
    expect(text(60)).toBe('A horde of Wolfs');
    expect(text(150)).toBe('A throng of Wolfs');
    expect(text(300)).toBe('A swarm of Wolfs');
    expect(text(700)).toBe('Zounds of Wolfs');
    expect(text(1200)).toBe('A legion of Wolfs');
  });

  it('offers an attack-confirm choice with a strength estimate for guarded objects', () => {
    const state = makeGame();
    visit(state, 'edric', 'mine', [7, 1]);
    const choice = lastChoice(state);
    expect(choice.kind).toBe('guardAttack');
    expect(choice.message).toBe('A few of Wolfs — would you like to attack?');
    expect(choice.options).toEqual(['attack', 'retreat']);
    expect(findObject(state, 'mine', [7, 1]).owner).toBeNull();
  });

  it('retreat leaves the guard and the object untouched', () => {
    const state = makeGame();
    visit(state, 'edric', 'mine', [7, 1]);
    resolveLast(state, 1);
    const mine = findObject(state, 'mine', [7, 1]);
    expect(mine.owner).toBeNull();
    expect(mine.guard?.count).toBe(4);
    expect(state.combat).toBeNull();
  });

  it('attack starts a real combat against the guard', () => {
    const state = makeGame();
    visit(state, 'edric', 'mine', [7, 1]);
    const events = resolveLast(state, 0);
    expect(state.combat).toMatchObject({ reason: 'guard', attackerHero: 'edric' });
    expect(state.combat?.combat.stacks.some((s) => s.creature === 'wolf')).toBe(true);
    expect(events.some((e) => e.type === 'combatStarted')).toBe(true);
  });

  it('wandering monsters act as their own guard', () => {
    const state = makeGame();
    visit(state, 'edric', 'monster');
    expect(lastChoice(state).kind).toBe('guardAttack');
    expect(liveGuard(findObject(state, 'monster'))).toEqual({ creature: 'wolf', count: 6 });
  });

  it('blocks all commands while a combat is pending', () => {
    const state = makeGame();
    visit(state, 'edric', 'mine', [7, 1]);
    resolveLast(state, 0);
    expect(() => dispatch(state, { type: 'endTurn', player: 'red' }, data)).toThrow(
      CommandRejectedError,
    );
  });

  it('grows guards and monsters by 10% each week', () => {
    const state = makeGame();
    state.day = 8;
    applyWeeklyObjectResets(state, data);
    expect(findObject(state, 'mine', [7, 1]).guard?.count).toBe(5); // ceil(4*1.1)
    expect(findObject(state, 'monster').count).toBe(7); // ceil(6*1.1)
  });

  it('does not grow guards mid-week', () => {
    const state = makeGame();
    state.day = 5;
    applyWeeklyObjectResets(state, data);
    expect(findObject(state, 'mine', [7, 1]).guard?.count).toBe(4);
  });
});

describe('visitables', () => {
  it('windmill grants 3-6 of a rare resource once per week', () => {
    const state = makeGame();
    const before = { ...state.players[0]?.resources } as Record<string, number>;
    visit(state, 'edric', 'windmill');
    const after = state.players[0]?.resources ?? before;
    const gained = (['mercury', 'sulfur', 'crystal', 'gems'] as const)
      .map((id) => after[id] - (before[id] ?? 0))
      .reduce((a, b) => a + b, 0);
    expect(gained).toBeGreaterThanOrEqual(3);
    expect(gained).toBeLessThanOrEqual(6);

    const again = visit(state, 'edric', 'windmill');
    expect(again).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'windmill').id,
      effect: false,
    });

    state.day = 8;
    applyWeeklyObjectResets(state, data);
    const events = visit(state, 'edric', 'windmill');
    expect(events.some((e) => e.type === 'resourcesGained')).toBe(true);
  });

  it('water wheel pays 1000 gold in week 1 and 500 later', () => {
    const first = makeGame();
    visit(first, 'edric', 'water_wheel');
    expect(first.players[0]?.resources.gold).toBe(21000);

    const later = makeGame();
    later.day = 9;
    visit(later, 'edric', 'water_wheel');
    expect(later.players[0]?.resources.gold).toBe(20500);
  });

  it('mystical garden grants 500 gold or 5 gems', () => {
    const state = makeGame();
    visit(state, 'edric', 'mystical_garden');
    const player = state.players[0];
    const goldGain = (player?.resources.gold ?? 0) - 20000;
    const gemGain = (player?.resources.gems ?? 0) - 5;
    expect([goldGain, gemGain]).toContainEqual(goldGain === 500 ? 500 : 5);
    expect(goldGain === 500 || gemGain === 5).toBe(true);
    expect(goldGain === 500 && gemGain === 5).toBe(false);
  });

  it('magic well refills mana once per hero per day and resets at dawn', () => {
    const state = makeGame();
    const hero = getHero(state, 'edric');
    hero.mana = 0;
    visit(state, 'edric', 'magic_well');
    const full = hero.mana;
    expect(full).toBeGreaterThan(0);

    hero.mana = 1;
    const repeat = visit(state, 'edric', 'magic_well');
    expect(hero.mana).toBe(1);
    expect(repeat).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'magic_well').id,
      effect: false,
    });

    const afterRed = dispatch(state, { type: 'endTurn', player: 'red' }, data).state;
    const nextDay = dispatch(afterRed, { type: 'endTurn', player: 'blue' }, data).state;
    expect(findObject(nextDay, 'magic_well').visitedBy).toEqual([]);
    getHero(nextDay, 'edric').mana = 0;
    visit(nextDay, 'edric', 'magic_well');
    expect(getHero(nextDay, 'edric').mana).toBe(full);
  });

  it('fountain of fortune grants +1..3 luck until next battle', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'fountain_of_fortune');
    const luck = getHero(state, 'edric').tempLuck;
    expect(luck).toBeGreaterThanOrEqual(1);
    expect(luck).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.type === 'blessingGained')).toBe(true);
  });

  it('rally flag grants +1 morale and +1 luck', () => {
    const state = makeGame();
    visit(state, 'edric', 'rally_flag');
    const hero = getHero(state, 'edric');
    expect(hero.tempLuck).toBeGreaterThanOrEqual(1);
    expect(hero.tempMorale).toBe(1);
  });

  it('learning stone grants 1000 xp once per hero', () => {
    const state = makeGame();
    visit(state, 'edric', 'learning_stone');
    expect(getHero(state, 'edric').xp).toBe(1000);
    expect(getHero(state, 'edric').level).toBe(2);
    expect(state.pendingChoices.some((c) => c.kind === 'levelUp')).toBe(true);

    const repeat = visit(state, 'edric', 'learning_stone');
    expect(getHero(state, 'edric').xp).toBe(1000);
    expect(repeat).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'learning_stone').id,
      effect: false,
    });

    visit(state, 'mortus', 'learning_stone');
    expect(getHero(state, 'mortus').xp).toBe(1000);
  });

  it('school of war trains +1 attack for 1000 gold, once per hero', () => {
    const state = makeGame();
    const attackBefore = getHero(state, 'edric').attack;
    visit(state, 'edric', 'school_of_war');
    expect(lastChoice(state).kind).toBe('schoolOfWar');
    const events = resolveLast(state, 0);
    expect(getHero(state, 'edric').attack).toBe(attackBefore + 1);
    expect(state.players[0]?.resources.gold).toBe(19000);
    expect(events).toContainEqual({ type: 'statTrained', hero: 'edric', stat: 'attack' });

    const repeat = visit(state, 'edric', 'school_of_war');
    expect(repeat).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'school_of_war').id,
      effect: false,
    });
  });

  it('school of war defense and decline branches', () => {
    const state = makeGame();
    visit(state, 'edric', 'school_of_war');
    resolveLast(state, 2); // decline
    expect(state.players[0]?.resources.gold).toBe(20000);

    visit(state, 'edric', 'school_of_war'); // declining does not consume the visit
    const defenseBefore = getHero(state, 'edric').defense;
    resolveLast(state, 1);
    expect(getHero(state, 'edric').defense).toBe(defenseBefore + 1);
  });

  it('school of war rejects visitors who cannot pay', () => {
    const state = makeGame();
    const player = state.players[0];
    if (!player) throw new Error('missing red player');
    player.resources.gold = 500;
    const events = visit(state, 'edric', 'school_of_war');
    expect(state.pendingChoices).toHaveLength(0);
    expect(events.some((e) => e.type === 'messageShown')).toBe(true);
  });

  it('observatory reveals a 20-tile radius once', () => {
    const state = makeGame();
    const red = state.players[0];
    if (!red) throw new Error('missing red player');
    expect(isExplored(red, SIZE, [15, 15])).toBe(false);
    visit(state, 'edric', 'observatory');
    expect(isExplored(red, SIZE, [15, 15])).toBe(true);
    const repeat = visit(state, 'edric', 'observatory');
    expect(repeat).toContainEqual({
      type: 'objectVisited',
      hero: 'edric',
      object: findObject(state, 'observatory').id,
      effect: false,
    });
  });
});

describe('special objects', () => {
  it('sign shows its message', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'sign');
    expect(events).toContainEqual({
      type: 'messageShown',
      object: findObject(state, 'sign').id,
      message: 'beware of wolves',
    });
  });

  it('obelisk shows a stub message once', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'obelisk');
    expect(events).toContainEqual({
      type: 'messageShown',
      object: findObject(state, 'obelisk').id,
      message: '?',
    });
    const repeat = visit(state, 'edric', 'obelisk');
    expect(repeat.some((e) => e.type === 'messageShown')).toBe(false);
  });

  it('monolith teleports the hero to its pair and reveals fog there', () => {
    const state = makeGame();
    const hero = getHero(state, 'edric');
    hero.pos = [13, 6];
    const events = visit(state, 'edric', 'monolith', [13, 6]);
    expect(hero.pos).toEqual([1, 8]);
    expect(events).toContainEqual({
      type: 'heroTeleported',
      hero: 'edric',
      from: [13, 6],
      to: [1, 8],
    });
    const red = state.players[0];
    if (!red) throw new Error('missing red player');
    expect(isExplored(red, SIZE, [1, 8])).toBe(true);
  });

  it('monolith does nothing when the exit is occupied', () => {
    const state = makeGame();
    getHero(state, 'mortus').pos = [1, 8];
    const hero = getHero(state, 'edric');
    hero.pos = [13, 6];
    const events = visit(state, 'edric', 'monolith', [13, 6]);
    expect(hero.pos).toEqual([13, 6]);
    expect(events.some((e) => e.type === 'heroTeleported')).toBe(false);
  });

  it('prison frees the stored hero next to it and removes the prison', () => {
    const state = makeGame();
    const events = visit(state, 'edric', 'prison');
    const freed = state.heroes.gareth;
    expect(freed).toBeDefined();
    expect(freed?.owner).toBe('red');
    expect(freed?.pos).toEqual([3, 7]);
    expect(state.players[0]?.heroes).toContain('gareth');
    expect(findObject(state, 'prison').removed).toBe(true);
    expect(events).toContainEqual({ type: 'heroReleased', hero: 'gareth', player: 'red' });
  });

  it('prison refuses to release past the hero cap', () => {
    const state = makeGame();
    const red = state.players[0];
    if (!red) throw new Error('missing red player');
    while (red.heroes.length < MAX_HEROES) {
      red.heroes.push(`dummy-${String(red.heroes.length)}`);
    }
    const events = visit(state, 'edric', 'prison');
    expect(state.heroes.gareth).toBeUndefined();
    expect(findObject(state, 'prison').removed).toBe(false);
    expect(events.some((e) => e.type === 'messageShown')).toBe(true);
  });
});

describe('towns', () => {
  it('entering an own town sets the visiting hero', () => {
    const state = makeGame();
    const town = state.towns[townIdAt([2, 2])];
    if (!town) throw new Error('missing red town');
    town.visitingHero = null;
    visit(state, 'edric', 'town', [2, 2]);
    expect(town.visitingHero).toBe('edric');
  });

  it('captures an undefended enemy town and updates both players', () => {
    const state = makeGame();
    const blueTown = state.towns[townIdAt([13, 13])];
    if (!blueTown) throw new Error('missing blue town');
    blueTown.visitingHero = null;
    const events = visit(state, 'edric', 'town', [13, 13]);
    expect(blueTown.owner).toBe('red');
    expect(state.players[0]?.towns).toContain(blueTown.id);
    expect(state.players[1]?.towns).not.toContain(blueTown.id);
    expect(findObject(state, 'town', [13, 13]).owner).toBe('red');
    expect(events).toContainEqual({
      type: 'townCaptured',
      town: blueTown.id,
      player: 'red',
      previousOwner: 'blue',
    });
  });

  it('starts a siege for a defended enemy town', () => {
    const state = makeGame();
    const blueTown = state.towns[townIdAt([13, 13])];
    if (!blueTown) throw new Error('missing blue town');
    blueTown.visitingHero = null;
    blueTown.garrison[0] = { creature: 'skeleton', count: 10 };
    const events = visit(state, 'edric', 'town', [13, 13]);
    expect(blueTown.owner).toBe('blue');
    expect(state.combat).toMatchObject({
      reason: 'siege',
      attackerHero: 'edric',
      defenderHero: null,
      defenderTown: blueTown.id,
    });
    expect(state.combat?.defenderSlots).toEqual([{ source: 'garrison', index: 0 }]);
    expect(events.some((e) => e.type === 'combatStarted')).toBe(true);
  });

  it('starts a siege when an enemy hero is visiting the town', () => {
    const state = makeGame();
    const blueTown = state.towns[townIdAt([13, 13])];
    if (!blueTown) throw new Error('missing blue town');
    const events = visit(state, 'edric', 'town', [13, 13]);
    expect(blueTown.owner).toBe('blue');
    expect(state.combat).toMatchObject({ reason: 'siege', defenderHero: 'mortus' });
    expect(events.some((e) => e.type === 'combatStarted')).toBe(true);
  });
});
