import { z } from 'zod';
import { FactionIdSchema } from '../data/schema';

export const PLAYER_COLORS = ['red', 'blue', 'tan', 'green'] as const;
export const PlayerColorSchema = z.enum(PLAYER_COLORS);
export type PlayerColor = z.infer<typeof PlayerColorSchema>;

export const NO_ROAD_CHAR = '.';

export const PosSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export type Pos = z.infer<typeof PosSchema>;

export const GuardSchema = z.object({
  creature: z.string().min(1),
  count: z.number().int().positive(),
});
export type Guard = z.infer<typeof GuardSchema>;

export const MapPlayerSchema = z.object({
  color: PlayerColorSchema,
  faction: FactionIdSchema,
  isHuman: z.boolean(),
  startTownAt: PosSchema,
  startHero: z.string().min(1),
});
export type MapPlayer = z.infer<typeof MapPlayerSchema>;

export const MapObjectSchema = z.object({
  type: z.string().min(1),
  at: PosSchema,
  subtype: z.string().min(1).optional(),
  owner: PlayerColorSchema.optional(),
  amount: z.number().int().positive().optional(),
  guard: GuardSchema.optional(),
  creature: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  artifact: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  pairId: z.string().min(1).optional(),
  hero: z.string().min(1).optional(),
});
export type MapObject = z.infer<typeof MapObjectSchema>;

export const VictoryConditionSchema = z.object({ type: z.literal('defeatAll') });
export type VictoryCondition = z.infer<typeof VictoryConditionSchema>;

export const LossConditionSchema = z.object({ type: z.literal('loseAll') });
export type LossCondition = z.infer<typeof LossConditionSchema>;

export const GameMapSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().min(8).max(96),
    players: z.array(MapPlayerSchema).min(2).max(4),
    terrain: z.string(),
    roads: z.string(),
    objects: z.array(MapObjectSchema),
    victory: VictoryConditionSchema,
    loss: LossConditionSchema,
  })
  .refine((m) => m.terrain.length === m.size * m.size, {
    message: 'terrain layer length must equal size*size',
  })
  .refine((m) => m.roads.length === m.size * m.size, {
    message: 'road layer length must equal size*size',
  });
export type GameMap = z.infer<typeof GameMapSchema>;
