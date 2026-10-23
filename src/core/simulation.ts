import { Color, Vector3 } from 'three';
import { DEV } from '../dev';
import {
  fadeScale,
  resolveEasing,
  type EasingFn,
  type EasingName,
} from '../easing';
import { releaseSpawnData } from '../pool';
import { resolvePattern } from '../presets';
import type { BulletSpawnData, PatternFactory, PatternKey } from '../patternTypes';

// ===========================================================================
// The headless bullet simulation
// ===========================================================================
//
// Everything a bullet *is*, with nothing about how it is drawn: the slot pool
// and its sparse set, spawning (offset, delay, life, payload, scale, color),
// semi-implicit Euler motion with acceleration, life and expiry, bounds
// culling, the emitter-id counter, consumption through `forEachActive`, and the
// bookkeeping a renderer needs to sync from it.
//
// This module imports `three`'s math classes (`Vector3`, `Color`) and the
// library's React-free pattern / pool / easing modules — never React, R3F, a
// renderer, a mesh or the DOM. It is the package's `/core` entry, and it is
// also the ONE implementation `<BulletField>` runs: a field that owns its
// bullets builds one of these and drives it; a field handed one through its
// `simulation` prop only renders it.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why a burst was short-changed — the fourth argument to every
 * `onPoolExhausted` callback (`<BulletField>`'s prop and
 * {@link BulletSimulationOptions.onPoolExhausted}).
 *
 * The two are worth telling apart because the remedies are different, and one
 * of them is "nothing":
 *
 * - `'pool-full'` — the shared slot pool had no free slots left. The honest
 *   fixes are the blunt ones: raise `maxBullets`, or slow the greedy emitter.
 *   Raised by every spawn path, and the only reason a {@link BulletSimulation}
 *   itself ever reports.
 * - `'reduced-motion-budget'` — `<BulletField>`'s field-wide 200-bullet
 *   reduced-motion snapshot budget was spent by earlier emitters, so this one
 *   was truncated in registration order. **The cap is not configurable**, and
 *   the pool itself may be nearly empty, so `maxBullets` is not the lever here
 *   — this reason exists so a consumer can stop reaching for it. Raised only
 *   from the field's reduced-motion snapshot path, and only when the budget
 *   (not the pool) was the binding constraint.
 */
export type PoolExhaustionReason = 'pool-full' | 'reduced-motion-budget';

/** Anything with numeric `x`, `y`, `z` — a `Vector3`, or your own vector type. */
export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where the bounds cull box's centre comes from, read **once per step**:
 *
 * - a ref-like `{ current }` (a React ref works) — `.current` `null` or
 *   `undefined` means the origin;
 * - a getter function — returning `null` / `undefined` means the origin;
 * - a vector, read live (mutate it and the next step sees the change).
 */
export type BoundsCenterSource =
  | { readonly current: Vector3Like | null | undefined }
  | (() => Vector3Like | null | undefined)
  | Vector3Like;

/**
 * The `forEachActive` callback: one live, visible bullet per call. Return
 * `true` to consume it (free its slot); return anything else to leave it.
 *
 * `pos` is the bullet's **live internal vector**, handed over to read. Do not
 * write to it, and do not keep it past the current step — the slot is recycled
 * once the bullet dies.
 */
export type ForEachActiveCallback = (
  index: number,
  pos: Vector3,
  payload: number,
  emitterId: number,
) => boolean | void;

/**
 * Raised once per burst that could not be spawned in full — never once per
 * dropped bullet. `spawned < requested` always holds when it is called.
 */
export type PoolExhaustedCallback = (
  emitterId: number,
  requested: number,
  spawned: number,
  reason: PoolExhaustionReason,
) => void;

/** Options for {@link createBulletSimulation}. Every one is optional. */
export interface BulletSimulationOptions {
  /**
   * Slot capacity — the most bullets alive at once. Fixed for the
   * simulation's life; allocated up front, never grown. A non-negative
   * integer. @default 2000
   */
  maxBullets?: number;
  /**
   * Half-extent of the axis-aligned cull **cube**: a bullet is culled on the
   * step it ends with any one coordinate more than this from the centre.
   * `Infinity` disables bounds culling (lifetime still despawns). Mutable
   * later as {@link BulletSimulation.boundsLimit}. @default 25
   */
  boundsLimit?: number;
  /**
   * Centre of the cull cube, read once per step. Omitted: the origin.
   * Mutable later as {@link BulletSimulation.boundsCenter}.
   */
  boundsCenter?: BoundsCenterSource | null;
  /**
   * Seconds of fade at the end of each bullet's life. **Bookkeeping only**:
   * it never affects when a bullet dies, only {@link BulletSimulation.fadeAt},
   * which a renderer multiplies into the drawn size. `0` disables it.
   * @default 1
   */
  fadeTime?: number;
  /** Shape of that fade. An unknown name throws here. @default 'linear' */
  fadeCurve?: EasingName | EasingFn;
  /**
   * Keep each bullet's position from the start of the latest step, so a
   * renderer can interpolate between the last two steps
   * ({@link BulletSimulation.previousPositionAt}). Costs `3 × maxBullets`
   * doubles and three stores per bullet per step. Fixed at creation.
   * @default false
   */
  interpolation?: boolean;
  /** See {@link PoolExhaustedCallback}. Mutable later. */
  onPoolExhausted?: PoolExhaustedCallback;
}

/**
 * A headless, deterministic bullet simulation — no React, no renderer, no DOM.
 * Create one with {@link createBulletSimulation}; render one with
 * `<BulletField simulation={sim} />`.
 *
 * ## Determinism
 * Given the same options and the same sequence of calls — `step(dt)`,
 * `fireAt`, `clear`, `forEachActive` consumptions, `setPayload`,
 * `acquireEmitter` / `releaseEmitter` and config writes — two simulations
 * hold bit-identical state: the same bullets in the same slots with the same
 * doubles. Nothing reads a clock, a frame, a renderer or `Math.random`. The
 * inputs must be deterministic too: patterns that call `Math.random`
 * (`gen.galaxy` and `gen.rose3D` without an `rng`, and the `'galaxy'` /
 * `'rose3D'` presets) are not, and a custom pattern built on `Math.sin` /
 * `Math.cos` is only reproducible within one JS engine build on one platform.
 * The built-in generators and modifiers use `detSin` / `detCos` (0.8.0), which
 * give the same bits on every engine. See the README's "Headless simulation".
 *
 * ## Slot indices
 * Every per-bullet accessor takes a **slot index** in `[0, capacity)` — the
 * `index` that `forEachActive` hands out. An index names "this bullet" only
 * while the bullet lives; reading a slot that is not live returns its last
 * occupant's stale values (check {@link isLive}). The accessors are the
 * renderer's per-bullet hot path, so they do not validate the index — an
 * index outside `[0, capacity)` reads `undefined`, not an error — and they
 * never allocate. (`setPayload` alone does validate, because it writes.)
 *
 * ## Allocation
 * None per step, per bullet, or per accessor call. The per-burst exceptions
 * are the pattern's own (`fireAt` resolves a pattern: one array, plus
 * whatever the factory allocates), exactly as on `<BulletField>`; and
 * {@link writeStateHash} grows the array you hand it.
 */
export interface BulletSimulation {
  // ---- Configuration (mutable at any time; read at step time) -------------

  /** See {@link BulletSimulationOptions.boundsLimit}. */
  boundsLimit: number;
  /** See {@link BulletSimulationOptions.boundsCenter}. */
  boundsCenter: BoundsCenterSource | null | undefined;
  /** See {@link BulletSimulationOptions.fadeTime}. */
  fadeTime: number;
  /** See {@link BulletSimulationOptions.fadeCurve}. Assigning an unknown name throws. */
  fadeCurve: EasingName | EasingFn;
  /** See {@link BulletSimulationOptions.onPoolExhausted}. */
  onPoolExhausted: PoolExhaustedCallback | undefined;

  /** Slot capacity (`maxBullets`). Fixed. */
  readonly capacity: number;
  /** Whether previous positions are kept. Fixed at creation. */
  readonly interpolation: boolean;

  // ---- Simulation --------------------------------------------------------

  /**
   * Advance exactly `dt` seconds: spawn delays count down, acceleration and
   * velocity integrate (`v += a·dt`, then `p += v·dt`), life counts down, and
   * bullets whose life reached `0` or that left the bounds cube are freed.
   * Bullets spawned before this call are advanced by it, delayed ones once
   * their delay runs out within it.
   *
   * `dt` is used as given — no clamp. A `dt` that is not a finite number
   * greater than `0` is ignored (a no-op, never a throw); `NaN`, negative and
   * infinite values warn once in development builds. Allocates nothing.
   */
  step(dt: number): void;
  /**
   * Spawn one burst at `origin` (copied immediately, never retained),
   * attributed to `emitterId` (default `0`, "anonymous"). A full pool drops
   * the burst's remainder — never a live bullet — and raises
   * `onPoolExhausted` once. Safe to call from inside a `forEachActive`
   * callback: the walk never visits bullets spawned during it.
   *
   * Allocates only what the pattern does (its array; `BulletSpawnData` is
   * pooled and released here).
   *
   * @returns How many bullets actually spawned.
   */
  fireAt(
    origin: Vector3Like,
    pattern: PatternKey | PatternFactory,
    emitterId?: number,
  ): number;
  /** Issue a fresh emitter id: starts at `1`, never recycled, never `0`. */
  acquireEmitter(): number;
  /**
   * Retire an id. Does **not** clear its bullets, which keep the id for the
   * rest of their flight. Advances the counter past `id`, so an id you chose
   * yourself is never issued to anyone else.
   */
  releaseEmitter(id: number): void;
  /**
   * Free every live bullet — or, given an id, exactly the bullets stamped with
   * it (`0` for the anonymous ones). Never touches another emitter's bullets.
   * @returns How many bullets were freed.
   */
  clear(emitterId?: number): number;
  /** Live bullets, delayed ones included. */
  readonly activeCount: number;
  /** Live bullets stamped with `emitterId`, delayed ones included. `O(active)`. */
  activeCountFor(emitterId: number): number;
  /**
   * Walk every live, **visible** bullet (delayed ones are skipped) and consume
   * each one for which `cb` returns `true`. `O(active)`; the walk order is
   * deterministic but unspecified. Reentrant for `fireAt` and `setPayload`.
   */
  forEachActive(cb: ForEachActiveCallback): void;
  /** Overwrite a live bullet's payload. Ignored for a slot that is not live. */
  setPayload(index: number, payload: number): void;
  /** Number of `step()` calls that advanced the simulation. Monotonic. */
  readonly stepCount: number;

  // ---- State hashing -----------------------------------------------------

  /**
   * Append every live bullet's state to `out`, in ascending slot order, as
   * ten numbers per bullet: `index, x, y, z, vx, vy, vz, life, payload,
   * emitterId`. Nothing else is appended, so `out.length` grows by exactly
   * `10 × activeCount`. Feed it to your own state hash; two simulations that
   * agree bit-for-bit append identical sequences. If your hash reads raw
   * bits, canonicalize NaN first (`v !== v`): a NaN's bit pattern is not
   * portable between engines. `O(highWater)`. Allocates only if `out` has to
   * grow.
   */
  writeStateHash(out: number[]): void;
  /**
   * A 32-bit hash of the same values {@link writeStateHash} writes (plus the
   * live count), over their exact IEEE-754 bits — so `0` and `-0`, or two
   * doubles one ulp apart, hash differently. Every NaN hashes as the one
   * canonical NaN (`0x7FF8000000000000`), since a NaN's bits are not portable
   * between engines. For replay checks and desync detection; not
   * cryptographic. Allocates nothing.
   */
  hashState(): number;

  // ---- Read access, for rendering ----------------------------------------

  /**
   * One past the highest slot occupied since the pool was last empty — the
   * span a renderer must draw. Reads as `0` whenever the pool is empty.
   */
  readonly highWater: number;
  /** Whether slot `index` holds a live bullet (delayed or not). */
  isLive(index: number): boolean;
  /** Whether slot `index` holds a live bullet whose delay has run out. */
  isVisible(index: number): boolean;
  /** The bullet's live position vector. Read-only to you. */
  positionAt(index: number): Readonly<Vector3>;
  /** The bullet's live velocity vector. Read-only to you. */
  velocityAt(index: number): Readonly<Vector3>;
  /**
   * The bullet's position at the start of the latest step it moved in, written
   * into `out` — its spawn position if it has not moved yet. Without
   * `interpolation` this is simply the current position.
   */
  previousPositionAt(index: number, out: Vector3): Vector3;
  /** Seconds of life left. */
  lifeAt(index: number): number;
  /** Seconds of spawn delay left; `<= 0` once visible. */
  delayAt(index: number): number;
  /** The bullet's payload. */
  payloadAt(index: number): number;
  /** The id of the emitter that fired the bullet. */
  emitterIdAt(index: number): number;
  /** The bullet's own size multiplier (`mod.scale`), excluding the fade. */
  scaleAt(index: number): number;
  /** The fade factor in `[0, 1]` (or above, for an overshooting curve) from `life`, `fadeTime` and `fadeCurve`. */
  fadeAt(index: number): number;
  /** The bullet's spawn color, written into `out` (linear working space, as `Color.set` stores it). */
  colorAt(index: number, out: Color): Color;

  // ---- Render sync -------------------------------------------------------

  /**
   * Lowest slot whose render state may have changed since the last
   * {@link markSynced}. Meaningless while `dirtyMax < dirtyMin`.
   */
  readonly dirtyMin: number;
  /** Highest such slot; `-1` (below `dirtyMin`) when nothing changed. */
  readonly dirtyMax: number;
  /** Whether slot `index` was (re)spawned since the last {@link markSynced}. */
  spawnedSinceSync(index: number): boolean;
  /**
   * Mark everything up to now as rendered: empties the dirty range and the
   * spawned-since-sync flags. Called by the one renderer that owns the sync —
   * `<BulletField simulation>` calls it once per frame. Two renderers syncing
   * one simulation would steal each other's dirty ranges; render a simulation
   * from one field.
   */
  markSynced(): void;
}

/**
 * Create a headless {@link BulletSimulation}.
 *
 * ```ts
 * import { createBulletSimulation } from '@k9kbdev/r3f-projectiles/core';
 *
 * const sim = createBulletSimulation({ maxBullets: 4000, boundsLimit: 40 });
 * const boss = sim.acquireEmitter();
 * sim.fireAt({ x: 0, y: 1, z: 0 }, ringPattern, boss);
 * sim.step(1 / 60);
 * ```
 *
 * @throws RangeError if `maxBullets` is not a non-negative integer.
 */
export function createBulletSimulation(
  options: BulletSimulationOptions = {},
): BulletSimulation {
  const maxBullets = options.maxBullets ?? 2000;
  if (!Number.isInteger(maxBullets) || maxBullets < 0) {
    throw new RangeError(
      `[r3f-projectiles] maxBullets must be a non-negative integer; got ${maxBullets}.`,
    );
  }
  return new SimulationCore({ ...options, maxBullets });
}

// ---------------------------------------------------------------------------
// Internal: the render sink
// ---------------------------------------------------------------------------

/**
 * How a simulation **owned by a `<BulletField>`** writes its matrices: inline,
 * at exactly the points the pre-0.6.0 field wrote them, so that field's
 * observable GPU writes — which slots, in what order, with what values, and
 * how many per step — are unchanged by the move into this module.
 *
 * - `spawned` — once per spawned bullet, before its first matrix: write its
 *   color, and prime its heading from the **pattern's** velocity.
 * - `show` / `hide` — the matrix that draws, or parks, slot `slot`.
 *
 * A headless simulation has no sink and pays for none of this: it composes no
 * matrices and evaluates no fade curve. An externally owned simulation is
 * rendered by pulling instead (the dirty range and read accessors), once per
 * frame. Internal — not exported from any entry.
 */
export interface SimulationSink {
  spawned(slot: number, color: Color, primeVelocity: Vector3): void;
  show(slot: number, position: Vector3, velocity: Vector3, scale: number): void;
  hide(slot: number): void;
}

// ---------------------------------------------------------------------------
// Internal: hashing scratch
// ---------------------------------------------------------------------------

/**
 * One double's worth of bytes, read back as two little-endian words — the
 * endianness is explicit so a hash agrees across machines, not just runs.
 * Module scope: allocated once per process, never per call.
 */
const _hashView = new DataView(new ArrayBuffer(8));

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The canonical quiet NaN, `0x7FF80000_00000000`, as the two words
 * {@link mixDouble} folds (low word first, as the little-endian reads below).
 */
const NAN_LO = 0x00000000;
const NAN_HI = 0x7ff80000;

/**
 * Fold one double's exact bits into a running 32-bit FNV-style hash.
 *
 * Every NaN folds as the one canonical NaN, without passing through the
 * buffer: a NaN's bit pattern is not portable in JavaScript (an arithmetic
 * NaN's sign and payload depend on the engine and the CPU, and writing a NaN
 * to a DataView may store any NaN encoding — ECMAScript's SetValueInBuffer
 * leaves the choice to the implementation), so hashing raw bits would let a
 * state holding a NaN hash differently per engine. Every non-NaN double is
 * hashed by its exact bits, as before.
 */
function mixDouble(h: number, v: number): number {
  if (v !== v) {
    h = Math.imul(h ^ NAN_LO, FNV_PRIME);
    return Math.imul(h ^ NAN_HI, FNV_PRIME);
  }
  _hashView.setFloat64(0, v, true);
  h = Math.imul(h ^ _hashView.getUint32(0, true), FNV_PRIME);
  return Math.imul(h ^ _hashView.getUint32(4, true), FNV_PRIME);
}

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F64 = new Float64Array(0);
const EMPTY_F32 = new Float32Array(0);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The one implementation of {@link BulletSimulation}.
 *
 * Exported from this module (not from any package entry) because
 * `<BulletField>` drives the members prefixed `_`, which are not part of the
 * public type: the reduced-motion snapshot's capped, zero-velocity spawns, the
 * unvalidated step its auto loop takes, the inline render sink, and the
 * last-operation slot span it flushes inline exactly as it always has.
 *
 * ## Storage
 * Positions, velocities and accelerations are one `Vector3` per slot — the
 * same objects, and so the same arithmetic (`addScaledVector`), the field has
 * always used, and `forEachActive` keeps handing out the live position vector
 * it always has. Every scalar is a typed array: `Float64Array`s, so each
 * value round-trips exactly as the JS number it was.
 *
 * ## Sparse set
 *
 *     dense[0 .. denseCount)   packed list of ACTIVE slot indices
 *     slotToDense[slot]        reverse map into `dense`, -1 when slot is free
 *     free[0 .. freeTop)       LIFO stack of available slots
 *
 * Acquire and release are O(1); `step`, `forEachActive`, `activeCountFor` and
 * `clear` are O(active). Every walk over `dense` that can release runs
 * **backwards**, because release swap-removes the last live entry into the
 * vacated position — a forward walk would skip it.
 */
export class SimulationCore implements BulletSimulation {
  boundsLimit: number;
  boundsCenter: BoundsCenterSource | null | undefined;
  fadeTime: number;
  onPoolExhausted: PoolExhaustedCallback | undefined;
  readonly interpolation: boolean;

  private _fadeCurve: EasingName | EasingFn;
  private _fadeFn: EasingFn;

  // ---- Per-slot state ----
  private _pos: Vector3[] = [];
  private _vel: Vector3[] = [];
  private _acc: Vector3[] = [];
  private _delay: Float64Array = EMPTY_F64;
  private _life: Float64Array = EMPTY_F64;
  private _payload: Float64Array = EMPTY_F64;
  private _emitter: Float64Array = EMPTY_F64;
  private _scale: Float64Array = EMPTY_F64;
  private _color: Float32Array = EMPTY_F32;
  /** Sync generation each slot was last spawned in; see `spawnedSinceSync`. */
  private _spawnGen: Float64Array = EMPTY_F64;
  /** Start-of-step positions, `3 × capacity`, only with `interpolation`. */
  private _prev: Float64Array | null = null;

  // ---- Sparse set ----
  private _dense: Int32Array = EMPTY_I32;
  private _slotToDense: Int32Array = EMPTY_I32;
  private _free: Int32Array = EMPTY_I32;
  private _freeTop = 0;
  private _denseCount = 0;
  private _highWater = 0;
  private _capacity = 0;

  // ---- Counters ----
  /** Next emitter id. Monotonic from `1`; `0` is never issued. */
  private _nextEmitterId = 1;
  private _stepCount = 0;

  // ---- Render sync bookkeeping ----
  private _pendMin = 0;
  private _pendMax = -1;
  private _syncGen = 1;

  // ---- Scratch (allocated once) ----
  private readonly _origin = new Vector3();
  private readonly _tmpColor = new Color();

  private _warnedBadDt = false;

  /** @internal The render sink of an owning `<BulletField>`; `null` headless. */
  _sink: SimulationSink | null = null;
  /** @internal Slot span the most recent spawn / step / clear / consume wrote. */
  _opMin = 0;
  /** @internal See {@link _opMin}; `-1` when it wrote nothing. */
  _opMax = -1;
  /** @internal Bullets the most recent {@link _burst}'s pattern asked for. */
  _lastRequested = 0;

  constructor(options: BulletSimulationOptions = {}) {
    this.boundsLimit = options.boundsLimit ?? 25;
    this.boundsCenter = options.boundsCenter;
    this.fadeTime = options.fadeTime ?? 1;
    this._fadeCurve = options.fadeCurve ?? 'linear';
    this._fadeFn = resolveEasing(this._fadeCurve);
    this.onPoolExhausted = options.onPoolExhausted;
    this.interpolation = options.interpolation === true;
    this._reset(options.maxBullets ?? 2000);
  }

  get fadeCurve(): EasingName | EasingFn {
    return this._fadeCurve;
  }

  set fadeCurve(curve: EasingName | EasingFn) {
    // Resolve first, so an unknown name throws and leaves the old curve intact.
    this._fadeFn = resolveEasing(curve);
    this._fadeCurve = curve;
  }

  get capacity(): number {
    return this._capacity;
  }

  get activeCount(): number {
    return this._denseCount;
  }

  get stepCount(): number {
    return this._stepCount;
  }

  /**
   * Decays to `0` when read while the pool is empty — the lazy reset the
   * field's `mesh.count` sync has always applied, kept lazy so the field's
   * draw count is exactly what it was.
   */
  get highWater(): number {
    if (this._denseCount === 0) this._highWater = 0;
    return this._highWater;
  }

  get dirtyMin(): number {
    return this._pendMin;
  }

  get dirtyMax(): number {
    return this._pendMax;
  }

  // ---- Pool lifecycle ------------------------------------------------------

  /**
   * @internal (Re)initialize the pool at `capacity`, freeing every slot.
   * Reallocates only when the capacity changes; the emitter-id counter is
   * never reset. `<BulletField>` calls this from its mount / `maxBullets`
   * effect — release site 5, mass release.
   */
  _reset(capacity: number): void {
    if (capacity !== this._capacity) {
      const pos: Vector3[] = new Array(capacity);
      const vel: Vector3[] = new Array(capacity);
      const acc: Vector3[] = new Array(capacity);
      for (let i = 0; i < capacity; i++) {
        pos[i] = new Vector3();
        vel[i] = new Vector3();
        acc[i] = new Vector3();
      }
      this._pos = pos;
      this._vel = vel;
      this._acc = acc;
      this._delay = new Float64Array(capacity);
      this._life = new Float64Array(capacity);
      this._payload = new Float64Array(capacity);
      this._emitter = new Float64Array(capacity);
      this._scale = new Float64Array(capacity).fill(1);
      this._color = new Float32Array(capacity * 3);
      this._spawnGen = new Float64Array(capacity);
      this._prev = this.interpolation ? new Float64Array(capacity * 3) : null;
      this._dense = new Int32Array(capacity);
      this._slotToDense = new Int32Array(capacity);
      this._free = new Int32Array(capacity);
      this._capacity = capacity;
    }
    this._slotToDense.fill(-1);
    // Filled descending so the LIFO pops 0, 1, 2, … on a fresh pool.
    const free = this._free;
    for (let i = 0; i < capacity; i++) free[i] = capacity - 1 - i;
    this._freeTop = capacity;
    this._denseCount = 0;
    this._highWater = 0;
    this._pendMin = 0;
    this._pendMax = -1;
    this._syncGen++;
    this._opMin = 0;
    this._opMax = -1;
  }

  /** Pop a free slot and append it to `dense`. `-1` when full. */
  private _acquireSlot(): number {
    if (this._freeTop === 0) return -1;
    const slot = this._free[--this._freeTop];
    const d = this._denseCount++;
    this._dense[d] = slot;
    this._slotToDense[slot] = d;
    if (slot >= this._highWater) this._highWater = slot + 1;
    return slot;
  }

  /** Swap-remove `slot` from `dense` and push it on the free stack. */
  private _releaseSlot(slot: number): void {
    const d = this._slotToDense[slot];
    if (d < 0) return; // already free — never double-push
    const last = this._dense[--this._denseCount];
    this._dense[d] = last;
    this._slotToDense[last] = d;
    this._slotToDense[slot] = -1;
    this._free[this._freeTop++] = slot;
  }

  /** Record an operation's slot span: as the last op, and into the sync range. */
  private _endOp(min: number, max: number): void {
    this._opMin = min;
    this._opMax = max;
    if (max < min) return;
    if (this._pendMax < this._pendMin) {
      this._pendMin = min;
      this._pendMax = max;
      return;
    }
    if (min < this._pendMin) this._pendMin = min;
    if (max > this._pendMax) this._pendMax = max;
  }

  // ---- Spawning -------------------------------------------------------------

  /**
   * @internal Spawn already-resolved `spawnData` at `origin`. Returns the
   * number spawned; the span written lands in `_opMin` / `_opMax`. O(burst).
   *
   * `zeroVelocity` (the reduced-motion snapshot) freezes the bullets but still
   * primes the sink's heading from the pattern's velocity, so frozen arrows
   * point where the pattern aimed them. `cap` truncates the burst; it is
   * checked before the free stack is touched, which is what lets the caller
   * tell a cap-bound burst from a pool-bound one.
   */
  _spawn(
    origin: Vector3Like,
    spawnData: BulletSpawnData[],
    emitterId: number,
    zeroVelocity: boolean,
    cap?: number,
  ): number {
    const o = this._origin;
    o.x = origin.x;
    o.y = origin.y;
    o.z = origin.z;
    const sink = this._sink;
    const prev = this._prev;
    const color = this._tmpColor;
    let spawned = 0;
    let minSlot = 0;
    let maxSlot = -1;
    for (let d = 0; d < spawnData.length; d++) {
      if (cap !== undefined && spawned >= cap) break;

      const slot = this._acquireSlot();
      if (slot === -1) break; // pool exhausted: drop the newest, never a live one

      if (maxSlot < 0) {
        minSlot = slot;
        maxSlot = slot;
      } else if (slot < minSlot) {
        minSlot = slot;
      } else if (slot > maxSlot) {
        maxSlot = slot;
      }

      const data = spawnData[d];
      const p = this._pos[slot];
      const v = this._vel[slot];
      p.copy(o).add(data.offset);
      this._delay[slot] = data.delay;
      this._life[slot] = data.life;
      this._payload[slot] = data.payload;
      this._emitter[slot] = emitterId;
      // No `?? 1`: `scale` is required on `BulletSpawnData` and `acquire()`
      // resets it, so a `??` would only turn a compile error into a silent path.
      this._scale[slot] = data.scale;

      if (zeroVelocity) {
        v.set(0, 0, 0);
        this._acc[slot].set(0, 0, 0);
      } else {
        v.copy(data.velocity);
        this._acc[slot].copy(data.acceleration);
      }

      // `color` is genuinely nullable, so it keeps its default here.
      color.set(data.color ?? 0xff3333);
      const c = slot * 3;
      this._color[c] = color.r;
      this._color[c + 1] = color.g;
      this._color[c + 2] = color.b;
      this._spawnGen[slot] = this._syncGen;

      if (prev !== null) {
        prev[c] = p.x;
        prev[c + 1] = p.y;
        prev[c + 2] = p.z;
      }

      if (sink !== null) {
        sink.spawned(slot, color, data.velocity);
        // A spawn-time "show" carries the bullet's own scale and no fade: for
        // a reduced-motion snapshot or a spawn into a paused field it is the
        // only matrix the bullet ever gets.
        if (this._delay[slot] <= 0) sink.show(slot, p, v, this._scale[slot]);
        else sink.hide(slot);
      }

      spawned++;
    }
    this._endOp(minSlot, maxSlot);
    return spawned;
  }

  /**
   * @internal Resolve `pattern`, spawn it, and return the spawn data to the
   * pool. Returns the number spawned; the number requested is left in
   * `_lastRequested`. Reports nothing — which constraint bound is the
   * caller's to say.
   */
  _burst(
    origin: Vector3Like,
    pattern: PatternKey | PatternFactory,
    emitterId: number,
    zeroVelocity: boolean,
    cap?: number,
  ): number {
    const spawnData = resolvePattern(pattern);
    this._lastRequested = spawnData.length;
    const spawned = this._spawn(origin, spawnData, emitterId, zeroVelocity, cap);
    releaseSpawnData(spawnData);
    return spawned;
  }

  fireAt(
    origin: Vector3Like,
    pattern: PatternKey | PatternFactory,
    emitterId = 0,
  ): number {
    // `emitterId` is an open parameter, so keep the counter an upper bound on
    // every id ever seen: a later `acquireEmitter()` can then never return an
    // id that bullets in flight already carry. `0` is always below the floor.
    if (emitterId >= this._nextEmitterId) this._nextEmitterId = emitterId + 1;

    const spawned = this._burst(origin, pattern, emitterId, false);
    const requested = this._lastRequested;
    const cb = this.onPoolExhausted;
    if (cb && spawned < requested) cb(emitterId, requested, spawned, 'pool-full');
    return spawned;
  }

  acquireEmitter(): number {
    return this._nextEmitterId++;
  }

  releaseEmitter(id: number): void {
    if (id >= this._nextEmitterId) this._nextEmitterId = id + 1;
  }

  // ---- Stepping -------------------------------------------------------------

  step(dt: number): void {
    if (!(dt > 0 && dt < Infinity)) {
      if (dt !== 0 && DEV && !this._warnedBadDt) {
        this._warnedBadDt = true;
        console.warn(
          `[r3f-projectiles] BulletSimulation.step(${dt}) ignored: dt must be a ` +
            'finite number of seconds greater than 0.',
        );
      }
      return;
    }
    this._advance(dt);
  }

  /**
   * @internal One step of exactly `dt`, unvalidated — `<BulletField>`'s auto
   * loop steps by its clamped frame delta, which may legitimately be `0`.
   *
   * Reads nothing but the pool, the config and `dt`; that is the whole of the
   * determinism guarantee.
   */
  _advance(dt: number): void {
    const sink = this._sink;
    const prev = this._prev;
    const fadeSeconds = this.fadeTime;
    const fadeFn = this._fadeFn;

    // Bounds: a per-axis test against a cube of half-extent `boundsLimit`,
    // centred on `boundsCenter` — read ONCE per step — or on the origin. With
    // no centre the subtraction is `x - 0`, exactly `x` in IEEE arithmetic.
    // `Infinity` skips the test.
    const limit = this.boundsLimit;
    const cullBounds = limit !== Infinity;
    const center = this._readCenter();
    const cx = center ? center.x : 0;
    const cy = center ? center.y : 0;
    const cz = center ? center.z : 0;

    const pos = this._pos;
    const vel = this._vel;
    const acc = this._acc;
    const delay = this._delay;
    const life = this._life;
    const scale = this._scale;
    const dense = this._dense;
    let minSlot = 0;
    let maxSlot = -1;

    // O(active). BACKWARDS, because the despawn branch swap-removes mid-walk.
    for (let d = this._denseCount - 1; d >= 0; d--) {
      const i = dense[d];

      if (delay[i] > 0) {
        delay[i] -= dt;
        if (delay[i] > 0) continue; // still waiting, still hidden
        // Delay just ended — fall through to the normal update.
      }

      const p = pos[i];
      const v = vel[i];
      if (prev !== null) {
        const o = i * 3;
        prev[o] = p.x;
        prev[o + 1] = p.y;
        prev[o + 2] = p.z;
      }

      // Semi-implicit Euler: velocity first, then position with the new velocity.
      v.addScaledVector(acc[i], dt);
      p.addScaledVector(v, dt);
      life[i] -= dt;
      const left = life[i];

      if (
        left <= 0 ||
        (cullBounds &&
          (Math.abs(p.x - cx) > limit ||
            Math.abs(p.y - cy) > limit ||
            Math.abs(p.z - cz) > limit))
      ) {
        // ---- Release sites 1 (lifetime expiry) and 2 (out of bounds) ----
        if (sink !== null) sink.hide(i);
        if (maxSlot < 0) {
          minSlot = i;
          maxSlot = i;
        } else if (i < minSlot) {
          minSlot = i;
        } else if (i > maxSlot) {
          maxSlot = i;
        }
        this._releaseSlot(i);
        continue;
      }

      // The fade composes with the bullet's own scale. Visual only — the test
      // above is the sole authority on lifetime — so a sinkless simulation
      // skips it entirely and a renderer asks `fadeAt` instead.
      if (sink !== null) {
        sink.show(i, p, v, fadeScale(left, fadeSeconds, fadeFn) * scale[i]);
      }
      if (maxSlot < 0) {
        minSlot = i;
        maxSlot = i;
      } else if (i < minSlot) {
        minSlot = i;
      } else if (i > maxSlot) {
        maxSlot = i;
      }
    }

    this._stepCount++;
    this._endOp(minSlot, maxSlot);
  }

  private _readCenter(): Vector3Like | null | undefined {
    const src = this.boundsCenter;
    if (!src) return null;
    if (typeof src === 'function') return src();
    if ('current' in src) return src.current;
    return src;
  }

  // ---- Consuming and clearing ----------------------------------------------

  clear(emitterId?: number): number {
    const fieldWide = emitterId === undefined;
    const sink = this._sink;
    const dense = this._dense;
    let minSlot = 0;
    let maxSlot = -1;
    let released = 0;
    // ---- Release site 4 ---- BACKWARDS: see the class comment.
    for (let d = this._denseCount - 1; d >= 0; d--) {
      const i = dense[d];
      if (!fieldWide && this._emitter[i] !== emitterId) continue;
      if (sink !== null) sink.hide(i);
      if (maxSlot < 0) {
        minSlot = i;
        maxSlot = i;
      } else if (i < minSlot) {
        minSlot = i;
      } else if (i > maxSlot) {
        maxSlot = i;
      }
      this._releaseSlot(i);
      released++;
    }
    this._endOp(minSlot, maxSlot);
    return released;
  }

  activeCountFor(emitterId: number): number {
    const dense = this._dense;
    const emitter = this._emitter;
    let n = 0;
    for (let d = this._denseCount - 1; d >= 0; d--) {
      if (emitter[dense[d]] === emitterId) n++;
    }
    return n;
  }

  forEachActive(cb: ForEachActiveCallback): void {
    const sink = this._sink;
    const dense = this._dense;
    const delay = this._delay;
    const pos = this._pos;
    const payload = this._payload;
    const emitter = this._emitter;
    let minSlot = 0;
    let maxSlot = -1;
    // BACKWARDS — release site 3 consumes mid-walk. A spawn from inside `cb`
    // appends at or above the cursor, ground the walk has already covered, so
    // it is never visited and never clobbers an unvisited entry.
    for (let d = this._denseCount - 1; d >= 0; d--) {
      const i = dense[d];
      if (delay[i] > 0) continue; // a hit test never lands on a parked bullet
      if (cb(i, pos[i], payload[i], emitter[i]) === true) {
        this._releaseSlot(i);
        if (sink !== null) sink.hide(i);
        if (maxSlot < 0) {
          minSlot = i;
          maxSlot = i;
        } else if (i < minSlot) {
          minSlot = i;
        } else if (i > maxSlot) {
          maxSlot = i;
        }
      }
    }
    this._endOp(minSlot, maxSlot);
  }

  setPayload(index: number, payload: number): void {
    // `-1` for a free slot, `undefined` for an index outside the pool or not
    // an integer: one negated comparison rejects all of them.
    if (!(this._slotToDense[index] >= 0)) return;
    this._payload[index] = payload;
  }

  // ---- Hashing -------------------------------------------------------------

  writeStateHash(out: number[]): void {
    if (this._denseCount === 0) return;
    const s2d = this._slotToDense;
    for (let i = 0, n = this._highWater; i < n; i++) {
      if (s2d[i] < 0) continue;
      const p = this._pos[i];
      const v = this._vel[i];
      out.push(
        i,
        p.x,
        p.y,
        p.z,
        v.x,
        v.y,
        v.z,
        this._life[i],
        this._payload[i],
        this._emitter[i],
      );
    }
  }

  hashState(): number {
    let h = mixDouble(FNV_OFFSET, this._denseCount);
    if (this._denseCount === 0) return h >>> 0;
    const s2d = this._slotToDense;
    for (let i = 0, n = this._highWater; i < n; i++) {
      if (s2d[i] < 0) continue;
      const p = this._pos[i];
      const v = this._vel[i];
      h = mixDouble(h, i);
      h = mixDouble(h, p.x);
      h = mixDouble(h, p.y);
      h = mixDouble(h, p.z);
      h = mixDouble(h, v.x);
      h = mixDouble(h, v.y);
      h = mixDouble(h, v.z);
      h = mixDouble(h, this._life[i]);
      h = mixDouble(h, this._payload[i]);
      h = mixDouble(h, this._emitter[i]);
    }
    return h >>> 0;
  }

  // ---- Read access ---------------------------------------------------------

  isLive(index: number): boolean {
    return this._slotToDense[index] >= 0;
  }

  isVisible(index: number): boolean {
    return this._slotToDense[index] >= 0 && !(this._delay[index] > 0);
  }

  positionAt(index: number): Readonly<Vector3> {
    return this._pos[index];
  }

  velocityAt(index: number): Readonly<Vector3> {
    return this._vel[index];
  }

  previousPositionAt(index: number, out: Vector3): Vector3 {
    const prev = this._prev;
    if (prev === null) return out.copy(this._pos[index]);
    const o = index * 3;
    return out.set(prev[o], prev[o + 1], prev[o + 2]);
  }

  lifeAt(index: number): number {
    return this._life[index];
  }

  delayAt(index: number): number {
    return this._delay[index];
  }

  payloadAt(index: number): number {
    return this._payload[index];
  }

  emitterIdAt(index: number): number {
    return this._emitter[index];
  }

  scaleAt(index: number): number {
    return this._scale[index];
  }

  fadeAt(index: number): number {
    return fadeScale(this._life[index], this.fadeTime, this._fadeFn);
  }

  colorAt(index: number, out: Color): Color {
    const c = index * 3;
    out.r = this._color[c];
    out.g = this._color[c + 1];
    out.b = this._color[c + 2];
    return out;
  }

  // ---- Render sync -----------------------------------------------------------

  spawnedSinceSync(index: number): boolean {
    return this._spawnGen[index] === this._syncGen;
  }

  markSynced(): void {
    this._pendMin = 0;
    this._pendMax = -1;
    this._syncGen++;
  }
}
