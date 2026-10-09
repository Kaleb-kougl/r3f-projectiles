import {
  useRef,
  useMemo,
  useEffect,
  useImperativeHandle,
  createContext,
  forwardRef,
  type ReactNode,
} from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Object3D,
  Color,
  Vector3,
  DynamicDrawUsage,
  type BufferGeometry,
  type InstancedMesh as InstancedMeshType,
} from 'three';
import { useBulletRender } from './render/useBulletRender';
import type { BulletOrient } from './render/orient';
import type { BulletOutline } from './render/outline';
import { resolvePattern } from './presets';
import { resolveEasing, fadeScale } from './easing';
import { releaseSpawnData } from './pool';
import type {
  BulletSpawnData,
  EasingFn,
  EasingName,
  PatternFactory,
  PatternKey,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bullet cap under reduced-motion mode to keep the static snapshot modest. */
const REDUCED_MOTION_MAX = 200;

/** Floats per instance matrix — the stride `instanceMatrix` update ranges use. */
const MATRIX_STRIDE = 16;

/** Shared placeholder so the sparse-set refs are never null before pool init. */
const EMPTY_SLOTS = new Int32Array(0);

// ---------------------------------------------------------------------------
// GPU helpers
// ---------------------------------------------------------------------------

/**
 * Flag `instanceMatrix` dirty over **only** the slot span actually written.
 *
 * `[minSlot, maxSlot]` is a contiguous superset of the (possibly scattered)
 * slots touched by the caller, so it can never under-report a write. three
 * merges and sorts accumulated ranges itself before uploading, and clears them
 * once the upload lands — so ranges added by paths that run between two frames
 * (`fire()` while paused, `clear()`, `forEachActive`) accumulate correctly
 * rather than shadowing each other.
 *
 * **Every** site that sets `instanceMatrix.needsUpdate` must go through here.
 * A site that flagged the attribute dirty without contributing a range would
 * have its writes skipped whenever some other site had left a range pending.
 *
 * `addUpdateRange` is three r159+. The package's peer range allows older
 * builds; there the method is simply absent and the whole buffer uploads —
 * exactly the pre-existing behaviour, so no fallback is needed.
 */
function markMatrixDirty(
  mesh: InstancedMeshType,
  minSlot: number,
  maxSlot: number,
): void {
  if (maxSlot < minSlot) return;
  const attr = mesh.instanceMatrix;
  if (typeof attr.addUpdateRange === 'function') {
    attr.addUpdateRange(
      minSlot * MATRIX_STRIDE,
      (maxSlot - minSlot + 1) * MATRIX_STRIDE,
    );
  }
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Exhaustion reporting
// ---------------------------------------------------------------------------

/**
 * Why a burst was short-changed — the fourth argument to
 * {@link BulletFieldProps.onPoolExhausted}.
 *
 * The two are worth telling apart because the remedies are different, and one
 * of them is "nothing":
 *
 * - `'pool-full'` — the shared slot pool had no free slots left. The honest
 *   fixes are the blunt ones: raise `maxBullets`, or slow the greedy emitter's
 *   `fireRate`. Raised by every spawn path.
 * - `'reduced-motion-budget'` — the field-wide 200-bullet reduced-motion
 *   snapshot budget was spent by earlier emitters, so this one was truncated
 *   in registration order. **The cap is not configurable**, and the pool
 *   itself may be nearly empty, so `maxBullets` is not the lever here — this
 *   reason exists so a consumer can stop reaching for it. Raised only from the
 *   reduced-motion snapshot path, and only when the budget (not the pool) was
 *   the binding constraint.
 */
export type PoolExhaustionReason = 'pool-full' | 'reduced-motion-budget';

/**
 * Raise {@link BulletFieldProps.onPoolExhausted} for one burst, if it was
 * short-changed and anyone is listening.
 *
 * Deliberately **once per burst**. Every spawn path calls this exactly once,
 * immediately after `spawnBullets` returns — the single point where both the
 * requested count and the spawned count are in hand. Pushing the check down
 * into the spawn loop instead would produce one callback per dropped bullet:
 * 100 calls in one frame for a 100-bullet burst into a full pool, in a callback
 * a consumer is likely to log or count from.
 *
 * The `reason` is the caller's to decide, because only the caller knows which
 * constraint bound: every path but the reduced-motion snapshot can only ever
 * run out of slots, and that one has two ways to come up short.
 *
 * Module scope, not a closure in the component: a second hook in this file
 * switches on the React Compiler lint pass for the whole module, which then
 * rejects the frame loop's deliberate mutations.
 */
function reportExhaustion(
  cb:
    | ((
        emitterId: number,
        requested: number,
        spawned: number,
        reason: PoolExhaustionReason,
      ) => void)
    | undefined,
  emitterId: number,
  requested: number,
  spawned: number,
  reason: PoolExhaustionReason,
): void {
  if (cb && spawned < requested) cb(emitterId, requested, spawned, reason);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BulletState {
  position: Vector3;
  velocity: Vector3;
  acceleration: Vector3;
  delay: number;
  life: number;
  /** Opaque per-bullet integer, copied from spawn data; never interpreted here. */
  payload: number;
  /**
   * Which emitter fired this bullet. Field-issued at registration and never
   * recycled, so a bullet stays correctly attributed even after its emitter
   * unregisters and its id is retired. `0` means "anonymous".
   */
  emitterId: number;
  /**
   * Per-bullet size multiplier, copied from spawn data. Multiplied into every
   * matrix write that shows the bullet — the spawn-time write and the per-frame
   * fade write — never into the writes that hide one.
   */
  scale: number;
}

/**
 * Props for the public `<Emitter>` component — the five of `<BulletManager>`'s
 * seventeen that describe an emitter rather than the field.
 *
 * All optional, and the defaults are applied by `<Emitter>` itself. They are
 * the same values `<BulletManager>` has always documented, and they now live in
 * exactly one place: `<BulletManager>` forwards whatever it was given, `undefined`
 * included, rather than defaulting a second time.
 */
export interface EmitterProps {
  /**
   * Which pattern to fire — a built-in {@link PatternKey} or a custom
   * {@link PatternFactory}. @default 'fibonacciSphere'
   */
  pattern?: PatternKey | PatternFactory;
  /** Shots per second. @default 1.5 */
  fireRate?: number;
  /**
   * Emitter origin, read fresh from `.current` at each shot, so a moving source
   * keeps up. When omitted (or `.current` is `null`) the built-in Y-axis orbit
   * drives auto-fire and `(0, spawnCenterY, 0)` is the static fallback.
   */
  origin?: { readonly current: Vector3 | null };
  /** Y-coordinate of this emitter's static spawn centre. @default 3 */
  spawnCenterY?: number;
  /** Radians per second for the built-in orbit. @default 0.3 */
  rotationSpeed?: number;
}

/**
 * {@link EmitterProps} after `<Emitter>` has applied its defaults — the shape
 * the frame loop actually reads.
 *
 * Held as a live view that the entry's owner overwrites on every render — the
 * same `propsRef` discipline the frame loop uses for field props, so `useFrame`
 * never reads a stale closure and a re-render never re-registers anything.
 *
 * Required-except-`origin` on purpose: the loop must never have to re-apply a
 * default, which is how a default would end up living in two places.
 */
export interface ResolvedEmitterProps {
  pattern: PatternKey | PatternFactory;
  fireRate: number;
  /** Read fresh from `.current` at each shot, so a moving source keeps up. */
  origin?: { readonly current: Vector3 | null };
  spawnCenterY: number;
  rotationSpeed: number;
}

/**
 * One registered emitter. Everything an emitter owns that survives across
 * frames lives here rather than on the field, so N emitters keep N independent
 * cadences, N orbit phases, and N reduced-motion snapshots.
 *
 * The object identity is the registry key: build it once (a `useRef`), mutate
 * `props` in place on render, and never swap it.
 */
export interface EmitterEntry {
  props: ResolvedEmitterProps;
  /**
   * Provenance id, **issued by the field**, not by the entry's owner.
   * `register()` stamps the next value of a monotonic counter that starts at
   * `1` and never recycles; `unregister()` retires it without touching this
   * emitter's in-flight bullets, which keep the id they were stamped with.
   *
   * `0` until the field has seen this entry, and `0` is the reserved
   * "anonymous" id — so a burst fired before registration lands anonymously
   * rather than being attributed to whichever emitter registers next.
   */
  id: number;
  /** Seconds accumulated toward the next auto-shot. Only `clear()` resets it. */
  timeAccum: number;
  /** Phase of the built-in Y-axis orbit, advanced only when no `origin` ref. */
  sourceRotation: number;
  /** Reduced-motion "already snapshotted" guard — per emitter, not per field. */
  reducedMotionSpawned: boolean;
}

/**
 * The imperative registration surface. Purely imperative by design: registering
 * must never trigger a re-render, so this is a stable object holding two
 * functions rather than anything that lives in React state.
 *
 * Service order is registration order, which is mount order, which is JSX
 * order. An emitter that unmounts and remounts therefore lands at the **tail**
 * of the registry, and so takes last priority when the pool is exhausted.
 */
export interface EmitterRegistry {
  /**
   * Add an emitter to the service order **and issue it a provenance id**.
   * Registration *is* the acquire, and there is no `id` prop on `<Emitter>`,
   * because a caller-supplied id could collide with a live one and let one
   * emitter clear another's bullets.
   *
   * It stamps `entry.id` rather than returning a number, because the frame loop
   * reads the id off the entry. That is why the imperative path needs its own
   * `acquireEmitter()` rather than reusing this: same counter, but a caller
   * holding no entry has nothing for `register` to stamp.
   */
  register(entry: EmitterEntry): void;
  /**
   * Remove an emitter from the service order and retire its id. Deliberately
   * does **not** clear its bullets: those stay in flight and keep the id they
   * were stamped with, which is what makes the id trustworthy provenance.
   */
  unregister(entry: EmitterEntry): void;
}

/**
 * The field's **public** imperative surface — what a `ref` on `<BulletField>`
 * receives, and nothing more.
 *
 * It is deliberately narrower than the object behind it. The registry plumbing
 * (`register` / `unregister` / `fire`) is on {@link EmitterRegistryHandle},
 * which this does not extend, for one concrete reason: all three take an
 * {@link EmitterEntry}, and `EmitterEntry` is not exported from the package
 * barrel. A public type naming a type consumers cannot import is not a public
 * type — and `fire(entry)` in particular reads as the obvious way to fire an
 * emitter while being precisely the one method a consumer cannot call. The
 * consumer-facing way to fire an `<Emitter>` is a `ref` on the `<Emitter>`
 * itself; the way to fire without one is {@link fireAt}.
 *
 * The split is type-level only. At runtime there is a single handle object,
 * built once by `useMemo` and handed to both `useImperativeHandle` and the
 * registry provider — see {@link EmitterRegistryContext} for why that identity
 * must stay stable.
 *
 * ## Two consumption paths
 * `<Emitter>` suits stable, few, declarative emitters: a player's weapon, a
 * fixed turret. It does **not** suit a swarm — mounting a React component per
 * enemy reintroduces exactly the per-entity churn pooled games exist to avoid.
 * So this handle also spawns directly: a game with 100 archers calls
 * {@link acquireEmitter} per archer, {@link fireAt} from its own frame loop, and
 * {@link releaseEmitter} on death. No components, no mount churn, no cap.
 *
 * Both paths draw from the same pool and the same monotonic id counter, so
 * provenance is comparable across them.
 */
export interface BulletFieldHandle {
  /**
   * Spawn one burst at an arbitrary origin, attributed to `emitterId`. The
   * imperative counterpart of `<Emitter>`: for consumers whose emitters are
   * pool rows rather than components.
   *
   * `origin` is read once and copied; the field never retains it. Like
   * {@link EmitterRegistryHandle.fire} this works while the field is paused and
   * flushes inline, and it advances no cadence — there is no cadence to
   * advance.
   *
   * @param emitterId - Provenance for the burst. Defaults to the reserved
   * anonymous id `0`, so a consumer that does not care about provenance can
   * ignore {@link acquireEmitter} entirely. `clear(0)` then clears exactly the
   * anonymous bullets and nothing else.
   */
  fireAt(
    origin: Vector3,
    pattern: PatternKey | PatternFactory,
    emitterId?: number,
  ): void;
  /**
   * Issue a fresh provenance id for an emitter that is not a component.
   *
   * A second entry point onto the very counter {@link EmitterRegistry.register}
   * uses — not a second counter, and not the same method: `register` stamps
   * `entry.id` because the frame loop has to be able to read it, so it cannot
   * also be the function that returns an id to a caller holding no entry.
   *
   * Ids start at `1`, are **never** recycled, and `0` is never issued. So the
   * returned id cannot collide with a live emitter's, cannot inherit a dead
   * one's in-flight bullets, and cannot be used to clear them.
   */
  acquireEmitter(): number;
  /**
   * Retire an id issued by {@link acquireEmitter}.
   *
   * Deliberately does **not** clear that emitter's bullets: they stay in
   * flight, keep the id they were stamped with, and stay correctly attributed
   * in {@link forEachActive} for the rest of their lives. A dying archer that
   * wants its bullets gone calls `clear(id)` first; one that wants them to
   * finish their flight does not. Separating the two is the whole point of
   * provenance.
   */
  releaseEmitter(id: number): void;
  /**
   * Deactivate bullets and reset the matching emitter cadence(s).
   *
   * **Field-wide (`clear()`)** resets every piece of per-emitter frame state
   * the field owns: every registered emitter's cadence timer, every
   * reduced-motion snapshot guard, and the shared reduced-motion budget. All
   * three, together — the one-emitter `<BulletManager>` wrapper is only
   * faithful because the pre-split `clear()` reset all three at once.
   *
   * **Per-emitter (`clear(id)`)** touches only that emitter: its bullets, its
   * cadence, its snapshot guard. Every other emitter's bullets are untouched,
   * which is the cross-emitter invariant this library is built on — no emitter
   * can ever destroy another's bullets, by any route.
   */
  clear(emitterId?: number): void;
  /** Number of bullets currently alive, across every emitter. */
  readonly activeCount: number;
  /**
   * How many live bullets carry `emitterId`. O(active), and the way a consumer
   * observes the first-come-first-served pool without walking it themselves.
   */
  activeCountFor(emitterId: number): number;
  forEachActive: (
    cb: (
      index: number,
      pos: Vector3,
      payload: number,
      emitterId: number,
    ) => boolean | void,
  ) => void;
}

/**
 * The whole handle object — {@link BulletFieldHandle} plus the plumbing an
 * `<Emitter>` needs — and therefore the type the registry context carries.
 *
 * **Internal.** Not barrelled, and it must not become so while it names
 * {@link EmitterEntry}. It exists only so the ref type can stay narrow without
 * the runtime object being split in two: `useMemo` builds one object of this
 * type, the provider takes it as-is, and `useImperativeHandle` hands the same
 * object out through the narrower {@link BulletFieldHandle}.
 */
export interface EmitterRegistryHandle
  extends BulletFieldHandle,
    EmitterRegistry {
  /**
   * Spawn one burst for `entry`, right now. This is how `<Emitter>` implements
   * its own `fire()`; consumers reach it through that ref, or use
   * {@link BulletFieldHandle.fireAt}.
   *
   * Deliberately **not** the same operation the frame loop performs, and the
   * differences are load-bearing (they are what `<BulletManager>.fire()` has
   * always done): the origin falls back to a static `(0, spawnCenterY, 0)`
   * rather than the orbit, neither `timeAccum` nor `sourceRotation` advances,
   * it works while the field is paused, and it flushes `needsUpdate` inline —
   * because a paused field's frame loop will never flush for it.
   */
  fire(entry: EmitterEntry): void;
}

// ---------------------------------------------------------------------------
// Registry context
// ---------------------------------------------------------------------------

/**
 * How an `<Emitter>` reaches the field it is rendered inside.
 *
 * The value is the field's own imperative handle object — the same object a
 * `ref` on `<BulletField>` receives, seen through the wider
 * {@link EmitterRegistryHandle} rather than the public
 * {@link BulletFieldHandle}, and built once by `useMemo` so the context value
 * is referentially stable for the life of the field. That stability is
 * what keeps `<Emitter>`'s registration effect from ever re-running, which is
 * what keeps a re-render from silently moving an emitter to the tail of the
 * service order.
 *
 * It carries the {@link EmitterRegistry} pair plus `fire`, because
 * `<Emitter>`'s own `fire()` handle has to reach the field's spawn path and
 * context is the only channel a child has back to its provider.
 *
 * Exported as the raw context rather than wrapped in a `useEmitterRegistry`
 * hook on purpose: a second hook in this file switches on the React Compiler's
 * lint pass for the whole module, which then rejects the two deliberate
 * mutations the frame loop is built on (the `propsRef` write during render and
 * the reused `_spawnRange` out-param). `<Emitter>` does the `useContext` and
 * the null check itself. Internal either way — neither is barrelled.
 */
export const EmitterRegistryContext =
  createContext<EmitterRegistryHandle | null>(null);

/**
 * Field-level props: everything that describes the shared mesh, the shared
 * pool, or the whole-field simulation. The emitter-level half of the split
 * lives in {@link EmitterProps}.
 *
 * **Defaults live here**, applied by `<BulletField>`'s own destructuring, and
 * nowhere else. Through phase 3 they lived in `<BulletManager>` and this
 * interface was required-except-`children`, on the reasoning that defaulting in
 * both places is two places to drift. Now that `<BulletField>` is public it
 * needs usable defaults of its own, and the way to avoid the drift is to move
 * them down rather than copy them: the wrapper forwards what it was handed,
 * `undefined` included, and a `undefined` prop is exactly what triggers the
 * default below. `<BulletManager>`'s documented values are unchanged.
 */
export interface BulletFieldProps {
  /** Maximum number of concurrent bullet instances. @default 2000 */
  maxBullets?: number;
  /** Distance from origin at which bullets are deactivated. @default 25 */
  boundsLimit?: number;
  /** Radius of each bullet sphere. @default 0.12 */
  bulletRadius?: number;
  /** Seconds of fade-out at the end of a bullet's life. @default 1 */
  fadeTime?: number;
  /** Shape of the fade — an {@link EasingName} or your own {@link EasingFn}. @default 'linear' */
  fadeCurve?: EasingName | EasingFn;
  /** Freeze the simulation (bullets hold position). @default false */
  paused?: boolean;
  /** Spawn one static, zero-velocity snapshot per emitter, then freeze. @default false */
  reducedMotion?: boolean;
  /** Called once per frame with the current number of active bullets. */
  onBulletCount?: (count: number) => void;
  /**
   * Called when a burst could not be spawned in full because the shared pool
   * had no free slots left.
   *
   * The pool is first-come, first-served in registration order and **a full
   * field drops the newest burst** — it never recycles a live slot, because
   * recycling would rewrite the `payload` and `emitterId` of a bullet a
   * consumer may be holding an index to inside `forEachActive`. So exhaustion
   * is silent unless you ask, and this is how you ask.
   *
   * Raised **once per burst, not once per bullet**: a 100-bullet burst into a
   * full pool produces exactly one call, with `requested` 100 and `spawned`
   * however many slots were left. It fires from every spawn path — auto-fire,
   * `fire()`, `fireAt()`, and the reduced-motion snapshot, where a burst
   * truncated by the field-wide 200 cap reports the same way, because
   * exhaustion has one semantics in this library rather than two.
   *
   * That last case is what `reason` is for. One semantics is right; one
   * *remedy* would not be. A `'pool-full'` burst is a sign to raise
   * `maxBullets` or slow an emitter down; a `'reduced-motion-budget'` one is
   * not, because the 200 cap is deliberately not configurable — so without the
   * discriminator the only actionable response to the callback is a guess.
   *
   * @param emitterId - Who was firing. `0` for an anonymous `fireAt`.
   * @param requested - Bullets the pattern asked for.
   * @param spawned - Bullets that actually landed. Always `< requested` here.
   * @param reason - Which constraint bound. See {@link PoolExhaustionReason}.
   */
  onPoolExhausted?: (
    emitterId: number,
    requested: number,
    spawned: number,
    reason: PoolExhaustionReason,
  ) => void;
  /**
   * Material override for the shared mesh, rendered inside the single
   * `instancedMesh`. Defaults to `<meshBasicMaterial fog={false} />`.
   *
   * It is a prop rather than a child for two reasons: `children` is needed for
   * `<Emitter>` elements, and "one field, one material" is then stated by the
   * type signature instead of by a paragraph. Two materials means two fields —
   * so partition emitters by material, not by faction or entity type.
   */
  material?: ReactNode;
  /**
   * Bullet geometry, replacing the default `<sphereGeometry args={[bulletRadius,
   * 6, 6]} />`. See `bulletGeometry` for ready-made flat shapes.
   *
   * **Convention:** forward is local +X (what `orient="velocity"` aims), up is
   * local +Y (flat shapes lie in XZ facing +Y), and the shape is authored at
   * unit size — it is scaled by `bulletRadius`, and per bullet by `mod.scale`,
   * through the instance matrix.
   *
   * **Ownership stays with you.** The field attaches it and never disposes it,
   * on unmount or when the prop changes — so one geometry can be shared by any
   * number of fields, and you dispose it when you are done with it. Only the
   * default sphere, which the field creates, is the field's to dispose.
   */
  geometry?: BufferGeometry;
  /**
   * How each instance is rotated: `'none'` (today's behaviour), `'velocity'`
   * (local +X along the bullet's current velocity) or `'camera'` (billboard,
   * local +Y toward the camera). See {@link BulletOrient}. @default 'none'
   */
  orient?: BulletOrient;
  /**
   * A uniform-color rim drawn behind every bullet, by a second instanced mesh
   * sharing this field's `instanceMatrix` and `count` — one extra draw call and
   * no extra per-bullet CPU work. See {@link BulletOutline}. Omit for none.
   */
  outline?: BulletOutline;
  /**
   * The field's emitters — `<Emitter>` elements, which render nothing and
   * register themselves through the registry context this component provides.
   * Service order is registration order, which is mount order, which is the
   * order they appear here.
   *
   * Any node is accepted (nothing stops a consumer nesting other scene objects
   * under the field), but only `<Emitter>` participates in the frame loop.
   */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `<BulletField>` — the mesh, the pool, and the one frame loop.
 *
 * It owns everything that is shared between emitters, and emitters own
 * everything else:
 *
 * - one `<instancedMesh>`, one geometry, one material
 * - one slot pool, fronted by a sparse set (`dense` / `slotToDense` / `free`)
 * - one `useFrame`, which walks the emitter registry in registration order,
 *   services each due shot, then runs a single simulate + draw pass
 *
 * ```tsx
 * <BulletField maxBullets={2000} material={<meshStandardMaterial emissive="hotpink" />}>
 *   <Emitter origin={bossRef}   pattern={bossPattern}   fireRate={3} />
 *   <Emitter origin={turretRef} pattern={turretPattern} fireRate={1} />
 * </BulletField>
 * ```
 *
 * ## Two ways to spawn
 * Declarative `<Emitter>` children for stable, few emitters; the imperative
 * {@link BulletFieldHandle.fireAt} for swarms, whose emitters are pool rows
 * rather than components. They share the pool, the mesh, and the id counter.
 *
 * ## One field, one material — and one pool
 * Two materials means two `<BulletField>`s, which means two pools, which is the
 * cost this component exists to avoid. So **partition emitters by material, not
 * by faction or entity type**.
 *
 * ## Exhaustion
 * The pool is first-come, first-served in registration order, and a full field
 * drops the newest burst — never a live one. Observe it with
 * {@link BulletFieldProps.onPoolExhausted} and
 * {@link BulletFieldHandle.activeCountFor}.
 *
 * ## Performance characteristics
 * - **Allocation-free frame loop, with three named exceptions.** Every scratch
 *   `Vector3` / `Object3D` / `Color` is created once via `useMemo` and reused,
 *   so the loop allocates nothing per frame or per bullet *of its own*. Three
 *   allocations happen inside calls it makes, and the claim is only worth
 *   anything if they are named rather than rounded off:
 *   - **three's `addUpdateRange`** pushes one `{start, count}` record per dirty
 *     flush — so roughly one small, immediately-dead object on any frame that
 *     moved a bullet. **Kept on purpose**, and the trade is not close: that
 *     record is what turns an unconditional ~128 KB full-buffer upload into an
 *     upload of the slots actually written. Removing it would mean a range
 *     object reused in place, which cannot live at module scope beside
 *     {@link markMatrixDirty} (one record shared across every mounted field,
 *     each pushing it onto a different mesh's `updateRanges`, is an aliasing
 *     bug waiting to happen), so it would have to be threaded per-field through
 *     the helper — and it would still have to read `updateRanges` to work out
 *     whether three had consumed and cleared the previous one yet. That is a
 *     hard dependency on the renderer's upload timing, in a package whose peer
 *     range (`three >= 0.150`) includes builds with no `addUpdateRange` at all,
 *     bought for 32 bytes a frame.
 *   - **`resolvePattern`** returns a fresh array per burst, so a frame that
 *     spawns pays one array per emitter that fired. The `BulletSpawnData`
 *     objects inside are pooled and returned by `releaseSpawnData`; the array
 *     that holds them is not.
 *   - **The built-in pattern factories**, which go through `compose` and so
 *     allocate a rest-args array plus one modifier closure per call. Only a
 *     frame that spawns pays this, and a consumer-supplied `PatternFactory`
 *     pays whatever it does instead.
 * - **Frame-rate independent**: physics uses `addScaledVector(v, dt)` with
 *   `dt` clamped to `Math.min(delta, 0.1)`.
 * - **Batched GPU writes**: `needsUpdate` is set once after the full loop,
 *   never per bullet, and always through {@link markMatrixDirty}.
 * - **DynamicDrawUsage**: GPU buffer hint applied on mount.
 * - **Pool init at (0, −999, 0)**: prevents first-frame flash.
 */
export const BulletField = forwardRef<BulletFieldHandle, BulletFieldProps>(
  function BulletField(
    // ---- The one place a field-level default lives -------------------------
    // Not duplicated in `<BulletManager>`: the wrapper forwards whatever it was
    // handed, `undefined` included, and `undefined` is exactly what selects the
    // value below. One definition, so there is nothing to drift.
    {
      maxBullets = 2000,
      boundsLimit = 25,
      bulletRadius = 0.12,
      fadeTime = 1,
      fadeCurve = 'linear',
      paused = false,
      reducedMotion = false,
      onBulletCount,
      onPoolExhausted,
      material,
      geometry,
      orient = 'none',
      outline,
      children,
    },
    ref,
  ) {
    const meshRef = useRef<InstancedMeshType | null>(null);
    const bulletsRef = useRef<BulletState[]>([]);

    // ---- Emitter registry --------------------------------------------------
    //
    // A plain array, mutated imperatively. Registration order is service order,
    // and `splice` keeps the survivors in order when one unregisters.
    const entriesRef = useRef<EmitterEntry[]>([]);

    /**
     * Next provenance id to hand out. Monotonic, starts at `1`, and is **never**
     * decremented or reused — not on unregister, not on `clear()`, not on a
     * `maxBullets` realloc.
     *
     * Never recycling is the whole point. Ids are stamped onto bullets that
     * outlive their emitter, so a recycled id would let a freshly mounted
     * emitter inherit a dead one's in-flight bullets — and, once `clear(id)`
     * lands, destroy them. `0` is reserved for "anonymous" and is never issued.
     */
    const nextEmitterIdRef = useRef(1);

    /**
     * Reduced motion's 200-bullet cap is field-wide, not per emitter: it exists
     * to keep the static snapshot modest, which is a whole-scene concern. So it
     * is a budget that emitters draw down in registration order, and a late
     * emitter is truncated rather than every emitter being thinned.
     */
    const reducedMotionBudgetRef = useRef(REDUCED_MOTION_MAX);

    // ---- Sparse set over the slot pool -------------------------------------
    //
    //   dense[0 .. denseCount)   packed list of ACTIVE slot indices
    //   slotToDense[slot]        reverse map into `dense`, -1 when slot is free
    //   free[0 .. freeTop)       LIFO stack of available slots
    //
    // Acquire and release are O(1); the frame loop, `forEachActive`,
    // `activeCount` and `clear()` become O(active) rather than O(maxBullets).
    // All three arrays are sized from `maxBullets` and are reallocated by the
    // same effect that reallocates the bullet pool — release site 5.
    const denseRef = useRef<Int32Array>(EMPTY_SLOTS);
    const slotToDenseRef = useRef<Int32Array>(EMPTY_SLOTS);
    const freeRef = useRef<Int32Array>(EMPTY_SLOTS);
    const freeTopRef = useRef(0);
    const denseCountRef = useRef(0);
    /**
     * Highest slot index ever occupied, plus one — bounds `mesh.count` so the
     * vertex shader never runs for parked instances. Decays to 0 whenever the
     * field empties.
     */
    const highWaterRef = useRef(0);

    // ---- Prop refs for reading inside useFrame without stale closures ------
    const propsRef = useRef({
      paused,
      reducedMotion,
      boundsLimit,
      fadeTime,
      // Resolved at RENDER time, not per frame: an unknown easing name then throws
      // once, during render, with a stack pointing at the JSX — instead of sixty
      // times a second inside useFrame, which can take the WebGL context down with
      // it. It also keeps the frame loop free of any resolution work.
      fadeCurveFn: resolveEasing(fadeCurve),
      onBulletCount,
      onPoolExhausted,
    });
    propsRef.current = {
      paused,
      reducedMotion,
      boundsLimit,
      fadeTime,
      fadeCurveFn: resolveEasing(fadeCurve),
      onBulletCount,
      onPoolExhausted,
    };

    // ---- Scratch objects (allocated ONCE, reused every frame) --------------
    const { _dummy, _tempColor, _sourcePos, _spawnRange } = useMemo(
      () => ({
        _dummy: new Object3D(),
        _tempColor: new Color(),
        _sourcePos: new Vector3(),
        // Out-param for `spawnBullets`: the slot span it wrote, so the caller
        // can fold it into its own update range without allocating a result.
        _spawnRange: { min: 0, max: -1 },
      }),
      [],
    );

    // ---- Render options (geometry / orient / outline) ----------------------
    // Composes every matrix that SHOWS a bullet (both write sites below), and
    // owns the camera sync and the outline mesh. Stable for the field's life.
    const writer = useBulletRender(meshRef, {
      maxBullets,
      bulletRadius,
      geometry,
      orient,
      outline,
    });

    // ---- Sparse-set operations (stable identity, close over the refs) ------
    const { acquireSlot, releaseSlot, syncMeshCount } = useMemo(
      () => ({
        /** Pop a free slot and append it to `dense`. Returns -1 when full. */
        acquireSlot(): number {
          if (freeTopRef.current === 0) return -1;
          const slot = freeRef.current[--freeTopRef.current];
          const d = denseCountRef.current++;
          denseRef.current[d] = slot;
          slotToDenseRef.current[slot] = d;
          if (slot >= highWaterRef.current) highWaterRef.current = slot + 1;
          return slot;
        },

        /**
         * Swap-remove `slot` from `dense` and push it back onto the free stack.
         *
         * The last live entry moves into the vacated position, which is why
         * every walk over `dense` that can release must run BACKWARDS: a
         * forward walk would skip the relocated entry.
         */
        releaseSlot(slot: number): void {
          const d = slotToDenseRef.current[slot];
          if (d < 0) return; // already free — never double-push
          const last = denseRef.current[--denseCountRef.current];
          denseRef.current[d] = last;
          slotToDenseRef.current[last] = d;
          slotToDenseRef.current[slot] = -1;
          freeRef.current[freeTopRef.current++] = slot;
        },

        /**
         * Point `mesh.count` at the high-water mark, decaying it to zero once
         * the field has emptied. Bounds the draw, not the upload.
         */
        syncMeshCount(mesh: InstancedMeshType): void {
          if (denseCountRef.current === 0) highWaterRef.current = 0;
          mesh.count = highWaterRef.current;
        },
      }),
      [],
    );

    // ---- Pool initialization (mount only) ----------------------------------
    useEffect(() => {
      const mesh = meshRef.current;
      if (!mesh) return;

      // Allocate the CPU-side bullet state array ONCE
      const pool: BulletState[] = new Array(maxBullets);
      for (let i = 0; i < maxBullets; i++) {
        pool[i] = {
          position: new Vector3(),
          velocity: new Vector3(),
          acceleration: new Vector3(),
          delay: 0,
          life: 0,
          payload: 0,
          emitterId: 0,
          scale: 1,
        };
      }
      bulletsRef.current = pool;

      // ---- Release site 5: mass release by array swap --------------------
      // The old pool is discarded wholesale, so every slot it held is gone.
      // Liveness used to live inside that array and so self-healed; the sparse
      // set lives in sibling refs the swap does not touch, and must be reset
      // here explicitly or the field leaks every slot it had allocated.
      const dense = new Int32Array(maxBullets);
      const slotToDense = new Int32Array(maxBullets).fill(-1);
      const free = new Int32Array(maxBullets);
      // Filled descending so the LIFO pops 0, 1, 2, … on a virgin pool.
      for (let i = 0; i < maxBullets; i++) free[i] = maxBullets - 1 - i;
      denseRef.current = dense;
      slotToDenseRef.current = slotToDense;
      freeRef.current = free;
      freeTopRef.current = maxBullets;
      denseCountRef.current = 0;
      highWaterRef.current = 0;

      // GPU buffer hint — tells the driver we'll update every frame
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);

      // Full capacity while priming, so `setMatrixAt`/`setColorAt` see every
      // slot and `instanceColor` is allocated at full size before `count` is
      // ever lowered to the high-water mark below.
      mesh.count = maxBullets;

      // Prevent first-frame flash: park every instance off-screen + black
      for (let i = 0; i < maxBullets; i++) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        mesh.setColorAt(i, _tempColor.set(0x000000));
      }
      mesh.instanceMatrix.clearUpdateRanges?.();
      markMatrixDirty(mesh, 0, maxBullets - 1);
      mesh.instanceColor!.needsUpdate = true;

      // Nothing is alive yet, so nothing needs drawing.
      mesh.count = 0;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maxBullets]);

    // ---- Internal spawn function (zero-allocation) -------------------------
    /**
     * Spawn a burst. Returns the number of bullets actually spawned and writes
     * the slot span it touched into `_spawnRange` for the caller's update
     * range. Slot acquisition is O(1) per bullet, so a burst is O(burst)
     * rather than O(burst × maxBullets).
     */
    const spawnBullets = useMemo(() => {
      return (
        mesh: InstancedMeshType,
        bullets: BulletState[],
        sourcePos: Vector3,
        spawnData: BulletSpawnData[],
        zeroVelocity: boolean,
        emitterId: number,
        cap?: number,
      ): number => {
        let spawned = 0;
        let minSlot = 0;
        let maxSlot = -1;
        for (let d = 0; d < spawnData.length; d++) {
          if (cap !== undefined && spawned >= cap) break;

          // Pop a free slot — O(1)
          const slotIdx = acquireSlot();
          if (slotIdx === -1) break; // pool exhausted

          if (maxSlot < 0) {
            minSlot = slotIdx;
            maxSlot = slotIdx;
          } else if (slotIdx < minSlot) {
            minSlot = slotIdx;
          } else if (slotIdx > maxSlot) {
            maxSlot = slotIdx;
          }

          const data = spawnData[d];
          const bullet = bullets[slotIdx];

          bullet.position.copy(sourcePos).add(data.offset);
          bullet.delay = data.delay;
          bullet.life = data.life;
          bullet.payload = data.payload;
          bullet.emitterId = emitterId;
          // No `?? 1` here, deliberately. `scale` is REQUIRED on
          // `BulletSpawnData` and `acquire()` resets it on both branches, so
          // pool-sourced data can never carry `undefined`. The only way to get
          // there is a hand-rolled `PatternFactory` building bare object
          // literals, which TypeScript already rejects at compile time — a `??`
          // would downgrade that compile error into a silent runtime path.
          // (`color` keeps its `??` below because it is genuinely nullable.)
          bullet.scale = data.scale;

          if (zeroVelocity) {
            bullet.velocity.set(0, 0, 0);
            bullet.acceleration.set(0, 0, 0);
          } else {
            bullet.velocity.copy(data.velocity);
            bullet.acceleration.copy(data.acceleration);
          }

          // Zero-allocation color set — reuse _tempColor scratch object
          _tempColor.set(data.color ?? 0xff3333);
          mesh.setColorAt(slotIdx, _tempColor);

          // Fresh heading for a recycled slot (orient="velocity" only), from
          // the PATTERN's velocity so a zero-velocity snapshot still aims.
          writer.prime(slotIdx, data.velocity);

          // If no delay, position immediately; otherwise hide at -999.
          //
          // ---- Per-bullet scale, WRITE SITE 2 ----
          // This is the load-bearing one. Two whole paths never reach the fade
          // line in the simulate loop: `reducedMotion` spawns and returns above
          // it, and `paused` returns before it — so for a reduced-motion
          // snapshot, or a `fire()` while paused, this is the ONLY matrix write
          // the bullet ever receives. Hardcoding `1` here made `mod.scale()` a
          // permanent no-op in exactly the accessibility snapshot that has no
          // animation to convey size any other way.
          if (bullet.delay <= 0) {
            writer.write(mesh, slotIdx, bullet.position, bullet.velocity, bullet.scale);
          } else {
            _dummy.position.set(0, -999, 0);
            _dummy.scale.set(0, 0, 0);
            _dummy.updateMatrix();
            mesh.setMatrixAt(slotIdx, _dummy.matrix);
          }

          spawned++;
        }

        _spawnRange.min = minSlot;
        _spawnRange.max = maxSlot;
        return spawned;
      };
    }, [_dummy, _tempColor, _spawnRange, acquireSlot, writer]);

    // ---- Imperative handle -------------------------------------------------
    //
    // Built by `useMemo` rather than inside `useImperativeHandle`, because the
    // same object is ALSO the registry context value: an `<Emitter>` child
    // needs `register`/`unregister`/`fire` during render, and only a value the
    // render body holds can be handed to a provider. Every dependency below is
    // itself `useMemo(…, [])`-stable, so this object is created exactly once —
    // the context value never changes identity and no consumer re-registers.
    //
    // Typed as the wider `EmitterRegistryHandle` because that is what the
    // provider needs. `useImperativeHandle` below narrows the SAME object to
    // the public `BulletFieldHandle` at the ref boundary — the split is
    // entirely in the types; there is one object, and there must be.
    const handle = useMemo<EmitterRegistryHandle>(
      () => ({
        /**
         * Append an emitter to the registry and issue it a fresh provenance
         * id. Never re-renders the field.
         *
         * Registering *is* acquiring: an emitter that unregisters and
         * registers again is a different emitter as far as provenance is
         * concerned, and gets a different id — which is exactly what stops it
         * from inheriting the bullets its previous incarnation left in flight.
         */
        register(entry: EmitterEntry) {
          const entries = entriesRef.current;
          if (entries.indexOf(entry) === -1) {
            entry.id = nextEmitterIdRef.current++;
            entries.push(entry);
          }
        },

        /**
         * Drop an emitter, leaving the surviving entries in their order, and
         * retire its id.
         *
         * Bullets already in flight are untouched on purpose. They keep the id
         * they were stamped with, and because ids never recycle, nothing the
         * field issues later can ever collide with it — so a consumer walking
         * `forEachActive` still attributes them correctly long after the
         * emitter that fired them is gone.
         */
        unregister(entry: EmitterEntry) {
          const entries = entriesRef.current;
          const i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          entry.id = 0;
        },

        /** Manually trigger one burst for a single emitter. */
        fire(entry: EmitterEntry) {
          const mesh = meshRef.current;
          if (!mesh) return;
          const bullets = bulletsRef.current;
          const { pattern: pat, spawnCenterY: cy, origin: originRef } = entry.props;

          const originVec = originRef?.current;
          if (originVec) _sourcePos.copy(originVec);
          else _sourcePos.set(0, cy, 0);
          const spawnData = resolvePattern(pat);
          const requested = spawnData.length;
          const spawned = spawnBullets(
            mesh,
            bullets,
            _sourcePos,
            spawnData,
            false,
            entry.id,
          );
          releaseSpawnData(spawnData);
          // Only one thing can cut a `fire()` short: no free slots.
          reportExhaustion(
            propsRef.current.onPoolExhausted,
            entry.id,
            requested,
            spawned,
            'pool-full',
          );

          syncMeshCount(mesh);
          markMatrixDirty(mesh, _spawnRange.min, _spawnRange.max);
          // Colors are written only at spawn, so only a real spawn dirties them.
          if (spawned > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        },

        /**
         * Spawn one burst at an arbitrary origin — the no-React path.
         *
         * Everything `fire()` does, minus the entry: the origin is given rather
         * than resolved, the pattern is given rather than declared, and the
         * provenance id is the caller's (or the reserved anonymous `0`). It
         * works while the field is paused and flushes inline for the same
         * reason `fire()` does — a paused frame loop will never flush for it.
         *
         * `origin` is copied into the field's own scratch vector immediately,
         * so the caller may reuse or mutate theirs the moment this returns.
         *
         * Safe to call from inside a `forEachActive` callback: new slots are
         * appended above the backwards walk's cursor, so the walk can neither
         * revisit them nor lose an entry to them.
         */
        fireAt(
          origin: Vector3,
          pattern: PatternKey | PatternFactory,
          emitterId = 0,
        ) {
          const mesh = meshRef.current;
          if (!mesh) return;
          const bullets = bulletsRef.current;

          // ---- Keep the counter an upper bound on every id ever seen ----
          // `emitterId` is an open parameter, so a consumer managing its own
          // ids can hand over one the field never issued. Absorbing it here
          // means a later `acquireEmitter()` can never return an id that
          // bullets already in flight are stamped with — which is decision 1's
          // cross-emitter invariant, held even for a caller that freelances.
          // The default `0` is below the counter's floor of `1` and so is
          // always a no-op: anonymous stays anonymous.
          if (emitterId >= nextEmitterIdRef.current) {
            nextEmitterIdRef.current = emitterId + 1;
          }

          _sourcePos.copy(origin);
          const spawnData = resolvePattern(pattern);
          const requested = spawnData.length;
          const spawned = spawnBullets(
            mesh,
            bullets,
            _sourcePos,
            spawnData,
            false,
            emitterId,
          );
          releaseSpawnData(spawnData);
          // `fireAt` draws no budget, so the pool is the only thing that can
          // refuse it.
          reportExhaustion(
            propsRef.current.onPoolExhausted,
            emitterId,
            requested,
            spawned,
            'pool-full',
          );

          syncMeshCount(mesh);
          markMatrixDirty(mesh, _spawnRange.min, _spawnRange.max);
          if (spawned > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        },

        /**
         * Issue a provenance id to a caller that has no entry to stamp.
         *
         * The **same** counter `register()` draws from, so a swarm's imperative
         * archers and the JSX `<Emitter>`s in the same field can never collide.
         * It has to be a separate method rather than the same one because
         * `register` stamps `entry.id` — the frame loop reads the id off the
         * entry, so `register` has nowhere to return it from, and a caller
         * holding no entry has nothing for it to stamp.
         */
        acquireEmitter(): number {
          return nextEmitterIdRef.current++;
        },

        /**
         * Retire an id.
         *
         * There is deliberately **nothing to reclaim**: the counter never
         * recycles, so retiring an id means only that it is never issued again,
         * which it already was not. What the call is for is the **negative**
         * guarantee, and that is a real contract worth stating in code — it
         * does not clear that emitter's bullets, does not re-attribute them to
         * `0` or to anyone else, and does not touch any other emitter. A dying
         * archer whose bullets should vanish calls `clear(id)` first; one whose
         * bullets should finish their flight just releases. Separating those
         * two is the whole point of provenance, and folding a `clear` in here
         * would take the choice away.
         *
         * The one line of state it does own is the same upper-bound rule
         * `fireAt` applies: an id the consumer names is an id the field will
         * never issue, whether or not the field issued it in the first place.
         */
        releaseEmitter(id: number): void {
          if (id >= nextEmitterIdRef.current) nextEmitterIdRef.current = id + 1;
        },

        /**
         * Deactivate bullets and reset the matching emitter cadence(s).
         *
         * Field-wide `clear()` is not merely "clear each emitter": it resets
         * three distinct pieces of state together — every entry's `timeAccum`,
         * every entry's `reducedMotionSpawned` guard, and the shared
         * reduced-motion budget. Miss any one and the one-emitter
         * `<BulletManager>` wrapper stops being faithful, because the
         * pre-split `clear()` reset all three in a single statement each.
         *
         * `clear(id)` is the same three resets, narrowed to one emitter: only
         * bullets stamped with `id` are released, and only entries currently
         * holding `id` have their cadence and snapshot guard reset. Bullets
         * fired by an emitter whose id has since been retired are stamped with
         * that retired id, so they are reachable by `clear(retiredId)` and
         * unreachable by every other id — including the next one the field
         * issues. That is the cross-emitter invariant: no emitter can destroy
         * another emitter's bullets, and no successor inherits a predecessor's.
         *
         * The reduced-motion budget is handled differently by the two forms,
         * and deliberately. Field-wide re-arms it outright — the snapshot is a
         * whole-scene concern and clearing the scene restores the whole
         * allowance. Per-emitter refunds exactly what it released (clamped to
         * the cap), so re-arming one emitter's guard is matched by budget for
         * it to spend, without handing the other emitters a second snapshot's
         * worth. In the normal path the frame loop re-arms the budget every
         * frame anyway, so the refund is observable only under `reducedMotion`.
         *
         * Emitter ids are deliberately NOT reset by either form. `clear()`
         * destroys bullets, not identities; the counter is monotonic for the
         * life of the field.
         *
         * @param emitterId - Restrict to one emitter. Omit to clear the field.
         * Pass `0` to clear exactly the anonymous `fireAt` bullets.
         */
        clear(emitterId?: number) {
          const mesh = meshRef.current;
          if (!mesh) return;
          const fieldWide = emitterId === undefined;

          // ---- Release site 4 ----
          // Walk `dense` BACKWARDS: swap-remove relocates the last live entry
          // into the vacated position, and only a backwards walk is immune.
          // (Skipping an entry is safe for the same reason: the relocated one
          // always comes from an index above the cursor, already visited.)
          // O(active), not O(maxBullets).
          const bullets = bulletsRef.current;
          const dense = denseRef.current;
          let minSlot = 0;
          let maxSlot = -1;
          let released = 0;
          for (let d = denseCountRef.current - 1; d >= 0; d--) {
            const i = dense[d];
            if (!fieldWide && bullets[i].emitterId !== emitterId) continue;
            _dummy.position.set(0, -999, 0);
            _dummy.scale.set(0, 0, 0);
            _dummy.updateMatrix();
            mesh.setMatrixAt(i, _dummy.matrix);
            if (maxSlot < 0) {
              minSlot = i;
              maxSlot = i;
            } else if (i < minSlot) {
              minSlot = i;
            } else if (i > maxSlot) {
              maxSlot = i;
            }
            releaseSlot(i);
            released++;
          }

          // Cadence and the reduced-motion snapshot belong to the emitters, so
          // clearing the field clears all of theirs — and the budget those
          // snapshots draw from is the field's, so it is re-armed here too.
          // All three, or the wrapper diverges.
          const entries = entriesRef.current;
          for (let e = 0; e < entries.length; e++) {
            if (!fieldWide && entries[e].id !== emitterId) continue;
            entries[e].timeAccum = 0;
            entries[e].reducedMotionSpawned = false;
          }
          if (fieldWide) {
            reducedMotionBudgetRef.current = REDUCED_MOTION_MAX;
          } else if (released > 0) {
            reducedMotionBudgetRef.current = Math.min(
              REDUCED_MOTION_MAX,
              reducedMotionBudgetRef.current + released,
            );
          }

          syncMeshCount(mesh);
          markMatrixDirty(mesh, minSlot, maxSlot);
        },

        /** Number of bullets currently alive, across every emitter. */
        get activeCount(): number {
          return denseCountRef.current;
        },

        /**
         * How many live bullets carry `emitterId`.
         *
         * O(active) — it walks the sparse set's `dense` list, never the whole
         * pool — and counts delayed bullets as well as visible ones, because a
         * delayed bullet still occupies a slot. That is what makes it the right
         * number to reason about the pool with, and the companion to
         * `onPoolExhausted` for a consumer deciding whether to fire at all.
         */
        activeCountFor(emitterId: number): number {
          const bullets = bulletsRef.current;
          const dense = denseRef.current;
          let n = 0;
          for (let d = denseCountRef.current - 1; d >= 0; d--) {
            if (bullets[dense[d]].emitterId === emitterId) n++;
          }
          return n;
        },

        /**
         * Iterate active, visible bullets; consume any for which `cb` returns
         * `true`. Delayed (not-yet-visible) bullets are skipped so a hit test
         * never lands on a parked instance.
         *
         * **Reentrant.** `cb` may call `fireAt` — a retaliation shot from
         * inside a hit test is exactly the case decision 1 was written around.
         * The backwards walk makes it safe rather than lucky: a spawn appends
         * to `dense` at an index at or above the cursor, which is only ever
         * ground the walk has already covered, so a bullet fired mid-walk is
         * never visited by that walk, never clobbers an unvisited entry, and
         * carries the id it was fired with rather than the one being visited.
         */
        forEachActive(cb) {
          const bullets = bulletsRef.current;
          const mesh = meshRef.current;
          const dense = denseRef.current;
          let minSlot = 0;
          let maxSlot = -1;
          // BACKWARDS — release site 3 consumes mid-walk, and swap-remove moves
          // the last live entry down into the vacated position. A forward walk
          // would skip one live bullet per consumption: a silent, load-dependent
          // miss in the consumer's hit test.
          for (let d = denseCountRef.current - 1; d >= 0; d--) {
            const i = dense[d];
            const b = bullets[i];
            if (b.delay > 0) continue;
            // `emitterId` is the fourth argument and therefore additive: a
            // three-parameter callback written before provenance existed keeps
            // compiling and keeps behaving identically.
            if (cb(i, b.position, b.payload, b.emitterId) === true) {
              releaseSlot(i);
              if (mesh) {
                _dummy.position.set(0, -999, 0);
                _dummy.scale.set(0, 0, 0);
                _dummy.updateMatrix();
                mesh.setMatrixAt(i, _dummy.matrix);
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
          }
          if (mesh && maxSlot >= 0) {
            syncMeshCount(mesh);
            markMatrixDirty(mesh, minSlot, maxSlot);
          }
        },
      }),
      [_dummy, _sourcePos, _spawnRange, spawnBullets, releaseSlot, syncMeshCount],
    );

    useImperativeHandle(ref, () => handle, [handle]);

    // ---- Frame loop --------------------------------------------------------
    useFrame((_state, delta) => {
      const mesh = meshRef.current;
      if (!mesh) return;

      const props = propsRef.current;

      // Respect paused prop
      if (props.paused) return;

      const dt = Math.min(delta, 0.1); // clamp to prevent spiral-of-death
      const bullets = bulletsRef.current;
      const entries = entriesRef.current;

      // ---- Reduced motion: spawn once per emitter, skip timer & rotation ----
      if (props.reducedMotion) {
        let serviced = false;
        let rmMin = 0;
        let rmMax = -1;
        let rmSpawned = 0;

        for (let e = 0; e < entries.length; e++) {
          const entry = entries[e];
          // The guard is per emitter, so an emitter that appears *after*
          // reduced motion engaged still gets its own snapshot instead of
          // being invisible forever.
          if (entry.reducedMotionSpawned) continue;
          entry.reducedMotionSpawned = true;
          serviced = true;

          const budget = reducedMotionBudgetRef.current;
          if (budget <= 0) continue; // field-wide cap already spent

          // ---- Decision 5: the one deliberate behavioural divergence ----
          // Each emitter snapshots from ITS OWN origin, falling back to its own
          // static `(0, spawnCenterY, 0)` — the same resolution `fire()` uses.
          //
          // `<BulletManager>` used to set the static centre unconditionally
          // here, never reading `origin`, so a `<BulletManager origin={ref}
          // reducedMotion>` snapshotted at the world origin rather than at the
          // emitter. That is taken as a bug: an accessibility snapshot that
          // draws a moving emitter's bullets somewhere the emitter is not is
          // worse than useless, it is the only generalization that means
          // anything at N>1, and it makes all three origin-resolution paths
          // (fire, auto-fire, snapshot) agree for the first time.
          const originVec = entry.props.origin?.current;
          if (originVec) _sourcePos.copy(originVec);
          else _sourcePos.set(0, entry.props.spawnCenterY, 0);
          const spawnData = resolvePattern(entry.props.pattern);
          const requested = spawnData.length;
          const n = spawnBullets(
            mesh,
            bullets,
            _sourcePos,
            spawnData,
            true,
            entry.id,
            budget,
          );
          releaseSpawnData(spawnData);
          // A snapshot truncated by the field-wide 200 cap reports through the
          // same callback as one truncated by a full pool. Decision 5 makes the
          // budget behave as drop-newest in registration order precisely so
          // exhaustion has one semantics here rather than two — but the two
          // still want different remedies, so they are told apart by `reason`.
          //
          // This is the one path where either constraint can bind, and the two
          // are distinguishable without asking the pool: `spawnBullets` checks
          // its `cap` at the top of each iteration, before touching the free
          // stack, so it can only return the whole budget by having been
          // stopped BY the budget. Anything short of it means a slot was
          // refused. When both would have bound, the budget is the proximate
          // cause and is what gets reported.
          reportExhaustion(
            props.onPoolExhausted,
            entry.id,
            requested,
            n,
            n === budget ? 'reduced-motion-budget' : 'pool-full',
          );
          reducedMotionBudgetRef.current = budget - n;
          rmSpawned += n;

          if (_spawnRange.max >= 0) {
            if (rmMax < 0) {
              rmMin = _spawnRange.min;
              rmMax = _spawnRange.max;
            } else {
              if (_spawnRange.min < rmMin) rmMin = _spawnRange.min;
              if (_spawnRange.max > rmMax) rmMax = _spawnRange.max;
            }
          }
        }

        if (serviced) {
          // Flush the one-time update
          syncMeshCount(mesh);
          markMatrixDirty(mesh, rmMin, rmMax);
          if (rmSpawned > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
        return; // no animation under reduced motion
      }

      // Reset the snapshot budget if the consumer toggles reduced motion off;
      // each emitter's own guard is reset in the service loop below.
      reducedMotionBudgetRef.current = REDUCED_MOTION_MAX;

      // The slot span this frame wrote, folded across every emitter's spawn and
      // the simulate loop so a single merged update range covers them all.
      let minSlot = 0;
      let maxSlot = -1;
      let spawnedThisFrame = 0;

      // ---- Auto-fire timers, one per emitter, in registration order ----
      for (let e = 0; e < entries.length; e++) {
        const entry = entries[e];
        entry.reducedMotionSpawned = false;

        const ep = entry.props;
        entry.timeAccum += dt;
        const fireInterval = 1 / ep.fireRate;

        if (entry.timeAccum >= fireInterval) {
          entry.timeAccum -= fireInterval;

          // Source position: a live `origin` ref if supplied, else the built-in
          // Y-axis orbit. Read fresh here so a moving emitter fires from its
          // current position.
          const originVec = ep.origin?.current;
          if (originVec) {
            _sourcePos.copy(originVec);
          } else {
            entry.sourceRotation += ep.rotationSpeed * fireInterval;
            const rot = entry.sourceRotation;
            _sourcePos.set(
              Math.cos(rot) * 2,
              ep.spawnCenterY,
              Math.sin(rot) * 2,
            );
          }

          const spawnData = resolvePattern(ep.pattern);
          const requested = spawnData.length;
          const spawned = spawnBullets(
            mesh,
            bullets,
            _sourcePos,
            spawnData,
            false,
            entry.id,
          );
          spawnedThisFrame += spawned;
          releaseSpawnData(spawnData);
          // Once per burst, per emitter — never once per dropped bullet. The
          // reduced-motion budget is not in play on this path (it returns
          // above), so the pool is the only constraint that can bind.
          reportExhaustion(
            props.onPoolExhausted,
            entry.id,
            requested,
            spawned,
            'pool-full',
          );

          if (_spawnRange.max >= 0) {
            if (maxSlot < 0) {
              minSlot = _spawnRange.min;
              maxSlot = _spawnRange.max;
            } else {
              if (_spawnRange.min < minSlot) minSlot = _spawnRange.min;
              if (_spawnRange.max > maxSlot) maxSlot = _spawnRange.max;
            }
          }
        }
      }

      // ---- Update all active bullets ----
      const fadeCurveFn = props.fadeCurveFn; // already resolved at render time
      const fadeSeconds = props.fadeTime;

      // O(active), not O(maxBullets). BACKWARDS, because the despawn branch
      // below swap-removes from `dense` mid-walk.
      const dense = denseRef.current;
      for (let d = denseCountRef.current - 1; d >= 0; d--) {
        const i = dense[d];
        const b = bullets[i];

        // Handle delay countdown
        if (b.delay > 0) {
          b.delay -= dt;
          if (b.delay > 0) {
            // Still waiting — keep hidden, and its matrix already says so
            continue;
          }
          // Delay just ended — fall through to normal update
        }

        // Frame-rate independent physics
        b.velocity.addScaledVector(b.acceleration, dt);
        b.position.addScaledVector(b.velocity, dt);
        b.life -= dt;

        // Deactivate: lifetime expired or out of bounds
        if (
          b.life <= 0 ||
          Math.abs(b.position.x) > props.boundsLimit ||
          Math.abs(b.position.y) > props.boundsLimit ||
          Math.abs(b.position.z) > props.boundsLimit
        ) {
          // ---- Release sites 1 (lifetime expiry) and 2 (out of bounds) ----
          _dummy.position.set(0, -999, 0);
          _dummy.scale.set(0, 0, 0);
          _dummy.updateMatrix();
          mesh.setMatrixAt(i, _dummy.matrix);
          if (maxSlot < 0) {
            minSlot = i;
            maxSlot = i;
          } else if (i < minSlot) {
            minSlot = i;
          } else if (i > maxSlot) {
            maxSlot = i;
          }
          releaseSlot(i);
          continue;
        }

        // Fade: scale down over the last `fadeTime` seconds, shaped by `fadeCurve`.
        // Visual only — the despawn test above is the sole authority on lifetime.
        //
        // ---- Per-bullet scale, WRITE SITE 1 ----
        // The bullet's own multiplier composes with the fade rather than
        // replacing it, so a `mod.scale(3)` bullet fades from 3 to 0 exactly as
        // a default one fades from 1 to 0.
        const fade = fadeScale(b.life, fadeSeconds, fadeCurveFn);
        const s = fade * b.scale;
        writer.write(mesh, i, b.position, b.velocity, s);
        if (maxSlot < 0) {
          minSlot = i;
          maxSlot = i;
        } else if (i < minSlot) {
          minSlot = i;
        } else if (i > maxSlot) {
          maxSlot = i;
        }
      }

      // ---- Batch GPU buffer updates (ONCE after full loop, never per-bullet)
      syncMeshCount(mesh);
      markMatrixDirty(mesh, minSlot, maxSlot);
      // `instanceColor` is written ONLY at spawn, never in this loop, so a
      // frame that spawned nothing has nothing to upload.
      if (spawnedThisFrame > 0 && mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }

      // ---- Callback with active count ----
      if (props.onBulletCount) {
        // Every survivor is still in `dense`; every despawn left it.
        props.onBulletCount(denseCountRef.current);
      }
    });

    // ---- JSX ---------------------------------------------------------------
    // Exactly one `instancedMesh`, and it must stay the first (only) node this
    // component contributes to the scene: a wrapping `<group>` or a sibling
    // scene object would move it, and consumers — including the
    // characterization suite — reach the mesh through `scene.children[0]`.
    //
    // The provider is safe there because a context provider is not a scene
    // object: R3F never reconciles it into the graph. `{children}` is safe for
    // the same reason — `<Emitter>` renders `null`.
    //
    // THE FRAGMENT AROUND THE MESH IS LOAD-BEARING. R3F v9 defers an `args`
    // reconstruction into a module-level `reconstructed` queue and flushes it
    // only from the *tail* sibling of the updated run:
    //
    //     const isTailSibling = fiber.sibling === null || …
    //     if (isTailSibling) swapInstances()
    //
    // (`@react-three/fiber/dist/events-*.esm.js`, `commitUpdate` — and that is
    // the only call site of `swapInstances`.) Give the `instancedMesh` a later
    // JSX sibling and `fiber.sibling` stops being null, so a `maxBullets`
    // change queues a new mesh that is never swapped in: the field silently
    // keeps its old capacity. The fragment puts the mesh alone at its own fiber
    // level, so it is always the tail sibling no matter what `children` holds —
    // and the mesh still comes first, so it stays `scene.children[0]`.
    //
    // (React only unwraps an unkeyed fragment when it is a parent's *sole*
    // child. JSX always hands this provider a two-element children array, even
    // when `children` is `undefined`, so the fragment fiber always survives —
    // and in the case where it would not, the mesh has no sibling anyway.)
    //
    // The same rule is why the optional `outline` mesh is NOT a JSX sibling:
    // `useBulletRender` adds it imperatively as a three.js child of this mesh,
    // invisible to React, the reconciler and `scene.children`.
    return (
      <EmitterRegistryContext.Provider value={handle}>
        <>
          <instancedMesh
            ref={meshRef}
            args={[undefined, undefined, maxBullets]}
            frustumCulled={false}
          >
            {geometry ? (
              // A consumer geometry is attached, never owned: R3F never
              // disposes a <primitive>, and `dispose={null}` says so twice.
              <primitive object={geometry} attach="geometry" dispose={null} />
            ) : (
              <sphereGeometry args={[bulletRadius, 6, 6]} />
            )}
            {material ?? <meshBasicMaterial fog={false} />}
          </instancedMesh>
        </>
        {children}
      </EmitterRegistryContext.Provider>
    );
  },
);
