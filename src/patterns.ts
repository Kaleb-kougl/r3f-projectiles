import { Vector3, Quaternion } from 'three';
import { acquire } from './pool';
import type { BulletSpawnData, Modifier } from './types';

// ---------------------------------------------------------------------------
// Module-scope scratch objects — allocated ONCE, never inside a hot path.
// ---------------------------------------------------------------------------

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q1 = new Quaternion();

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
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden Angle

    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2; // y goes from 1 to -1
      const r = Math.sqrt(1 - y * y);        // radius at y
      const theta = phi * i;

      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;

      _v1.set(x, y, z).normalize();

      const p = acquire();
      p.offset.copy(_v1).multiplyScalar(radius);
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
      const r = Math.cos(q_knot * t) + 2;
      const x = r * Math.cos(p_knot * t);
      const y = -Math.sin(q_knot * t);
      const z = r * Math.sin(p_knot * t);

      const pos = _v1.set(x, y, z).multiplyScalar(radius * 0.5);

      const spawned = acquire();
      spawned.offset.copy(pos);
      spawned.velocity.copy(pos).normalize();
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
   */
  galaxy(count: number, radius: number = 4, arms: number = 3, spin: number = 2): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const armIndex = i % arms;
      const dist = Math.random();
      // Logarithmic distribution for density near center
      const d = dist * dist;

      const angle = d * spin + armIndex * ((Math.PI * 2) / arms);
      const r = d * radius;

      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const y = (Math.random() - 0.5) * (radius * 0.2); // Flat disc with some thickness

      const p = acquire();
      p.offset.set(x, y, z);
      p.velocity.set(Math.cos(angle + Math.PI / 2), 0, Math.sin(angle + Math.PI / 2));
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
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1); // 0 to 1
      const angle = t * Math.PI * 2 * turns;

      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = (t - 0.5) * height;

      const p = acquire();
      p.offset.set(x, y, z);
      p.velocity.set(Math.cos(angle), 0, Math.sin(angle));
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
   */
  rose3D(count: number, k: number = 4, radius: number = 2): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;

      // R modulated by cosine of angle × k
      const r = Math.abs(Math.cos(k * theta)) * radius;

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.cos(phi);
      const z = r * Math.sin(phi) * Math.sin(theta);

      const pos = _v1.set(x, y, z);
      const p = acquire();
      p.offset.copy(pos);
      p.velocity.copy(pos).normalize();
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
      p.offset.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      p.velocity.set(Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(speed);
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
        const dir = _v1.copy(s.velocity).normalize();
        s.acceleration.addScaledVector(dir, forward);
        if (lateral !== 0) {
          // Compute a lateral direction (perpendicular to velocity and up)
          // Fallback to right if velocity is exactly up/down
          const up = Math.abs(dir.y) > 0.99 ? _v3.set(1, 0, 0) : _v3.set(0, 1, 0);
          const right = _v2.crossVectors(dir, up).normalize();
          s.acceleration.addScaledVector(right, lateral);
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
   * @param axis  - Rotation axis (will be normalized).
   * @param angle - Rotation angle in radians.
   */
  rotate(axis: Vector3, angle: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      const q = _q1.setFromAxisAngle(axis.normalize(), angle);
      spawns.forEach((s) => {
        s.velocity.applyQuaternion(q);
        s.acceleration.applyQuaternion(q);
        s.offset.applyQuaternion(q);
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
