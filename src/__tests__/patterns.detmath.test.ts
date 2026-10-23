// @vitest-environment node
//
// 0.8.0 L2: the generators and modifiers on det math.
//
// (a) 0.7.0 equivalence — a "V8 property". 0.8.0 replaced `Math.sin` /
//     `Math.cos` with `detSin` / `detCos` and three's vector math with
//     `src/vecmath.ts`, keeping every formula's operation order. V8's own
//     `Math.sin` / `Math.cos` are the same fdlibm port, so on V8 (Node, Chrome,
//     Electron) with the installed three every bit of the spawn data must equal
//     0.7.0's, which a verbatim copy in `fixtures/patterns070.ts` reproduces. On
//     any other engine 0.7.0's `Math.sin` is that engine's own, so only
//     closeness (2 ulp) is asserted there.
// (b) The cross-engine golden: one hash over the spawn data of
//     `helpers/patternGolden.ts`' fixed list. Engine-independent by
//     construction; L4 recomputes it in browsers.
// (c) `mod.rotate` still normalizes the caller's axis in place.
// (d) Nothing in `gen` / `mod` calls three's math methods any more.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { gen, mod, compose, createSeededRandom } from '../patterns';
import { releaseSpawnData } from '../pool';
import type { BulletSpawnData, Modifier } from '../patternTypes';
import { gen070, mod070 } from './fixtures/patterns070';
import {
  PATTERN_CASES,
  patternCaseHashes,
  patternGoldenHash,
  type PatternApi,
} from './helpers/patternGolden';

// `process.versions.v8`, read through globalThis (no Node types in the tests).
const ON_V8 =
  typeof (globalThis as { process?: { versions?: { v8?: unknown } } }).process?.versions?.v8 ===
  'string';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

const _f64 = new Float64Array(1);
const _i64 = new BigInt64Array(_f64.buffer);

/** A double's bits mapped onto a line where adjacent doubles differ by 1. */
function ordered(x: number): bigint {
  _f64[0] = x;
  const i = _i64[0];
  return i < 0n ? -(i & 0x7fffffffffffffffn) : i;
}

/** Distance in ulps; 0 for two NaNs, and +0 / -0 are 0 apart. */
function ulpDistance(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

function hex(x: number): string {
  _f64[0] = x;
  return (_i64[0] & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Batch comparison
// ---------------------------------------------------------------------------

const FIELDS: readonly [string, (s: BulletSpawnData) => number | null][] = [
  ['offset.x', (s) => s.offset.x],
  ['offset.y', (s) => s.offset.y],
  ['offset.z', (s) => s.offset.z],
  ['velocity.x', (s) => s.velocity.x],
  ['velocity.y', (s) => s.velocity.y],
  ['velocity.z', (s) => s.velocity.z],
  ['acceleration.x', (s) => s.acceleration.x],
  ['acceleration.y', (s) => s.acceleration.y],
  ['acceleration.z', (s) => s.acceleration.z],
  ['delay', (s) => s.delay],
  ['life', (s) => s.life],
  ['scale', (s) => s.scale],
  ['payload', (s) => s.payload],
  ['color', (s) => s.color],
];

/** Mismatches found so far (capped) and how many batches / values were compared. */
interface Tally {
  bad: string[];
  batches: number;
  values: number;
}

const newTally = (): Tally => ({ bad: [], batches: 0, values: 0 });

/**
 * Compare a 0.8.0 batch with 0.7.0's, every field of every bullet. On V8: the
 * same bits (`Object.is`, so `-0` vs `0` is a mismatch and NaN matches NaN).
 * Elsewhere: within 2 ulp, or — where a component is the small difference of
 * larger terms (a cross product, a rotation) and its own ulp is meaningless —
 * within 2 ulp of the batch's largest magnitude.
 */
function compareBatch(t: Tally, label: string, now: BulletSpawnData[], was: BulletSpawnData[]): void {
  t.batches++;
  if (now.length !== was.length) {
    t.bad.push(`${label}: length ${now.length} vs ${was.length}`);
    return;
  }
  let scale = 0;
  if (!ON_V8) {
    for (const s of was) {
      for (const [, get] of FIELDS) {
        const v = get(s);
        if (typeof v === 'number' && Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
      }
    }
  }
  for (let i = 0; i < now.length; i++) {
    for (const [field, get] of FIELDS) {
      const a = get(now[i]);
      const b = get(was[i]);
      t.values++;
      let ok: boolean;
      if (ON_V8 || a === null || b === null) ok = Object.is(a, b);
      else ok = ulpDistance(a, b) <= 2 || Math.abs(a - b) <= 2 * Number.EPSILON * scale;
      if (!ok && t.bad.length < 20) {
        t.bad.push(
          `${label} [${i}].${field}: 0.8.0 ${String(a)} (${typeof a === 'number' ? hex(a) : '-'})` +
            ` vs 0.7.0 ${String(b)} (${typeof b === 'number' ? hex(b) : '-'})`,
        );
      }
    }
  }
}

/** Run both versions, compare, return both batches to the pool. */
function both(t: Tally, label: string, now: () => BulletSpawnData[], was: () => BulletSpawnData[]): void {
  const a = now();
  const b = was();
  compareBatch(t, label, a, b);
  releaseSpawnData(a);
  releaseSpawnData(b);
}

function expectClean(t: Tally, minBatches: number): void {
  expect(t.bad).toEqual([]);
  expect(t.batches).toBeGreaterThanOrEqual(minBatches);
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const COUNTS = range(1, 64);

// ---------------------------------------------------------------------------
// (a) 0.7.0 equivalence
// ---------------------------------------------------------------------------

describe(`patterns — 0.7.0 equivalence (V8 property: ${ON_V8 ? 'bit-identical' : '≤ 2 ulp'} here)`, () => {
  it('gen.arc: counts 1..64 × spreads (incl. ≥ 2π) × headings (incl. negative, > 2π) × speed / radius', () => {
    const t = newTally();
    const spreads = [0, 0.1, Math.PI / 4, 1.2, Math.PI / 2, Math.PI, 3, TAU - 1e-8, TAU - 1e-9, TAU, 7, 100];
    const headings = [0, -0, 0.3, -1, 1.3, -7.5, TAU + 0.5, 20, -100, 1e3];
    const speedRadius: [number, number][] = [[2, 0], [-1.5, 1.5], [0, 0.3], [7.25, -2]];
    for (const count of COUNTS) {
      for (const spread of spreads) {
        for (const heading of headings) {
          for (const [speed, radius] of speedRadius) {
            both(
              t,
              `arc(${count}, ${spread}, ${speed}, ${heading}, ${radius})`,
              () => gen.arc(count, spread, speed, heading, radius),
              () => gen070.arc(count, spread, speed, heading, radius),
            );
          }
        }
      }
    }
    // Defaults too.
    for (const count of COUNTS) both(t, `arc(${count})`, () => gen.arc(count), () => gen070.arc(count));
    expectClean(t, 64 * 12 * 10 * 4);
  });

  it('gen.ring: counts 1..64 × speed × radius', () => {
    const t = newTally();
    for (const count of [0, ...COUNTS, 100, 360]) {
      for (const speed of [2, -1.5, 0, 7.25]) {
        for (const radius of [0, 1.5, -2]) {
          both(
            t,
            `ring(${count}, ${speed}, ${radius})`,
            () => gen.ring(count, speed, radius),
            () => gen070.ring(count, speed, radius),
          );
        }
      }
      both(t, `ring(${count})`, () => gen.ring(count), () => gen070.ring(count));
    }
    expectClean(t, 60 * 13);
  });

  it('gen.fibonacciSphere: counts 1..64 (and 200) × radius', () => {
    const t = newTally();
    for (const count of [...COUNTS, 200]) {
      for (const radius of [1, 2.5, -1, 0]) {
        both(
          t,
          `fibonacciSphere(${count}, ${radius})`,
          () => gen.fibonacciSphere(count, radius),
          () => gen070.fibonacciSphere(count, radius),
        );
      }
    }
    expectClean(t, 65 * 4);
  });

  it('gen.torusKnot: counts 1..64 × (p, q) × radius', () => {
    const t = newTally();
    const pq: [number, number][] = [[2, 3], [3, 5], [1, 1], [0, 2], [-2, 3], [2.5, 1.5], [7, 11]];
    for (const count of COUNTS) {
      for (const [p, q] of pq) {
        for (const radius of [2, 0.7, -1]) {
          both(
            t,
            `torusKnot(${count}, ${p}, ${q}, ${radius})`,
            () => gen.torusKnot(count, p, q, radius),
            () => gen070.torusKnot(count, p, q, radius),
          );
        }
      }
      both(t, `torusKnot(${count})`, () => gen.torusKnot(count), () => gen070.torusKnot(count));
    }
    expectClean(t, 64 * 22);
  });

  it('gen.helix: counts 1..64 × radius × height × turns', () => {
    const t = newTally();
    for (const count of COUNTS) {
      for (const [radius, height, turns] of [
        [2, 4, 2],
        [0.5, -3, 5.5],
        [-1, 0, 0],
        [3, 10, 100],
      ] as [number, number, number][]) {
        both(
          t,
          `helix(${count}, ${radius}, ${height}, ${turns})`,
          () => gen.helix(count, radius, height, turns),
          () => gen070.helix(count, radius, height, turns),
        );
      }
      both(t, `helix(${count})`, () => gen.helix(count), () => gen070.helix(count));
    }
    expectClean(t, 64 * 5);
  });

  it('gen.galaxy: seeded (createSeededRandom), counts × radius × arms (incl. 0) × spin', () => {
    const t = newTally();
    for (const count of [1, 2, 7, 64, 200]) {
      for (const radius of [4, 1]) {
        for (const arms of [3, 1, 0, 5]) {
          for (const spin of [2, 0, -3]) {
            for (const seed of [1, 42, 1337]) {
              both(
                t,
                `galaxy(${count}, ${radius}, ${arms}, ${spin}, seed ${seed})`,
                () => gen.galaxy(count, radius, arms, spin, createSeededRandom(seed)),
                () => gen070.galaxy(count, radius, arms, spin, createSeededRandom(seed)),
              );
            }
          }
        }
      }
    }
    expectClean(t, 5 * 2 * 4 * 3 * 3);
  });

  it('gen.rose3D: seeded (createSeededRandom), counts × k × radius', () => {
    const t = newTally();
    for (const count of [1, 2, 16, 100, 500]) {
      for (const k of [4, 3, 0, 2.5, -1, 7]) {
        for (const radius of [2, 1, -0.5]) {
          for (const seed of [1, 42, 9]) {
            both(
              t,
              `rose3D(${count}, ${k}, ${radius}, seed ${seed})`,
              () => gen.rose3D(count, k, radius, createSeededRandom(seed)),
              () => gen070.rose3D(count, k, radius, createSeededRandom(seed)),
            );
          }
        }
      }
    }
    expectClean(t, 5 * 6 * 3 * 3);
  });

  // Bases for the modifiers: each generator, the zero-velocity single bullet
  // (accelerate normalizes a zero vector) and the sphere's poles (velocity
  // (0, ±1, 0): accelerate's fallback `up`).
  const BASES: [string, (g: typeof gen) => BulletSpawnData[]][] = [
    ['arc(13, 1.1, 2.5, 0.3, 0.5)', (g) => g.arc(13, 1.1, 2.5, 0.3, 0.5)],
    ['arc(8, 2π, -2, -4)', (g) => g.arc(8, TAU, -2, -4)],
    ['ring(16, -2, 1)', (g) => g.ring(16, -2, 1)],
    ['fibonacciSphere(1, 1)', (g) => g.fibonacciSphere(1, 1)],
    ['fibonacciSphere(40, 2)', (g) => g.fibonacciSphere(40, 2)],
    ['torusKnot(30)', (g) => g.torusKnot(30)],
    ['helix(25)', (g) => g.helix(25)],
    ['galaxy(50, seed 5)', (g) => g.galaxy(50, 4, 3, 2, createSeededRandom(5))],
    ['rose3D(50, seed 6)', (g) => g.rose3D(50, 4, 2, createSeededRandom(6))],
  ];
  // Generators are bit-identical (above), so each modifier is compared on its
  // own version's generator output.
  const base070 = gen070 as unknown as typeof gen;

  it('mod.accelerate: forward × lateral (0 and nonzero) on every base, applied once and twice', () => {
    const t = newTally();
    for (const [name, base] of BASES) {
      for (const forward of [0, 1.5, -2, 1e-3]) {
        for (const lateral of [0, 0.7, -1.2, 3]) {
          const label = `${name} + accelerate(${forward}, ${lateral})`;
          both(
            t,
            label,
            () => compose(base(gen), mod.accelerate(forward, lateral)),
            () => compose(base(base070), mod070.accelerate(forward, lateral)),
          );
          both(
            t,
            `${label} ×2`,
            () => compose(base(gen), mod.accelerate(forward, lateral), mod.accelerate(lateral, forward)),
            () => compose(base(base070), mod070.accelerate(forward, lateral), mod070.accelerate(lateral, forward)),
          );
        }
      }
    }
    expectClean(t, 9 * 16 * 2);
  });

  it('mod.rotate: several axes (unnormalized, negative) × angles, after accelerate; the axes end equal too', () => {
    const t = newTally();
    const axes: [number, number, number][] = [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -5],
      [1, 2, 3],
      [0.3, -0.4, 0.5],
      [-7, 0.01, 2],
      [0, 0, 0],
    ];
    const angles = [0, -0, Math.PI / 2, -1, 3, 7, 100, -TAU, 1e3];
    for (const [name, base] of BASES) {
      for (const [x, y, z] of axes) {
        for (const angle of angles) {
          const axisNow = new Vector3(x, y, z);
          const axisWas = new Vector3(x, y, z);
          const rotNow: Modifier = mod.rotate(axisNow, angle);
          const rotWas: Modifier = mod070.rotate(axisWas, angle);
          both(
            t,
            `${name} + accelerate(1, 0.5) + rotate((${x}, ${y}, ${z}), ${angle}) ×2`,
            // The same modifier twice: the second run re-normalizes the
            // already-normalized axis, as 0.7.0 did.
            () => compose(base(gen), mod.accelerate(1, 0.5), rotNow, rotNow),
            () => compose(base(base070), mod070.accelerate(1, 0.5), rotWas, rotWas),
          );
          for (const c of ['x', 'y', 'z'] as const) {
            if (!(ON_V8 ? Object.is(axisNow[c], axisWas[c]) : ulpDistance(axisNow[c], axisWas[c]) <= 2)) {
              t.bad.push(`axis (${x}, ${y}, ${z}).${c}: ${axisNow[c]} vs ${axisWas[c]}`);
            }
          }
        }
      }
    }
    expectClean(t, 9 * 7 * 9);
  });

  it('mod.sequence, color, payload, scale, and long chains', () => {
    const t = newTally();
    for (const [name, base] of BASES) {
      for (const step of [0, 0.05, -0.1, 1 / 3]) {
        both(
          t,
          `${name} + sequence(${step}) ×2 + color + payload + scale`,
          () =>
            compose(base(gen), mod.sequence(step), mod.sequence(step), mod.color(0xff00ff), mod.payload(12345), mod.scale(0.5)),
          () =>
            compose(
              base(base070),
              mod070.sequence(step),
              mod070.sequence(step),
              mod070.color(0xff00ff),
              mod070.payload(12345),
              mod070.scale(0.5),
            ),
        );
      }
      both(
        t,
        `${name} + accelerate + rotate + accelerate + rotate + sequence`,
        () =>
          compose(
            base(gen),
            mod.accelerate(2, -0.3),
            mod.rotate(new Vector3(1, 1, 0), 0.7),
            mod.accelerate(-0.5, 1.1),
            mod.rotate(new Vector3(0, -1, 2), -2.2),
            mod.sequence(0.02),
          ),
        () =>
          compose(
            base(base070),
            mod070.accelerate(2, -0.3),
            mod070.rotate(new Vector3(1, 1, 0), 0.7),
            mod070.accelerate(-0.5, 1.1),
            mod070.rotate(new Vector3(0, -1, 2), -2.2),
            mod070.sequence(0.02),
          ),
      );
    }
    expectClean(t, 9 * 5);
  });

  it('the golden list (b) itself: 0.7.0 gives the same hash on V8', () => {
    const api070: PatternApi = {
      gen: gen070 as unknown as typeof gen,
      mod: mod070 as unknown as typeof mod,
      compose,
      createSeededRandom,
      vec3: (x, y, z) => new Vector3(x, y, z),
    };
    const was = patternGoldenHash(api070);
    if (ON_V8) expect(patternGoldenHash(API)).toBe(was);
    else expect(typeof was).toBe('number'); // engine-specific Math.sin: no equality to assert
  });
});

// ---------------------------------------------------------------------------
// (b) The cross-engine golden
// ---------------------------------------------------------------------------

const API: PatternApi = {
  gen,
  mod,
  compose,
  createSeededRandom,
  vec3: (x, y, z) => new Vector3(x, y, z),
};

describe('patterns — golden spawn hash (engine-independent)', () => {
  // Produced once under Node 22 (V8) on 0.8.0 L2, after the 0.7.0 equivalence
  // above held bit for bit — so it is also 0.7.0's hash on V8. Every engine
  // must reproduce it (L4's `test:engines` recomputes it in Chromium, Firefox
  // and WebKit from the built bundle). If it changes, some pattern's bits
  // changed: a breaking change to every recording.
  it('the fixed generator + modifier list hashes to the committed value', () => {
    expect(patternGoldenHash(API)).toBe(GOLDEN);
  });

  it('per case, too (pinpoints which case moved)', () => {
    expect(patternCaseHashes(API)).toEqual(GOLDEN_CASES);
  });

  it('a plain { x, y, z } axis works the same as a Vector3 (what a browser page may pass)', () => {
    const plain: PatternApi = {
      ...API,
      vec3: (x, y, z) => ({ x, y, z }) as unknown as Vector3,
    };
    expect(patternGoldenHash(plain)).toBe(GOLDEN);
  });

  it('the list covers every generator and modifier', () => {
    const names = PATTERN_CASES.map((c) => c.name).join(' ');
    for (const g of Object.keys(gen)) expect(names).toContain(`${g}(`);
    for (const m of Object.keys(mod)) expect(names).toContain(m);
  });
});

/** See the test above: 0x8c6d3dd6. */
const GOLDEN = 2355969494;

/** Each case's hash, same provenance as {@link GOLDEN}. */
const GOLDEN_CASES: { name: string; hash: number }[] = [
  { name: "fibonacciSphere(1, 2)", hash: 0x5c758c4c },
  { name: "fibonacciSphere(64, 2.5)", hash: 0xf54782a4 },
  { name: "fibonacciSphere(7, -1)", hash: 0x54877279 },
  { name: "torusKnot(48)", hash: 0xb72cfce5 },
  { name: "torusKnot(33, 3, 5, 0.7)", hash: 0x9afc1611 },
  { name: "torusKnot(20, -2, 2.5, -1)", hash: 0x3f32e20b },
  { name: "galaxy(100, 4, 3, 2, seed 1337)", hash: 0x8088592b },
  { name: "galaxy(40, 1.5, 0, -3, seed 7)", hash: 0xd9e8eed6 },
  { name: "helix(1)", hash: 0x5c758c4c },
  { name: "helix(50)", hash: 0x5eaede92 },
  { name: "helix(17, 0.5, -3, 5.5)", hash: 0xf2589e00 },
  { name: "rose3D(80, 4, 2, seed 42)", hash: 0x6ec8602a },
  { name: "rose3D(30, 2.5, 1, seed 9)", hash: 0x3567d570 },
  { name: "ring(1)", hash: 0x8805fd8c },
  { name: "ring(64, 3, 0.5)", hash: 0xc35c1d23 },
  { name: "ring(12, -1.5, 2)", hash: 0x2035d393 },
  { name: "arc(1, π/4, 2, 0.3)", hash: 0x7b604393 },
  { name: "arc(9)", hash: 0x7cbfc393 },
  { name: "arc(12, 2π, 2, -1.25)", hash: 0xf41a611b },
  { name: "arc(5, 7, -3, 2π + 0.5, 1)", hash: 0x48442e56 },
  { name: "arc(32, π, 4.5, -100, 0.25)", hash: 0x7231a937 },
  { name: "arc(3, 0, 1, 1e3)", hash: 0x0d083189 },
  { name: "arc(24, 1.2, 3, 0.4) + accelerate(1.5, 0.7) + sequence(0.05) + color + payload + scale", hash: 0xb69387d0 },
  { name: "fibonacciSphere(64, 1) + accelerate(-2, -1.2)", hash: 0xa163c0ba },
  { name: "fibonacciSphere(1, 1) + accelerate(1, 1)", hash: 0x5c758c4c },
  { name: "ring(16, 2) + accelerate(0.8) + rotate((1, 2, 3), 0.9)", hash: 0xaf38ecbc },
  { name: "helix(30) + rotate((0, 0, -5), -7) + rotate((0.3, -0.4, 0.5), 100)", hash: 0xdd8b9681 },
  { name: "torusKnot(25) + accelerate(0.5, 2) + rotate((1, 0, 0), π/2) + sequence(-0.1)", hash: 0xe1d341c8 },
];

// ---------------------------------------------------------------------------
// (c) mod.rotate and its axis
// ---------------------------------------------------------------------------

describe('mod.rotate — the axis', () => {
  it('is normalized in place when the modifier runs (not when it is created), as in 0.7.0', () => {
    const axis = new Vector3(0, 3, 4);
    const rot = mod.rotate(axis, 1);
    expect([axis.x, axis.y, axis.z]).toEqual([0, 3, 4]);

    const spawns = gen.ring(4);
    rot(spawns);
    const expected = new Vector3(0, 3, 4).normalize();
    expect(Object.is(axis.x, expected.x)).toBe(true);
    expect(Object.is(axis.y, expected.y)).toBe(true);
    expect(Object.is(axis.z, expected.z)).toBe(true);
    expect(axis.length()).toBeCloseTo(1, 15);
    releaseSpawnData(spawns);
  });

  it('a zero axis stays zero and rotates nothing (normalize divides by 1)', () => {
    const axis = new Vector3(0, 0, 0);
    const spawns = gen.ring(6, 2, 1);
    const before = spawns.map((s) => s.velocity.toArray());
    mod.rotate(axis, 1.3)(spawns);
    expect([axis.x, axis.y, axis.z]).toEqual([0, 0, 0]);
    // q = (0, 0, 0, cos 0.65): v + w·0 + 0 = v.
    expect(spawns.map((s) => s.velocity.toArray())).toEqual(before);
    releaseSpawnData(spawns);
  });
});

// ---------------------------------------------------------------------------
// (d) Independent of three's math
// ---------------------------------------------------------------------------

describe('patterns — no three math methods', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the whole golden list runs with three’s vector / quaternion math poisoned', () => {
    const poison = (name: string) => () => {
      throw new Error(`three's ${name} called from gen / mod`);
    };
    const v3 = Vector3.prototype as unknown as Record<string, () => unknown>;
    for (const m of [
      'normalize',
      'length',
      'lengthSq',
      'multiplyScalar',
      'divideScalar',
      'addScaledVector',
      'add',
      'sub',
      'cross',
      'crossVectors',
      'applyQuaternion',
      'applyAxisAngle',
      'applyMatrix3',
      'applyMatrix4',
    ]) {
      vi.spyOn(v3, m).mockImplementation(poison(`Vector3.${m}`));
    }
    const q = Quaternion.prototype as unknown as Record<string, () => unknown>;
    for (const m of ['setFromAxisAngle', 'multiply', 'normalize']) {
      vi.spyOn(q, m).mockImplementation(poison(`Quaternion.${m}`));
    }
    const sin = vi.spyOn(Math, 'sin');
    const cos = vi.spyOn(Math, 'cos');

    expect(patternGoldenHash(API)).toBe(GOLDEN);
    expect(sin).not.toHaveBeenCalled();
    expect(cos).not.toHaveBeenCalled();
  });
});
