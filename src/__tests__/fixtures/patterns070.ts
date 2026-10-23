// A verbatim copy of r3f-projectiles 0.7.0's generators and modifiers
// (`git show 391864f:src/patterns.ts`), kept as the reference that
// `patterns.detmath.test.ts` holds 0.8.0 against: `Math.sin` / `Math.cos` and
// three's `normalize` / `multiplyScalar` / `addScaledVector` / `crossVectors` /
// `setFromAxisAngle` / `applyQuaternion`, exactly as 0.7.0 called them.
//
// Test-only. Do not "fix" or modernise anything below: its whole value is that
// it is 0.7.0's code. Only the export names (`gen070`, `mod070`), these header
// lines and the import paths differ from the original; the docblocks are cut.
/* eslint-disable */

import { Vector3, Quaternion } from 'three';
import { acquire } from '../../pool';
import type { BulletSpawnData, Modifier } from '../../patternTypes';

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

export const gen070 = {
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

  galaxy(
    count: number,
    radius: number = 4,
    arms: number = 3,
    spin: number = 2,
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

      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const y = (rng() - 0.5) * (radius * 0.2); // Flat disc with some thickness

      const p = acquire();
      p.offset.set(x, y, z);
      p.velocity.set(Math.cos(angle + Math.PI / 2), 0, Math.sin(angle + Math.PI / 2));
      p.life = 8.0;
      spawns.push(p);
    }
    return spawns;
  },

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

  rose3D(
    count: number,
    k: number = 4,
    radius: number = 2,
    rng: () => number = Math.random,
  ): BulletSpawnData[] {
    const spawns: BulletSpawnData[] = [];
    for (let i = 0; i < count; i++) {
      const theta = rng() * Math.PI * 2;
      const phi = rng() * Math.PI;

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

export const mod070 = {
  color(col: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.color = col));
      return spawns;
    };
  },

  payload(value: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.payload = value));
      return spawns;
    };
  },

  scale(n: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s) => (s.scale = n));
      return spawns;
    };
  },

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

  sequence(delayStep: number): Modifier {
    return (spawns: BulletSpawnData[]) => {
      spawns.forEach((s, i) => {
        s.delay += i * delayStep;
      });
      return spawns;
    };
  },

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

