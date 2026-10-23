// ---------------------------------------------------------------------------
// The cross-engine golden over detSinCos (0.8.0 L1, factored out in L4)
// ---------------------------------------------------------------------------
//
// `detmath.test.ts` pins this hash under Node; `scripts/test-engines.mjs`
// recomputes it in Chromium, Firefox and WebKit against the built
// `dist/detmath.js` and must get the same number.
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
