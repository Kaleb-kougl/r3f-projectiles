import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { gen, mod, compose } from '../patterns';
import { releaseSpawnData } from '../pool';
import type { BulletSpawnData } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that every element has the required BulletSpawnData shape. */
function assertSpawnDataShape(spawns: BulletSpawnData[]) {
  for (const s of spawns) {
    expect(s.offset).toBeInstanceOf(Vector3);
    expect(s.velocity).toBeInstanceOf(Vector3);
    expect(s.acceleration).toBeInstanceOf(Vector3);
    expect(typeof s.delay).toBe('number');
    expect(typeof s.life).toBe('number');
    expect(s.color === null || typeof s.color === 'number').toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

describe('gen', () => {
  describe.each([
    { name: 'fibonacciSphere', fn: () => gen.fibonacciSphere(50, 2) },
    { name: 'torusKnot', fn: () => gen.torusKnot(50) },
    { name: 'galaxy', fn: () => gen.galaxy(50) },
    { name: 'helix', fn: () => gen.helix(50) },
    { name: 'rose3D', fn: () => gen.rose3D(50) },
    { name: 'ring', fn: () => gen.ring(50) },
  ])('$name', ({ fn }) => {
    let spawns: BulletSpawnData[];

    beforeEach(() => {
      spawns = fn();
    });

    it('returns the requested count', () => {
      expect(spawns).toHaveLength(50);
      releaseSpawnData(spawns);
    });

    it('returns valid BulletSpawnData shape', () => {
      assertSpawnDataShape(spawns);
      releaseSpawnData(spawns);
    });

    it('sets finite offset, velocity, and acceleration', () => {
      for (const s of spawns) {
        expect(Number.isFinite(s.offset.x)).toBe(true);
        expect(Number.isFinite(s.offset.y)).toBe(true);
        expect(Number.isFinite(s.offset.z)).toBe(true);
        expect(Number.isFinite(s.velocity.x)).toBe(true);
        expect(Number.isFinite(s.velocity.y)).toBe(true);
        expect(Number.isFinite(s.velocity.z)).toBe(true);
      }
      releaseSpawnData(spawns);
    });
  });

  it('fibonacciSphere distributes points on a sphere', () => {
    const spawns = gen.fibonacciSphere(100, 3);
    // Every offset should have length ≈ radius (3)
    for (const s of spawns) {
      expect(s.offset.length()).toBeCloseTo(3, 1);
    }
    releaseSpawnData(spawns);
  });

  it('ring places bullets at the given radius', () => {
    const spawns = gen.ring(16, 2, 5);
    for (const s of spawns) {
      // offset should be on the ring at radius 5 (Y=0 plane)
      const r = Math.sqrt(s.offset.x ** 2 + s.offset.z ** 2);
      expect(r).toBeCloseTo(5, 4);
      expect(s.offset.y).toBe(0);
    }
    releaseSpawnData(spawns);
  });

  it('ring with radius 0 starts all bullets at origin', () => {
    const spawns = gen.ring(10, 2, 0);
    for (const s of spawns) {
      expect(s.offset.length()).toBeCloseTo(0, 10);
    }
    releaseSpawnData(spawns);
  });

  it('galaxy sets life to 8.0', () => {
    const spawns = gen.galaxy(20);
    for (const s of spawns) {
      expect(s.life).toBe(8.0);
    }
    releaseSpawnData(spawns);
  });

  it('torusKnot accepts custom p/q parameters', () => {
    const spawns = gen.torusKnot(30, 3, 5, 1);
    expect(spawns).toHaveLength(30);
    assertSpawnDataShape(spawns);
    releaseSpawnData(spawns);
  });

  it('helix respects turns parameter', () => {
    const spawns = gen.helix(20, 2, 4, 1);
    expect(spawns).toHaveLength(20);
    assertSpawnDataShape(spawns);
    releaseSpawnData(spawns);
  });
});

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

describe('mod', () => {
  describe('color', () => {
    it('sets color on all spawns', () => {
      const spawns = gen.ring(10);
      mod.color(0xff0000)(spawns);
      for (const s of spawns) {
        expect(s.color).toBe(0xff0000);
      }
      releaseSpawnData(spawns);
    });

    it('overwrites existing color', () => {
      const spawns = gen.ring(5);
      mod.color(0x00ff00)(spawns);
      mod.color(0x0000ff)(spawns);
      for (const s of spawns) {
        expect(s.color).toBe(0x0000ff);
      }
      releaseSpawnData(spawns);
    });
  });

  describe('sequence', () => {
    it('sets incremental delays', () => {
      const spawns = gen.ring(5);
      mod.sequence(0.1)(spawns);
      for (let i = 0; i < spawns.length; i++) {
        expect(spawns[i].delay).toBeCloseTo(i * 0.1, 10);
      }
      releaseSpawnData(spawns);
    });

    it('adds to existing delay', () => {
      const spawns = gen.ring(3);
      spawns[0].delay = 1.0;
      spawns[1].delay = 1.0;
      spawns[2].delay = 1.0;
      mod.sequence(0.5)(spawns);
      expect(spawns[0].delay).toBeCloseTo(1.0, 10);
      expect(spawns[1].delay).toBeCloseTo(1.5, 10);
      expect(spawns[2].delay).toBeCloseTo(2.0, 10);
      releaseSpawnData(spawns);
    });
  });

  describe('accelerate', () => {
    it('adds forward acceleration along velocity vector', () => {
      const spawns = gen.ring(4, 1);
      // Record original velocity directions
      const originalDirs = spawns.map((s) => s.velocity.clone().normalize());
      mod.accelerate(2)(spawns);

      for (let i = 0; i < spawns.length; i++) {
        // acceleration should have a component along the original velocity direction
        const dot = spawns[i].acceleration.dot(originalDirs[i]);
        expect(dot).toBeGreaterThan(0);
      }
      releaseSpawnData(spawns);
    });

    it('adds lateral acceleration when lateral != 0', () => {
      const spawns = gen.ring(4, 1);
      mod.accelerate(0, 3)(spawns);

      for (const s of spawns) {
        // With zero forward and non-zero lateral, acceleration should be non-zero
        expect(s.acceleration.length()).toBeGreaterThan(0);
      }
      releaseSpawnData(spawns);
    });

    it('does not add lateral acceleration when lateral = 0', () => {
      const spawns = gen.ring(4, 1);
      mod.accelerate(2, 0)(spawns);

      for (const s of spawns) {
        // Acceleration should be purely along the velocity direction
        const dir = s.velocity.clone().normalize();
        const accelDir = s.acceleration.clone().normalize();
        const dot = Math.abs(dir.dot(accelDir));
        expect(dot).toBeCloseTo(1, 4);
      }
      releaseSpawnData(spawns);
    });
  });

  describe('rotate', () => {
    it('applies rotation to offset, velocity, and acceleration', () => {
      const spawns = gen.ring(4, 1);
      // Give them some acceleration to verify it rotates too
      mod.accelerate(1)(spawns);

      // Record originals
      const origOffset = spawns.map((s) => s.offset.clone());
      const origVel = spawns.map((s) => s.velocity.clone());

      // Rotate 90° around Y-axis
      mod.rotate(new Vector3(0, 1, 0), Math.PI / 2)(spawns);

      for (let i = 0; i < spawns.length; i++) {
        // Lengths should be preserved
        expect(spawns[i].offset.length()).toBeCloseTo(origOffset[i].length(), 4);
        expect(spawns[i].velocity.length()).toBeCloseTo(origVel[i].length(), 4);

        // Vectors should have changed (unless they're zero)
        if (origOffset[i].length() > 0.001) {
          const dot = spawns[i].offset.clone().normalize().dot(origOffset[i].clone().normalize());
          // A 90° rotation should give dot ≈ 0, not ≈ 1
          expect(Math.abs(dot)).toBeLessThan(0.9);
        }
      }
      releaseSpawnData(spawns);
    });

    it('preserves vector lengths', () => {
      const spawns = gen.fibonacciSphere(20, 3);
      const origLengths = spawns.map((s) => s.offset.length());
      mod.rotate(new Vector3(1, 1, 0), Math.PI / 3)(spawns);
      for (let i = 0; i < spawns.length; i++) {
        expect(spawns[i].offset.length()).toBeCloseTo(origLengths[i], 4);
      }
      releaseSpawnData(spawns);
    });
  });
});

// ---------------------------------------------------------------------------
// compose()
// ---------------------------------------------------------------------------

describe('compose', () => {
  it('applies modifiers left-to-right', () => {
    const spawns = compose(
      gen.ring(10),
      mod.color(0xff0000),
      mod.sequence(0.05),
    );

    for (let i = 0; i < spawns.length; i++) {
      expect(spawns[i].color).toBe(0xff0000);
      expect(spawns[i].delay).toBeCloseTo(i * 0.05, 10);
    }
    releaseSpawnData(spawns);
  });

  it('returns the same array reference (mutation, not copy)', () => {
    const generated = gen.ring(5);
    const result = compose(generated, mod.color(0x00ff00));
    expect(result).toBe(generated);
    releaseSpawnData(result);
  });

  it('works with no modifiers', () => {
    const spawns = compose(gen.ring(8));
    expect(spawns).toHaveLength(8);
    assertSpawnDataShape(spawns);
    releaseSpawnData(spawns);
  });

  it('works with multiple modifiers stacked', () => {
    const spawns = compose(
      gen.fibonacciSphere(20, 2),
      mod.color(0x39ff14),
      mod.accelerate(1.5),
      mod.sequence(0.01),
      mod.rotate(new Vector3(0, 0, 1), Math.PI / 6),
    );

    expect(spawns).toHaveLength(20);
    for (const s of spawns) {
      expect(s.color).toBe(0x39ff14);
      expect(s.acceleration.length()).toBeGreaterThan(0);
    }
    releaseSpawnData(spawns);
  });
});
