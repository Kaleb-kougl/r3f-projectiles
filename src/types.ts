import type { BufferGeometry, Vector3 } from 'three';
import type { EasingFn, EasingName } from './easing';
import type { BulletOrient } from './render/orient';
import type { BulletOutline } from './render/outline';

export type { EasingFn, EasingName };

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

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

/**
 * Display-friendly labels for each built-in pattern.
 * Useful for UI selectors / dropdowns.
 */
export const PATTERN_LABELS: Record<PatternKey, string> = {
  fibonacciSphere: 'Fibonacci Sphere',
  torusKnot: 'Torus Knot',
  galaxy: 'Galaxy',
  helix: 'Helix',
  rose3D: 'Rose 3D',
  ring: 'Ring',
  arc: 'Arc',
} as const;

// ---------------------------------------------------------------------------
// Component props & imperative handle
// ---------------------------------------------------------------------------

/**
 * Props for the `<BulletManager>` R3F component.
 *
 * All props are optional and have sensible defaults. The component is fully
 * controlled — no internal Zustand or context dependency.
 */
export interface BulletManagerProps {
  /** Maximum number of concurrent bullet instances. @default 2000 */
  maxBullets?: number;

  /**
   * Which pattern to fire. Pass a `PatternKey` string for a built-in preset,
   * or a custom `PatternFactory` function for full control.
   * @default 'fibonacciSphere'
   */
  pattern?: PatternKey | PatternFactory;

  /** Shots per second. @default 1.5 */
  fireRate?: number;

  /** Freeze the simulation (bullets hold position). @default false */
  paused?: boolean;

  /**
   * When `true`, spawns a single static snapshot of the current pattern
   * with zero velocity — suitable for users who prefer reduced motion.
   * @default false
   */
  reducedMotion?: boolean;

  /** Distance from origin at which bullets are deactivated. @default 25 */
  boundsLimit?: number;

  /** Y-coordinate of the spawn center. @default 3 */
  spawnCenterY?: number;

  /** Radians per second for the source-position orbit. @default 0.3 */
  rotationSpeed?: number;

  /**
   * Emitter origin, read fresh from `.current` at each shot. Lets a moving
   * source fire from its live position instead of the built-in Y-axis orbit.
   * A plain `{ current }` object or a React ref both work. When omitted (or
   * `.current` is `null`), the orbit is used — fully backwards-compatible.
   */
  origin?: { readonly current: Vector3 | null };

  /**
   * Radius of each bullet sphere — or, with a custom `geometry`, the scale
   * applied to that unit-sized geometry. @default 0.12
   */
  bulletRadius?: number;

  /**
   * Bullet geometry, replacing the default sphere. Forward is local +X, up is
   * local +Y, authored at unit size and scaled by `bulletRadius`. **Never
   * disposed by the manager** — it is yours. See `bulletGeometry` for
   * ready-made flat shapes.
   */
  geometry?: BufferGeometry;

  /**
   * How each bullet is rotated: `'none'`, `'velocity'` (local +X along the
   * current velocity) or `'camera'` (billboard). @default 'none'
   */
  orient?: BulletOrient;

  /**
   * A uniform-color rim behind every bullet, drawn by a second instanced mesh
   * that shares this manager's instance matrices. Omit for none.
   */
  outline?: BulletOutline;

  /**
   * Seconds of fade-out at the end of a bullet's life. The bullet renders at full
   * size until this much life remains, then scales down to nothing.
   *
   * Affects rendering only — never when a bullet despawns. Set `0` to disable
   * fading entirely. If this exceeds a bullet's total `life`, that bullet starts
   * partway through its fade and never reaches full size.
   *
   * @default 1
   */
  fadeTime?: number;

  /**
   * Shape of the fade — a built-in {@link EasingName} or your own {@link EasingFn}.
   *
   * Standard easing semantics: the input is fade progress (`0` at fade start, `1` at
   * despawn) and the output is how faded the bullet is. So `easeIn*` holds the bullet
   * at size and drops it late, `easeOut*` shrinks it immediately then lingers.
   *
   * @default 'linear'
   */
  fadeCurve?: EasingName | EasingFn;

  /**
   * Override the default `<meshBasicMaterial fog={false} />` by passing
   * a custom material as a child element.
   */
  children?: React.ReactNode;

  /**
   * Called once per frame with the current number of active bullets.
   * Useful for HUD counters or performance monitoring.
   */
  onBulletCount?: (count: number) => void;
}

/**
 * Imperative handle exposed via `React.forwardRef` + `useImperativeHandle`.
 *
 * @example
 * ```tsx
 * const ref = useRef<BulletManagerHandle>(null);
 * <BulletManager ref={ref} />
 * // later…
 * ref.current?.fire();
 * ```
 */
export interface BulletManagerHandle {
  /** Manually trigger one burst of the current pattern. */
  fire: () => void;
  /** Deactivate all bullets and reset the simulation timer. */
  clear: () => void;
  /** Number of bullets currently alive. */
  readonly activeCount: number;
  /**
   * Iterate active (visible, non-delayed) bullets in one pass. Return `true`
   * from `cb` to consume — the bullet is deactivated and its slot freed.
   *
   * `pos` is the bullet's live internal position vector: read it (e.g. for a
   * hit test), but never retain a reference across frames. `payload` is the
   * bullet's opaque per-bullet integer (see {@link BulletSpawnData.payload}).
   *
   * `emitterId` identifies which emitter fired the bullet. It is issued by the
   * field, starts at `1`, and is never recycled — so a bullet stays correctly
   * attributed even after the emitter that fired it is gone. `0` means the
   * bullet has no emitter (anonymous).
   *
   * The `emitterId` parameter is **additive**: JavaScript ignores arguments a
   * callback does not declare, so an existing three-parameter callback keeps
   * compiling and keeps behaving exactly as before.
   */
  forEachActive: (
    cb: (
      index: number,
      pos: Vector3,
      payload: number,
      emitterId: number,
    ) => boolean | void,
  ) => void;
}
