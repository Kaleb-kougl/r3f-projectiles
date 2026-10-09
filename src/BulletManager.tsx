import { useRef, useImperativeHandle, forwardRef } from 'react';
import { BulletField, type BulletFieldHandle } from './BulletField';
import { Emitter, type EmitterHandle } from './Emitter';
import type { BulletManagerProps, BulletManagerHandle } from './types';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `<BulletManager>` — a fully props-driven R3F instanced-mesh bullet system.
 *
 * Renders thousands of projectiles using a single `<instancedMesh>` driven by
 * one pooled frame loop — see Performance characteristics for exactly what
 * "pooled" is and is not claiming. All configuration is controlled via props;
 * there is **no** internal Zustand, Context, or Next.js dependency.
 *
 * ## Structure
 * Internally this is a one-emitter {@link BulletField}: the field owns the
 * mesh, the slot pool, and the single `useFrame`, and this component renders
 * exactly one `<Emitter>` into it — contributing an origin, a pattern, and a
 * cadence. At one emitter the split is invisible from the outside, which is
 * the point: every prop, default, and imperative method behaves exactly as it
 * always has. The wrapper's only real work is splitting the seventeen props
 * across the two components and routing `children` to the field's `material`.
 *
 * ## Where the defaults live
 * In `<BulletField>` and `<Emitter>`, not here. This component forwards every
 * prop exactly as it received it — `undefined` included — and `undefined` is
 * precisely what makes a destructuring default apply. So each of the seventeen
 * documented defaults is written down once, in the component that consumes it,
 * and the wrapper cannot drift from the field because it does not restate
 * anything. (Through phase 3 it was the other way round: defaults here,
 * `BulletFieldProps` required. That was the right call while `<BulletField>`
 * was internal and this was its only caller; a public `<BulletField>` needs
 * usable defaults of its own, and moving them down is how you get that without
 * ending up with two copies.) The `@default` tags on
 * {@link BulletManagerProps} remain this component's contract and are unchanged.
 *
 * ## Performance characteristics
 * The loop these describe is {@link BulletField}'s — this component owns none
 * of it — and the full version of the allocation note lives there.
 * - **Allocation-free frame loop, with three named exceptions**: every scratch
 *   `Vector3` / `Object3D` / `Color` is created once via `useMemo` and reused,
 *   so the loop allocates nothing per frame or per bullet *of its own*. Three
 *   allocations happen inside calls it makes: three's `addUpdateRange` pushes
 *   one `{start, count}` record per dirty flush (kept deliberately — it is what
 *   buys a ~128 KB full-buffer upload down to the slots actually written);
 *   `resolvePattern` builds a fresh array per burst; and the built-in pattern
 *   factories go through `compose`, allocating a rest-args array plus one
 *   modifier closure per call. Only a frame that spawns pays the latter two.
 *   The `BulletSpawnData` objects in that array are pooled; the array holding
 *   them is not.
 * - **Frame-rate independent**: physics uses `addScaledVector(v, dt)` with
 *   `dt` clamped to `Math.min(delta, 0.1)`.
 * - **Batched GPU writes**: `needsUpdate` is set **once** after the full bullet
 *   loop, never per-bullet, and always through the field's `markMatrixDirty`.
 * - **DynamicDrawUsage**: GPU buffer hint applied on mount.
 * - **Pool init at (0, −999, 0)**: prevents first-frame flash.
 *
 * ## Material override
 * Pass a child element to replace the default `<meshBasicMaterial fog={false} />`:
 *
 * ```tsx
 * <BulletManager pattern="galaxy">
 *   <meshStandardMaterial emissive="hotpink" emissiveIntensity={2} />
 * </BulletManager>
 * ```
 *
 * ## Imperative handle
 * Use a ref to access `fire()`, `clear()`, and `activeCount`:
 *
 * ```tsx
 * const ref = useRef<BulletManagerHandle>(null);
 * <BulletManager ref={ref} pattern="ring" />
 * ```
 *
 * @see {@link BulletManagerProps} for the full prop list.
 * @see {@link BulletManagerHandle} for the imperative API.
 */
export const BulletManager = forwardRef<BulletManagerHandle, BulletManagerProps>(
  function BulletManager(
    // No defaults here — see "Where the defaults live" above. Every one of
    // these is forwarded verbatim, and an omitted prop arrives at
    // `<BulletField>` or `<Emitter>` as `undefined`, which is what triggers the
    // single definition of its default there.
    {
      maxBullets,
      pattern,
      fireRate,
      paused,
      reducedMotion,
      boundsLimit,
      spawnCenterY,
      rotationSpeed,
      origin,
      bulletRadius,
      fadeTime,
      fadeCurve,
      children,
      onBulletCount,
      geometry,
      orient,
      outline,
    },
    ref,
  ) {
    const fieldRef = useRef<BulletFieldHandle | null>(null);
    const emitterRef = useRef<EmitterHandle | null>(null);

    // ---- Imperative handle -------------------------------------------------
    //
    // The three field-wide methods forward to the field; `fire()` forwards to
    // this wrapper's single emitter, which is what keeps its four documented
    // differences from the frame loop (static origin fallback, no cadence or
    // orbit advance, works while paused, flushes inline) intact. Both refs are
    // resolved at call time, so the handle object never has to be rebuilt.
    useImperativeHandle(
      ref,
      () => ({
        /** Manually trigger one burst of the current pattern. */
        fire() {
          emitterRef.current?.fire();
        },

        /** Deactivate all bullets and reset the simulation timer. */
        clear() {
          fieldRef.current?.clear();
        },

        /** Number of bullets currently alive. */
        get activeCount(): number {
          return fieldRef.current?.activeCount ?? 0;
        },

        /**
         * Iterate active, visible bullets; consume any for which `cb` returns
         * `true`. Delayed (not-yet-visible) bullets are skipped so a hit test
         * never lands on a parked instance.
         */
        forEachActive(cb) {
          fieldRef.current?.forEachActive(cb);
        },
      }),
      [],
    );

    // ---- JSX ---------------------------------------------------------------
    // `children` is this component's material override and always has been, so
    // it is routed to the field's `material` prop — which exists precisely so
    // that `children` is free to carry emitters. The field's single
    // `instancedMesh` stays the only scene node this subtree contributes:
    // `<Emitter>` renders `null` and the registry provider is not a scene
    // object.
    return (
      <BulletField
        ref={fieldRef}
        maxBullets={maxBullets}
        boundsLimit={boundsLimit}
        bulletRadius={bulletRadius}
        fadeTime={fadeTime}
        fadeCurve={fadeCurve}
        paused={paused}
        reducedMotion={reducedMotion}
        onBulletCount={onBulletCount}
        material={children}
        geometry={geometry}
        orient={orient}
        outline={outline}
      >
        <Emitter
          ref={emitterRef}
          pattern={pattern}
          fireRate={fireRate}
          origin={origin}
          spawnCenterY={spawnCenterY}
          rotationSpeed={rotationSpeed}
        />
      </BulletField>
    );
  },
);
