// ---------------------------------------------------------------------------
// Deterministic sin / cos — bit-identical on every JavaScript engine
// ---------------------------------------------------------------------------
//
// Ported from fdlibm 5.3 (the Freely Distributable LIBM, netlib.org/fdlibm),
// whose notice follows and must be preserved:
//
//   ====================================================
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
//   Developed at SunSoft, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this
//   software is freely granted, provided that this notice
//   is preserved.
//   ====================================================
//
// What was ported, operation for operation:
//
// - `e_rem_pio2.c` `__ieee754_rem_pio2`, its medium-size path only: Cody–Waite
//   reduction of |x| by pi/2 with the three-part constant (pio2_1 / pio2_1t,
//   pio2_2 / pio2_2t, pio2_3 / pio2_3t), `n = floor(|x| * invpio2 + 0.5)`, and
//   the second and third refinement rounds taken when the exponent check sees
//   cancellation. As in fdlibm 5.3 the reduction runs on |x| and a negative x
//   negates the remainder and the quadrant. Two departures, neither of which
//   adds an operation to a result: the `|x| < 3pi/4` shortcut is not ported
//   (the medium path with n = 1 covers it, as FreeBSD msun's
//   `goto medium` does near pi/2), and the `npio2_hw` quick check that skips
//   the exponent check for n < 32 is not ported — the exponent check always
//   runs, as in FreeBSD msun, so refinement is taken whenever it is needed.
//   The Payne–Hanek path for huge |x| (`__kernel_rem_pio2`) is not ported:
//   beyond `DETMATH_RANGE` the medium path still runs (see below).
// - `k_sin.c` `__kernel_sin` and `k_cos.c` `__kernel_cos` (fdlibm 5.3, with
//   the `qx` / `hz` split for |x| >= 0.3), coefficients and Horner order
//   unchanged.
// - `s_sin.c` / `s_cos.c`: the |x| <= pi/4 fast path and the quadrant switch
//   on `n & 3`.
//
// Why this is deterministic: ECMAScript specifies `+ - * /` and `Math.sqrt`
// as correctly rounded IEEE 754 double operations, `Math.abs` and
// `Math.floor` exactly, and never contracts a multiply and an add into an FMA.
// This file uses only those, comparisons, integer bit operations, a
// DataView to read a double's high word (exact) and Float64Array scratch
// slots (which store a double exactly). A fixed sequence of them
// gives the same bits on every conforming engine. `Math.sin` / `Math.cos` are
// "implementation-approximated" by the spec and give no such guarantee.
//
// No `Math.sin / cos / tan / pow / exp / log` and no `**` anywhere below:
// every constant is a double literal whose exact bits are in its comment (a
// test checks each literal against its comment).
//
// This module imports nothing, so the `/detmath` entry is self-contained.

/** The pair {@link detSinCos} writes: `s` = sine, `c` = cosine. */
export interface SinCos {
  s: number;
  c: number;
}

/**
 * The input range over which {@link detSin}, {@link detCos} and
 * {@link detSinCos} are accurate to within 1 ulp of the correctly rounded
 * result: `|x| <= DETMATH_RANGE` = 2^19 · π/2 ≈ 823,549.66 radians (the double
 * nearest 2^18 · π, bits `0x412921FB_54442D18`).
 *
 * Beyond it the result is still deterministic — the same operations on every
 * engine — but accuracy drops as |x| grows (and for very large |x| the value
 * is meaningless). Development builds warn once.
 */
export const DETMATH_RANGE = 823549.6645826427; // 0x412921FB, 0x54442D18

// ---- e_rem_pio2.c constants ---------------------------------------------------

const invpio2 = 0.6366197723675814; // 0x3FE45F30, 0x6DC9C883  53 bits of 2/pi
const pio2_1 = 1.5707963267341256; // 0x3FF921FB, 0x54400000  first 33 bits of pi/2
const pio2_1t = 6.077100506506192e-11; // 0x3DD0B461, 0x1A626331  pi/2 - pio2_1
const pio2_2 = 6.077100506303966e-11; // 0x3DD0B461, 0x1A600000  second 33 bits of pi/2
const pio2_2t = 2.0222662487959506e-21; // 0x3BA3198A, 0x2E037073  pi/2 - (pio2_1 + pio2_2)
const pio2_3 = 2.0222662487111665e-21; // 0x3BA3198A, 0x2E000000  third 33 bits of pi/2
const pio2_3t = 8.4784276603689e-32; // 0x397B839A, 0x252049C1  pi/2 - (pio2_1 + pio2_2 + pio2_3)

// ---- k_sin.c constants --------------------------------------------------------

const S1 = -0.16666666666666632; // 0xBFC55555, 0x55555549
const S2 = 0.00833333333332249; // 0x3F811111, 0x1110F8A6
const S3 = -0.0001984126982985795; // 0xBF2A01A0, 0x19C161D5
const S4 = 2.7557313707070068e-6; // 0x3EC71DE3, 0x57B1FE7D
const S5 = -2.5050760253406863e-8; // 0xBE5AE5E6, 0x8A2B9CEB
const S6 = 1.58969099521155e-10; // 0x3DE5D93A, 0x5ACFD57C

// ---- k_cos.c constants --------------------------------------------------------

const C1 = 0.0416666666666666; // 0x3FA55555, 0x5555554C
const C2 = -0.001388888888887411; // 0xBF56C16C, 0x16C15177
const C3 = 2.480158728947673e-5; // 0x3EFA01A0, 0x19CB1590
const C4 = -2.7557314351390663e-7; // 0xBE927E4F, 0x809C52AD
const C5 = 2.087572321298175e-9; // 0x3E21EE9E, 0xBDB4B1C4
const C6 = -1.1359647557788195e-11; // 0xBDA8FAE9, 0xBE8838D4

// ---- Word access ----------------------------------------------------------------

/**
 * One 8-byte scratch buffer for fdlibm's `__HI(x)` / `__LO(x)` word access.
 * DataView reads and writes are exact and big-endian by default, so the high
 * word is at byte 0 on every platform. Module scoped: nothing allocates per
 * call.
 */
const _words = new DataView(new ArrayBuffer(8));

/** fdlibm's `__HI(x)`: the high 32 bits of x as a signed int32. */
function highWord(x: number): number {
  _words.setFloat64(0, x);
  return _words.getInt32(0);
}

// ---- Development-build range warning -------------------------------------------

/**
 * The same check as `src/dev.ts` (the literal `process.env.NODE_ENV` text a
 * bundler substitutes; a missing `process` counts as production), inlined so
 * this module imports nothing.
 */
declare const process: { env: { NODE_ENV?: string } };
const DEV: boolean = (() => {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
})();

let _warned = false;

function warnOutOfRange(x: number): void {
  if (_warned) return;
  _warned = true;
  console.warn(
    `[r3f-projectiles] detSin / detCos: |x| = ${Math.abs(x)} is beyond DETMATH_RANGE ` +
      `(2^19 * pi/2 = ${DETMATH_RANGE}). The result is still deterministic on every ` +
      'engine but no longer accurate to 1 ulp. Wrap angles into range first. ' +
      '(Shown once.)',
  );
}

// ---- __ieee754_rem_pio2 (medium path) ------------------------------------------

/**
 * The kernels' argument, as a head / tail pair: fdlibm's `y[0]` / `y[1]` after
 * a reduction (x - n·pi/2 = `_y[0] + _y[1]`), or `x` and `0` when |x| ~<= pi/4.
 * remPio2 also takes its x from `_y[0]`.
 *
 * ## Why the internal functions talk through typed arrays (performance only)
 *
 * The bits are the same either way; this is about allocation. V8 passes and
 * returns JS values tagged, so a double crossing a call V8 did not inline —
 * an argument or a return value — is boxed into a fresh heap number, and a
 * double kept in a module-scope `let` is re-boxed on every write. Whether
 * these helpers get inlined depends on the caller's inlining budget, which
 * varies from run to run. With plain arguments and returns (0.8.0 L1/L2),
 * `detmath.bench.test.ts`'s gen.arc bursts ran at ~1.6× of 0.7.0's
 * Math.sin / Math.cos on Node 22, over the plan's 1.5× budget; laid out like
 * this, ~1.2–1.3×. So the helpers take no double arguments and return no
 * doubles: inputs and results live in two Float64Arrays (`_y` here, `_k` for
 * the kernels' results), whose elements hold a double unboxed and exactly
 * (every bit, -0 included).
 */
const _y = new Float64Array(2);

/**
 * Reduce x = `_y[0]` (|x| > pi/4, finite) by pi/2: overwrites `_y` with the
 * remainder as the head/tail pair `_y[0]` + `_y[1]` (|_y[0]| <= ~pi/4) and
 * returns the quadrant `n & 3`, with x ≈ n·pi/2 + remainder. (fdlibm tests
 * the sign as `hx < 0`; for a nonzero, non-NaN x that is exactly `x < 0`.)
 *
 * n itself is a double: within the range `|n| < 2^20` and an integer. The
 * quadrant is `n & 3` (ToInt32 being modular, well defined and
 * engine-independent for any finite n), taken here rather than by the callers
 * so the return value is a small integer.
 */
function remPio2(): number {
  const x = _y[0];
  const ix = highWord(x) & 0x7fffffff;
  const t = Math.abs(x);
  const fn = Math.floor(t * invpio2 + 0.5); // fdlibm 5.3: n = (int)(t*invpio2+half)
  let r = t - fn * pio2_1;
  let w = fn * pio2_1t; // 1st round, good to 85 bits
  const j = ix >> 20;
  let y0 = r - w;
  let i = j - ((highWord(y0) >> 20) & 0x7ff);
  if (i > 16) {
    // 2nd round, good to 118 bits
    let tt = r;
    w = fn * pio2_2;
    r = tt - w;
    w = fn * pio2_2t - (tt - r - w);
    y0 = r - w;
    i = j - ((highWord(y0) >> 20) & 0x7ff);
    if (i > 49) {
      // 3rd round, good to 151 bits, covers all cases
      tt = r;
      w = fn * pio2_3;
      r = tt - w;
      w = fn * pio2_3t - (tt - r - w);
      y0 = r - w;
    }
  }
  const y1 = r - y0 - w;
  if (x < 0) {
    _y[0] = -y0;
    _y[1] = -y1;
    return -fn & 3;
  }
  _y[0] = y0;
  _y[1] = y1;
  return fn & 3;
}

// ---- __kernel_sin / __kernel_cos -------------------------------------------------

/** The kernels' results: `_k[0]` is kernelSin's, `_k[1]` kernelCos's (see `_y`). */
const _k = new Float64Array(2);

/**
 * fdlibm's `__kernel_sin(x, y, iy)`: sin(x + y) on |x| <= ~pi/4, with
 * x = `_y[0]` and y = `_y[1]` its tail (iy = 0 means y is 0). The result goes
 * to `_k[0]`.
 */
function kernelSin(iy: number): void {
  const x = _y[0];
  const y = _y[1];
  // ix < 0x3e400000, i.e. |x| < 2^-27: sin(x) rounds to x. Yields x itself,
  // so the sign of zero survives.
  if (Math.abs(x) < 7.450580596923828e-9 /* 2^-27: 0x3E400000, 0x00000000 */) {
    _k[0] = x;
    return;
  }
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) _k[0] = x + v * (S1 + z * r);
  else _k[0] = x - (z * (0.5 * y - v * r) - y - v * S1);
}

/**
 * fdlibm's `__kernel_cos(x, y)`: cos(x + y) on |x| <= ~pi/4, with x = `_y[0]`
 * and y = `_y[1]` its tail. The result goes to `_k[1]`.
 */
function kernelCos(): void {
  const x = _y[0];
  const y = _y[1];
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) {
    // |x| < 2^-27
    _k[1] = 1;
    return;
  }
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) {
    // |x| < 0.3
    _k[1] = 1 - (0.5 * z - (z * r - x * y));
    return;
  }
  let qx: number;
  if (ix > 0x3fe90000) {
    // |x| > 0.78125
    qx = 0.28125;
  } else {
    // qx = x/4 to 21 bits: high word ix - 2^21 (exponent - 2), low word 0
    _words.setInt32(0, ix - 0x00200000);
    _words.setInt32(4, 0);
    qx = _words.getFloat64(0);
  }
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  _k[1] = a - (hz - (z * r - x * y));
}

// ---- Public API --------------------------------------------------------------------

/**
 * Deterministic sine: the same bits on every JavaScript engine, within 1 ulp
 * of the correctly rounded `sin(x)` for `|x| <= DETMATH_RANGE`.
 *
 * `detSin(NaN)`, `detSin(±Infinity)` are `NaN`; `detSin(-0)` is `-0`.
 * Beyond {@link DETMATH_RANGE} the result is deterministic but inaccurate
 * (development builds warn once).
 */
export function detSin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return x - x; // NaN, ±Infinity -> NaN
  _y[0] = x;
  _y[1] = 0;
  if (ix <= 0x3fe921fb) {
    // |x| ~<= pi/4
    kernelSin(0);
    return _k[0];
  }
  if (DEV && Math.abs(x) > DETMATH_RANGE) warnOutOfRange(x);
  switch (remPio2()) {
    case 0:
      kernelSin(1);
      return _k[0];
    case 1:
      kernelCos();
      return _k[1];
    case 2:
      kernelSin(1);
      return -_k[0];
    default:
      kernelCos();
      return -_k[1];
  }
}

/**
 * Deterministic cosine: the same bits on every JavaScript engine, within
 * 1 ulp of the correctly rounded `cos(x)` for `|x| <= DETMATH_RANGE`.
 *
 * `detCos(NaN)`, `detCos(±Infinity)` are `NaN`; `detCos(0) === 1`.
 * Beyond {@link DETMATH_RANGE} the result is deterministic but inaccurate
 * (development builds warn once).
 */
export function detCos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return x - x; // NaN, ±Infinity -> NaN
  _y[0] = x;
  _y[1] = 0;
  if (ix <= 0x3fe921fb) {
    // |x| ~<= pi/4
    kernelCos();
    return _k[1];
  }
  if (DEV && Math.abs(x) > DETMATH_RANGE) warnOutOfRange(x);
  switch (remPio2()) {
    case 0:
      kernelCos();
      return _k[1];
    case 1:
      kernelSin(1);
      return -_k[0];
    case 2:
      kernelCos();
      return -_k[1];
    default:
      kernelSin(1);
      return _k[0];
  }
}

/**
 * Sine and cosine of x from one range reduction, written into `out` and
 * returned. Bit for bit `out.s === detSin(x)` and `out.c === detCos(x)`;
 * allocates nothing, so a module-scope `out` can be reused per call.
 *
 * ```ts
 * const sc: SinCos = { s: 0, c: 0 };
 * detSinCos(angle, sc);
 * v.x = sc.c * speed;
 * v.z = sc.s * speed;
 * ```
 */
export function detSinCos(x: number, out: SinCos): SinCos {
  const ix = highWord(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) {
    // NaN, ±Infinity -> NaN
    out.s = out.c = x - x;
    return out;
  }
  _y[0] = x;
  _y[1] = 0;
  // |x| ~<= pi/4: the kernels on (x, 0), sin with iy = 0, in quadrant 0.
  let iy = 0;
  let quadrant = 0;
  if (ix > 0x3fe921fb) {
    if (DEV && Math.abs(x) > DETMATH_RANGE) warnOutOfRange(x);
    quadrant = remPio2();
    iy = 1;
  }
  kernelSin(iy);
  kernelCos();
  const s = _k[0];
  const c = _k[1];
  switch (quadrant) {
    case 0:
      out.s = s;
      out.c = c;
      break;
    case 1:
      out.s = c;
      out.c = -s;
      break;
    case 2:
      out.s = -s;
      out.c = -c;
      break;
    default:
      out.s = -c;
      out.c = s;
  }
  return out;
}
