import {
  useRef,
  useEffect,
  useContext,
  useImperativeHandle,
  forwardRef,
} from 'react';
import {
  EmitterRegistryContext,
  type EmitterEntry,
  type EmitterProps,
} from './BulletField';

// ---------------------------------------------------------------------------
// Imperative handle
// ---------------------------------------------------------------------------

/**
 * Imperative surface of a single `<Emitter>`.
 *
 * `fire()` is deliberately **not** the same operation the frame loop performs
 * — the differences are the ones `<BulletManager>.fire()` has always had, and
 * they are documented on `EmitterRegistryHandle.fire`, the internal spawn path
 * this delegates to: a static
 * `(0, spawnCenterY, 0)` origin fallback instead of the orbit, no advance of
 * either the cadence timer or the orbit phase, it works while the field is
 * paused, and it flushes `needsUpdate` inline.
 */
export interface EmitterHandle {
  /** Manually trigger one burst of this emitter's pattern. */
  fire: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `<Emitter>` — an origin, a pattern, and a cadence. Renders nothing.
 *
 * Mount one or more as children of a `<BulletField>`; they share that field's
 * mesh, pool, and single frame loop, so N emitters cost N registry entries
 * rather than N draw calls.
 *
 * ```tsx
 * <BulletField maxBullets={2000} material={<meshStandardMaterial />}>
 *   <Emitter origin={bossRef}   pattern={bossPattern}   fireRate={3} />
 *   <Emitter origin={turretRef} pattern={turretPattern} fireRate={1} />
 * </BulletField>
 * ```
 *
 * ## Registration is imperative, and that is the point
 * The entry object is built once by `useRef` — its identity **is** the registry
 * key — and registered in a mount `useEffect`. Props are refreshed onto that
 * same object on every render, the same `propsRef` discipline the field's frame
 * loop uses, so:
 *
 * - registering never triggers a re-render, in this component or the field;
 * - a prop change never re-registers, which matters because re-registering
 *   would move this emitter to the **tail** of the service order for no reason.
 *
 * ## Service order
 * Registration order is service order, and registration order is mount order,
 * which is JSX order. An emitter that unmounts and remounts therefore lands at
 * the tail of the registry, and so is last to be served when the shared pool is
 * exhausted. Read nothing else into service order.
 *
 * ## Not for swarms
 * One `<Emitter>` per enemy reintroduces exactly the per-entity mount churn a
 * pooled game exists to avoid. Emitters that are pool rows rather than
 * components should use the field's imperative surface instead:
 * `acquireEmitter()` on spawn, `fireAt()` from your own loop,
 * `releaseEmitter()` on death.
 */
export const Emitter = forwardRef<EmitterHandle, EmitterProps>(
  function Emitter(
    // ---- The one place an emitter-level default lives --------------------
    // `<BulletManager>` forwards what it was handed, `undefined` included, and
    // `undefined` is what selects the value here. Its documented defaults are
    // these, defined once.
    {
      pattern = 'fibonacciSphere',
      fireRate = 1.5,
      origin,
      spawnCenterY = 3,
      rotationSpeed = 0.3,
    },
    ref,
  ) {
    // The field's handle object, provided by the enclosing `<BulletField>`. It
    // is created once per field, so it is referentially stable and safe as an
    // effect dependency below. Missing it throws during render, so the mistake
    // points at the offending JSX rather than producing an emitter that
    // silently never fires.
    const registry = useContext(EmitterRegistryContext);
    if (!registry) {
      throw new Error('<Emitter> must be rendered as a child of <BulletField>.');
    }

    // ---- The registry entry ------------------------------------------------
    //
    // Stable object identity: built once, mutated in place, never swapped.
    const entryRef = useRef<EmitterEntry>({
      props: { pattern, fireRate, origin, spawnCenterY, rotationSpeed },
      // `0` — the reserved "anonymous" id — until the field issues a real one
      // in `register()` below. There is no `id` prop on purpose: an id the
      // consumer chooses can collide with a live emitter's, and provenance
      // that can collide is not provenance.
      id: 0,
      timeAccum: 0,
      sourceRotation: 0,
      reducedMotionSpawned: false,
    });
    const entryProps = entryRef.current.props;
    entryProps.pattern = pattern;
    entryProps.fireRate = fireRate;
    entryProps.origin = origin;
    entryProps.spawnCenterY = spawnCenterY;
    entryProps.rotationSpeed = rotationSpeed;

    // ---- Registration ------------------------------------------------------
    //
    // `registry` is referentially stable for the life of the field, so this
    // runs exactly once on mount and once on unmount. Everything the emitter
    // owns across frames — cadence, orbit phase, reduced-motion guard — lives
    // on the entry, so unregistering takes all of it with it and leaves every
    // other emitter's bullets, including any still in flight from this one,
    // completely untouched.
    //
    // Registration is also the id **acquire**, and unregistration the release:
    // the field stamps `entry.id` here. Ids never recycle, so this emitter's
    // in-flight bullets stay correctly attributed after unmount, and a
    // remounted `<Emitter>` is a genuinely new emitter with a new id rather
    // than an heir to the old one's bullets.
    useEffect(() => {
      const entry = entryRef.current;
      registry.register(entry);
      return () => {
        registry.unregister(entry);
      };
    }, [registry]);

    // ---- Imperative handle -------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        fire() {
          registry.fire(entryRef.current);
        },
      }),
      [registry],
    );

    // Renders nothing: an emitter contributes to the field's frame loop, never
    // to the scene graph. This is what keeps the field's `instancedMesh` the
    // first and only node the subtree contributes.
    return null;
  },
);
