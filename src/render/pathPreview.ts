import type { Pos } from '../maps/schema';

export interface PathStepPreview {
  pos: Pos;
  cost: number;
  day: number; // 1 = reachable today, 2 = tomorrow, …
  dayBreak: boolean; // first step of a new day
}

// Assign each path step the day on which the hero reaches it, given the
// hero's remaining movement points today and full daily movement points.
export function splitPathByDays(
  steps: readonly Pos[],
  stepCosts: readonly number[],
  currentMp: number,
  dailyMp: number,
): PathStepPreview[] {
  if (steps.length !== stepCosts.length) {
    throw new Error('splitPathByDays: steps and stepCosts length mismatch');
  }
  if (dailyMp <= 0) {
    throw new Error('splitPathByDays: dailyMp must be positive');
  }
  const result: PathStepPreview[] = [];
  let remaining = currentMp;
  let day = 1;
  for (let i = 0; i < steps.length; i++) {
    const pos = steps[i];
    const cost = stepCosts[i];
    if (!pos || cost === undefined) break;
    let dayBreak = false;
    if (cost > remaining) {
      day += 1;
      remaining = dailyMp;
      dayBreak = true;
    }
    remaining -= cost;
    result.push({ pos: [...pos], cost, day, dayBreak });
  }
  return result;
}
