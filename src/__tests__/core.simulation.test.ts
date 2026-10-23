// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

// The headless core must load and run with no React, no R3F and no DOM. These
// mocks make any import of either a hard failure, so every test in this file
// doubles as proof that `../core` pulls neither in — and the `node`
// environment above means there is no `window` or `document` to lean on.
vi.mock('react', () => {
  throw new Error('the headless core imported react');
});
vi.mock('@react-three/fiber', () => {
  throw new Error('the headless core imported @react-three/fiber');
});

import { Color, Vector3 } from 'three';
import {
  createBulletSimulation,
  createSeededRandom,
  type BulletSimulation,
} from '../core';
import { acquire } from '../pool';
import { gen, mod, compose } from '../patterns';
import { definePayload } from '../payload';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * `createBulletSimulation` — the headless core, driven directly, with no
 * React renderer anywhere in the file: the replay-check / dedicated-server
 * shape a game with a fixed tick uses it in.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

interface Spec {
  offset?: V3;
  velocity?: V3;
  acceleration?: V3;
  delay?: number;
  life?: number;
  payload?: number;
  scale?: number;
  color?: number | null;
}

function burst(specs: Spec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(...(s.offset ?? [0, 0, 0]));
      d.velocity.set(...(s.velocity ?? [0, 0, 0]));
      d.acceleration.set(...(s.acceleration ?? [0, 0, 0]));
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = s.color ?? null;
      d.payload = s.payload ?? 0;
      d.scale = s.scale ?? 1;
      return d;
    });
}

interface Row {
  index: number;
  payload: number;
  emitterId: number;
  pos: V3;
}

function census(sim: BulletSimulation): Row[] {
  const rows: Row[] = [];
  sim.forEachActive((index, pos, payload, emitterId) => {
    rows.push({ index, payload, emitterId, pos: [pos.x, pos.y, pos.z] });
  });
  return rows.sort((a, b) => a.payload - b.payload);
}

const ZERO = { x: 0, y: 0, z: 0 };

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Construction
// ===========================================================================

describe('createBulletSimulation — construction', () => {
  it('defaults to the field\'s defaults and starts empty', () => {
    const sim = createBulletSimulation();
    expect(sim.capacity).toBe(2000);
    expect(sim.boundsLimit).toBe(25);
    expect(sim.fadeTime).toBe(1);
    expect(sim.fadeCurve).toBe('linear');
    expect(sim.interpolation).toBe(false);
    expect(sim.activeCount).toBe(0);
    expect(sim.highWater).toBe(0);
    expect(sim.stepCount).toBe(0);
  });

  it('rejects a maxBullets that is not a non-negative integer, and an unknown fadeCurve', () => {
    expect(() => createBulletSimulation({ maxBullets: -1 })).toThrow(RangeError);
    expect(() => createBulletSimulation({ maxBullets: 1.5 })).toThrow(RangeError);
    expect(() => createBulletSimulation({ maxBullets: NaN })).toThrow(RangeError);
    expect(() =>
      createBulletSimulation({ fadeCurve: 'nope' as unknown as 'linear' }),
    ).toThrow(/Unknown easing/);

    const sim = createBulletSimulation();
    expect(() => {
      sim.fadeCurve = 'bogus' as unknown as 'linear';
    }).toThrow(/Unknown easing/);
    expect(sim.fadeCurve).toBe('linear'); // a rejected curve leaves the old one
  });
});

// ===========================================================================
// 2. fireAt and step
// ===========================================================================

describe('fireAt + step — spawn, motion, delay, life', () => {
  it('spawns at origin + offset, copies the origin, and returns the count', () => {
    const sim = createBulletSimulation({ maxBullets: 10 });
    const origin = new Vector3(1, 2, 3);
    const n = sim.fireAt(origin, burst([{ payload: 1, offset: [1, 0, 0] }, { payload: 2 }]));
    origin.set(100, 100, 100); // never retained

    expect(n).toBe(2);
    expect(sim.activeCount).toBe(2);
    expect(census(sim).map((r) => r.pos)).toEqual([
      [2, 2, 3],
      [1, 2, 3],
    ]);
  });

  it('integrates semi-implicit Euler over exactly dt, unclamped', () => {
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, burst([{ payload: 1, velocity: [2, 0, 0], acceleration: [0, 1, 0] }]));
    sim.step(0.25);
    expect(census(sim)[0].pos).toEqual([0.5, 0.0625, 0]);
    sim.step(0.5); // no 0.1 clamp — the caller owns the clock
    expect(census(sim)[0].pos[0]).toBe(1.5);
    expect(sim.stepCount).toBe(2);
  });

  it('counts down delay (hidden from forEachActive) and life (then frees the slot)', () => {
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, burst([{ payload: 1, delay: 0.2 }, { payload: 2, life: 0.3 }]));

    expect(sim.activeCount).toBe(2);
    expect(census(sim).map((r) => r.payload)).toEqual([2]);
    const delayed = [0, 1].find((i) => sim.payloadAt(i) === 1)!;
    expect(sim.isLive(delayed)).toBe(true);
    expect(sim.isVisible(delayed)).toBe(false);

    sim.step(0.1);
    sim.step(0.1);
    expect(census(sim).map((r) => r.payload)).toEqual([1, 2]);
    expect(sim.isVisible(delayed)).toBe(true);

    sim.step(0.1); // payload 2: 0.3 - 0.3 = 0 → expired
    expect(census(sim).map((r) => r.payload)).toEqual([1]);
    expect(sim.activeCount).toBe(1);
  });

  it('ignores a dt that is not a finite number > 0, warning once for the bad ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, burst([{ payload: 1, velocity: [1, 0, 0] }]));

    sim.step(0);
    expect(warn).not.toHaveBeenCalled();
    for (const dt of [NaN, -1, Infinity]) sim.step(dt);

    expect(census(sim)[0].pos).toEqual([0, 0, 0]);
    expect(sim.stepCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/dt must be a finite number/);
  });

  it('a full pool drops the newest bullets, never a live one, and reports once per burst', () => {
    const onPoolExhausted = vi.fn();
    const sim = createBulletSimulation({ maxBullets: 5, onPoolExhausted });
    sim.fireAt(ZERO, burst([{ payload: 1 }, { payload: 1 }, { payload: 1 }]), 3);
    const n = sim.fireAt(ZERO, burst(Array.from({ length: 4 }, () => ({ payload: 2 }))), 4);

    expect(n).toBe(2);
    expect(sim.activeCount).toBe(5);
    expect(sim.activeCountFor(3)).toBe(3);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(4, 4, 2, 'pool-full');
  });

  it('resolves built-in pattern keys, and throws for an unknown one', () => {
    const sim = createBulletSimulation();
    expect(sim.fireAt(ZERO, 'ring')).toBe(100);
    expect(() => sim.fireAt(ZERO, 'nope' as unknown as 'ring')).toThrow(/Unknown pattern/);
  });
});

// ===========================================================================
// 3. Bounds
// ===========================================================================

describe('bounds — per-axis cube, Infinity, boundsCenter as ref / getter / vector', () => {
  const spread = burst([
    { payload: 1, offset: [20, 20, 20] }, // inside the cube, outside a sphere
    { payload: 2, offset: [0, 25.01, 0] }, // one axis out
    { payload: 3, offset: [100, 0, 0] }, // centre of a moved box
  ]);

  it('culls per axis against boundsLimit on the next step', () => {
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, spread);
    sim.step(0.01);
    expect(census(sim).map((r) => r.payload)).toEqual([1]);
  });

  it('boundsLimit = Infinity disables culling; lifetime still despawns', () => {
    const sim = createBulletSimulation({ boundsLimit: Infinity });
    sim.fireAt(ZERO, spread);
    sim.fireAt(ZERO, burst([{ payload: 4, life: 0.01 }]));
    sim.step(0.01);
    expect(census(sim).map((r) => r.payload)).toEqual([1, 2, 3]);
  });

  it('accepts a ref, a getter or a live vector as the centre, read each step', () => {
    for (const make of [
      (v: Vector3) => ({ current: v }),
      (v: Vector3) => () => v,
      (v: Vector3) => v,
    ]) {
      const center = new Vector3(100, 0, 0);
      const sim = createBulletSimulation({ boundsLimit: 5, boundsCenter: make(center) });
      sim.fireAt(ZERO, spread);
      sim.step(0.01);
      expect(census(sim).map((r) => r.payload)).toEqual([3]);

      center.set(103, 0, 0); // still within 5 of the moved box
      sim.step(0.01);
      expect(sim.activeCount).toBe(1);
      center.set(0, 0, 0);
      sim.step(0.01);
      expect(sim.activeCount).toBe(0);
    }
  });

  it('a null centre (ref or getter) means the origin; config is mutable between steps', () => {
    const sim = createBulletSimulation({ boundsLimit: 5, boundsCenter: { current: null } });
    sim.fireAt(ZERO, burst([{ payload: 1, offset: [4, 0, 0] }, { payload: 2, offset: [8, 0, 0] }]));
    sim.step(0.01);
    expect(census(sim).map((r) => r.payload)).toEqual([1]);

    sim.boundsCenter = () => null;
    sim.boundsLimit = 3;
    sim.step(0.01);
    expect(sim.activeCount).toBe(0);
  });
});

// ===========================================================================
// 4. Consumption, payload, clear, emitter ids
// ===========================================================================

describe('forEachActive, setPayload, clear and emitter ids', () => {
  it('consumes on `true`, hands out the live position vector, and is reentrant for fireAt', () => {
    const sim = createBulletSimulation({ maxBullets: 20 });
    sim.fireAt(ZERO, burst(Array.from({ length: 6 }, (_, i) => ({ payload: i }))));

    const seen: number[] = [];
    sim.forEachActive((i, pos, payload) => {
      seen.push(payload);
      expect(pos).toBe(sim.positionAt(i)); // the live internal vector
      if (payload % 2 === 0) {
        sim.fireAt(ZERO, burst([{ payload: 100 + payload }])); // retaliation shot
        return true;
      }
    });

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]); // newcomers not visited
    expect(census(sim).map((r) => r.payload)).toEqual([1, 3, 5, 100, 102, 104]);
  });

  it('setPayload rewrites a live bullet and ignores everything else', () => {
    const Shot = definePayload({ hp: 3 });
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, burst([{ payload: Shot.pack({ hp: 2 }) }]));

    let hits = 0;
    for (let k = 0; k < 4; k++) {
      sim.forEachActive((i, _p, payload) => {
        hits++;
        const hp = Shot.get(payload, 'hp');
        if (hp === 0) return true;
        sim.setPayload(i, Shot.with(payload, 'hp', hp - 1));
      });
    }
    expect(hits).toBe(3);
    expect(sim.activeCount).toBe(0);

    for (const i of [0, -1, 1e9, 0.5, NaN]) sim.setPayload(i, 7);
    sim.fireAt(ZERO, burst([{ payload: 5 }]));
    expect(census(sim).map((r) => r.payload)).toEqual([5]);
  });

  it('issues ids from 1, never recycles them, and absorbs ids it is handed', () => {
    const sim = createBulletSimulation();
    expect(sim.acquireEmitter()).toBe(1);
    expect(sim.acquireEmitter()).toBe(2);
    sim.releaseEmitter(2);
    expect(sim.acquireEmitter()).toBe(3);
    sim.fireAt(ZERO, burst([{}]), 10); // a freelanced id
    expect(sim.acquireEmitter()).toBe(11);
    sim.releaseEmitter(50);
    expect(sim.acquireEmitter()).toBe(51);
  });

  it('clear(id) frees exactly that emitter\'s bullets; clear() frees all; release keeps bullets', () => {
    const sim = createBulletSimulation();
    const a = sim.acquireEmitter();
    const b = sim.acquireEmitter();
    sim.fireAt(ZERO, burst([{}, {}, {}]), a);
    sim.fireAt(ZERO, burst([{}, {}]), b);
    sim.fireAt(ZERO, burst([{ delay: 1 }]), 0);

    sim.releaseEmitter(a);
    expect(sim.activeCountFor(a)).toBe(3); // release clears nothing

    expect(sim.clear(a)).toBe(3);
    expect(sim.activeCountFor(a)).toBe(0);
    expect(sim.activeCountFor(b)).toBe(2);
    expect(sim.clear(0)).toBe(1); // the anonymous, delayed one
    expect(sim.clear()).toBe(2);
    expect(sim.activeCount).toBe(0);
    expect(sim.highWater).toBe(0); // decays once empty
  });
});

// ===========================================================================
// 5. Read access and render bookkeeping
// ===========================================================================

describe('read access — what a renderer syncs from', () => {
  it('exposes position, velocity, life, payload, id, scale, fade and spawn color per slot', () => {
    const sim = createBulletSimulation({ fadeTime: 1 });
    sim.fireAt(
      new Vector3(1, 0, 0),
      burst([{ velocity: [0, 2, 0], life: 0.75, payload: 9, scale: 3, color: 0xffffff }]),
      4,
    );
    const i = 0;
    expect(sim.positionAt(i).toArray()).toEqual([1, 0, 0]);
    expect(sim.velocityAt(i).toArray()).toEqual([0, 2, 0]);
    expect(sim.lifeAt(i)).toBe(0.75);
    expect(sim.delayAt(i)).toBe(0);
    expect(sim.payloadAt(i)).toBe(9);
    expect(sim.emitterIdAt(i)).toBe(4);
    expect(sim.scaleAt(i)).toBe(3);
    expect(sim.fadeAt(i)).toBe(0.75); // linear, 1 s fade, 0.75 s left
    const c = sim.colorAt(i, new Color());
    expect([c.r, c.g, c.b]).toEqual([1, 1, 1]);

    sim.fadeTime = 0; // bookkeeping only: disables the fade, kills nothing
    expect(sim.fadeAt(i)).toBe(1);
    sim.fireAt(ZERO, burst([{ color: null }]));
    const d = sim.colorAt(1, new Color());
    const expected = new Color(0xff3333); // the field's default bullet color
    expect([d.r, d.g, d.b]).toEqual([
      Math.fround(expected.r),
      Math.fround(expected.g),
      Math.fround(expected.b),
    ]);
  });

  it('tracks a dirty slot range and spawned-since-sync flags until markSynced()', () => {
    const sim = createBulletSimulation({ maxBullets: 50 });
    expect(sim.dirtyMax).toBeLessThan(sim.dirtyMin);

    sim.fireAt(ZERO, burst(Array.from({ length: 5 }, () => ({ velocity: [1, 0, 0] }))));
    expect([sim.dirtyMin, sim.dirtyMax]).toEqual([0, 4]);
    expect(sim.spawnedSinceSync(3)).toBe(true);
    expect(sim.highWater).toBe(5);

    sim.markSynced();
    expect(sim.dirtyMax).toBeLessThan(sim.dirtyMin);
    expect(sim.spawnedSinceSync(3)).toBe(false);

    sim.forEachActive((i) => i === 1 || undefined); // consume slot 1
    expect([sim.dirtyMin, sim.dirtyMax]).toEqual([1, 1]);
    sim.step(0.1); // moves the four survivors
    expect([sim.dirtyMin, sim.dirtyMax]).toEqual([0, 4]);
    expect(sim.spawnedSinceSync(0)).toBe(false);
  });

  it('with interpolation, keeps each bullet\'s start-of-step position', () => {
    const sim = createBulletSimulation({ interpolation: true });
    sim.fireAt(new Vector3(1, 0, 0), burst([{ velocity: [2, 0, 0] }, { velocity: [0, 1, 0], delay: 0.15 }]));
    const out = new Vector3();

    expect(sim.previousPositionAt(0, out).toArray()).toEqual([1, 0, 0]); // = spawn

    sim.step(0.25);
    expect(sim.previousPositionAt(0, out).toArray()).toEqual([1, 0, 0]);
    expect(sim.positionAt(0).x).toBe(1.5);
    sim.step(0.25);
    expect(sim.previousPositionAt(0, out).toArray()).toEqual([1.5, 0, 0]);

    // The delayed bullet's delay ran out during the first step, which moved it
    // from where it sat waiting (its "previous" then) to y = 0.25.
    expect(sim.previousPositionAt(1, out).toArray()).toEqual([1, 0.25, 0]);
    expect(sim.positionAt(1).y).toBe(0.5);

    const plain = createBulletSimulation();
    plain.fireAt(ZERO, burst([{ velocity: [1, 0, 0] }]));
    plain.step(0.5);
    expect(plain.previousPositionAt(0, out).toArray()).toEqual([0.5, 0, 0]); // = current
  });
});

// ===========================================================================
// 6. State hashing
// ===========================================================================

describe('writeStateHash / hashState', () => {
  it('appends ten numbers per live bullet in ascending slot order', () => {
    const sim = createBulletSimulation();
    sim.fireAt(
      new Vector3(1, 2, 3),
      burst([
        { velocity: [4, 5, 6], life: 7, payload: 8 },
        { payload: 9, delay: 1 }, // delayed bullets are state too
      ]),
      2,
    );
    sim.forEachActive(() => undefined);
    const out: number[] = [42]; // appends; never truncates
    sim.writeStateHash(out);
    expect(out).toEqual([42, 0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 1, 1, 2, 3, 0, 0, 0, 1000, 9, 2]);
  });

  it('hashes the exact bits: a one-ulp or a sign-of-zero difference changes it', () => {
    const make = (x: number) => {
      const sim = createBulletSimulation();
      sim.fireAt({ x, y: 0, z: 0 }, burst([{}]));
      return sim.hashState();
    };
    expect(make(1)).toBe(make(1));
    expect(make(1)).not.toBe(make(1 + Number.EPSILON));
    const signed = (payload: number) => {
      const sim = createBulletSimulation();
      sim.fireAt(ZERO, burst([{}]));
      sim.setPayload(0, payload);
      return sim.hashState();
    };
    expect(signed(0)).not.toBe(signed(-0));
    expect(createBulletSimulation().hashState()).toBe(createBulletSimulation().hashState());
    expect(Number.isInteger(make(1)) && make(1) >= 0 && make(1) < 2 ** 32).toBe(true);
  });

  // A NaN's bits are not portable: `Infinity - Infinity` is fff8… on V8 x86
  // and 7ff8… in JavaScriptCore, and a DataView / typed-array store may pick
  // any NaN encoding. hashState folds every NaN as the canonical
  // 0x7FF8000000000000, so a state holding one hashes the same everywhere.
  describe('NaN canonicalization', () => {
    const dv = new DataView(new ArrayBuffer(8));
    /** A NaN with the given 64 raw bits, read back through a DataView. */
    const crafted = (bits: bigint): number => {
      dv.setBigUint64(0, bits);
      return dv.getFloat64(0);
    };
    const zero = 0;
    const NANS: [string, number][] = [
      ['NaN', NaN],
      ['0 / 0', zero / zero],
      ['Infinity - Infinity', Infinity - Infinity],
      ['Math.sqrt(-1)', Math.sqrt(-1)],
      ['crafted 0x7ff8000000000000', crafted(0x7ff8000000000000n)],
      ['crafted 0xfff8000000000000 (sign bit)', crafted(0xfff8000000000000n)],
      ['crafted 0x7ff0000000000001 (signalling payload)', crafted(0x7ff0000000000001n)],
      ['crafted 0xfff7dead0000beef (sign + payload)', crafted(0xfff7dead0000beefn)],
      ['crafted 0x7fffffffffffffff (all payload bits)', crafted(0x7fffffffffffffffn)],
    ];

    /**
     * The documented hash with a canonical NaN, written out independently: FNV
     * over each double's two little-endian words, the count first.
     */
    function reference(values: number[], count: number): number {
      const view = new DataView(new ArrayBuffer(8));
      let h = 0x811c9dc5;
      for (const v of [count, ...values]) {
        if (Number.isNaN(v)) view.setBigUint64(0, 0x7ff8000000000000n, true);
        else view.setFloat64(0, v, true);
        h = Math.imul(h ^ view.getUint32(0, true), 0x01000193);
        h = Math.imul(h ^ view.getUint32(4, true), 0x01000193);
      }
      return h >>> 0;
    }

    it('the injected NaNs really are NaNs (and some carry non-canonical bits)', () => {
      for (const [, v] of NANS) expect(Number.isNaN(v)).toBe(true);
      dv.setFloat64(0, NANS[5][1]);
      // What the engine kept is its business; at least one pattern differs from canonical.
      const kept = NANS.map(([, v]) => (dv.setFloat64(0, v), dv.getBigUint64(0)));
      expect(new Set(kept).size).toBeGreaterThan(1);
    });

    it('a NaN position hashes to a fixed value, however the NaN was made', () => {
      const hashes = NANS.map(([name, nan]) => {
        const sim = createBulletSimulation();
        sim.fireAt({ x: nan, y: 1, z: 2 }, burst([{ velocity: [3, 4, 5], life: 6, payload: 7 }]), 8);
        const out: number[] = [];
        sim.writeStateHash(out);
        expect(Number.isNaN(out[1]), name).toBe(true);
        return sim.hashState();
      });
      for (const h of hashes) expect(h).toBe(NAN_POSITION_HASH);
      expect(reference([0, NaN, 1, 2, 3, 4, 5, 6, 7, 8], 1)).toBe(NAN_POSITION_HASH);
    });

    it('a NaN payload (setPayload) hashes the same for every NaN, and unlike any number', () => {
      const hash = (payload: number): number => {
        const sim = createBulletSimulation();
        sim.fireAt(ZERO, burst([{}]));
        sim.setPayload(0, payload);
        return sim.hashState();
      };
      const first = hash(NANS[0][1]);
      for (const [name, nan] of NANS) expect(hash(nan), name).toBe(first);
      expect(first).toBe(reference([0, 0, 0, 0, 0, 0, 0, 1000, NaN, 0], 1));
      expect(first).not.toBe(hash(0));
      expect(first).not.toBe(hash(Infinity));
    });

    it('non-NaN states hash by their exact bits, as before', () => {
      const sim = createBulletSimulation();
      // y: -0 + an offset of -0 stays -0.
      sim.fireAt(
        { x: 1.5, y: -0, z: 1e-300 },
        burst([{ offset: [0, -0, 0], velocity: [Infinity, -Infinity, -0], life: 3, payload: -4 }]),
        5,
      );
      const out: number[] = [];
      sim.writeStateHash(out);
      expect(Object.is(out[2], -0) && Object.is(out[6], -0)).toBe(true);
      expect(out).toEqual([0, 1.5, -0, 1e-300, Infinity, -Infinity, -0, 3, -4, 5]);
      expect(sim.hashState()).toBe(reference(out, 1));
      expect(sim.hashState()).toBe(NON_NAN_HASH);
    });
  });
});

/** `hashState` of the NaN-position state above, on every engine. */
const NAN_POSITION_HASH = 4162726109; // 0xf81e28dd
/** `hashState` of the non-NaN state above (unchanged from 0.7.0's hashing). */
const NON_NAN_HASH = 2673421217; // 0x9f592ba1

// ===========================================================================
// 7. Seeded generators
// ===========================================================================

describe('gen.galaxy / gen.rose3D — optional seeded rng', () => {
  const dump = (spawns: BulletSpawnData[]) =>
    spawns.flatMap((s) => [...s.offset.toArray(), ...s.velocity.toArray()]);

  it('createSeededRandom yields the same stream per seed, in [0, 1)', () => {
    const a = createSeededRandom(1234);
    const b = createSeededRandom(1234);
    const c = createSeededRandom(1235);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 1000 }, () => c())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    // Pinned: mulberry32 is pure 32-bit integer arithmetic, so this exact value
    // holds on every engine. A change here breaks every recorded replay.
    expect(createSeededRandom(0)()).toBe(0.26642920868471265);
  });

  it('makes galaxy and rose3D reproducible, and leaves the default on Math.random', () => {
    expect(dump(gen.galaxy(40, 4, 3, 2, createSeededRandom(7)))).toEqual(
      dump(gen.galaxy(40, 4, 3, 2, createSeededRandom(7))),
    );
    expect(dump(gen.rose3D(40, 4, 2, createSeededRandom(7)))).toEqual(
      dump(gen.rose3D(40, 4, 2, createSeededRandom(7))),
    );

    const random = vi.spyOn(Math, 'random');
    gen.galaxy(10);
    gen.rose3D(10);
    expect(random).toHaveBeenCalledTimes(40); // two draws per bullet, as before
  });

  it('a seeded galaxy fired into two simulations produces identical state', () => {
    const play = () => {
      const rng = createSeededRandom(99);
      const sim = createBulletSimulation({ maxBullets: 4000, boundsLimit: 10 });
      const pattern = () => compose(gen.galaxy(60, 4, 3, 2, rng), mod.accelerate(0.4));
      for (let t = 0; t < 120; t++) {
        if (t % 10 === 0) sim.fireAt({ x: Math.sin(t), y: 0, z: 0 }, pattern, 1);
        sim.step(1 / 60);
      }
      return sim;
    };
    const a = play();
    const b = play();
    expect(a.activeCount).toBeGreaterThan(0);
    expect(a.hashState()).toBe(b.hashState());
  });
});
