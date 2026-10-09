import { DEV } from './dev';

// ---------------------------------------------------------------------------
// Step mode
// ---------------------------------------------------------------------------

/**
 * Who advances a `<BulletField>`'s simulation.
 *
 * - `'auto'` — the field's own `useFrame` advances it once per rendered frame,
 *   by the frame's `delta` clamped to `0.1` s. Exactly the pre-0.5.0 loop.
 * - `'manual'` — the field's `useFrame` advances **nothing**. The consumer calls
 *   `step(dt)` on the field's handle, as many times per rendered frame as its
 *   own fixed-timestep loop wants, and each call advances exactly `dt` seconds.
 *   The frame loop is left with one job: uploading whatever those steps wrote,
 *   once per rendered frame.
 */
export type StepMode = 'auto' | 'manual';

// ---------------------------------------------------------------------------
// Per-field step state
// ---------------------------------------------------------------------------

/**
 * What a field's simulation steps have written since its last GPU flush, plus
 * the field's warn-once flags for misuse of `step()`.
 *
 * ## Why steps do not flag the upload themselves
 * A step writes instance matrices on the CPU — that is the simulation's output
 * — but it never touches `needsUpdate` or `addUpdateRange`. It folds the slot
 * span it wrote into `min` / `max` here instead, and the field's frame loop
 * turns the accumulated span into **one** dirty range and **one** version bump
 * per rendered frame. Five `step()` calls between two frames therefore cost one
 * `addUpdateRange` record and one upload, not five.
 *
 * In `'auto'` mode there is exactly one step per frame, so this is a
 * pass-through: the step folds, the same frame flushes, and the observable GPU
 * writes are the ones the pre-0.5.0 loop made inline.
 *
 * One object per field, created once and mutated in place — the same
 * discipline as the field's other scratch objects, so neither a step nor a
 * flush allocates.
 *
 * Internal. Not barrelled.
 */
export interface StepState {
  /** Lowest slot written since the last flush. Meaningless while `max < min`. */
  min: number;
  /** Highest slot written since the last flush; `-1` when nothing was. */
  max: number;
  /** A step spawned at least once, so `instanceColor` needs uploading too. */
  colors: boolean;
  /**
   * At least one **animating** step ran since the last flush — the condition
   * under which `onBulletCount` is raised. A reduced-motion step does not set
   * it, matching the pre-0.5.0 loop, which returned before the callback.
   */
  stepped: boolean;
  /** `step()` was called in `'auto'` mode and the dev warning has been shown. */
  warnedAutoStep: boolean;
  /** `step()` was called with an unusable `dt` and the dev warning has been shown. */
  warnedBadDt: boolean;
}

/** A fresh, empty {@link StepState}. Call once per field, never per frame. */
export function createStepState(): StepState {
  return {
    min: 0,
    max: -1,
    colors: false,
    stepped: false,
    warnedAutoStep: false,
    warnedBadDt: false,
  };
}

/**
 * Widen the pending dirty span to cover `[min, max]`. An empty span
 * (`max < min`, which is how every caller spells "wrote nothing") is a no-op.
 */
export function foldPendingRange(
  state: StepState,
  min: number,
  max: number,
): void {
  if (max < min) return;
  if (state.max < state.min) {
    state.min = min;
    state.max = max;
    return;
  }
  if (min < state.min) state.min = min;
  if (max > state.max) state.max = max;
}

/** Forget everything pending — called by the flush, after it has uploaded. */
export function resetPending(state: StepState): void {
  state.min = 0;
  state.max = -1;
  state.colors = false;
  state.stepped = false;
}

// ---------------------------------------------------------------------------
// The `step()` gate
// ---------------------------------------------------------------------------

/**
 * Decide whether a `step(dt)` call may advance the simulation, warning (once
 * per field, development builds only) about the two misuses that would
 * otherwise fail silently.
 *
 * Every refusal is a **no-op**, never a throw: `step()` is called from inside
 * a game's frame loop, and an exception there takes the whole loop — and often
 * the WebGL context — down with it.
 *
 * - **`'auto'` mode** — refused, with a one-time warning. The field already
 *   advances itself every frame; honouring an extra step would silently run
 *   the simulation fast. Switch `stepMode` to `'manual'` to own the clock.
 * - **`paused`** — refused, silently. `paused` means "freeze the simulation"
 *   in both modes, and a refused step is **not** queued for later.
 * - **`dt` not a finite number > 0** — refused. `NaN`, negatives and
 *   `Infinity` warn once, because each is a bug in the caller's clock: `NaN`
 *   would poison every bullet's position and a negative step would run time
 *   backwards through code that was never written to. `0` is refused without a
 *   warning, since a zero-length step is a legitimate degenerate case of a
 *   fixed-step accumulator and would be a no-op anyway.
 */
export function shouldStep(
  state: StepState,
  stepMode: StepMode,
  paused: boolean,
  dt: number,
): boolean {
  if (stepMode !== 'manual') {
    if (DEV && !state.warnedAutoStep) {
      state.warnedAutoStep = true;
      console.warn(
        '[r3f-projectiles] step() was called on a <BulletField> with ' +
          "stepMode 'auto'; it is ignored. The field already advances itself " +
          "once per rendered frame — pass stepMode=\"manual\" to drive it with step(dt).",
      );
    }
    return false;
  }
  if (paused) return false;
  if (!(dt > 0 && dt < Infinity)) {
    if (dt !== 0 && DEV && !state.warnedBadDt) {
      state.warnedBadDt = true;
      console.warn(
        `[r3f-projectiles] step(${dt}) ignored: dt must be a finite number of ` +
          'seconds greater than 0.',
      );
    }
    return false;
  }
  return true;
}
