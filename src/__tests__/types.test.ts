import { describe, it, expect } from 'vitest';
import { PATTERN_LABELS } from '../types';
import type { PatternKey } from '../types';

describe('types', () => {
  it('PATTERN_LABELS explicitly covers all built-in pattern key string union variants', () => {
    // Expected keys based on the union variants
    const expectedKeys: PatternKey[] = [
      'fibonacciSphere',
      'torusKnot',
      'galaxy',
      'helix',
      'rose3D',
      'ring'
    ];

    const actualKeys = Object.keys(PATTERN_LABELS);

    expect(actualKeys.length).toBe(expectedKeys.length);
    for (const key of expectedKeys) {
      expect(actualKeys).toContain(key);
      expect(typeof PATTERN_LABELS[key]).toBe('string');
    }
  });
});
