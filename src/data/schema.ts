import { z } from 'zod';

export const RESOURCE_IDS = [
  'gold',
  'wood',
  'ore',
  'mercury',
  'sulfur',
  'crystal',
  'gems',
] as const;
export const ResourceIdSchema = z.enum(RESOURCE_IDS);
export type ResourceId = z.infer<typeof ResourceIdSchema>;

export const CostSchema = z.partialRecord(ResourceIdSchema, z.number().int().nonnegative());
export type Cost = z.infer<typeof CostSchema>;

export const FACTION_IDS = ['castle', 'rampart', 'necropolis'] as const;
export const FactionIdSchema = z.enum(FACTION_IDS);
export type FactionId = z.infer<typeof FactionIdSchema>;

const CreatureFlagSchema = z.enum(['flying', 'wide', 'undead']);
export type CreatureFlag = z.infer<typeof CreatureFlagSchema>;

const SpecialTypeSchema = z.enum([
  'doubleShot',
  'doubleAttack',
  'noRetaliation',
  'unlimitedRetaliation',
  'extraRetaliations',
  'jousting',
  'breath',
  'deathCloud',
  'noMeleePenalty',
  'lifeDrain',
  'regeneration',
  'bind',
  'blind',
  'curse',
  'disease',
  'aging',
  'doubleDamage',
  'magicResistance',
  'spellImmunityToLevel',
  'manaDrain',
  'moraleAura',
  'enemyMoraleDebuff',
  'magicResistAura',
  'resurrectOnce',
  'spellCostAura',
]);
export type SpecialType = z.infer<typeof SpecialTypeSchema>;

const CreatureSpecialSchema = z.object({
  type: SpecialTypeSchema,
  value: z.number().optional(),
});
export type CreatureSpecial = z.infer<typeof CreatureSpecialSchema>;

export const CreatureSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    faction: z.union([FactionIdSchema, z.literal('neutral')]),
    tier: z.number().int().min(1).max(7),
    attack: z.number().int().nonnegative(),
    defense: z.number().int().nonnegative(),
    dmgMin: z.number().int().positive(),
    dmgMax: z.number().int().positive(),
    hp: z.number().int().positive(),
    speed: z.number().int().positive(),
    growth: z.number().int().positive(),
    cost: CostSchema,
    aiValue: z.number().int().positive(),
    upgradeOf: z.string().optional(),
    shots: z.number().int().positive().optional(),
    flags: z.array(CreatureFlagSchema).default([]),
    specials: z.array(CreatureSpecialSchema).default([]),
  })
  .refine((c) => c.dmgMin <= c.dmgMax, { message: 'dmgMin must be <= dmgMax' });
export type Creature = z.infer<typeof CreatureSchema>;

export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  values: z.tuple([z.number(), z.number(), z.number()]),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SpellSchoolSchema = z.enum(['air', 'earth', 'fire', 'water', 'all']);
export type SpellSchool = z.infer<typeof SpellSchoolSchema>;

export const SpellTargetSchema = z.enum([
  'enemyStack',
  'friendlyStack',
  'anyStack',
  'area',
  'battlefield',
  'adventure',
]);
export type SpellTarget = z.infer<typeof SpellTargetSchema>;

const SpellKindSchema = z.enum([
  'damage',
  'buff',
  'debuff',
  'heal',
  'resurrect',
  'dispel',
  'disable',
  'adventure',
]);
export type SpellKind = z.infer<typeof SpellKindSchema>;

const SpellTierSchema = z.object({
  base: z.number().optional(),
  spCoef: z.number().optional(),
  mass: z.boolean().optional(),
  jumps: z.number().int().optional(),
  description: z.string().min(1),
});
export type SpellTier = z.infer<typeof SpellTierSchema>;

export const SpellSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  level: z.number().int().min(1).max(5),
  school: SpellSchoolSchema,
  manaCost: z.number().int().positive(),
  target: SpellTargetSchema,
  kind: SpellKindSchema,
  tiers: z.tuple([SpellTierSchema, SpellTierSchema, SpellTierSchema, SpellTierSchema]),
});
export type Spell = z.infer<typeof SpellSchema>;

export const ARTIFACT_SLOTS = [
  'head',
  'neck',
  'torso',
  'weapon',
  'shield',
  'feet',
  'ring',
  'misc',
] as const;
export const ArtifactSlotSchema = z.enum(ARTIFACT_SLOTS);
export type ArtifactSlot = z.infer<typeof ArtifactSlotSchema>;

const ArtifactRaritySchema = z.enum(['treasure', 'minor', 'major', 'relic']);
export type ArtifactRarity = z.infer<typeof ArtifactRaritySchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: ArtifactSlotSchema,
  rarity: ArtifactRaritySchema,
  bonuses: z.object({
    attack: z.number().int().optional(),
    defense: z.number().int().optional(),
    spellPower: z.number().int().optional(),
    knowledge: z.number().int().optional(),
    morale: z.number().int().optional(),
    luck: z.number().int().optional(),
    movement: z.number().int().optional(),
    sightRadius: z.number().int().optional(),
    manaRegen: z.number().int().optional(),
  }),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

const BuildingKindSchema = z.enum([
  'hall',
  'fort',
  'tavern',
  'marketplace',
  'silo',
  'blacksmith',
  'mageGuild',
  'dwelling',
  'special',
]);
export type BuildingKind = z.infer<typeof BuildingKindSchema>;

export const BuildingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: BuildingKindSchema,
  cost: CostSchema,
  prereqs: z.array(z.string()).default([]),
  income: CostSchema.optional(),
  growthMultiplier: z.number().optional(),
  guildLevel: z.number().int().min(1).max(5).optional(),
  creature: z.string().optional(),
  growthBonus: z
    .object({ creature: z.string().min(1), amount: z.number().int().positive() })
    .optional(),
  upgradeOf: z.string().optional(),
  uniquePerPlayer: z.boolean().optional(),
  special: z.string().optional(),
});
export type Building = z.infer<typeof BuildingSchema>;

export const TerrainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  char: z.string().length(1),
  moveCost: z.number().int().positive().nullable(),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
});
export type Terrain = z.infer<typeof TerrainSchema>;

export const RoadSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  char: z.string().length(1),
  moveCost: z.number().int().positive(),
});
export type Road = z.infer<typeof RoadSchema>;

export const TerrainFileSchema = z.object({
  terrains: z.array(TerrainSchema),
  roads: z.array(RoadSchema),
});
export type TerrainFile = z.infer<typeof TerrainFileSchema>;

const StatChancesSchema = z.tuple([
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
]);

export const HeroClassSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  faction: FactionIdSchema,
  startStats: z.object({
    attack: z.number().int().nonnegative(),
    defense: z.number().int().nonnegative(),
    spellPower: z.number().int().nonnegative(),
    knowledge: z.number().int().nonnegative(),
  }),
  levelUpChancesEarly: StatChancesSchema,
  levelUpChancesLate: StatChancesSchema,
  hasSpellbook: z.boolean(),
  skillWeights: z.record(z.string(), z.number().positive()),
});
export type HeroClass = z.infer<typeof HeroClassSchema>;

const SkillRankSchema = z.enum(['basic', 'advanced', 'expert']);
export type SkillRank = z.infer<typeof SkillRankSchema>;

export const HeroTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  class: z.string().min(1),
  startSkills: z.array(z.object({ skill: z.string(), rank: SkillRankSchema })),
  startArmy: z.array(
    z.object({
      creature: z.string(),
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    }),
  ),
  startSpell: z.string().optional(),
});
export type HeroTemplate = z.infer<typeof HeroTemplateSchema>;

export const HeroesFileSchema = z.object({
  xpThresholds: z.array(z.number().int().positive()),
  classes: z.array(HeroClassSchema),
  heroes: z.array(HeroTemplateSchema),
});
export type HeroesFile = z.infer<typeof HeroesFileSchema>;

export const FactionSchema = z.object({
  id: FactionIdSchema,
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  alignment: z.enum(['good', 'evil', 'neutral']),
  creatures: z
    .array(
      z.object({
        tier: z.number().int().min(1).max(7),
        base: z.string(),
        upgrade: z.string(),
      }),
    )
    .length(7),
  dwellings: z.array(BuildingSchema),
  specialBuildings: z.array(BuildingSchema),
  heroClasses: z.array(z.string()).length(2),
  spellPool: z.array(z.string()),
  siloResource: ResourceIdSchema,
  maxGuildLevel: z.number().int().min(1).max(5),
});
export type Faction = z.infer<typeof FactionSchema>;

const ObjectCategorySchema = z.enum(['enterable', 'flaggable', 'pickup', 'visitable', 'special']);
export type ObjectCategory = z.infer<typeof ObjectCategorySchema>;

const ObjectResetSchema = z.enum(['none', 'daily', 'weekly', 'oncePerHero', 'once']);
export type ObjectReset = z.infer<typeof ObjectResetSchema>;

const AmountRangeSchema = z.tuple([z.number().int(), z.number().int()]);

export const ObjectTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: ObjectCategorySchema,
  reset: ObjectResetSchema.default('none'),
  subtypes: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        income: CostSchema.optional(),
      }),
    )
    .optional(),
  amountRanges: z.partialRecord(ResourceIdSchema, AmountRangeSchema).optional(),
  chestOptions: z.array(z.object({ gold: z.number().int(), xp: z.number().int() })).optional(),
  reward: z
    .object({
      xp: z.number().int().optional(),
      luck: AmountRangeSchema.optional(),
      morale: z.number().int().optional(),
      revealRadius: z.number().int().optional(),
      goldCost: z.number().int().optional(),
      statChoice: z.array(z.enum(['attack', 'defense'])).optional(),
      statAmount: z.number().int().optional(),
      gold: z.number().int().optional(),
      firstWeekGold: z.number().int().optional(),
      manaRefill: z.boolean().optional(),
    })
    .optional(),
});
export type ObjectType = z.infer<typeof ObjectTypeSchema>;

export const CreaturesFileSchema = z.array(CreatureSchema);
export const SkillsFileSchema = z.array(SkillSchema);
export const SpellsFileSchema = z.array(SpellSchema);
export const ArtifactsFileSchema = z.array(ArtifactSchema);
export const BuildingsFileSchema = z.array(BuildingSchema);
export const ObjectsFileSchema = z.array(ObjectTypeSchema);
