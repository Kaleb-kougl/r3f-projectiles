import type { Vector3 } from 'three';

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
  | 'ring';

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
}
