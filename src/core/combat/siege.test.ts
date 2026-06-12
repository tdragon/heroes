import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data';
import { rollChance, seedRng } from '../rng';
import {
  activeCombatStack,
  combatAct,
  createCombat,
  reachableHexesFor,
  type CombatAction,
  type CombatArmyStack,
  type CombatEvent,
} from './engine';
import { computeDamage, rollBaseDamage } from './damage';
import { bfsReachable, hexDistance, type Hex } from './grid';
import {
  createSiege,
  GATE_ROW,
  MOAT_DAMAGE,
  MOAT_X,
  siegeLevelFromBuildings,
  WALL_X,
  wallsBreached,
  type SiegeLevel,
} from './siege';
import {
  getCombatStack,
  livingStacks,
  noHero,
  oppositeSide,
  type CombatHeroInfo,
  type CombatState,
} from './state';

const data = loadGameData();

interface MakeOptions {
  attackerHero?: Partial<CombatHeroInfo>;
  defenderHero?: Partial<CombatHeroInfo>;
  seed?: number;
}

function makeSiege(
  level: SiegeLevel,
  attacker: CombatArmyStack[],
  defender: CombatArmyStack[],
  opts: MakeOptions = {},
): { combat: CombatState; events: CombatEvent[] } {
  return createCombat(
    {
      attacker: { hero: { ...noHero(), ...opts.attackerHero }, stacks: attacker },
      defender: { hero: { ...noHero(), ...opts.defenderHero }, stacks: defender },
      rng: seedRng(opts.seed ?? 42),
      siege: level,
    },
    data,
  );
}

const GATE_INDEX = 3;

describe('siege construction', () => {
  it('derives the siege level from town buildings', () => {
    expect(siegeLevelFromBuildings(['village_hall'])).toBeNull();
    expect(siegeLevelFromBuildings(['fort'])).toBe('fort');
    expect(siegeLevelFromBuildings(['fort', 'citadel'])).toBe('citadel');
    expect(siegeLevelFromBuildings(['fort', 'citadel', 'castle'])).toBe('castle');
  });

  it('builds walls, towers, and moat per level', () => {
    const fort = createSiege('fort');
    expect(fort.segments).toHaveLength(4);
    expect(fort.segments.filter((s) => s.isGate)).toHaveLength(1);
    expect(fort.segments.every((s) => s.pos.x === WALL_X)).toBe(true);
    expect(fort.towers).toHaveLength(0);
    expect(fort.moat).toHaveLength(0);
    expect(wallsBreached(fort)).toBe(false);

    const citadel = createSiege('citadel');
    expect(citadel.towers).toHaveLength(1);
    expect(citadel.moat.every((m) => m.x === MOAT_X)).toBe(true);
    expect(citadel.moat.length).toBeGreaterThan(0);

    const castle = createSiege('castle');
    expect(castle.towers).toHaveLength(3);
  });

  it('siege battles get no random obstacles', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'pikeman', count: 1 }],
      [{ creature: 'skeleton', count: 1 }],
    );
    expect(combat.obstacles).toEqual([]);
    expect(combat.siege?.level).toBe('fort');
  });
});

describe('walls and movement', () => {
  it('walls block attacker ground movement; the gate opens only for defenders', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'angel', count: 1 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    const walker = getCombatStack(combat, 'd0');
    walker.pos = { x: 12, y: GATE_ROW };
    // defender may walk out through the gate hex
    const defenderReach = reachableHexesFor(combat, 'd0', data);
    expect(defenderReach.some((h) => h.x < WALL_X)).toBe(true);

    const attacker = getCombatStack(combat, 'a0');
    attacker.pos = { x: 8, y: GATE_ROW };
    // flying attacker crosses the wall but cannot land on it
    const flyReach = reachableHexesFor(combat, 'a0', data);
    expect(flyReach.some((h) => h.x > WALL_X)).toBe(true);
    expect(flyReach.some((h) => h.x === WALL_X)).toBe(false);
  });

  it('ground attackers cannot pass the wall until the gate falls', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    const pikemen = getCombatStack(combat, 'a0');
    pikemen.pos = { x: 9, y: GATE_ROW };
    expect(reachableHexesFor(combat, 'a0', data).every((h) => h.x < WALL_X)).toBe(true);

    const gate = combat.siege?.segments[GATE_INDEX];
    if (!gate) throw new Error('missing gate');
    gate.hp = 0;
    const reach = reachableHexesFor(combat, 'a0', data);
    expect(reach.some((h) => h.x === WALL_X && h.y === GATE_ROW)).toBe(true);
    expect(reach.some((h) => h.x > WALL_X)).toBe(true);
  });

  it('melee can batter the gate down, but not the wall segments', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    const pikemen = getCombatStack(combat, 'a0');
    pikemen.pos = { x: 9, y: GATE_ROW };
    while (activeCombatStack(combat)?.id !== 'a0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    expect(() =>
      combatAct(combat, { type: 'attackWall', segment: 0, from: { x: 9, y: 1 } }, data),
    ).toThrow('only the gate');

    const hit = (): CombatEvent[] => {
      while (activeCombatStack(combat)?.id !== 'a0') {
        combatAct(combat, { type: 'defend' }, data);
      }
      return combatAct(
        combat,
        { type: 'attackWall', segment: GATE_INDEX, from: { x: 9, y: GATE_ROW } },
        data,
      );
    };
    const first = hit();
    expect(first).toContainEqual({
      type: 'wallHit',
      segment: GATE_INDEX,
      damage: 1,
      hp: 1,
      source: 'melee',
    });
    const second = hit();
    expect(second).toContainEqual({
      type: 'wallHit',
      segment: GATE_INDEX,
      damage: 1,
      hp: 0,
      source: 'melee',
    });
    expect(combat.siege?.segments[GATE_INDEX]).toMatchObject({ hp: 0 });
  });

  it('moat hexes can be entered but not passed through', () => {
    const stops: Hex[] = Array.from({ length: 11 }, (_, y) => ({ x: 1, y }));
    const reach = bfsReachable(
      { x: 0, y: 5 },
      4,
      () => true,
      (h) => stops.some((s) => s.x === h.x && s.y === h.y),
    );
    expect(reach.some((h) => h.x === 1)).toBe(true);
    expect(reach.some((h) => h.x >= 2)).toBe(false);
  });
});

describe('catapult, towers, and moat', () => {
  it('catapult hits a random standing wall segment at round start', () => {
    // across seeds, the catapult connects roughly half the time
    let hits = 0;
    const samples = 200;
    for (let seed = 0; seed < samples; seed++) {
      const { events } = makeSiege(
        'fort',
        [{ creature: 'pikeman', count: 1 }],
        [{ creature: 'walking_dead', count: 1 }],
        { seed },
      );
      const wallHits = events.filter((e) => e.type === 'wallHit' && e.source === 'catapult');
      if (wallHits.length > 0) {
        hits += 1;
        const hit = wallHits[0];
        if (hit?.type === 'wallHit') {
          expect(hit.segment).toBeGreaterThanOrEqual(0);
          expect(hit.segment).toBeLessThan(GATE_INDEX); // never the gate
          expect(hit.hp).toBe(1);
        }
      }
    }
    expect(hits / samples).toBeGreaterThan(0.4);
    expect(hits / samples).toBeLessThan(0.6);
  });

  it('keep tower shoots the nearest attacker each round; castle has three towers', () => {
    const { combat, events } = makeSiege(
      'citadel',
      [{ creature: 'pikeman', count: 20 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    const shots = events.filter((e) => e.type === 'towerShot');
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ target: 'a0' });
    expect(getCombatStack(combat, 'a0').count).toBeLessThan(20);

    const castle = makeSiege(
      'castle',
      [{ creature: 'pikeman', count: 50 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    expect(castle.events.filter((e) => e.type === 'towerShot')).toHaveLength(3);
  });

  it('standing in the moat deals damage at round start', () => {
    const { combat } = makeSiege(
      'citadel',
      [{ creature: 'angel', count: 2 }],
      [{ creature: 'walking_dead', count: 1 }],
    );
    const angels = getCombatStack(combat, 'a0');
    angels.pos = { x: MOAT_X, y: 2 };
    const poolBefore = angels.firstHp + (angels.count - 1) * 200;
    const all: CombatEvent[] = [];
    let guard = 0;
    while (!all.some((e) => e.type === 'roundStarted' && e.round === 2)) {
      guard += 1;
      if (guard > 10) throw new Error('round 2 never started');
      all.push(...combatAct(combat, { type: 'defend' }, data));
    }
    expect(all).toContainEqual({ type: 'moatDamage', stack: 'a0', damage: MOAT_DAMAGE });
    // the round-2 keep tower shot also hits; the rest of the drop is the moat
    const towerDamage = all
      .filter((e) => e.type === 'towerShot' && e.target === 'a0')
      .reduce((sum, e) => (e.type === 'towerShot' ? sum + e.damage : sum), 0);
    const poolAfter = angels.firstHp + (angels.count - 1) * 200;
    expect(poolBefore - poolAfter).toBe(MOAT_DAMAGE + towerDamage);
  });
});

describe('shooting through walls', () => {
  it('attacker shots through standing walls are halved; defenders shoot freely', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'archer', count: 10 }],
      [{ creature: 'lich', count: 5 }],
    );
    const archers = getCombatStack(combat, 'a0');
    archers.pos = { x: 5, y: 5 };
    const liches = getCombatStack(combat, 'd0');
    liches.pos = { x: 12, y: 5 };

    // replicate the engine's roll to predict the damage
    while (activeCombatStack(combat)?.id !== 'a0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    const archer = data.creatures.archer;
    const lich = data.creatures.lich;
    if (!archer || !lich) throw new Error('missing creatures');
    const [base] = rollBaseDamage(combat.rngState, archer.dmgMin, archer.dmgMax, archers.count);
    const expected = computeDamage({
      base,
      attack: archer.attack,
      defense: Math.floor(lich.defense * 1.2), // the lich defended on its turn
      ranged: true,
      wallPenalty: true,
    }).total;
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    const attack = events.find((e) => e.type === 'stackAttacked');
    expect(attack?.type === 'stackAttacked' && attack.damage).toBe(expected);

    // defender lich shoots out without a wall penalty
    while (activeCombatStack(combat)?.id !== 'd0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    const [lichBase, afterBase] = rollBaseDamage(
      combat.rngState,
      lich.dmgMin,
      lich.dmgMax,
      liches.count,
    );
    void afterBase;
    const lichExpected = computeDamage({
      base: lichBase,
      attack: lich.attack,
      defense: archer.defense,
      ranged: true,
      distancePenalty: hexDistance(liches.pos, archers.pos) > 10,
    }).total;
    const lichEvents = combatAct(combat, { type: 'shoot', target: 'a0' }, data);
    const lichAttack = lichEvents.find((e) => e.type === 'stackAttacked');
    expect(lichAttack?.type === 'stackAttacked' && lichAttack.damage).toBe(lichExpected);
  });

  it('no penalty once every wall segment and the gate are down', () => {
    const { combat } = makeSiege(
      'fort',
      [{ creature: 'archer', count: 10 }],
      [{ creature: 'walking_dead', count: 30 }],
    );
    const siege = combat.siege;
    if (!siege) throw new Error('missing siege');
    for (const segment of siege.segments) segment.hp = 0;
    expect(wallsBreached(siege)).toBe(true);

    const archers = getCombatStack(combat, 'a0');
    archers.pos = { x: 5, y: 5 };
    getCombatStack(combat, 'd0').pos = { x: 12, y: 5 };
    while (activeCombatStack(combat)?.id !== 'a0') {
      combatAct(combat, { type: 'defend' }, data);
    }
    const archer = data.creatures.archer;
    const dead = data.creatures.walking_dead;
    if (!archer || !dead) throw new Error('missing creatures');
    const [base] = rollBaseDamage(combat.rngState, archer.dmgMin, archer.dmgMax, archers.count);
    const expected = computeDamage({
      base,
      attack: archer.attack,
      defense: dead.defense,
      ranged: true,
    }).total;
    const events = combatAct(combat, { type: 'shoot', target: 'd0' }, data);
    const attack = events.find((e) => e.type === 'stackAttacked');
    expect(attack?.type === 'stackAttacked' && attack.damage).toBe(expected);
  });
});

describe('full siege battle', () => {
  function autoPlay(combat: CombatState): CombatEvent[] {
    const all: CombatEvent[] = [];
    let guard = 0;
    while (combat.winner === null) {
      guard += 1;
      if (guard > 1000) throw new Error('siege did not terminate');
      const stack = activeCombatStack(combat);
      if (!stack) throw new Error('no active stack');
      const creature = data.creatures[stack.creature];
      if (!creature) throw new Error('unknown creature');
      const enemies = livingStacks(combat, oppositeSide(stack.side));
      const nearest = enemies.reduce((best, e) =>
        hexDistance(stack.pos, e.pos) < hexDistance(stack.pos, best.pos) ? e : best,
      );
      const adjacent = enemies.find((e) => hexDistance(stack.pos, e.pos) === 1);
      let action: CombatAction;
      if (creature.shots !== undefined && stack.shots > 0 && !adjacent) {
        action = { type: 'shoot', target: nearest.id };
      } else if (adjacent) {
        action = { type: 'melee', target: adjacent.id, from: stack.pos };
      } else {
        const reachable = reachableHexesFor(combat, stack.id, data);
        const attackFrom = reachable.find((h) => hexDistance(h, nearest.pos) === 1);
        if (attackFrom) {
          action = { type: 'melee', target: nearest.id, from: attackFrom };
        } else {
          let best: Hex | null = null;
          let bestDistance = hexDistance(stack.pos, nearest.pos);
          for (const hex of reachable) {
            const d = hexDistance(hex, nearest.pos);
            if (d < bestDistance) {
              bestDistance = d;
              best = hex;
            }
          }
          action = best ? { type: 'move', to: best } : { type: 'defend' };
        }
      }
      all.push(...combatAct(combat, action, data));
    }
    return all;
  }

  it('plays a castle siege to the end deterministically', () => {
    const battle = () =>
      makeSiege(
        'castle',
        [
          { creature: 'angel', count: 6 },
          { creature: 'marksman', count: 30 },
        ],
        [
          { creature: 'skeleton', count: 40 },
          { creature: 'lich', count: 8 },
        ],
        { seed: 7 },
      ).combat;
    const a = battle();
    const b = battle();
    autoPlay(a);
    autoPlay(b);
    expect(a.winner).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('matches the siege replay snapshot', () => {
    const { combat } = makeSiege(
      'castle',
      [
        { creature: 'angel', count: 6 },
        { creature: 'marksman', count: 30 },
      ],
      [
        { creature: 'skeleton', count: 40 },
        { creature: 'lich', count: 8 },
      ],
      { seed: 7 },
    );
    const events = autoPlay(combat);
    const summary = {
      winner: combat.winner,
      rounds: combat.round,
      attacks: events.filter((e) => e.type === 'stackAttacked').length,
      towerShots: events.filter((e) => e.type === 'towerShot').length,
      wallHits: events.filter((e) => e.type === 'wallHit').length,
      walls: combat.siege?.segments.map((s) => s.hp),
      survivors: combat.stacks
        .filter((s) => s.count > 0)
        .map((s) => ({ id: s.id, creature: s.creature, count: s.count })),
    };
    expect(summary).toMatchSnapshot();
  });
});

describe('catapult luck', () => {
  it('can deal 2 damage with positive attacker luck', () => {
    // find a seed where the catapult hits for 2 with luck 3
    let found = false;
    for (let seed = 0; seed < 300 && !found; seed++) {
      const { events } = makeSiege(
        'fort',
        [{ creature: 'pikeman', count: 1 }],
        [{ creature: 'walking_dead', count: 1 }],
        { seed, attackerHero: { luck: 3 } },
      );
      found = events.some((e) => e.type === 'wallHit' && e.damage === 2 && e.hp === 0);
    }
    expect(found).toBe(true);
    // sanity: rollChance with luck 3/24 fires sometimes
    const [fires] = rollChance(seedRng(1), 3 / 24);
    expect(typeof fires).toBe('boolean');
  });
});
