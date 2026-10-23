import {
  useRef,
  useMemo,
  useCallback,
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
  type InstancedBufferAttribute,
  type InstancedMesh as InstancedMeshType,
} from 'three';
import { useBulletRender } from './render/useBulletRender';
import { FRAME_ATTRIBUTE, type BulletFrames } from './render/frames';
import type { BulletOrient, InstanceWriter } from './render/orient';
import type { BulletOutline } from './render/outline';
import { resolveEasing } from './easing';
import { detSinCos, type SinCos } from './detmath';
import { DEV } from './dev';
import {
  SimulationCore,
  type BulletSimulation,
  type PoolExhaustionReason,
} from './core/simulation';
import {
  createStepState,
  foldPendingRange,
  resetPending,
  shouldStep,
  type StepMode,
} from './stepping';
import type {
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

/**
 * Scratch for the built-in orbit's `detSinCos` (0.8.0; was `Math.cos` /
 * `Math.sin`, bit-identical to them in Node). Written and read within one statement
 * pair, so one module-scope object serves every field.
 */
const _orbitSC: SinCos = { s: 0, c: 0 };

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
  // 0.7.0 frames: the per-instance cell is written beside every matrix, so it
  // uploads over the same slots.
  const frame = mesh.geometry.attributes[FRAME_ATTRIBUTE] as InstancedBufferAttribute | undefined;
  if (frame !== undefined) {
    if (typeof frame.addUpdateRange === 'function') {
      frame.addUpdateRange(minSlot, maxSlot - minSlot + 1);
    }
    frame.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Exhaustion reporting
// ---------------------------------------------------------------------------

/**
 * Why a burst was short-changed — the fourth argument to
 * {@link BulletFieldProps.onPoolExhausted}. Defined beside the headless
 * simulation (`./core/simulation`), which raises `'pool-full'` itself, and
 * re-exported here so the field's public surface is unchanged.
 */
export type { PoolExhaustionReason };

/**
 * Raise {@link BulletFieldProps.onPoolExhausted} for one burst, if it was
 * short-changed and anyone is listening.
 *
 * Deliberately **once per burst**. Every field-side spawn path calls this
 * exactly once, immediately after the core's `_burst` returns — the single
 * point where both the requested count (`_lastRequested`) and the spawned
 * count are in hand. (`fireAt` goes through the core's own `fireAt`, which
 * applies the same rule itself.) Pushing the check down
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

/**
 * Props for the public `<Emitter>` component — the five of `<BulletManager>`'s
 * nineteen that describe an emitter rather than the field.
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
 *
 * ## With an external `simulation`
 * On a field rendering a {@link BulletFieldProps.simulation}, every member
 * forwards to that simulation — `fireAt`, `acquireEmitter`, `releaseEmitter`,
 * `clear`, `activeCount`, `activeCountFor`, `forEachActive`, `setPayload` —
 * except `step()`, which is a no-op with a one-time development warning: the
 * simulation belongs to your code, and so does its clock. A forwarded spawn or
 * consumption is drawn on the next rendered frame, not flushed inline.
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
  /**
   * Advance the simulation by exactly `dt` seconds. **Manual mode only** —
   * see {@link BulletFieldProps.stepMode}.
   *
   * One call is one step of everything the frame loop does in `'auto'` mode:
   * every emitter's cadence timer and auto-fire (at most one shot per emitter
   * per step, as per frame in auto mode), orbit phase, spawn delays,
   * acceleration and motion, life and expiry, bounds culling, the fade, and the
   * reduced-motion snapshot. Call it as many times per rendered frame as your
   * fixed-timestep loop needs. `dt` is used as given — the `0.1` s clamp the
   * auto loop applies to a frame's `delta` does not apply here, because the
   * caller owns the clock.
   *
   * **Upload is per frame, not per step.** A step writes instance matrices on
   * the CPU but never flags them for upload; the field's frame loop uploads
   * the union of everything written since the previous frame exactly once. Five
   * steps between two frames cost one upload. Call `step()` *before* the
   * field's frame callback runs — from a `useFrame` with a negative priority,
   * or from outside R3F's loop entirely — or the steps land in the following
   * frame's upload instead.
   *
   * Allocates nothing per bullet. The only allocations are the per-burst ones
   * any spawn makes (the pattern's array), on steps where an emitter fires.
   *
   * **Determinism.** Given the same sequence of `step(dt)` calls,
   * `fire()` / `fireAt()` calls and `forEachActive` consumptions — and
   * deterministic patterns and origins — two fields produce bit-identical
   * bullet positions, however the steps were grouped into rendered frames.
   * Rendering never feeds back into the simulation. See the README's
   * "Deterministic stepping" section for the floating-point caveats.
   *
   * **A no-op** when the field is in `'auto'` mode (with a one-time warning in
   * development builds — the field already steps itself), while `paused` (the
   * step is dropped, not queued), before the field has mounted, for any `dt`
   * that is not a finite number greater than `0` (`NaN`, negative and
   * infinite values also warn once in development), and on a field rendering
   * an external `simulation` (one development warning — step the simulation
   * itself). Never throws.
   */
  step(dt: number): void;
  /**
   * Overwrite the payload of the live bullet at slot `index` — the write-back
   * half of {@link forEachActive}, for per-bullet state that changes in flight,
   * such as a pierce counter decremented on each hit.
   *
   * Pass the `index` a `forEachActive` callback was handed, during that same
   * walk; it is safe to call from inside the callback and changes nothing
   * about the walk. A slot that is not live — consumed, expired, or never
   * used — is ignored. An index means "this bullet" only until the bullet
   * dies: once its slot is reused by a later spawn, the same index names the
   * new bullet, so do not hold indices across steps. Allocates nothing;
   * touches no GPU state.
   */
  setPayload(index: number, payload: number): void;
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
  /**
   * Throw if this field cannot host an `<Emitter>` — that is, if it renders an
   * external {@link BulletFieldProps.simulation}. `<Emitter>` calls it during
   * render, so the error points at the offending JSX.
   */
  assertCanHostEmitters(): void;
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
 * the in-place writes to memoized objects — the core's config and its
 * last-operation span, the step state). `<Emitter>` does the `useContext` and
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
  /**
   * Half-extent of the cull box. A bullet is deactivated on the step it ends
   * with **any one** coordinate more than `boundsLimit` from the box's centre
   * — so the region is an axis-aligned **cube** of side `2 × boundsLimit`, not
   * a sphere, and the test is per axis (`|x − cx| > limit`, likewise `y`, `z`).
   *
   * Measured in the field's **local** coordinates — the space bullet positions
   * live in, and the same space `origin` / `fireAt` positions are read in. With
   * the field mounted untransformed at the scene root that is world space; under
   * a transformed parent it is that parent's space. The centre is the local
   * origin `(0, 0, 0)` unless {@link boundsCenter} moves it.
   *
   * `Infinity` disables bounds culling entirely (lifetime still despawns), for
   * games that cull against their own walls. `0` is **not** special: it culls
   * every bullet not exactly on the centre. @default 25
   */
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
  /**
   * Centre of the {@link boundsLimit} cull box, read fresh from `.current` once
   * per step — so the box can follow a moving player or camera instead of
   * sitting on the field's origin. In the field's local coordinates, like
   * bullet positions. Omitted, or `.current` `null`: the box is centred on
   * `(0, 0, 0)`, exactly as before 0.5.0.
   */
  boundsCenter?: { readonly current: Vector3 | null };
  /**
   * Who advances the simulation. See {@link StepMode}.
   *
   * `'auto'` (the default) is the loop this field has always run: one step per
   * rendered frame, by the frame's `delta` clamped to `0.1` s.
   *
   * `'manual'` hands the clock to you, for a fixed-timestep or deterministic
   * game: the field's `useFrame` stops advancing **anything** — cadence
   * timers, auto-fire, orbit phase, spawn delays, motion, life, bounds culling,
   * the fade, the reduced-motion snapshot — and
   * {@link BulletFieldHandle.step | `step(dt)`} does it instead, as often as
   * you call it. The frame loop keeps exactly one job: uploading what the
   * steps wrote, once per rendered frame. `fire()` and `fireAt()` behave
   * identically in both modes. `onBulletCount` is raised once per rendered
   * frame in which at least one step ran.
   *
   * May be switched at runtime; nothing is reset by the switch. @default 'auto'
   */
  stepMode?: StepMode;
  /**
   * Called once per frame with the current number of active bullets. Under
   * `stepMode="manual"`, only on frames in which `step()` advanced the
   * simulation at least once.
   */
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
   * Per-bullet **sprite frames** from one texture atlas (0.7.0): the
   * material's `map` is read as a `columns × rows` grid and `frame(index,
   * payload)` picks each bullet's cell whenever its matrix is written — so one
   * field draws arrows, orbs and shards together, chosen from the payload. An
   * `upright(frame)` callback marks cells that `orient`'s velocity rotation
   * skips. Needs a `geometry` with quad UVs (`bulletGeometry.quad()`); the
   * `'alpha'` outline follows each bullet's cell. See {@link BulletFrames}.
   */
  frames?: BulletFrames;
  /**
   * Render a simulation **you own** instead of running one.
   *
   * Pass a {@link BulletSimulation} from `createBulletSimulation()` — the
   * React-free core your game steps on its own fixed tick, headlessly
   * replayable — and this field becomes a pure renderer of it. Once per
   * rendered frame it syncs instance matrices (and, for bullets spawned since
   * the previous frame, colors) over the simulation's dirty slot range, through
   * the same instance writer the field always uses, and uploads them once.
   * `geometry`, `orient`, `outline`, `material` and `bulletRadius` work exactly
   * as they do on a field that owns its bullets.
   *
   * The rules, all of which follow from "the simulation is yours":
   *
   * - **The field never steps, spawns into or culls it.** Its frame loop only
   *   reads. `step()` on the handle is a no-op (one development warning); every
   *   other handle member forwards to the simulation.
   * - **The simulation's own options govern it.** `maxBullets` (the mesh is
   *   sized from `simulation.capacity`), `boundsLimit`, `boundsCenter`,
   *   `fadeTime`, `fadeCurve`, `stepMode`, `paused`, `reducedMotion` and
   *   `onPoolExhausted` are ignored, with one development warning listing any
   *   you passed.
   * - **`<Emitter>` children throw** during render: nothing would ever step
   *   their cadence. Fire from your own fixed step with `sim.fireAt`.
   * - **One renderer per simulation.** The sync consumes the dirty range
   *   (`markSynced`), so a second field rendering the same simulation would
   *   miss updates.
   * - **`onBulletCount`** is raised once per rendered frame in which the
   *   simulation stepped at least once since the previous frame.
   * - **Step before the field's frame callback** (a negative-priority
   *   `useFrame`, or outside R3F's loop) or the steps show one frame late.
   *
   * May be swapped for another simulation at runtime (the next frame redraws
   * every live bullet); switching a field between owning and rendering resets
   * the field's own pool. Give it a `key` if you would rather remount.
   */
  simulation?: BulletSimulation;
  /**
   * With {@link simulation}: render between the simulation's last two steps.
   * Called once per rendered frame; return the fraction `alpha` in `[0, 1]`
   * of a step your accumulator has banked (`accumulator / STEP`), and each
   * bullet is drawn at `previous + (current − previous) × alpha`. Values
   * outside `[0, 1]` are clamped; `NaN` draws the current state.
   *
   * Requires a simulation created with `interpolation: true`, which keeps the
   * start-of-step positions this reads; on any other it is ignored with a
   * one-time development warning. Interpolation rewrites every slot up to the
   * high-water mark each frame (the in-between position changes every frame
   * even when no step ran), so it costs one matrix per live bullet per frame —
   * still zero allocation. Position only: the fade and `orient="velocity"`
   * follow the latest step. Ignored without `simulation`.
   */
  interpolate?: () => number;
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
 *   — held by a {@link SimulationCore}, the same headless simulation the
 *   package's `/core` entry exports, which this component drives
 * - one `useFrame`, which walks the emitter registry in registration order,
 *   services each due shot, then runs a single simulate + draw pass
 *
 * ## Owning or rendering
 * By default the field **owns** its simulation: it creates the core, steps it
 * (per frame, or per `step(dt)` under `stepMode="manual"`), and services its
 * `<Emitter>` children's cadences. Given a {@link BulletFieldProps.simulation}
 * it **renders** one you own instead, and does nothing else to it.
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
 *   `dt` clamped to `Math.min(delta, 0.1)` — in `'auto'` mode. Under
 *   `stepMode="manual"` each `step(dt)` advances exactly the `dt` given.
 * - **Batched GPU writes**: `needsUpdate` is set once per rendered frame,
 *   never per bullet and never per step, and always through
 *   {@link markMatrixDirty}.
 *
 * The simulation half of that loop — motion, life, culling, consumption — is
 * the headless core's `_advance`, which writes each matrix through a render
 * sink at exactly the points this component always wrote them; the claims
 * above are the core's as much as the field's.
 *
 * ## Manual stepping
 * `stepMode="manual"` moves the simulation off the render clock: the frame
 * loop only uploads, and `step(dt)` on the handle advances the simulation —
 * any number of times per frame, for a fixed-timestep or deterministic game.
 * See {@link BulletFieldProps.stepMode} and {@link BulletFieldHandle.step}.
 * - **DynamicDrawUsage**: GPU buffer hint applied on mount.
 * - **Pool init at (0, −999, 0)**: prevents first-frame flash.
 */
// ---------------------------------------------------------------------------
// Module-scope helpers
// ---------------------------------------------------------------------------
//
// Module scope rather than closures in the component: a second hook in this
// file switches on the React Compiler lint pass for the whole module, which
// then rejects the frame loop's deliberate mutations.

/** Write the matrix that parks a slot: off-screen at (0, −999, 0), scale 0. */
function writeHidden(mesh: InstancedMeshType, slot: number, dummy: Object3D): void {
  dummy.position.set(0, -999, 0);
  dummy.scale.set(0, 0, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(slot, dummy.matrix);
}

/**
 * Props that configure a simulation, and so mean nothing to a field that
 * renders an external one. Listed once, for the development warning.
 */
const IGNORED_WITH_SIMULATION = [
  'maxBullets',
  'boundsLimit',
  'boundsCenter',
  'fadeTime',
  'fadeCurve',
  'paused',
  'reducedMotion',
  'stepMode',
  'onPoolExhausted',
] as const;

function externalEmitterError(): Error {
  return new Error(
    '[r3f-projectiles] <Emitter> cannot be rendered inside a <BulletField simulation={…}>: ' +
      'an external simulation is stepped by your code, so nothing would ever service the ' +
      "emitter's cadence. Fire from your own fixed step with sim.fireAt(origin, pattern, id).",
  );
}

/**
 * One rendered frame of an **external** simulation: write every slot in its
 * dirty range — widened to the whole live span on a `full` sync (a new or
 * newly attached simulation) and while interpolating — and upload once.
 *
 * Per slot: a free slot is parked; a slot (re)spawned since the last sync gets
 * its color and a fresh heading; a delayed bullet is parked; a visible one is
 * drawn through the field's {@link InstanceWriter} at its current position —
 * or, with `alpha >= 0`, between its start-of-step and current positions —
 * scaled by its own scale × fade, exactly as an owned field's step draws it.
 *
 * The range is contiguous, so it may include slots that did not change;
 * rewriting those is idempotent. Allocates nothing: `color` and `scratch` are
 * the field's own scratch objects.
 */
function syncExternal(
  mesh: InstancedMeshType,
  sim: BulletSimulation,
  writer: InstanceWriter,
  dummy: Object3D,
  color: Color,
  scratch: Vector3,
  alpha: number,
  full: boolean,
): void {
  const cap = mesh.instanceMatrix.count;
  const hw = Math.min(sim.highWater, cap);
  let min = sim.dirtyMin;
  let max = sim.dirtyMax;
  const interpolating = alpha >= 0;
  if ((full || interpolating) && hw > 0) {
    if (max < min) {
      min = 0;
      max = hw - 1;
    } else {
      if (min > 0) min = 0;
      if (max < hw - 1) max = hw - 1;
    }
  }
  if (max > cap - 1) max = cap - 1;

  let colors = false;
  for (let i = min; i <= max; i++) {
    if (!sim.isLive(i)) {
      writeHidden(mesh, i, dummy);
      continue;
    }
    if (full || sim.spawnedSinceSync(i)) {
      mesh.setColorAt(i, sim.colorAt(i, color));
      writer.prime(i, sim.velocityAt(i));
      colors = true;
    }
    if (!sim.isVisible(i)) {
      writeHidden(mesh, i, dummy);
      continue;
    }
    const position = interpolating
      ? sim.previousPositionAt(i, scratch).lerp(sim.positionAt(i), alpha)
      : sim.positionAt(i);
    writer.write(mesh, i, position, sim.velocityAt(i), sim.fadeAt(i) * sim.scaleAt(i), sim.payloadAt(i));
  }

  mesh.count = hw;
  markMatrixDirty(mesh, min, max);
  if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  sim.markSynced();
}

export const BulletField = forwardRef<BulletFieldHandle, BulletFieldProps>(
  function BulletField(props, ref) {
    // ---- The one place a field-level default lives -------------------------
    // Not duplicated in `<BulletManager>`: the wrapper forwards whatever it was
    // handed, `undefined` included, and `undefined` is exactly what selects the
    // value below. One definition, so there is nothing to drift. (`props` is
    // kept whole only so the external-simulation warning can tell a prop you
    // passed from a default.)
    const {
      maxBullets = 2000,
      boundsLimit = 25,
      bulletRadius = 0.12,
      fadeTime = 1,
      fadeCurve = 'linear',
      paused = false,
      reducedMotion = false,
      boundsCenter,
      stepMode = 'auto',
      onBulletCount,
      onPoolExhausted,
      material,
      geometry,
      orient = 'none',
      outline,
      frames,
      simulation,
      interpolate,
      children,
    } = props;

    const meshRef = useRef<InstancedMeshType | null>(null);

    /**
     * Instances in the mesh: the field's own `maxBullets`, or the external
     * simulation's fixed capacity.
     */
    const capacity = simulation ? simulation.capacity : maxBullets;

    // ---- Emitter registry --------------------------------------------------
    //
    // A plain array, mutated imperatively. Registration order is service order,
    // and `splice` keeps the survivors in order when one unregisters.
    const entriesRef = useRef<EmitterEntry[]>([]);

    /**
     * Reduced motion's 200-bullet cap is field-wide, not per emitter: it exists
     * to keep the static snapshot modest, which is a whole-scene concern. So it
     * is a budget that emitters draw down in registration order, and a late
     * emitter is truncated rather than every emitter being thinned.
     */
    const reducedMotionBudgetRef = useRef(REDUCED_MOTION_MAX);

    // ---- Prop refs for reading inside useFrame without stale closures ------
    const propsRef = useRef({
      paused,
      reducedMotion,
      boundsLimit,
      boundsCenter,
      stepMode,
      fadeTime,
      // Resolved at RENDER time, not per frame: an unknown easing name then throws
      // once, during render, with a stack pointing at the JSX — instead of sixty
      // times a second inside useFrame, which can take the WebGL context down with
      // it. It also keeps the frame loop free of any resolution work.
      fadeCurveFn: resolveEasing(fadeCurve),
      onBulletCount,
      onPoolExhausted,
      simulation,
      interpolate,
    });
    propsRef.current = {
      paused,
      reducedMotion,
      boundsLimit,
      boundsCenter,
      stepMode,
      fadeTime,
      fadeCurveFn: resolveEasing(fadeCurve),
      onBulletCount,
      onPoolExhausted,
      simulation,
      interpolate,
    };

    // ---- Scratch objects (allocated ONCE, reused every frame) --------------
    const { _dummy, _tempColor, _sourcePos, _lerp } = useMemo(
      () => ({
        _dummy: new Object3D(),
        _tempColor: new Color(),
        _sourcePos: new Vector3(),
        // Interpolated position for an external simulation's sync.
        _lerp: new Vector3(),
      }),
      [],
    );

    // ---- Step state: what steps wrote since the last upload ----------------
    //
    // Simulation steps fold their dirty slot span in here instead of flagging
    // the upload themselves; the frame loop flushes it once per rendered frame.
    // Created once, mutated in place. See `StepState` in ./stepping.
    const _step = useMemo(createStepState, []);

    /**
     * External-simulation bookkeeping, mutated in place: whether the next sync
     * must redraw every live bullet (set on attach), the simulation's
     * `stepCount` at the previous sync (for `onBulletCount`), and the
     * warn-once flags.
     */
    const _ext = useMemo(
      () => ({
        full: true,
        lastStepCount: 0,
        warnedStep: false,
        warnedInterpolate: false,
      }),
      [],
    );

    /**
     * The simulation step, reached by the handle's `step()`. A ref because the
     * handle is built before the step function is (the step lives where the
     * frame loop's body always has, further down); both are created once, so
     * this is assigned once in practice and never read stale.
     */
    const advanceRef = useRef<((dt: number) => void) | null>(null);

    // ---- Render options (geometry / orient / outline) ----------------------
    // Composes every matrix that SHOWS a bullet, and owns the camera sync and
    // the outline mesh. Stable for the field's life.
    const { writer, geometry: drawGeometry } = useBulletRender(meshRef, {
      maxBullets: capacity,
      bulletRadius,
      geometry,
      orient,
      outline,
      frames,
    });

    // ---- The field's own simulation ----------------------------------------
    //
    // The headless core — the one implementation of pool, spawn, motion, life,
    // culling, consumption and emitter ids. Created empty here and sized by the
    // pool effect below, so a field that only renders an external simulation
    // never allocates a pool of its own.
    //
    // Its render sink writes matrices inline, at exactly the points this
    // component always wrote them, through the same writer — so an owned
    // field's GPU writes (which slots, how many per step, what values) are
    // unchanged by the move. Every sink method is a no-op before mount.
    const core = useMemo(() => {
      const c = new SimulationCore({ maxBullets: 0 });
      c._sink = {
        spawned(slot, color, primeVelocity) {
          const mesh = meshRef.current;
          if (!mesh) return;
          mesh.setColorAt(slot, color);
          // Fresh heading for a recycled slot (orient="velocity" only), from
          // the PATTERN's velocity so a zero-velocity snapshot still aims.
          writer.prime(slot, primeVelocity);
        },
        show(slot, position, velocity, scale) {
          const mesh = meshRef.current;
          if (mesh) writer.write(mesh, slot, position, velocity, scale, c.payloadAt(slot));
        },
        hide(slot) {
          const mesh = meshRef.current;
          if (mesh) writeHidden(mesh, slot, _dummy);
        },
      };
      return c;
    }, [writer, _dummy]);

    /**
     * Point `mesh.count` at the owned pool's high-water mark, which decays to
     * zero once the field has emptied. Bounds the draw, not the upload.
     */
    const syncMeshCount = useCallback(
      (mesh: InstancedMeshType): void => {
        mesh.count = core.highWater;
      },
      [core],
    );

    // ---- Pool initialization (mount, and capacity / simulation changes) ----
    useEffect(() => {
      const mesh = meshRef.current;
      if (!mesh) return;

      // ---- Release site 5: mass release ----
      // The owned pool is (re)sized and every slot freed. An external
      // simulation is not ours to reset: it is only redrawn in full next frame.
      if (!simulation) core._reset(maxBullets);
      _ext.full = true;
      _ext.lastStepCount = simulation ? simulation.stepCount : 0;

      // GPU buffer hint — tells the driver we'll update every frame
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);

      // Full capacity while priming, so `setMatrixAt`/`setColorAt` see every
      // slot and `instanceColor` is allocated at full size before `count` is
      // ever lowered to the high-water mark below.
      mesh.count = capacity;

      // Prevent first-frame flash: park every instance off-screen + black
      for (let i = 0; i < capacity; i++) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        mesh.setColorAt(i, _tempColor.set(0x000000));
      }
      mesh.instanceMatrix.clearUpdateRanges?.();
      // Manual steps taken since the last frame described the OLD pool's slots
      // (possibly beyond the new capacity); the full upload below covers this one.
      resetPending(_step);
      markMatrixDirty(mesh, 0, capacity - 1);
      mesh.instanceColor!.needsUpdate = true;

      // Nothing is drawn yet: an owned pool is empty, and an external
      // simulation's live bullets are drawn by the next frame's full sync.
      mesh.count = 0;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capacity, simulation]);

    // ---- Development warning: props an external simulation ignores --------
    // Computed during render (a pure string), reported from an effect.
    let ignoredProps = '';
    if (DEV) {
      if (simulation) {
        for (const k of IGNORED_WITH_SIMULATION) {
          if (props[k] !== undefined) ignoredProps += (ignoredProps ? ', ' : '') + k;
        }
      } else if (interpolate !== undefined) {
        ignoredProps = 'interpolate';
      }
    }
    useEffect(() => {
      if (!ignoredProps) return;
      console.warn(
        simulation
          ? `[r3f-projectiles] <BulletField simulation={…}> ignores ${ignoredProps}: an ` +
              'external simulation is configured by its own options (createBulletSimulation).'
          : '[r3f-projectiles] <BulletField> ignores interpolate without a simulation prop.',
      );
    }, [ignoredProps, simulation]);

    // ---- Imperative handle -------------------------------------------------
    //
    // Built by `useMemo` rather than inside `useImperativeHandle`, because the
    // same object is ALSO the registry context value: an `<Emitter>` child
    // needs `register`/`unregister`/`fire` during render, and only a value the
    // render body holds can be handed to a provider. Every dependency below is
    // itself stable, so this object is created exactly once — the context
    // value never changes identity and no consumer re-registers.
    //
    // Typed as the wider `EmitterRegistryHandle` because that is what the
    // provider needs. `useImperativeHandle` below narrows the SAME object to
    // the public `BulletFieldHandle` at the ref boundary — the split is
    // entirely in the types; there is one object, and there must be.
    //
    // Each member reads the CURRENT `simulation` prop: with one, it forwards to
    // that simulation (and `step` refuses); without, it drives the owned core
    // and flushes inline exactly as this component always has.
    const handle = useMemo<EmitterRegistryHandle>(
      () => ({
        /**
         * Append an emitter to the registry and issue it a fresh provenance
         * id from the core's counter — the same one `acquireEmitter()` and
         * `fireAt` use. Never re-renders the field.
         *
         * Registering *is* acquiring: an emitter that unregisters and
         * registers again is a different emitter as far as provenance is
         * concerned, and gets a different id — which is exactly what stops it
         * from inheriting the bullets its previous incarnation left in flight.
         */
        register(entry: EmitterEntry) {
          if (propsRef.current.simulation) throw externalEmitterError();
          const entries = entriesRef.current;
          if (entries.indexOf(entry) === -1) {
            entry.id = core.acquireEmitter();
            entries.push(entry);
          }
        },

        /**
         * Drop an emitter, leaving the surviving entries in their order, and
         * retire its id. Bullets already in flight keep the id they were
         * stamped with; ids never recycle, so nothing issued later collides.
         */
        unregister(entry: EmitterEntry) {
          const entries = entriesRef.current;
          const i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          entry.id = 0;
        },

        assertCanHostEmitters() {
          if (propsRef.current.simulation) throw externalEmitterError();
        },

        /** Manually trigger one burst for a single emitter. */
        fire(entry: EmitterEntry) {
          // Unreachable with an external simulation: `<Emitter>` throws first.
          if (propsRef.current.simulation) return;
          const mesh = meshRef.current;
          if (!mesh) return;
          const { pattern: pat, spawnCenterY: cy, origin: originRef } = entry.props;

          const originVec = originRef?.current;
          if (originVec) _sourcePos.copy(originVec);
          else _sourcePos.set(0, cy, 0);
          const spawned = core._burst(_sourcePos, pat, entry.id, false);
          // Only one thing can cut a `fire()` short: no free slots.
          reportExhaustion(
            propsRef.current.onPoolExhausted,
            entry.id,
            core._lastRequested,
            spawned,
            'pool-full',
          );

          syncMeshCount(mesh);
          markMatrixDirty(mesh, core._opMin, core._opMax);
          // Colors are written only at spawn, so only a real spawn dirties them.
          if (spawned > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        },

        /**
         * Spawn one burst at an arbitrary origin — the core's own `fireAt`,
         * which keeps the id counter an upper bound on every id it is handed
         * and reports `'pool-full'` (here, to this field's `onPoolExhausted`).
         * Works while paused and flushes inline, because a paused frame loop
         * will never flush for it. Safe from inside a `forEachActive` callback.
         */
        fireAt(
          origin: Vector3,
          pattern: PatternKey | PatternFactory,
          emitterId = 0,
        ) {
          const props = propsRef.current;
          if (props.simulation) {
            props.simulation.fireAt(origin, pattern, emitterId);
            return;
          }
          const mesh = meshRef.current;
          if (!mesh) return;
          core.onPoolExhausted = props.onPoolExhausted;
          const spawned = core.fireAt(origin, pattern, emitterId);

          syncMeshCount(mesh);
          markMatrixDirty(mesh, core._opMin, core._opMax);
          if (spawned > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        },

        /** Issue a provenance id — the counter `register()` draws from too. */
        acquireEmitter(): number {
          const sim = propsRef.current.simulation;
          return sim ? sim.acquireEmitter() : core.acquireEmitter();
        },

        /**
         * Retire an id. Clears nothing, re-attributes nothing; only advances
         * the counter past an id the consumer named.
         */
        releaseEmitter(id: number): void {
          const sim = propsRef.current.simulation;
          if (sim) sim.releaseEmitter(id);
          else core.releaseEmitter(id);
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
         * bullets stamped with `id` are released (by the core), and only
         * entries currently holding `id` have their cadence and snapshot
         * guard reset. That is the cross-emitter invariant: no emitter can
         * destroy another emitter's bullets, and no successor inherits a
         * predecessor's.
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
         * destroys bullets, not identities.
         *
         * @param emitterId - Restrict to one emitter. Omit to clear the field.
         * Pass `0` to clear exactly the anonymous `fireAt` bullets.
         */
        clear(emitterId?: number) {
          const sim = propsRef.current.simulation;
          if (sim) {
            sim.clear(emitterId);
            return;
          }
          const mesh = meshRef.current;
          if (!mesh) return;
          const fieldWide = emitterId === undefined;

          // ---- Release site 4 ---- O(active), not O(maxBullets).
          const released = core.clear(emitterId);

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
          markMatrixDirty(mesh, core._opMin, core._opMax);
        },

        /** Number of bullets currently alive, across every emitter. */
        get activeCount(): number {
          const sim = propsRef.current.simulation;
          return sim ? sim.activeCount : core.activeCount;
        },

        /**
         * How many live bullets carry `emitterId` — O(active), delayed bullets
         * included, because a delayed bullet still occupies a slot.
         */
        activeCountFor(emitterId: number): number {
          const sim = propsRef.current.simulation;
          return sim ? sim.activeCountFor(emitterId) : core.activeCountFor(emitterId);
        },

        /**
         * Iterate active, visible bullets; consume any for which `cb` returns
         * `true`. Reentrant: `cb` may call `fireAt` (see the core's walk).
         * Consumption hides the slot through the sink; the span is flushed
         * once, after the walk.
         */
        forEachActive(cb) {
          const sim = propsRef.current.simulation;
          if (sim) {
            sim.forEachActive(cb);
            return;
          }
          core.forEachActive(cb);
          const mesh = meshRef.current;
          if (mesh && core._opMax >= 0) {
            syncMeshCount(mesh);
            markMatrixDirty(mesh, core._opMin, core._opMax);
          }
        },

        /**
         * Advance exactly `dt` seconds — manual mode only. Every refusal
         * (auto mode, paused, unusable `dt`, an external simulation) is a
         * no-op, never a throw. Uploads nothing itself: the step folds its
         * writes into `_step` and the frame loop flushes once per frame.
         */
        step(dt: number) {
          const props = propsRef.current;
          if (props.simulation) {
            if (DEV && !_ext.warnedStep) {
              _ext.warnedStep = true;
              console.warn(
                '[r3f-projectiles] step() was called on a <BulletField simulation={…}>; it is ' +
                  'ignored. The simulation belongs to your code — call sim.step(dt) on it.',
              );
            }
            return;
          }
          if (!shouldStep(_step, props.stepMode, props.paused, dt)) return;
          const advance = advanceRef.current;
          if (!meshRef.current || !advance) return;
          advance(dt);
        },

        /** Overwrite a live bullet's payload; ignored for a slot not live. */
        setPayload(index: number, payload: number) {
          const sim = propsRef.current.simulation;
          if (sim) sim.setPayload(index, payload);
          else core.setPayload(index, payload);
        },
      }),
      [core, _sourcePos, _step, _ext, syncMeshCount],
    );

    useImperativeHandle(ref, () => handle, [handle]);

    // ---- Simulation step ---------------------------------------------------
    //
    // One step of `dt` seconds of the OWNED simulation: the emitters' half
    // (reduced-motion snapshot, cadences, auto-fire), which lives here because
    // emitters are components, then the core's half (delays, motion, life,
    // culling, the fade write) — in the order the pre-0.6.0 loop ran them, so
    // bullets an emitter fires this step are advanced by this step.
    //
    // Called once per frame by the frame loop in `'auto'` mode, and by the
    // handle's `step(dt)` in `'manual'` mode; `paused` and the `dt` clamp are
    // the callers' business. Matrices are written on the CPU through the
    // core's sink but never flagged: the slot span is folded into `_step`, and
    // the frame loop below uploads the union once per rendered frame however
    // many steps ran.
    //
    // Nothing in here reads the renderer, the clock or the frame — only the
    // pool, the registry, the props and `dt`. That is the whole of the
    // determinism guarantee.
    const advance = useCallback((dt: number): void => {
      const props = propsRef.current;
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
          // static `(0, spawnCenterY, 0)` — the same resolution `fire()` uses,
          // so all three origin-resolution paths (fire, auto-fire, snapshot)
          // agree. (Before 0.4.0 the snapshot ignored `origin`; see the
          // changelog.)
          const originVec = entry.props.origin?.current;
          if (originVec) _sourcePos.copy(originVec);
          else _sourcePos.set(0, entry.props.spawnCenterY, 0);
          const n = core._burst(
            _sourcePos,
            entry.props.pattern,
            entry.id,
            true,
            budget,
          );
          // A snapshot truncated by the field-wide 200 cap reports through the
          // same callback as one truncated by a full pool, told apart by
          // `reason`. The core checks `cap` before touching the free stack, so
          // it can only return the whole budget by having been stopped BY the
          // budget; anything short of it means a slot was refused. When both
          // would have bound, the budget is the proximate cause.
          reportExhaustion(
            props.onPoolExhausted,
            entry.id,
            core._lastRequested,
            n,
            n === budget ? 'reduced-motion-budget' : 'pool-full',
          );
          reducedMotionBudgetRef.current = budget - n;
          rmSpawned += n;

          if (core._opMax >= 0) {
            if (rmMax < 0) {
              rmMin = core._opMin;
              rmMax = core._opMax;
            } else {
              if (core._opMin < rmMin) rmMin = core._opMin;
              if (core._opMax > rmMax) rmMax = core._opMax;
            }
          }
        }

        if (serviced) {
          // Queue the one-time update; the frame loop's flush uploads it.
          foldPendingRange(_step, rmMin, rmMax);
          if (rmSpawned > 0) _step.colors = true;
        }
        return; // no animation under reduced motion
      }

      // Reset the snapshot budget if the consumer toggles reduced motion off;
      // each emitter's own guard is reset in the service loop below.
      reducedMotionBudgetRef.current = REDUCED_MOTION_MAX;

      // The slot span this step wrote, folded across every emitter's spawn and
      // the core's step so a single merged update range covers them all.
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
            detSinCos(entry.sourceRotation, _orbitSC);
            _sourcePos.set(_orbitSC.c * 2, ep.spawnCenterY, _orbitSC.s * 2);
          }

          const spawned = core._burst(_sourcePos, ep.pattern, entry.id, false);
          spawnedThisFrame += spawned;
          // Once per burst, per emitter — never once per dropped bullet. The
          // reduced-motion budget is not in play on this path (it returns
          // above), so the pool is the only constraint that can bind.
          reportExhaustion(
            props.onPoolExhausted,
            entry.id,
            core._lastRequested,
            spawned,
            'pool-full',
          );

          if (core._opMax >= 0) {
            if (maxSlot < 0) {
              minSlot = core._opMin;
              maxSlot = core._opMax;
            } else {
              if (core._opMin < minSlot) minSlot = core._opMin;
              if (core._opMax > maxSlot) maxSlot = core._opMax;
            }
          }
        }
      }

      // ---- Update all active bullets: the core's step ----
      // Config is pushed in from the current props at step time — the moment
      // the pre-0.6.0 loop read them — so a prop change lands on the first
      // step after its render, as it always has.
      core.boundsLimit = props.boundsLimit;
      core.boundsCenter = props.boundsCenter;
      core.fadeTime = props.fadeTime;
      core.fadeCurve = props.fadeCurveFn; // already resolved at render time
      core._advance(dt);
      if (core._opMax >= 0) {
        if (maxSlot < 0) {
          minSlot = core._opMin;
          maxSlot = core._opMax;
        } else {
          if (core._opMin < minSlot) minSlot = core._opMin;
          if (core._opMax > maxSlot) maxSlot = core._opMax;
        }
      }

      // ---- Queue GPU buffer updates (ONCE after full loop, never per-bullet)
      // Folded, not flushed: the frame loop uploads the union of every step
      // since the last frame in one range.
      foldPendingRange(_step, minSlot, maxSlot);
      // `instanceColor` is written ONLY at spawn, never in the step, so a
      // step that spawned nothing has nothing to upload.
      if (spawnedThisFrame > 0) _step.colors = true;
      _step.stepped = true;
    }, [core, _sourcePos, _step]);
    advanceRef.current = advance;

    // ---- Frame loop --------------------------------------------------------
    //
    // External simulation: one sync of its dirty range, and nothing else.
    // Owned, `'auto'`: one clamped step, then the flush. Owned, `'manual'`:
    // the flush alone; `step(dt)` did the simulating.
    //
    // The flush is unconditional and cheap when idle: `syncMeshCount` is
    // idempotent (every path that moves the sparse set already ends in it),
    // an empty range marks nothing, and colors upload only if a step spawned.
    useFrame((_state, delta) => {
      const mesh = meshRef.current;
      if (!mesh) return;

      const props = propsRef.current;

      const sim = props.simulation;
      if (sim) {
        let alpha = -1;
        if (props.interpolate) {
          if (sim.interpolation) {
            alpha = props.interpolate();
            if (!(alpha <= 1)) alpha = 1; // also catches NaN: draw the current state
            else if (alpha < 0) alpha = 0;
          } else if (DEV && !_ext.warnedInterpolate) {
            _ext.warnedInterpolate = true;
            console.warn(
              '[r3f-projectiles] <BulletField interpolate> needs a simulation created with ' +
                '{ interpolation: true }; drawing the latest step instead.',
            );
          }
        }
        syncExternal(mesh, sim, writer, _dummy, _tempColor, _lerp, alpha, _ext.full);
        _ext.full = false;

        const steps = sim.stepCount;
        if (steps !== _ext.lastStepCount) {
          _ext.lastStepCount = steps;
          if (props.onBulletCount) props.onBulletCount(sim.activeCount);
        }
        return;
      }

      // Respect paused prop; manual mode never steps from here.
      if (props.stepMode !== 'manual' && !props.paused) {
        advance(Math.min(delta, 0.1)); // clamp to prevent spiral-of-death
      }

      // ---- Batch GPU buffer updates (ONCE per rendered frame, never per step)
      syncMeshCount(mesh);
      markMatrixDirty(mesh, _step.min, _step.max);
      if (_step.colors && mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
      const stepped = _step.stepped;
      resetPending(_step);

      // ---- Callback with active count ----
      // Only on a frame that animated: never while paused, never for a
      // reduced-motion snapshot, never on a manual frame with no step.
      if (stepped && props.onBulletCount) {
        props.onBulletCount(core.activeCount);
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
            args={[undefined, undefined, capacity]}
            frustumCulled={false}
          >
            {drawGeometry ? (
              // A consumer geometry is attached, never owned: R3F never
              // disposes a <primitive>, and `dispose={null}` says so twice.
              // With `frames` it is the field's view of that geometry, which
              // `useBulletRender` disposes (without the shared buffers).
              <primitive object={drawGeometry} attach="geometry" dispose={null} />
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
