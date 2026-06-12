import { describe, expect, it } from 'vitest';
import {
  canvasBackingSize,
  edgeScrollDelta,
  watchDevicePixelRatio,
  type DprMediaQuery,
} from './viewport';

describe('canvasBackingSize', () => {
  it('matches CSS size at dpr 1', () => {
    expect(canvasBackingSize(1000, 760, 1)).toEqual({ width: 1000, height: 760 });
  });

  it('scales by the device pixel ratio', () => {
    expect(canvasBackingSize(1000, 760, 2)).toEqual({ width: 2000, height: 1520 });
    expect(canvasBackingSize(390, 844, 3)).toEqual({ width: 1170, height: 2532 });
  });

  it('rounds fractional results', () => {
    expect(canvasBackingSize(333, 250, 1.5)).toEqual({ width: 500, height: 375 });
    expect(canvasBackingSize(401.4, 300.6, 1.25)).toEqual({ width: 502, height: 376 });
  });

  it('never collapses to zero', () => {
    expect(canvasBackingSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
    expect(canvasBackingSize(0.2, 0.2, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('edgeScrollDelta', () => {
  const W = 1000;
  const H = 760;
  const M = 16;
  const S = 10;

  it('is zero in the interior', () => {
    expect(edgeScrollDelta(500, 380, W, H, M, S)).toEqual([0, 0]);
    expect(edgeScrollDelta(M, M, W, H, M, S)).toEqual([0, 0]);
    expect(edgeScrollDelta(W - M, H - M, W, H, M, S)).toEqual([0, 0]);
  });

  it('scrolls toward each edge inside the margin band', () => {
    expect(edgeScrollDelta(0, 380, W, H, M, S)).toEqual([-S, 0]);
    expect(edgeScrollDelta(W - 1, 380, W, H, M, S)).toEqual([S, 0]);
    expect(edgeScrollDelta(500, 0, W, H, M, S)).toEqual([0, -S]);
    expect(edgeScrollDelta(500, H - 1, W, H, M, S)).toEqual([0, S]);
  });

  it('combines both axes in a corner', () => {
    expect(edgeScrollDelta(0, 0, W, H, M, S)).toEqual([-S, -S]);
    expect(edgeScrollDelta(W - 1, H - 1, W, H, M, S)).toEqual([S, S]);
    expect(edgeScrollDelta(W - 1, 0, W, H, M, S)).toEqual([S, -S]);
  });

  it('tracks the live viewport size, not a fixed canvas', () => {
    expect(edgeScrollDelta(380, 300, 390, 844, M, S)).toEqual([S, 0]);
    expect(edgeScrollDelta(380, 840, 390, 844, M, S)).toEqual([S, S]);
    expect(edgeScrollDelta(380, 300, W, H, M, S)).toEqual([0, 0]);
  });
});

describe('watchDevicePixelRatio', () => {
  interface FakeMedia {
    queries: string[];
    listeners: (() => void)[];
    matchMedia: (query: string) => DprMediaQuery;
  }

  function fakeMedia(): FakeMedia {
    const queries: string[] = [];
    const listeners: (() => void)[] = [];
    return {
      queries,
      listeners,
      matchMedia: (query) => {
        queries.push(query);
        return {
          addEventListener: (_type, listener) => {
            listeners.push(listener);
          },
        };
      },
    };
  }

  it('arms a resolution query for the current dpr and re-arms after each change', () => {
    const media = fakeMedia();
    let dpr = 1;
    let changes = 0;
    watchDevicePixelRatio(
      () => {
        changes += 1;
      },
      new AbortController().signal,
      media.matchMedia,
      () => dpr,
    );
    expect(media.queries).toEqual(['(resolution: 1dppx)']);

    dpr = 2;
    media.listeners[0]?.();
    expect(changes).toBe(1);
    expect(media.queries).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);

    dpr = 1.5;
    media.listeners[1]?.();
    expect(changes).toBe(2);
    expect(media.queries[2]).toBe('(resolution: 1.5dppx)');
  });
});
