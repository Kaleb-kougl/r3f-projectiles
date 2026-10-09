import type { Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Pattern-side types — React-free
// ---------------------------------------------------------------------------
//
// The types a pattern, the pool and the headless simulation need, kept apart
// from `./types` (which also declares `<BulletManager>`'s props and so names
// the global `React` namespace). The `/patterns` and `/core` entries' emitted
// declarations therefore never reference React, so a headless consumer
// type-checks without `@types/react`. `./types` re-exports all of these, so
// every existing import path keeps working.

// ---------------------------------------------------------------------------
// Bullet data
// ---------------------------------------------------------------------------

/**
 * Describes a single bullet to be spawned.
 *
 * Instances are pooled via `acquire()` / `releaseSpawnData()` to avoid
 * per-frame allocations. The `offset`, `velocity`, and `acceleration` vectors
 * are reused — never keep a reference across frames.
 */
export interface BulletSpawnData {
  /** Local-space offset from the spawn origin. */
  offset: Vector3;
  /** Initial velocity (world-space direction × speed). */
  velocity: Vector3;
  /** Per-frame acceleration applied additively to velocity. */
  acceleration: Vector3;
  /** Seconds to wait before the bullet becomes visible and starts moving. */
  delay: number;
  /** Hex color override, or `null` to use the default (0xff3333). */
  color: number | null;
  /** Remaining lifetime in seconds (default 5). */
  life: number;
  /**
   * Opaque per-bullet integer the library carries but never interprets. The
   * consumer defines its meaning — e.g. damage, a pierce counter, or a faction
   * tag. Set it with `mod.payload(n)`; read it back in `forEachActive`. Kept a
   * primitive so pooling stays allocation-free. @default 0
   */
  payload: number;
  /**
   * Per-bullet size multiplier, applied on top of the field's `bulletRadius`
   * rather than replacing it — `1` renders at the field's configured size, `2`
   * at double. Set it with `mod.scale(n)`. Kept a primitive so pooling stays
   * allocation-free. @default 1
   */
  scale: number;
}

// ---------------------------------------------------------------------------
// Pattern system
// ---------------------------------------------------------------------------

/**
 * Union of built-in pattern names that ship with the library.
 * Pass one of these strings to `BulletManager`'s `pattern` prop for a
 * zero-config preset.
 */
export type PatternKey =
  | 'fibonacciSphere'
  | 'torusKnot'
  | 'galaxy'
  | 'helix'
  | 'rose3D'
  | 'ring'
  | 'arc';

/**
 * A factory function that produces an array of `BulletSpawnData`.
 * Consumers can supply a custom factory instead of a `PatternKey` to
 * define their own bullet patterns.
 */
export type PatternFactory = () => BulletSpawnData[];

/**
 * A modifier transforms an array of spawn data in-place and returns it.
 * Modifiers are stacked via `compose()`.
 *
 * @example
 * ```ts
 * const redAccel: Modifier = compose(
 *   gen.ring(100),
 *   mod.color(0xff0000),
 *   mod.accelerate(2),
 * );
 * ```
 */
export type Modifier = (spawns: BulletSpawnData[]) => BulletSpawnData[];
