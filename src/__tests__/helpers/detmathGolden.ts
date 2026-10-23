// ---------------------------------------------------------------------------
// The cross-engine goldens over detSinCos (0.8.0 L1, factored out in L4)
// ---------------------------------------------------------------------------
//
// `detmath.test.ts` pins these hashes under Node; `scripts/test-engines.mjs`
// recomputes them in Chromium, Firefox and WebKit against the built
// `dist/detmath.js` and must get the same numbers.
//
// Engine-neutral on purpose, like `patternGolden.ts`: no vitest, no Node API,
// no value import (the imports below are type-only and erased), so the script
// can transpile this file on its own and run it in a page.

import type { SinCos } from '../../detmath';

/** What the golden needs: the det entry's `detSinCos` and the seeded rng. */
export interface DetMathApi {
  detSinCos: (x: number, out: SinCos) => SinCos;
  createSeededRandom: (seed: number) => () => number;
}

/** The committed value; `detmath.test.ts` pins it (0x7b8d985b). */
export const DETSINCOS_GOLDEN = 2072877147;

/**
 * 32-bit FNV-1a over the bytes of `detSinCos(x)` — `s` then `c`, each as its 8
 * IEEE 754 bytes in little-endian order — for `count` (1,000,000) inputs
 * `x = (rng() * 2 - 1) * 1e4` from `createSeededRandom(1337)`.
 */
export function detSinCosGoldenHash(api: DetMathApi, count: number = 1_000_000): number {
  const rng = api.createSeededRandom(1337);
  const sc: SinCos = { s: 0, c: 0 };
  const dv = new DataView(new ArrayBuffer(16));
  let h = 0x811c9dc5;
  for (let i = 0; i < count; i++) {
    api.detSinCos((rng() * 2 - 1) * 1e4, sc);
    dv.setFloat64(0, sc.s, true);
    dv.setFloat64(8, sc.c, true);
    for (let b = 0; b < 16; b++) h = Math.imul(h ^ dv.getUint8(b), 0x01000193);
  }
  return h >>> 0;
}

/** The committed beyond-range value; `detmath.test.ts` pins it (0xeb1d515f). */
export const DETSINCOS_BEYOND_GOLDEN = 3944567135;

/**
 * Inputs beyond `DETMATH_RANGE` (where detSinCos first reduces `x % (2π)`):
 * fixed edge values, then `count` (10,000) seeded ones `±m · 2^e` with
 * m in [1, 2) and e in 20..1023 — every binade from just past the range up to
 * `Number.MAX_VALUE`'s. Built from exact operations only (doubling, a product
 * by a power of two), so every engine gets the same inputs.
 */
export function beyondRangeInputs(
  createSeededRandom: DetMathApi['createSeededRandom'],
  count: number = 10_000,
): number[] {
  const pow2: number[] = [1];
  for (let e = 1; e <= 1023; e++) pow2.push(pow2[e - 1] * 2);
  const out: number[] = [
    823549.6645826428, // the double after DETMATH_RANGE
    -823549.6645826428,
    1e6,
    pow2[31] * 1.25,
    pow2[52],
    pow2[53],
    -pow2[53],
    pow2[54],
    pow2[60],
    1e100,
    -1e100,
    1e300,
    1.7976931348623157e308,
    -1.7976931348623157e308,
  ];
  const rng = createSeededRandom(4242);
  for (let i = 0; i < count; i++) {
    const m = 1 + rng();
    const e = 20 + Math.floor(rng() * 1004);
    const x = m * pow2[e];
    out.push(rng() < 0.5 ? -x : x);
  }
  return out;
}

/**
 * 32-bit FNV-1a over the bytes of `detSinCos(x)` (as {@link detSinCosGoldenHash})
 * for every {@link beyondRangeInputs} value.
 */
export function detSinCosBeyondGoldenHash(api: DetMathApi): number {
  const sc: SinCos = { s: 0, c: 0 };
  const dv = new DataView(new ArrayBuffer(16));
  let h = 0x811c9dc5;
  for (const x of beyondRangeInputs(api.createSeededRandom)) {
    api.detSinCos(x, sc);
    dv.setFloat64(0, sc.s, true);
    dv.setFloat64(8, sc.c, true);
    for (let b = 0; b < 16; b++) h = Math.imul(h ^ dv.getUint8(b), 0x01000193);
  }
  return h >>> 0;
}
