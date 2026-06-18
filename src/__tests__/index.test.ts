import { describe, it, expect } from 'vitest';
import * as PublicAPI from '../index';

describe('Public API Barrel File (index.ts)', () => {
  it('exports the expected modules and functions', () => {
    const expectedExports = [
      // Components
      'BulletManager',
      
      // Pattern system
      'gen',
      'mod',
      'compose',
      'BUILTIN_PATTERNS',
      'resolvePattern',
      
      // Pool
      'acquire',
      'releaseSpawnData',
      
      // Types (Only the values are present in Object.keys)
      'PATTERN_LABELS',
      
      // Utilities
      'ProjectileTelemetry',
    ];

    const actualExports = Object.keys(PublicAPI);

    // Ensure all expected exports are present
    expectedExports.forEach((key) => {
      expect(actualExports).toContain(key);
      expect(PublicAPI[key as keyof typeof PublicAPI]).toBeDefined();
    });

    // Ensure no unexpected internal functions or objects leak
    expect(actualExports.sort()).toEqual(expectedExports.sort());
  });
});
