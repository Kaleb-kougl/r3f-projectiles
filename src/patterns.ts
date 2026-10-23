import { Vector3 } from 'three';
import { acquire } from './pool';
import { detCos, detSinCos, type SinCos } from './detmath';
import { normalize3, cross3, quatFromAxisAngle, applyQuat3, type Quat } from './vecmath';
import type { BulletSpawnData, Modifier } from './patternTypes';

// Payload bitfields ride along on this entry because they are pattern-side
// data with no React in them: `mod.payload(Shot.pack({ … }))` is written next
// to `gen` and `mod`. `./payload` imports nothing but a NODE_ENV check, so the
// entry stays React- and R3F-free.
export { definePayload } from './payload';
export type { PayloadLayout, PayloadSchema, PayloadValues } from './payload';

// The seeded generator that makes `gen.galaxy` / `gen.rose3D` replayable rides
// along for the same reason: it is pattern-side and imports nothing.
export { createSeededRandom } from './rng';

// Deterministic sin / cos (0.8.0): pattern-side, imports nothing.
export { detSin, detCos, detSinCos, DETMATH_RANGE } from './detmath';
export type { SinCos } from './detmath';

// ---------------------------------------------------------------------------
// Module-scope scratch objects — allocated ONCE, never inside a hot path.
// ---------------------------------------------------------------------------

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _sc: SinCos = { s: 0, c: 0 };

// Arithmetic (0.8.0): trig is `detSin` / `detCos` / `detSinCos`, and vector
// math goes through `./vecmath` — never `Math.sin` / `Math.cos` or three's
// math methods, whose op order is three's to change. Every formula keeps
// 0.7.0's operation order, so in Node (whose `Math.sin` / `Math.cos` are an
// fdlibm port that agrees with det math bit for bit) the spawn data is
// bit-identical to 0.7.0's. In browsers and Electron (Chromium's libm path
// differs from Node's), Firefox and Safari, 0.7.0's `Math.sin` was the
// engine's own, so some bullets differ from 0.7.0 in the last bit; they now
// equal Node's everywhere. `Vector3.set` / `.copy` are plain stores.

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Pattern generators.
 *
 * Each function returns an array of `BulletSpawnData` acquired from the pool.
 * Callers **must** call `releaseSpawnData()` after the data has been consumed
 * to return objects to the pool.
 */
export const gen = {
  /**
   * Distributes bullets on a Fibonacci (golden-angle) sphere.
   * Produces an even coverage of a sphere — ideal for omni-directional bursts.
   *
   * @param count  - Number of bullets.
   * @param radius - Sphere radius (offset from origin).
   */
  fibonacciSphere(count: number, radius: number): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    if (count === 1) {
      const p = acquire();
      p.offset.set(0, 0, 0);
      p.velocity.set(0, 0, 0);
      spawns.push(p);
      return spawns;
    }

    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden Angle

    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2; // y goes from 1 to -1
      const r = Math.sqrt(1 - y * y);        // radius at y
      const theta = phi * i;

      detSinCos(theta, _sc);
      const x = _sc.c * r;
      const z = _sc.s * r;

      normalize3(_v1.set(x, y, z));

      const p = acquire();
      p.offset.x = _v1.x * radius;
      p.offset.y = _v1.y * radius;
      p.offset.z = _v1.z * radius;
      p.velocity.copy(_v1);
      spawns.push(p);
    }
    return spawns;
  },

  /**
   * Distributes bullets along a parametric torus knot curve.
   *
   * @param count  - Number of bullets.
   * @param p_knot - The *p* parameter of the (p,q) torus knot. @default 2
   * @param q_knot - The *q* parameter of the (p,q) torus knot. @default 3
   * @param radius - Scale factor. @default 2
   */
  torusKnot(count: number, p_knot: number = 2, q_knot: number = 3, radius: number = 2): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;

      // Parametric Torus Knot
      detSinCos(q_knot * t, _sc);
      const r = _sc.c + 2;
      const y = -_sc.s;
      detSinCos(p_knot * t, _sc);
      const x = r * _sc.c;
      const z = r * _sc.s;

      const k = radius * 0.5;
      const pos = _v1.set(x * k, y * k, z * k);

      const spawned = acquire();
      spawned.offset.copy(pos);
      normalize3(spawned.velocity.copy(pos));
      spawns.push(spawned);
    }
    return spawns;
  },

  /**
   * Distributes bullets in a spiral-arm galaxy pattern.
   * Uses logarithmic distribution for density near the center.
   *
   * @param count  - Number of bullets.
   * @param radius - Galaxy radius. @default 4
   * @param arms   - Number of spiral arms. @default 3
   * @param spin   - Tightness of spiral. @default 2
   * @param rng    - Source of uniform numbers in `[0, 1)`, called twice per
   *   bullet. @default Math.random — which makes this generator, and the
   *   built-in `'galaxy'` preset, **non-deterministic**. Pass a seeded
   *   generator (`createSeededRandom(seed)`) for a pattern that replays
   *   bit-identically.
   */
  galaxy(
    count: number,
    radius: number = 4,
    arms: number = 3,
    spin: number = 2,
    // eslint-disable-next-line no-restricted-properties -- documented non-deterministic default
    rng: () => number = Math.random,
  ): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    if (arms === 0) arms = 1;
    for (let i = 0; i < count; i++) {
      const armIndex = i % arms;
      const dist = rng();
      // Logarithmic distribution for density near center
      const d = dist * dist;

      const angle = d * spin + armIndex * ((Math.PI * 2) / arms);
      const r = d * radius;

      detSinCos(angle, _sc);
      const x = _sc.c * r;
      const z = _sc.s * r;
      const y = (rng() - 0.5) * (radius * 0.2); // Flat disc with some thickness

      const p = acquire();
      p.offset.set(x, y, z);
      detSinCos(angle + Math.PI / 2, _sc);
      p.velocity.set(_sc.c, 0, _sc.s);
      p.life = 8.0;
      spawns.push(p);
    }
    return spawns;
  },

  /**
   * Distributes bullets along a helix (DNA-style double spiral).
   *
   * @param count  - Number of bullets.
   * @param radius - Helix radius. @default 2
   * @param height - Total height of the helix. @default 4
   * @param turns  - Number of full rotations. @default 2
   */
  helix(count: number, radius: number = 2, height: number = 4, turns: number = 2): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    if (count === 1) {
      const p = acquire();
      p.offset.set(0, 0, 0);
      p.velocity.set(0, 0, 0);
      spawns.push(p);
      return spawns;
    }
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1); // 0 to 1
      const angle = t * Math.PI * 2 * turns;

      detSinCos(angle, _sc);
      const x = _sc.c * radius;
      const z = _sc.s * radius;
      const y = (t - 0.5) * height;

      const p = acquire();
      p.offset.set(x, y, z);
      p.velocity.set(_sc.c, 0, _sc.s);
      spawns.push(p);
    }
    return spawns;
  },

  /**
   * Distributes bullets in a 3D rose (rhodonea) curve.
   * The petal count is controlled by `k`.
   *
   * @param count  - Number of bullets.
   * @param k      - Petal parameter (even → 2k petals, odd → k petals). @default 4
   * @param radius - Maximum petal radius. @default 2
   * @param rng    - Source of uniform numbers in `[0, 1)`, called twice per
   *   bullet. @default Math.random — which makes this generator, and the
   *   built-in `'rose3D'` preset, **non-deterministic**. Pass a seeded
   *   generator (`createSeededRandom(seed)`) for a pattern that replays
   *   bit-identically.
   */
  rose3D(
    count: number,
    k: number = 4,
    radius: number = 2,
    // eslint-disable-next-line no-restricted-properties -- documented non-deterministic default
    rng: () => number = Math.random,
  ): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const phi = rng() * Math.PI;

      // R modulated by cosine of angle × k
      const r = Math.abs(detCos(k * theta)) * radius;

      detSinCos(phi, _sc);
      const sinPhi = _sc.s;
      const cosPhi = _sc.c;
      detSinCos(theta, _sc);
      const x = r * sinPhi * _sc.c;
      const y = r * cosPhi;
      const z = r * sinPhi * _sc.s;

      const pos = _v1.set(x, y, z);
      const p = acquire();
      p.offset.copy(pos);
      normalize3(p.velocity.copy(pos));
      spawns.push(p);
    }
    return spawns;
  },

  /**
   * Distributes bullets in a flat ring expanding outward.
   *
   * @param count  - Number of bullets in the ring.
   * @param speed  - Outward velocity magnitude. @default 2
   * @param radius - Initial ring radius (0 = all start at center). @default 0
   */
  ring(count: number, speed: number = 2, radius: number = 0): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const p = acquire();
      detSinCos(angle, _sc);
      p.offset.set(_sc.s * radius, 0, _sc.c * radius);
      // 0.7.0 was `.set(sin, 0, cos).multiplyScalar(speed)`: y stays `0 * speed`
      // (-0 for a negative speed, NaN for a non-finite one), bit for bit.
      p.velocity.set(_sc.s * speed, 0 * speed, _sc.c * speed);
      spawns.push(p);
    }
    return spawns;
  },

  /**
   * Distributes bullets in a flat arc — the only **directional** generator.
   *
   * Angles follow the same convention as {@link gen.ring}: `0` points along `+Z`,
   * increasing toward `+X`, so a direction is `(sin θ, 0, cos θ)` and a heading can be
   * recovered from a direction with `Math.atan2(dir.x, dir.z)`.
   *
   * At `spread >= 2π` this reduces exactly to `ring(count, speed, radius)` — evenly
   * spaced, with no doubled bullet where the ends meet — which makes `arc` a strict
   * superset of `ring`. Below `2π` the bullets span the cone inclusive of both edges,
   * so `count === 1` fires a single bullet straight down the heading.
   *
   * @param count   - Number of bullets in the arc.
   * @param spread  - Angular width of the cone in radians. @default Math.PI / 4
   * @param speed   - Outward velocity magnitude. @default 2
   * @param heading - Direction the arc is centred on, in radians. @default 0
   * @param radius  - Initial offset from the origin (0 = all start at centre). @default 0
   */
  arc(
    count: number,
    spread: number = Math.PI / 4,
    speed: number = 2,
    heading: number = 0,
    radius: number = 0,
  ): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    const TAU = Math.PI * 2;
    // A full circle must not place a bullet at both -π and +π: those are the same
    // direction, and that duplicate is exactly what would stop this reducing to `ring`.
    const full = spread >= TAU - 1e-9;

    for (let i = 0; i < count; i++) {
      let angle: number;
      if (full) {
        angle = heading + (i / count) * TAU;
      } else if (count === 1) {
        angle = heading;
      } else {
        angle = heading + (i / (count - 1) - 0.5) * spread;
      }
      const p = acquire();
      detSinCos(angle, _sc);
      p.offset.set(_sc.s * radius, 0, _sc.c * radius);
      // 0.7.0 was `.set(sin, 0, cos).multiplyScalar(speed)`: y stays `0 * speed`
      // (-0 for a negative speed, NaN for a non-finite one), bit for bit.
      p.velocity.set(_sc.s * speed, 0 * speed, _sc.c * speed);
      spawns.push(p);
    }
    return spawns;
  },
};

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Pattern modifiers.
 *
 * Each modifier is a curried function: call it with configuration to get a
 * `Modifier` that transforms spawn data in-place. Stack modifiers via
 * `compose()`.
 */
export const mod = {
  /**
   * Set a uniform color on every bullet in the spawn batch.
   *
   * @param col - Hex color value (e.g. `0xff3333`).
   */
  color(col: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.color = col));
      return spawns;
    };
  },

  /**
   * Stamp an opaque per-bullet integer onto every bullet in the batch. The
   * library carries it untouched; read it back via `forEachActive`. Use it for
   * per-bullet damage, pierce counters, faction tags, etc.
   *
   * @param value - The payload integer to assign.
   */
  payload(value: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.payload = value));
      return spawns;
    };
  },

  /**
   * Set a uniform size multiplier on every bullet in the batch. Multiplies
   * against the field's `bulletRadius` rather than replacing it, so `1` is the
   * field's configured size and `2` is double.
   *
   * @param n - The scale multiplier to assign.
   */
  scale(n: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.scale = n));
      return spawns;
    };
  },

  /**
   * Apply forward and/or lateral acceleration to every bullet.
   *
   * `forward` accelerates along the bullet's velocity vector.
   * `lateral` accelerates perpendicular to velocity (cross with world-up).
   *
   * @param forward - Forward acceleration magnitude.
   * @param lateral - Lateral acceleration magnitude. @default 0
   */
  accelerate(forward: number, lateral: number = 0): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => {
        const dir = normalize3(_v1.copy(s.velocity));
        const acc = s.acceleration;
        acc.x += dir.x * forward;
        acc.y += dir.y * forward;
        acc.z += dir.z * forward;
        if (lateral !== 0) {
          // Compute a lateral direction (perpendicular to velocity and up)
          // Fallback to right if velocity is exactly up/down
          const up = Math.abs(dir.y) > 0.99 ? _v3.set(1, 0, 0) : _v3.set(0, 1, 0);
          const right = normalize3(cross3(_v2, dir, up));
          acc.x += right.x * lateral;
          acc.y += right.y * lateral;
          acc.z += right.z * lateral;
        }
      });
      return spawns;
    };
  },

  /**
   * Stagger bullet spawn times so they appear in sequence rather than
   * all at once.
   *
   * @param delayStep - Seconds between each successive bullet.
   */
  sequence(delayStep: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s, i) => {
        s.delay += i * delayStep;
      });
      return spawns;
    };
  },

  /**
   * Rotate every bullet's offset, velocity, and acceleration around an axis.
   *
   * @param axis  - Rotation axis. Normalized **in place** each time the
   *   modifier runs (as since 0.1), so the caller's vector is mutated.
   * @param angle - Rotation angle in radians.
   */
  rotate(axis: Vector3, angle: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      const q = quatFromAxisAngle(_q1, normalize3(axis), angle);
      spawns.forEach((s) => {
        applyQuat3(s.velocity, q);
        applyQuat3(s.acceleration, q);
        applyQuat3(s.offset, q);
      });
      return spawns;
    };
  },
};

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

/**
 * Pipe a generator result through zero or more modifiers.
 *
 * Modifiers are applied left-to-right and mutate the array in-place for
 * zero-allocation composability.
 *
 * @param generatorResult - The output of a `gen.*()` call.
 * @param modifiers       - Modifiers to apply in order.
 * @returns The (mutated) spawn data array.
 *
 * @example
 * ```ts
 * const burst = compose(
 *   gen.ring(100, 3),
 *   mod.color(0x39ff14),
 *   mod.accelerate(1.5),
 * );
 * ```
 */
export function compose(generatorResult: BulletSpawnData[], ...modifiers: Modifier[]): BulletSpawnData[] {
  const data = generatorResult;
  modifiers.forEach((m) => {
    if (m) m(data);
  });
  return data;
}
