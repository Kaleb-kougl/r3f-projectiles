import { describe, it, expect } from 'vitest';
import { BUILTIN_PATTERNS, resolvePattern } from '../presets';
import { releaseSpawnData } from '../pool';
import type { PatternKey } from '../types';

describe('resolvePattern', () => {
  it('resolves every built-in string key', () => {
    const keys = Object.keys(BUILTIN_PATTERNS) as PatternKey[];
    for (const key of keys) {
      const spawns = resolvePattern(key);
      expect(spawns.length).toBeGreaterThan(0);
      releaseSpawnData(spawns);
    }
  });

  it('throws an error for invalid string keys', () => {
    expect(() => {
      resolvePattern('invalidKey' as PatternKey);
    }).toThrowError(/Unknown pattern "invalidKey"/);
  });

  it('invokes custom factory lambdas', () => {
    let invoked = false;
    const customFactory = () => {
      invoked = true;
      return [];
    };
    const spawns = resolvePattern(customFactory);
    expect(invoked).toBe(true);
    expect(spawns).toEqual([]);
  });

  it('bypasses type narrowing for string-like objects or unions', () => {
    // If a user bypasses type narrowing with `@ts-expect-error` but passes a valid key, it should still work
    const dynamicKey = 'ring' as unknown;
    // @ts-expect-error intentional testing of type bypass
    const spawns = resolvePattern(dynamicKey);
    expect(spawns.length).toBeGreaterThan(0);
    releaseSpawnData(spawns);
  });
});
