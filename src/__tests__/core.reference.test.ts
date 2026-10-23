// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createBulletSimulation, createSeededRandom, type BulletSimulation } from '../core';
import { gen, mod, compose } from '../patterns';
import { acquire, releaseSpawnData } from '../pool';
import { resolvePattern } from '../presets';
import type { BulletSpawnData, PatternFactory, PatternKey } from '../patternTypes';

/**
 * The core, pinned against a plain-number reference integrator (0.8.0 L4).
 *
 * `createBulletSimulation` keeps positions, velocities and accelerations in
 * three's `Vector3` and does its arithmetic through three's methods. A three
 * upgrade that changed one of them — say `addScaledVector` computing
 * `this.x + v.x * s` as a fused or reordered expression, or `copy` / `add`
 * dropping a `-0` — would move the core's bits without any of the core's own
 * code changing. This file is where that shows up first: a scripted run
 * (bursts from det patterns with acceleration, delays, short lives, a moving
 * cull box, consumption, per-emitter clears, a pool small enough to run full)
 * is replayed in a reference written with plain numbers only, and the two must
 * agree **bit for bit, on every slot, after every operation**.
 *
 * The three methods `src/core/simulation.ts` relies on for the simulated state
 * (as of 0.8.0), each mirrored here as the plain expression it computes:
 *
 *  - spawn: `p.copy(origin).add(offset)` → `p = origin + offset` per axis;
 *    `v.copy(velocity)`, `a.copy(acceleration)` → plain copies
 *    (`Vector3.set(0, 0, 0)` only on the reduced-motion path, not reached here);
 *  - step: `v.addScaledVector(a, dt)` → `v += a * dt`, then
 *    `p.addScaledVector(v, dt)` → `p += v * dt` with the new `v`
 *    (semi-implicit Euler, per axis x, y, z);
 *  - read-back: `previousPositionAt` → `out.set(prev…)` / `out.copy(p)`.
 *
 * The reference also mirrors the per-step order of `SimulationCore._advance`
 * exactly — the backwards walk over the dense list, the delay countdown
 * (`delay -= dt`, still hidden while `delay > 0`, integrating on the step it
 * runs out), the start-of-step position kept for interpolation, the velocity
 * then position update, `life -= dt`, then the release test (`life <= 0`, or any
 * axis more than `boundsLimit` from the centre read once per step) — and the
 * sparse set (LIFO free stack, swap-remove), so slot indices are compared too.
 */

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

interface RefSpawn {
  ox: number; oy: number; oz: number;
  vx: number; vy: number; vz: number;
  ax: number; ay: number; az: number;
  delay: number; life: number; payload: number;
}

/** Spawn data as plain numbers; the pooled objects go back to the pool. */
function snapshot(spawns: BulletSpawnData[]): RefSpawn[] {
  const out = spawns.map((s) => ({
    ox: s.offset.x, oy: s.offset.y, oz: s.offset.z,
    vx: s.velocity.x, vy: s.velocity.y, vz: s.velocity.z,
    ax: s.acceleration.x, ay: s.acceleration.y, az: s.acceleration.z,
    delay: s.delay, life: s.life, payload: s.payload,
  }));
  releaseSpawnData(spawns);
  return out;
}

class Reference {
  readonly px: number[]; readonly py: number[]; readonly pz: number[];
  readonly vx: number[]; readonly vy: number[]; readonly vz: number[];
  readonly ax: number[]; readonly ay: number[]; readonly az: number[];
  readonly qx: number[]; readonly qy: number[]; readonly qz: number[]; // start-of-step position
  readonly delay: number[]; readonly life: number[];
  readonly payload: number[]; readonly emitter: number[];
  readonly dense: number[]; readonly slotToDense: number[]; readonly free: number[];
  denseCount = 0;
  highWater = 0;

  constructor(readonly capacity: number) {
    const z = () => new Array<number>(capacity).fill(0);
    this.px = z(); this.py = z(); this.pz = z();
    this.vx = z(); this.vy = z(); this.vz = z();
    this.ax = z(); this.ay = z(); this.az = z();
    this.qx = z(); this.qy = z(); this.qz = z();
    this.delay = z(); this.life = z(); this.payload = z(); this.emitter = z();
    this.dense = z();
    this.slotToDense = new Array<number>(capacity).fill(-1);
    // Descending, so the LIFO pops 0, 1, 2, … first.
    this.free = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  }

  private acquire(): number {
    if (this.free.length === 0) return -1;
    const slot = this.free.pop()!;
    this.slotToDense[slot] = this.denseCount;
    this.dense[this.denseCount++] = slot;
    if (slot >= this.highWater) this.highWater = slot + 1;
    return slot;
  }

  private release(slot: number): void {
    const d = this.slotToDense[slot];
    if (d < 0) return;
    const last = this.dense[--this.denseCount];
    this.dense[d] = last;
    this.slotToDense[last] = d;
    this.slotToDense[slot] = -1;
    this.free.push(slot);
  }

  fire(x: number, y: number, z: number, spawns: RefSpawn[], emitterId: number): number {
    let n = 0;
    for (const s of spawns) {
      const i = this.acquire();
      if (i === -1) break; // full: the rest of the burst is dropped
      this.px[i] = x + s.ox;
      this.py[i] = y + s.oy;
      this.pz[i] = z + s.oz;
      this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
      this.ax[i] = s.ax; this.ay[i] = s.ay; this.az[i] = s.az;
      this.delay[i] = s.delay;
      this.life[i] = s.life;
      this.payload[i] = s.payload;
      this.emitter[i] = emitterId;
      this.qx[i] = this.px[i]; this.qy[i] = this.py[i]; this.qz[i] = this.pz[i];
      n++;
    }
    return n;
  }

  step(dt: number, limit: number, cx: number, cy: number, cz: number): void {
    for (let d = this.denseCount - 1; d >= 0; d--) {
      const i = this.dense[d];
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        if (this.delay[i] > 0) continue;
      }
      this.qx[i] = this.px[i]; this.qy[i] = this.py[i]; this.qz[i] = this.pz[i];
      this.vx[i] += this.ax[i] * dt;
      this.vy[i] += this.ay[i] * dt;
      this.vz[i] += this.az[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.life[i] -= dt;
      if (
        this.life[i] <= 0 ||
        (limit !== Infinity &&
          (Math.abs(this.px[i] - cx) > limit ||
            Math.abs(this.py[i] - cy) > limit ||
            Math.abs(this.pz[i] - cz) > limit))
      ) {
        this.release(i);
      }
    }
  }

  /** `forEachActive`: backwards, delayed bullets skipped, consumed ones released. */
  consume(pred: (index: number) => boolean): void {
    for (let d = this.denseCount - 1; d >= 0; d--) {
      const i = this.dense[d];
      if (this.delay[i] > 0) continue;
      if (pred(i)) this.release(i);
    }
  }

  clear(emitterId: number): number {
    let n = 0;
    for (let d = this.denseCount - 1; d >= 0; d--) {
      const i = this.dense[d];
      if (this.emitter[i] !== emitterId) continue;
      this.release(i);
      n++;
    }
    return n;
  }

  /** The documented `hashState`: FNV over the exact bits, little-endian words. */
  hash(): number {
    const dv = new DataView(new ArrayBuffer(8));
    const mix = (h: number, v: number): number => {
      dv.setFloat64(0, v, true);
      h = Math.imul(h ^ dv.getUint32(0, true), 0x01000193);
      return Math.imul(h ^ dv.getUint32(4, true), 0x01000193);
    };
    let h = mix(0x811c9dc5, this.denseCount);
    if (this.denseCount === 0) return h >>> 0;
    for (let i = 0; i < this.highWater; i++) {
      if (this.slotToDense[i] < 0) continue;
      for (const v of [
        i, this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i],
        this.life[i], this.payload[i], this.emitter[i],
      ]) h = mix(h, v);
    }
    return h >>> 0;
  }
}

// ---------------------------------------------------------------------------
// Bit-for-bit comparison
// ---------------------------------------------------------------------------

const _prev = new Vector3();

/** The first difference between `sim` and `ref`, or null. `Object.is`: -0 ≠ 0. */
function diff(sim: BulletSimulation, ref: Reference, interpolation: boolean): string | null {
  if (sim.activeCount !== ref.denseCount) return `activeCount ${sim.activeCount} vs ${ref.denseCount}`;
  for (let i = 0; i < ref.capacity; i++) {
    const live = ref.slotToDense[i] >= 0;
    if (sim.isLive(i) !== live) return `slot ${i}: live ${sim.isLive(i)} vs ${live}`;
    if (!live) continue;
    const p = sim.positionAt(i);
    const v = sim.velocityAt(i);
    const q = sim.previousPositionAt(i, _prev);
    const pairs: [string, number, number][] = [
      ['x', p.x, ref.px[i]], ['y', p.y, ref.py[i]], ['z', p.z, ref.pz[i]],
      ['vx', v.x, ref.vx[i]], ['vy', v.y, ref.vy[i]], ['vz', v.z, ref.vz[i]],
      ['delay', sim.delayAt(i), ref.delay[i]], ['life', sim.lifeAt(i), ref.life[i]],
      ['payload', sim.payloadAt(i), ref.payload[i]], ['emitter', sim.emitterIdAt(i), ref.emitter[i]],
      // Without interpolation, previousPositionAt is the current position.
      ['prev.x', q.x, interpolation ? ref.qx[i] : ref.px[i]],
      ['prev.y', q.y, interpolation ? ref.qy[i] : ref.py[i]],
      ['prev.z', q.z, interpolation ? ref.qz[i] : ref.pz[i]],
    ];
    for (const [name, a, b] of pairs) {
      if (!Object.is(a, b)) return `slot ${i}: ${name} ${a} vs ${b}`;
    }
  }
  if (sim.highWater !== (ref.denseCount === 0 ? 0 : ref.highWater)) {
    return `highWater ${sim.highWater} vs ${ref.highWater}`;
  }
  if (ref.denseCount === 0) ref.highWater = 0; // the core's lazy decay, on read
  if (sim.hashState() !== ref.hash()) return `hashState ${sim.hashState()} vs ${ref.hash()}`;
  return null;
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

const DT = 1 / 60;
const STEPS = 1500;
const CAPACITY = 320;

/** A burst factory chosen and parameterized by `rng` — every value drawn up front. */
function pickPattern(rng: () => number): PatternFactory | PatternKey {
  const r = () => rng() * 2 - 1;
  const kind = Math.floor(rng() * 7);
  switch (kind) {
    case 0: {
      const count = 3 + Math.floor(rng() * 20);
      const spread = rng() * 7;
      const speed = 1 + rng() * 4;
      const heading = r() * 10;
      const fwd = r() * 3;
      const lat = r() * 2;
      const seq = rng() * 0.1;
      const radius = rng() * 1.5;
      return () => compose(gen.arc(count, spread, speed, heading, radius), mod.accelerate(fwd, lat), mod.sequence(seq));
    }
    case 1: {
      const count = 4 + Math.floor(rng() * 24);
      const speed = r() * 5;
      const radius = rng() * 2;
      const fwd = r() * 4;
      return () => compose(gen.ring(count, speed, radius), mod.accelerate(fwd), mod.payload(count));
    }
    case 2: {
      const count = 1 + Math.floor(rng() * 40);
      const radius = r() * 3;
      return () => compose(gen.fibonacciSphere(count, radius), mod.accelerate(-1.5, 0.4));
    }
    case 3: {
      const count = 1 + Math.floor(rng() * 30);
      const ax = r(), ay = r(), az = r(), angle = r() * 7;
      const fwd = r() * 2;
      return () => compose(gen.helix(count), mod.rotate(new Vector3(ax, ay, az), angle), mod.accelerate(fwd, 2));
    }
    case 4:
      return rng() < 0.5 ? 'ring' : 'torusKnot';
    case 5: {
      const seed = Math.floor(rng() * 1e6);
      const count = 5 + Math.floor(rng() * 30);
      return () => compose(gen.rose3D(count, 3, 1.5, createSeededRandom(seed)), mod.accelerate(0.6, -0.3));
    }
    default: {
      // Hand-built: every axis accelerated, offsets, negative and positive
      // delays, short lives (expiry within the run), fractional payloads.
      const n = 1 + Math.floor(rng() * 12);
      const specs = Array.from({ length: n }, () => ({
        o: [r() * 2, r() * 2, r() * 2], v: [r() * 6, r() * 6, r() * 6], a: [r() * 9, r() * 9, r() * 9],
        delay: r() * 0.5, life: 0.05 + rng() * 4, payload: r() * 1e6,
      }));
      return () =>
        specs.map((s) => {
          const d = acquire();
          d.offset.set(s.o[0], s.o[1], s.o[2]);
          d.velocity.set(s.v[0], s.v[1], s.v[2]);
          d.acceleration.set(s.a[0], s.a[1], s.a[2]);
          d.delay = s.delay;
          d.life = s.life;
          d.payload = s.payload;
          return d;
        });
    }
  }
}

interface Variant {
  name: string;
  interpolation: boolean;
  boundsLimit: number;
}

const VARIANTS: Variant[] = [
  { name: 'interpolation off, cull cube 9', interpolation: false, boundsLimit: 9 },
  { name: 'interpolation on, cull cube 9', interpolation: true, boundsLimit: 9 },
  { name: 'interpolation on, no bounds (lifetime only)', interpolation: true, boundsLimit: Infinity },
];

describe('core — bit-for-bit against a plain-number reference integrator', () => {
  for (const variant of VARIANTS) {
    it(`${STEPS} steps at dt = 1/60, ${variant.name}`, () => {
      const rng = createSeededRandom(20261023);
      const center = { x: 0, y: 0, z: 0 };
      const sim = createBulletSimulation({
        maxBullets: CAPACITY,
        boundsLimit: variant.boundsLimit,
        boundsCenter: center,
        interpolation: variant.interpolation,
        fadeTime: 0.5,
      });
      const ref = new Reference(CAPACITY);
      const emitters = [0, sim.acquireEmitter(), sim.acquireEmitter(), 17];
      let fired = 0;
      let dropped = 0;
      let consumed = 0;
      let checks = 0;

      const check = (what: string, k: number) => {
        checks++;
        const d = diff(sim, ref, variant.interpolation);
        if (d !== null) expect.fail(`step ${k}, after ${what}: ${d}`);
      };

      for (let k = 0; k < STEPS; k++) {
        if (k % 9 === 0) {
          const pattern = pickPattern(rng);
          const x = (rng() * 2 - 1) * 4;
          const y = (rng() * 2 - 1) * 2;
          const z = (rng() * 2 - 1) * 4;
          const id = emitters[Math.floor(rng() * emitters.length)];
          const spawns = snapshot(resolvePattern(pattern));
          const want = ref.fire(x, y, z, spawns, id);
          const got = sim.fireAt({ x, y, z }, pattern, id);
          expect(got).toBe(want);
          fired += got;
          dropped += spawns.length - got;
          check('fireAt', k);
        }

        // The cull box drifts; both sides read it once per step.
        center.x = (k % 240) * 0.01 - 1.2;
        center.z = -center.x * 0.5;
        sim.step(DT);
        ref.step(DT, variant.boundsLimit, center.x, center.y, center.z);
        check('step', k);

        if (k % 37 === 36) {
          const pred = (i: number) => (i * 7 + k) % 5 === 0;
          sim.forEachActive((i) => {
            if (!pred(i)) return false;
            consumed++;
            return true;
          });
          ref.consume(pred);
          check('forEachActive', k);
        }

        if (k % 400 === 399) {
          const id = emitters[(k / 400) | 0];
          expect(sim.clear(id)).toBe(ref.clear(id));
          check('clear', k);
        }
      }

      // The script exercised what it claims to: a full pool, expiry and culling.
      expect(fired).toBeGreaterThan(2000);
      expect(dropped).toBeGreaterThan(0);
      expect(consumed).toBeGreaterThan(0);
      expect(checks).toBeGreaterThan(STEPS);
      expect(sim.stepCount).toBe(STEPS);
    });
  }
});
