import { describe, expect, it } from 'vitest';
import type { Pos } from '../maps/schema';
import { splitPathByDays } from './pathPreview';

const steps = (n: number): Pos[] => Array.from({ length: n }, (_, i): Pos => [i + 1, 0]);

describe('splitPathByDays', () => {
  it('keeps the whole path on day 1 when MP suffices', () => {
    const result = splitPathByDays(steps(3), [100, 100, 100], 500, 1500);
    expect(result.map((s) => s.day)).toEqual([1, 1, 1]);
    expect(result.every((s) => !s.dayBreak)).toBe(true);
  });

  it('breaks to day 2 when current MP runs out', () => {
    const result = splitPathByDays(steps(4), [100, 100, 100, 100], 250, 1500);
    expect(result.map((s) => s.day)).toEqual([1, 1, 2, 2]);
    expect(result.map((s) => s.dayBreak)).toEqual([false, false, true, false]);
  });

  it('uses exact MP without an extra day break', () => {
    const result = splitPathByDays(steps(2), [100, 100], 200, 1500);
    expect(result.map((s) => s.day)).toEqual([1, 1]);
  });

  it('splits across multiple days with daily MP budget', () => {
    const result = splitPathByDays(steps(5), [200, 200, 200, 200, 200], 200, 400);
    expect(result.map((s) => s.day)).toEqual([1, 2, 2, 3, 3]);
    expect(result.filter((s) => s.dayBreak).length).toBe(2);
  });

  it('starts at day 2 when no MP left today', () => {
    const result = splitPathByDays(steps(2), [100, 100], 0, 1500);
    expect(result.map((s) => s.day)).toEqual([2, 2]);
    expect(result[0]?.dayBreak).toBe(true);
  });

  it('preserves positions and costs', () => {
    const path = steps(2);
    const result = splitPathByDays(path, [100, 141], 1500, 1500);
    expect(result.map((s) => s.pos)).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(result.map((s) => s.cost)).toEqual([100, 141]);
  });

  it('rejects mismatched input lengths and non-positive daily MP', () => {
    expect(() => splitPathByDays(steps(2), [100], 100, 1500)).toThrow('length mismatch');
    expect(() => splitPathByDays(steps(1), [100], 100, 0)).toThrow('dailyMp');
  });
});
