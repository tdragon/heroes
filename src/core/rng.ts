// Seeded mulberry32 PRNG. State is a plain number passed in/out so it can
// live inside a serializable GameState. Never use Math.random() in core.

export type RngState = number;

export function seedRng(seed: number): RngState {
  return seed | 0;
}

export function nextFloat(state: RngState): [number, RngState] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, s];
}

export function rollRange(state: RngState, min: number, max: number): [number, RngState] {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`rollRange expects integers, got ${String(min)}..${String(max)}`);
  }
  if (min > max) {
    throw new Error(`rollRange min ${String(min)} > max ${String(max)}`);
  }
  const [value, next] = nextFloat(state);
  return [min + Math.floor(value * (max - min + 1)), next];
}

export function rollChance(state: RngState, probability: number): [boolean, RngState] {
  if (probability < 0 || probability > 1) {
    throw new Error(`rollChance probability out of [0,1]: ${String(probability)}`);
  }
  const [value, next] = nextFloat(state);
  return [value < probability, next];
}
