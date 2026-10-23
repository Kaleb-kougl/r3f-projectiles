// ---------------------------------------------------------------------------
// Easing — shapes for the bullet fade-out
// ---------------------------------------------------------------------------

/**
 * An easing function.
 *
 * The input `p` is normalised **fade progress**: `0` the moment the fade begins,
 * `1` at despawn. The return value is how *faded* the bullet is — `0` for
 * untouched, `1` for gone.
 *
 * These are the standard easing semantics, so any function from easings.net can be
 * dropped in and will mean what it normally means.
 */
export type EasingFn = (p: number) => number;

/** Names of the built-in easing curves. */
export type EasingName =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'smoothstep';

/**
 * Built-in easing curves. Every one satisfies `f(0) === 0`, `f(1) === 1` and is
 * monotonic non-decreasing across `[0, 1]`.
 *
 * Read them as descriptions of the *fade*, not the bullet:
 * - `easeIn*` — fade starts slow, so the bullet holds its size then vanishes quickly.
 * - `easeOut*` — fade starts fast, so the bullet shrinks immediately then lingers small.
 */
export const EASING: Record<EasingName, EasingFn> = {
  linear: (p) => p,
  easeInQuad: (p) => p * p,
  easeOutQuad: (p) => 1 - (1 - p) * (1 - p),
  // Integer powers are plain multiplications (0.8.0; was `Math.pow`, which
  // ECMAScript leaves implementation-approximated): the same bits everywhere.
  easeInOutQuad: (p) => {
    if (p < 0.5) return 2 * p * p;
    const t = -2 * p + 2;
    return 1 - (t * t) / 2;
  },
  easeInCubic: (p) => p * p * p,
  easeOutCubic: (p) => {
    const t = 1 - p;
    return 1 - t * t * t;
  },
  easeInOutCubic: (p) => {
    if (p < 0.5) return 4 * p * p * p;
    const t = -2 * p + 2;
    return 1 - (t * t * t) / 2;
  },
  smoothstep: (p) => p * p * (3 - 2 * p),
};

/**
 * Resolve a `fadeCurve` prop value to a concrete function.
 *
 * Mirrors {@link resolvePattern}: an unrecognised name throws rather than silently
 * falling back, so a typo surfaces immediately.
 *
 * @param curve - A built-in easing name or a custom function.
 */
export function resolveEasing(curve: EasingName | EasingFn): EasingFn {
  if (typeof curve === 'function') return curve;
  const fn = EASING[curve];
  if (!fn) {
    throw new Error(
      `[r3f-projectiles] Unknown easing "${curve}". ` +
        `Valid names: ${Object.keys(EASING).join(', ')}`,
    );
  }
  return fn;
}

/**
 * The visual scale multiplier for a bullet with `life` seconds remaining.
 *
 * Affects rendering only — it never influences when a bullet despawns, and the
 * consumer's own collision radius is untouched.
 *
 * With the defaults (`fadeTime = 1`, `curve = linear`) this is exactly
 * `Math.min(life, 1)`, which is the behaviour that predates the props:
 * `life >= 1` returns 1, otherwise `p = 1 - life` and `1 - p === life`.
 *
 * The result is clamped at 0 from below — a negative scale mirrors the mesh — but
 * deliberately not from above, so an overshooting curve can "pop" a bullet before it
 * dies. A non-finite curve would corrupt the instance matrix buffer, so it falls
 * back to full size.
 *
 * @param life     - Seconds of life remaining.
 * @param fadeTime - Seconds of fade at the end of life. `<= 0` disables fading.
 * @param curve    - Resolved easing function.
 */
export function fadeScale(life: number, fadeTime: number, curve: EasingFn): number {
  if (!(fadeTime > 0)) return 1; // 0, negative or NaN → no fade
  if (life >= fadeTime) return 1; // not fading yet
  const p = 1 - life / fadeTime; // 0 at fade start → 1 at despawn
  const s = 1 - curve(p);
  return Number.isFinite(s) ? Math.max(0, s) : 1;
}
