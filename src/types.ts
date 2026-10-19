import type { BufferGeometry, Vector3 } from 'three';
import type {
  BulletSpawnData,
  Modifier,
  PatternFactory,
  PatternKey,
} from './patternTypes';
import type { EasingFn, EasingName } from './easing';
import type { StepMode } from './stepping';
import type { BulletOrient } from './render/orient';
import type { BulletOutline } from './render/outline';
import type { BulletFrames } from './render/frames';

export type { EasingFn, EasingName };

// Pattern-side types live in the React-free `./patternTypes`; re-exported so
// `./types` stays the one place to import any public type from.
export type { BulletSpawnData, Modifier, PatternFactory, PatternKey };

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

  /**
   * Half-extent of the cull box: a bullet is deactivated once **any one** of
   * its coordinates is more than this far from the box's centre — an
   * axis-aligned cube, not a sphere. Measured in the field's local
   * coordinates, centred on `(0, 0, 0)` unless `boundsCenter` moves it.
   * `Infinity` disables bounds culling. @default 25
   */
  boundsLimit?: number;

  /**
   * Centre of the `boundsLimit` cull box, read fresh from `.current` once per
   * step, so culling can follow a moving player or camera. Omitted (or
   * `.current` `null`): centred on the field's origin.
   */
  boundsCenter?: { readonly current: Vector3 | null };

  /**
   * `'auto'` advances the simulation once per rendered frame; `'manual'` stops
   * the frame loop from advancing anything and hands the clock to the handle's
   * `step(dt)`. See `BulletFieldProps.stepMode`. @default 'auto'
   */
  stepMode?: StepMode;

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
   * current velocity), `'camera'` (billboard) or `'camera-velocity'`
   * (billboard turned toward the on-screen velocity, 0.7.0). @default 'none'
   */
  orient?: BulletOrient;

  /**
   * A uniform-color rim behind every bullet, drawn by a second instanced mesh
   * that shares this manager's instance matrices. Omit for none.
   */
  outline?: BulletOutline;

  /**
   * Per-bullet sprite frames from one atlas (0.7.0). Same as
   * `<BulletField frames>`; needs `geometry`.
   */
  frames?: BulletFrames;

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
  /**
   * Advance the simulation by exactly `dt` seconds — `stepMode="manual"` only;
   * a no-op (with a one-time development warning) in `'auto'` mode. Uploads
   * happen once per rendered frame however many steps ran. Full contract on
   * `BulletFieldHandle.step`.
   */
  step: (dt: number) => void;
  /**
   * Overwrite the payload of the live bullet at `index` — the write-back half
   * of `forEachActive`, e.g. for a pierce counter. Ignored for a slot that is
   * not live. Full contract on `BulletFieldHandle.setPayload`.
   */
  setPayload: (index: number, payload: number) => void;
}
