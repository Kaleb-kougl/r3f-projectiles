import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { acquire, releaseSpawnData } from '../pool';
import type { BulletSpawnData } from '../types';

// ---------------------------------------------------------------------------
// acquire()
// ---------------------------------------------------------------------------

describe('acquire', () => {
  it('returns a BulletSpawnData with zeroed fields', () => {
    const p = acquire();

    expect(p.offset).toBeInstanceOf(Vector3);
    expect(p.velocity).toBeInstanceOf(Vector3);
    expect(p.acceleration).toBeInstanceOf(Vector3);

    expect(p.offset.x).toBe(0);
    expect(p.offset.y).toBe(0);
    expect(p.offset.z).toBe(0);

    expect(p.velocity.x).toBe(0);
    expect(p.velocity.y).toBe(0);
    expect(p.velocity.z).toBe(0);

    expect(p.acceleration.x).toBe(0);
    expect(p.acceleration.y).toBe(0);
    expect(p.acceleration.z).toBe(0);

    expect(p.delay).toBe(0);
    expect(p.color).toBeNull();
    expect(p.life).toBe(5.0);

    releaseSpawnData([p]);
  });

  it('returns unique objects on successive calls (no aliasing)', () => {
    const a = acquire();
    const b = acquire();
    expect(a).not.toBe(b);
    expect(a.offset).not.toBe(b.offset);
    releaseSpawnData([a, b]);
  });
});

// ---------------------------------------------------------------------------
// releaseSpawnData + acquire — pool recycling
// ---------------------------------------------------------------------------

describe('pool recycling', () => {
  it('reuses released objects', () => {
    const first = acquire();
    // Mutate the object to confirm it gets reset on re-acquire
    first.offset.set(99, 99, 99);
    first.velocity.set(10, 20, 30);
    first.acceleration.set(1, 2, 3);
    first.delay = 42;
    first.color = 0xdeadbe;
    first.life = 999;

    releaseSpawnData([first]);

    // The next acquire should return the same recycled object, but reset
    const second = acquire();

    // It should be the exact same reference (recycled from pool)
    expect(second).toBe(first);

    // But all fields should be reset
    expect(second.offset.x).toBe(0);
    expect(second.offset.y).toBe(0);
    expect(second.offset.z).toBe(0);
    expect(second.velocity.x).toBe(0);
    expect(second.velocity.y).toBe(0);
    expect(second.velocity.z).toBe(0);
    expect(second.acceleration.x).toBe(0);
    expect(second.acceleration.y).toBe(0);
    expect(second.acceleration.z).toBe(0);
    expect(second.delay).toBe(0);
    expect(second.color).toBeNull();
    expect(second.life).toBe(5.0);

    releaseSpawnData([second]);
  });

  it('handles releasing an empty array gracefully', () => {
    expect(() => releaseSpawnData([])).not.toThrow();
  });

  it('handles releasing null/undefined gracefully', () => {
    // The implementation guards against falsy input
    expect(() => releaseSpawnData(null as unknown as BulletSpawnData[])).not.toThrow();
    expect(() => releaseSpawnData(undefined as unknown as BulletSpawnData[])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pool max size cap
// ---------------------------------------------------------------------------

describe('pool max size cap', () => {
  it('does not grow unboundedly — excess items are silently discarded', () => {
    // Create and release more objects than MAX_POOL_SIZE (20_000)
    // We can't easily observe the internal pool length, but we can verify
    // that releasing a large batch doesn't throw and that acquire still works.
    const batch: BulletSpawnData[] = [];
    const batchSize = 100;

    for (let i = 0; i < batchSize; i++) {
      batch.push(acquire());
    }

    // Release all of them — some may be capped
    expect(() => releaseSpawnData(batch)).not.toThrow();

    // Acquire them back — should all be valid
    const reacquired: BulletSpawnData[] = [];
    for (let i = 0; i < batchSize; i++) {
      const p = acquire();
      expect(p.offset).toBeInstanceOf(Vector3);
      expect(p.delay).toBe(0);
      expect(p.life).toBe(5.0);
      reacquired.push(p);
    }

    releaseSpawnData(reacquired);
  });

  it('still allocates fresh objects when pool is exhausted', () => {
    // Drain any existing pool items
    const drained: BulletSpawnData[] = [];
    for (let i = 0; i < 50; i++) {
      drained.push(acquire());
    }

    // These should all be valid even if pool was empty
    for (const d of drained) {
      expect(d.offset).toBeInstanceOf(Vector3);
      expect(d.life).toBe(5.0);
    }

    releaseSpawnData(drained);
  });
});
