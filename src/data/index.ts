import creaturesJson from './creatures.json';
import skillsJson from './skills.json';
import spellsJson from './spells.json';
import artifactsJson from './artifacts.json';
import buildingsJson from './buildings.json';
import terrainJson from './terrain.json';
import heroesJson from './heroes.json';
import objectsJson from './objects.json';
import castleJson from './factions/castle.json';
import rampartJson from './factions/rampart.json';
import necropolisJson from './factions/necropolis.json';
import {
  ArtifactsFileSchema,
  BuildingsFileSchema,
  CreaturesFileSchema,
  FactionSchema,
  HeroesFileSchema,
  ObjectsFileSchema,
  SkillsFileSchema,
  SpellsFileSchema,
  TerrainFileSchema,
  type Artifact,
  type Building,
  type Creature,
  type Faction,
  type HeroClass,
  type HeroTemplate,
  type ObjectType,
  type Road,
  type Skill,
  type Spell,
  type Terrain,
} from './schema';

export interface GameData {
  creatures: Record<string, Creature>;
  skills: Record<string, Skill>;
  spells: Record<string, Spell>;
  artifacts: Record<string, Artifact>;
  buildings: Record<string, Building>;
  terrains: Record<string, Terrain>;
  roads: Record<string, Road>;
  objectTypes: Record<string, ObjectType>;
  heroClasses: Record<string, HeroClass>;
  heroes: Record<string, HeroTemplate>;
  factions: Record<string, Faction>;
  xpThresholds: number[];
}

function indexById<T extends { id: string }>(items: T[], kind: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) {
    if (item.id in out) {
      throw new Error(`duplicate ${kind} id: ${item.id}`);
    }
    out[item.id] = item;
  }
  return out;
}

function factionBuildings(faction: Faction): Building[] {
  return [...faction.dwellings, ...faction.specialBuildings];
}

function detectPrereqCycle(graph: Map<string, readonly string[]>): string[] {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const errors: string[] = [];

  const visit = (id: string, trail: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`building prereq cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const prereq of graph.get(id) ?? []) {
      if (graph.has(prereq)) visit(prereq, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
  };

  for (const id of graph.keys()) visit(id, []);
  return errors;
}

export function validateCrossReferences(data: GameData): string[] {
  const errors: string[] = [];

  for (const creature of Object.values(data.creatures)) {
    if (creature.upgradeOf !== undefined) {
      const base = data.creatures[creature.upgradeOf];
      if (!base) {
        errors.push(`creature ${creature.id}: upgradeOf ${creature.upgradeOf} does not exist`);
      } else {
        if (base.faction !== creature.faction) {
          errors.push(`creature ${creature.id}: upgrade faction mismatch with ${base.id}`);
        }
        if (base.tier !== creature.tier) {
          errors.push(`creature ${creature.id}: upgrade tier mismatch with ${base.id}`);
        }
      }
    }
  }

  for (const faction of Object.values(data.factions)) {
    const tiers = new Set<number>();
    for (const entry of faction.creatures) {
      tiers.add(entry.tier);
      for (const id of [entry.base, entry.upgrade]) {
        const creature = data.creatures[id];
        if (!creature) {
          errors.push(`faction ${faction.id}: creature ${id} does not exist`);
        } else if (creature.faction !== faction.id) {
          errors.push(`faction ${faction.id}: creature ${id} belongs to ${creature.faction}`);
        }
      }
      const upgrade = data.creatures[entry.upgrade];
      if (upgrade && upgrade.upgradeOf !== entry.base) {
        errors.push(`faction ${faction.id}: ${entry.upgrade} is not an upgrade of ${entry.base}`);
      }
    }
    if (tiers.size !== 7) {
      errors.push(`faction ${faction.id}: creature tiers are not exactly 1..7`);
    }

    const localBuildings = indexById(factionBuildings(faction), `faction ${faction.id} building`);
    for (const building of Object.values(localBuildings)) {
      if (building.id in data.buildings) {
        errors.push(
          `faction ${faction.id}: building ${building.id} collides with a common building`,
        );
      }
      if (building.creature !== undefined && !(building.creature in data.creatures)) {
        errors.push(`building ${building.id}: creature ${building.creature} does not exist`);
      }
      if (building.upgradeOf !== undefined && !(building.upgradeOf in localBuildings)) {
        errors.push(`building ${building.id}: upgradeOf ${building.upgradeOf} does not exist`);
      }
      for (const prereq of building.prereqs) {
        if (!(prereq in data.buildings) && !(prereq in localBuildings)) {
          errors.push(`building ${building.id}: prereq ${prereq} does not exist`);
        }
      }
    }

    const graph = new Map<string, readonly string[]>();
    for (const building of Object.values(data.buildings)) graph.set(building.id, building.prereqs);
    for (const building of Object.values(localBuildings)) graph.set(building.id, building.prereqs);
    errors.push(...detectPrereqCycle(graph).map((e) => `faction ${faction.id}: ${e}`));

    for (const spellId of faction.spellPool) {
      if (!(spellId in data.spells)) {
        errors.push(`faction ${faction.id}: spell ${spellId} does not exist`);
      }
    }

    for (const classId of faction.heroClasses) {
      const heroClass = data.heroClasses[classId];
      if (!heroClass) {
        errors.push(`faction ${faction.id}: hero class ${classId} does not exist`);
      } else if (heroClass.faction !== faction.id) {
        errors.push(`faction ${faction.id}: hero class ${classId} belongs to ${heroClass.faction}`);
      }
    }
  }

  for (const building of Object.values(data.buildings)) {
    for (const prereq of building.prereqs) {
      if (!(prereq in data.buildings)) {
        errors.push(`building ${building.id}: prereq ${prereq} does not exist`);
      }
    }
  }
  const commonGraph = new Map<string, readonly string[]>(
    Object.values(data.buildings).map((b) => [b.id, b.prereqs]),
  );
  errors.push(...detectPrereqCycle(commonGraph));

  for (const heroClass of Object.values(data.heroClasses)) {
    if (!(heroClass.faction in data.factions)) {
      errors.push(`hero class ${heroClass.id}: faction ${heroClass.faction} does not exist`);
    }
    for (const skillId of Object.keys(heroClass.skillWeights)) {
      if (!(skillId in data.skills)) {
        errors.push(`hero class ${heroClass.id}: skill weight for unknown skill ${skillId}`);
      }
    }
  }

  for (const hero of Object.values(data.heroes)) {
    if (!(hero.class in data.heroClasses)) {
      errors.push(`hero ${hero.id}: class ${hero.class} does not exist`);
    }
    for (const entry of hero.startSkills) {
      if (!(entry.skill in data.skills)) {
        errors.push(`hero ${hero.id}: start skill ${entry.skill} does not exist`);
      }
    }
    for (const stack of hero.startArmy) {
      if (!(stack.creature in data.creatures)) {
        errors.push(`hero ${hero.id}: start army creature ${stack.creature} does not exist`);
      }
      if (stack.min > stack.max) {
        errors.push(`hero ${hero.id}: start army ${stack.creature} min > max`);
      }
    }
    if (hero.startSpell !== undefined && !(hero.startSpell in data.spells)) {
      errors.push(`hero ${hero.id}: start spell ${hero.startSpell} does not exist`);
    }
  }

  for (let i = 1; i < data.xpThresholds.length; i++) {
    const prev = data.xpThresholds[i - 1];
    const curr = data.xpThresholds[i];
    if (prev !== undefined && curr !== undefined && curr <= prev) {
      errors.push(`xpThresholds not strictly increasing at index ${String(i)}`);
    }
  }

  const chars = new Set<string>();
  for (const entry of [...Object.values(data.terrains), ...Object.values(data.roads)]) {
    if (chars.has(entry.char)) {
      errors.push(`terrain/road char '${entry.char}' is not unique (${entry.id})`);
    }
    chars.add(entry.char);
  }

  return errors;
}

export function loadGameData(): GameData {
  const creatures = CreaturesFileSchema.parse(creaturesJson);
  const skills = SkillsFileSchema.parse(skillsJson);
  const spells = SpellsFileSchema.parse(spellsJson);
  const artifacts = ArtifactsFileSchema.parse(artifactsJson);
  const buildings = BuildingsFileSchema.parse(buildingsJson);
  const terrainFile = TerrainFileSchema.parse(terrainJson);
  const heroesFile = HeroesFileSchema.parse(heroesJson);
  const objectTypes = ObjectsFileSchema.parse(objectsJson);
  const factions = [castleJson, rampartJson, necropolisJson].map((f) => FactionSchema.parse(f));

  const data: GameData = {
    creatures: indexById(creatures, 'creature'),
    skills: indexById(skills, 'skill'),
    spells: indexById(spells, 'spell'),
    artifacts: indexById(artifacts, 'artifact'),
    buildings: indexById(buildings, 'building'),
    terrains: indexById(terrainFile.terrains, 'terrain'),
    roads: indexById(terrainFile.roads, 'road'),
    objectTypes: indexById(objectTypes, 'object type'),
    heroClasses: indexById(heroesFile.classes, 'hero class'),
    heroes: indexById(heroesFile.heroes, 'hero'),
    factions: indexById(factions, 'faction'),
    xpThresholds: heroesFile.xpThresholds,
  };

  const errors = validateCrossReferences(data);
  if (errors.length > 0) {
    throw new Error(`game data cross-reference errors:\n${errors.join('\n')}`);
  }
  return data;
}
