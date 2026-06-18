import { Vector3 } from 'three';
import type { BulletSpawnData } from './types';

// ---------------------------------------------------------------------------
// Module-scope pool
// ---------------------------------------------------------------------------

/** Internal free-list of recyclable spawn data objects. */
const _pool: BulletSpawnData[] = [];

/** Hard cap to prevent unbounded memory growth. */
const MAX_POOL_SIZE = 20_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a `BulletSpawnData` instance from the pool, or allocate a fresh one
 * if the pool is empty.
 *
 * Returned objects are reset to safe defaults:
 * - `offset`, `velocity`, `acceleration` → `(0, 0, 0)`
 * - `delay` → `0`
 * - `color` → `null`
 * - `life` → `5.0`
 *
 * @returns A ready-to-use `BulletSpawnData` instance.
 */
export function acquire(): BulletSpawnData {
  if (_pool.length > 0) {
    const p = _pool.pop()!;
    p.offset.set(0, 0, 0);
    p.velocity.set(0, 0, 0);
    p.acceleration.set(0, 0, 0);
    p.delay = 0;
    p.color = null;
    p.life = 5.0;
    return p;
  }

  return {
    offset: new Vector3(),
    velocity: new Vector3(),
    acceleration: new Vector3(),
    delay: 0,
    color: null,
    life: 5.0,
  };
}

/**
 * Return an array of `BulletSpawnData` objects to the pool for reuse.
 *
 * Call this after a burst's spawn data has been fully consumed (i.e. all
 * bullets have been initialized from it). The pool will accept items up to
 * `MAX_POOL_SIZE`; excess items are silently discarded and left for GC.
 *
 * @param arr - The spawn data array to release. Safe to pass `null`/`undefined`.
 */
export function releaseSpawnData(arr: BulletSpawnData[]): void {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item) continue;
    if (_pool.length < MAX_POOL_SIZE) {
      if (!_pool.includes(item)) {
        _pool.push(item);
      }
    }
  }
}
