import { describe, it, expect } from 'vitest';
import * as PublicAPI from '../index';

describe('Public API Barrel File (index.ts)', () => {
  it('exports the expected modules and functions', () => {
    const expectedExports = [
      // Components
      'BulletManager',
      // Phase 4 of docs/bulletfield-emitter-split.md makes the N-emitter form
      // public. These two strings are the only edit that phase makes to an
      // existing test — the exact-set assertion at the bottom is deliberately
      // left as-is, because it is what forces this list to be maintained.
      'BulletField',
      'Emitter',

      // Pattern system
      'gen',
      'mod',
      'compose',
      'BUILTIN_PATTERNS',
      'resolvePattern',

      // Payload bitfields (0.5.0)
      'definePayload',

      // Easing (bullet fade-out)
      'EASING',

      // Pool
      'acquire',
      'releaseSpawnData',
      
      // Types (Only the values are present in Object.keys)
      'PATTERN_LABELS',
      
      // Utilities
      'ProjectileTelemetry',

      // Rendering (0.5.0): ready-made bullet geometries
      'bulletGeometry',

      // Headless simulation (0.6.0), also on the React-free `/core` entry
      'createBulletSimulation',
      'createSeededRandom',

      // Deterministic sin / cos (0.8.0), also on /patterns, /core, /detmath
      'detSin',
      'detCos',
      'detSinCos',
      'DETMATH_RANGE',

      // Rendering (0.7.0): per-bullet sprite frames; the outline attribute
      // name custom flat geometries need for an even 'extrude' rim
      'FRAME_ATTRIBUTE',
      'OUTLINE_DIRECTION_ATTRIBUTE',
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
