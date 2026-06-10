import { gen, mod, compose } from './patterns';
import type { BulletSpawnData, PatternKey, PatternFactory } from './types';

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/**
 * Registry of built-in pattern factories.
 *
 * Each entry is a zero-arg function that returns a freshly generated (and
 * pool-acquired) array of `BulletSpawnData`. The data must be released via
 * `releaseSpawnData()` after consumption.
 *
 * @example
 * ```ts
 * const data = BUILTIN_PATTERNS.galaxy();
 * spawnBullets(mesh, bullets, origin, data, false);
 * releaseSpawnData(data);
 * ```
 */
export const BUILTIN_PATTERNS: Record<PatternKey, PatternFactory> = {
  fibonacciSphere: () => compose(gen.fibonacciSphere(200, 2), mod.color(0x39ff14)),
  torusKnot: () => compose(gen.torusKnot(300), mod.color(0xff3333)),
  galaxy: () => compose(gen.galaxy(250), mod.color(0x6666ff)),
  helix: () => compose(gen.helix(200), mod.color(0xff66ff)),
  rose3D: () => compose(gen.rose3D(200), mod.color(0xffff33)),
  ring: () => compose(gen.ring(100), mod.color(0x33ffff)),
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a `pattern` prop value to concrete spawn data.
 *
 * - If `pattern` is a `PatternKey` string, the corresponding built-in
 *   factory is invoked.
 * - If `pattern` is a `PatternFactory` function, it is called directly.
 *
 * This allows `<BulletManager pattern="galaxy" />` and
 * `<BulletManager pattern={() => compose(gen.ring(50), mod.color(0xff0000))} />`
 * to work interchangeably.
 *
 * @param pattern - A built-in key or custom factory.
 * @returns Fresh spawn data (caller must `releaseSpawnData()` after use).
 */
export function resolvePattern(pattern: PatternKey | PatternFactory): BulletSpawnData[] {
  if (typeof pattern === 'string') {
    const factory = BUILTIN_PATTERNS[pattern];
    if (!factory) {
      throw new Error(
        `[r3f-projectiles] Unknown pattern "${pattern}". ` +
        `Valid keys: ${Object.keys(BUILTIN_PATTERNS).join(', ')}`,
      );
    }
    return factory();
  }
  return pattern();
}
