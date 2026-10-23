// ---------------------------------------------------------------------------
// The cross-engine golden over the built-in patterns' spawn data (0.8.0 L2)
// ---------------------------------------------------------------------------
//
// A fixed list of generator + modifier calls and a hash over every bit of the
// spawn data they produce. `patterns.detmath.test.ts` pins the hash under Node;
// L4's `test:engines` recomputes it in Chromium, Firefox and WebKit against the
// built `dist/patterns.js` and must get the same number.
//
// So this file is engine-neutral on purpose: no vitest, no Node API, and no
// value import at all. The patterns API comes in as an argument (`PatternApi`:
// the `/patterns` entry's `gen`, `mod`, `compose`, `createSeededRandom`, plus
// a `vec3` factory for `mod.rotate`'s axis), so a browser page can hand it the
// built bundle and a `new THREE.Vector3` — or a plain `{ x, y, z }`, since
// 0.8.0's `mod.rotate` only reads and writes the axis' fields. The imports
// below are type-only and erased.
//
// Changing the list or the hash changes the golden: update the committed
// value in the test in the same commit and say why.

import type { Vector3 } from 'three';
import type * as Patterns from '../../patterns';
import type { BulletSpawnData } from '../../patternTypes';

/** What the golden needs from the `/patterns` entry. */
export interface PatternApi {
  gen: typeof Patterns.gen;
  mod: typeof Patterns.mod;
  compose: typeof Patterns.compose;
  createSeededRandom: typeof Patterns.createSeededRandom;
  /** A fresh vector for `mod.rotate`'s axis (it is normalized in place). */
  vec3: (x: number, y: number, z: number) => Vector3;
}

/** One entry of the golden list: a name and the call that produces its batch. */
export interface PatternCase {
  name: string;
  run: (api: PatternApi) => BulletSpawnData[];
}

const TAU = Math.PI * 2;

/**
 * The golden list. Every generator and every modifier appears, with arguments
 * that reach each branch: `arc` below, at and above a full circle, `count`
 * 1 and many, negative and > 2π headings, negative speed (a `-0` y); the
 * `fibonacciSphere` / `helix` single-bullet path; `galaxy` with `arms` 0;
 * `rose3D` / `galaxy` on a seeded rng; `accelerate` on a zero velocity and a
 * vertical one (its fallback `up`); `rotate` about unnormalized axes.
 */
export const PATTERN_CASES: readonly PatternCase[] = [
  { name: 'fibonacciSphere(1, 2)', run: ({ gen }) => gen.fibonacciSphere(1, 2) },
  { name: 'fibonacciSphere(64, 2.5)', run: ({ gen }) => gen.fibonacciSphere(64, 2.5) },
  { name: 'fibonacciSphere(7, -1)', run: ({ gen }) => gen.fibonacciSphere(7, -1) },
  { name: 'torusKnot(48)', run: ({ gen }) => gen.torusKnot(48) },
  { name: 'torusKnot(33, 3, 5, 0.7)', run: ({ gen }) => gen.torusKnot(33, 3, 5, 0.7) },
  { name: 'torusKnot(20, -2, 2.5, -1)', run: ({ gen }) => gen.torusKnot(20, -2, 2.5, -1) },
  {
    name: 'galaxy(100, 4, 3, 2, seed 1337)',
    run: ({ gen, createSeededRandom }) => gen.galaxy(100, 4, 3, 2, createSeededRandom(1337)),
  },
  {
    name: 'galaxy(40, 1.5, 0, -3, seed 7)',
    run: ({ gen, createSeededRandom }) => gen.galaxy(40, 1.5, 0, -3, createSeededRandom(7)),
  },
  { name: 'helix(1)', run: ({ gen }) => gen.helix(1) },
  { name: 'helix(50)', run: ({ gen }) => gen.helix(50) },
  { name: 'helix(17, 0.5, -3, 5.5)', run: ({ gen }) => gen.helix(17, 0.5, -3, 5.5) },
  {
    name: 'rose3D(80, 4, 2, seed 42)',
    run: ({ gen, createSeededRandom }) => gen.rose3D(80, 4, 2, createSeededRandom(42)),
  },
  {
    name: 'rose3D(30, 2.5, 1, seed 9)',
    run: ({ gen, createSeededRandom }) => gen.rose3D(30, 2.5, 1, createSeededRandom(9)),
  },
  { name: 'ring(1)', run: ({ gen }) => gen.ring(1) },
  { name: 'ring(64, 3, 0.5)', run: ({ gen }) => gen.ring(64, 3, 0.5) },
  { name: 'ring(12, -1.5, 2)', run: ({ gen }) => gen.ring(12, -1.5, 2) },
  { name: 'arc(1, π/4, 2, 0.3)', run: ({ gen }) => gen.arc(1, Math.PI / 4, 2, 0.3) },
  { name: 'arc(9)', run: ({ gen }) => gen.arc(9) },
  { name: 'arc(12, 2π, 2, -1.25)', run: ({ gen }) => gen.arc(12, TAU, 2, -1.25) },
  { name: 'arc(5, 7, -3, 2π + 0.5, 1)', run: ({ gen }) => gen.arc(5, 7, -3, TAU + 0.5, 1) },
  { name: 'arc(32, π, 4.5, -100, 0.25)', run: ({ gen }) => gen.arc(32, Math.PI, 4.5, -100, 0.25) },
  { name: 'arc(3, 0, 1, 1e3)', run: ({ gen }) => gen.arc(3, 0, 1, 1e3) },
  {
    name: 'arc(24, 1.2, 3, 0.4) + accelerate(1.5, 0.7) + sequence(0.05) + color + payload + scale',
    run: ({ gen, mod, compose }) =>
      compose(
        gen.arc(24, 1.2, 3, 0.4),
        mod.accelerate(1.5, 0.7),
        mod.sequence(0.05),
        mod.color(0x39ff14),
        mod.payload(0x7fff),
        mod.scale(1.75),
      ),
  },
  {
    name: 'fibonacciSphere(64, 1) + accelerate(-2, -1.2)',
    run: ({ gen, mod, compose }) => compose(gen.fibonacciSphere(64, 1), mod.accelerate(-2, -1.2)),
  },
  {
    name: 'fibonacciSphere(1, 1) + accelerate(1, 1)',
    run: ({ gen, mod, compose }) => compose(gen.fibonacciSphere(1, 1), mod.accelerate(1, 1)),
  },
  {
    name: 'ring(16, 2) + accelerate(0.8) + rotate((1, 2, 3), 0.9)',
    run: ({ gen, mod, compose, vec3 }) =>
      compose(gen.ring(16, 2, 1), mod.accelerate(0.8), mod.rotate(vec3(1, 2, 3), 0.9)),
  },
  {
    name: 'helix(30) + rotate((0, 0, -5), -7) + rotate((0.3, -0.4, 0.5), 100)',
    run: ({ gen, mod, compose, vec3 }) =>
      compose(
        gen.helix(30),
        mod.rotate(vec3(0, 0, -5), -7),
        mod.rotate(vec3(0.3, -0.4, 0.5), 100),
      ),
  },
  {
    name: 'torusKnot(25) + accelerate(0.5, 2) + rotate((1, 0, 0), π/2) + sequence(-0.1)',
    run: ({ gen, mod, compose, vec3 }) =>
      compose(
        gen.torusKnot(25),
        mod.accelerate(0.5, 2),
        mod.rotate(vec3(1, 0, 0), Math.PI / 2),
        mod.sequence(-0.1),
      ),
  },
];

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Running 32-bit FNV-1a state over IEEE 754 bytes, little-endian, explicit. */
export class Fnv1a {
  private h = FNV_OFFSET;
  private readonly dv = new DataView(new ArrayBuffer(8));

  /** Fold one double's 8 bytes (little-endian) into the hash. */
  double(v: number): this {
    this.dv.setFloat64(0, v, true);
    let h = this.h;
    for (let b = 0; b < 8; b++) h = Math.imul(h ^ this.dv.getUint8(b), FNV_PRIME);
    this.h = h;
    return this;
  }

  /** The hash so far, as an unsigned 32-bit integer. */
  value(): number {
    return this.h >>> 0;
  }
}

/**
 * Fold a batch into `h`: its length, then per bullet, in array order, `offset`
 * x y z, `velocity` x y z, `acceleration` x y z, `delay`, `life`, `scale`,
 * `payload`, and `color` (`-1` for `null`). Every field of `BulletSpawnData`.
 */
export function hashSpawns(h: Fnv1a, spawns: readonly BulletSpawnData[]): Fnv1a {
  h.double(spawns.length);
  for (const s of spawns) {
    h.double(s.offset.x).double(s.offset.y).double(s.offset.z);
    h.double(s.velocity.x).double(s.velocity.y).double(s.velocity.z);
    h.double(s.acceleration.x).double(s.acceleration.y).double(s.acceleration.z);
    h.double(s.delay).double(s.life).double(s.scale).double(s.payload);
    h.double(s.color === null ? -1 : s.color);
  }
  return h;
}

/** Each case's own hash, in list order — for pinpointing a changed case. */
export function patternCaseHashes(api: PatternApi): { name: string; hash: number }[] {
  return PATTERN_CASES.map((c) => ({ name: c.name, hash: hashSpawns(new Fnv1a(), c.run(api)).value() }));
}

/** The golden: every case's batch folded, in list order, into one hash. */
export function patternGoldenHash(api: PatternApi): number {
  const h = new Fnv1a();
  for (const c of PATTERN_CASES) hashSpawns(h, c.run(api));
  return h.value();
}
