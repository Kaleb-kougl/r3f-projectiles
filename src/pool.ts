import { Vector3 } from 'three';
import type { BulletSpawnData } from './patternTypes';

// ---------------------------------------------------------------------------
// Module-scope pool
// ---------------------------------------------------------------------------

/** Internal free-list of recyclable spawn data objects. */
const _pool: BulletSpawnData[] = [];

/**
 * Membership index for {@link _pool} — the double-release guard.
 *
 * `releaseSpawnData` used to answer "is this item already free?" with
 * `_pool.includes(item)`, a linear scan **per item** against a free list of up
 * to 20,000. That is O(burst × poolSize) per release, and `fireAt` puts it in
 * the hot path: 100 imperative emitters each releasing a burst every frame.
 *
 * A `WeakSet` answers the same question in O(1). It holds exactly the objects
 * currently sitting in `_pool` — added on push, removed on pop — so it is
 * bounded by `MAX_POOL_SIZE` and never keeps an object alive that the pool has
 * discarded. The guarantee is unchanged and unweakened: a double release is
 * still a no-op, so a caller that releases the same burst twice can never get
 * two live aliases of one object back out of `acquire()`.
 *
 * It is a `WeakSet` rather than a boolean flag on `BulletSpawnData` because
 * that interface is public: a `_pooled` field would leak into every
 * hand-rolled `PatternFactory`'s object literal and into the type docs.
 */
const _pooled = new WeakSet<BulletSpawnData>();

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
 * - `payload` → `0`
 * - `scale` → `1`
 *
 * @returns A ready-to-use `BulletSpawnData` instance.
 */
export function acquire(): BulletSpawnData {
  if (_pool.length > 0) {
    const p = _pool.pop()!;
    _pooled.delete(p);
    p.offset.set(0, 0, 0);
    p.velocity.set(0, 0, 0);
    p.acceleration.set(0, 0, 0);
    p.delay = 0;
    p.color = null;
    p.life = 5.0;
    p.payload = 0;
    p.scale = 1;
    return p;
  }

  return {
    offset: new Vector3(),
    velocity: new Vector3(),
    acceleration: new Vector3(),
    delay: 0,
    color: null,
    life: 5.0,
    payload: 0,
    scale: 1,
  };
}

/**
 * Return an array of `BulletSpawnData` objects to the pool for reuse.
 *
 * Call this after a burst's spawn data has been fully consumed (i.e. all
 * bullets have been initialized from it). The pool will accept items up to
 * `MAX_POOL_SIZE`; excess items are silently discarded and left for GC.
 *
 * **Double-releasing is safe**: an item already sitting in the free list is
 * skipped, so the pool can never hand two callers the same object. The check is
 * O(1) via {@link _pooled} — it used to be an O(poolSize) `includes()` scan,
 * which mattered once `fireAt` made this a per-frame, per-emitter call.
 *
 * @param arr - The spawn data array to release. Safe to pass `null`/`undefined`,
 *   and safe to pass a sparse array or one containing `null`/`undefined` holes —
 *   the signature admits exactly what the two guards below already tolerate.
 */
export function releaseSpawnData(
  arr: (BulletSpawnData | null | undefined)[] | null | undefined,
): void {
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item) continue;
    if (_pool.length < MAX_POOL_SIZE) {
      // Discarded items (pool full) are deliberately NOT marked: they are no
      // longer the pool's, so a later release may legitimately re-admit one.
      if (!_pooled.has(item)) {
        _pooled.add(item);
        _pool.push(item);
      }
    }
  }
}
