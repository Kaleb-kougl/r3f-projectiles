// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detSin, detCos, detSinCos, DETMATH_RANGE, type SinCos } from '../detmath';
import { createSeededRandom } from '../rng';
import * as Root from '../index';
import * as Patterns from '../patterns';
import * as Core from '../core/index';
import fixtures from './fixtures/sincos.json';
import {
  DETSINCOS_BEYOND_GOLDEN,
  DETSINCOS_GOLDEN,
  beyondRangeInputs,
  detSinCosBeyondGoldenHash,
  detSinCosGoldenHash,
} from './helpers/detmathGolden';

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

const _f64 = new Float64Array(1);
const _i64 = new BigInt64Array(_f64.buffer);
const _dv = new DataView(new ArrayBuffer(8));

/** A fixture's 16-hex-digit big-endian IEEE 754 bit pattern -> the double. */
function fromHex(hex: string): number {
  _dv.setBigUint64(0, BigInt('0x' + hex));
  return _dv.getFloat64(0);
}

/** A double's bit pattern as 16 hex digits (for failure messages). */
function toHex(x: number): string {
  _dv.setFloat64(0, x);
  return _dv.getBigUint64(0).toString(16).padStart(16, '0');
}

/**
 * The double's position on the number line counted in ulps: monotonic in the
 * value, consecutive doubles differ by 1, and +0 / -0 both map to 0.
 */
function ordinal(x: number): bigint {
  _f64[0] = x;
  const b = _i64[0];
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}

/** Distance between two finite doubles in ulps (doubles strictly between + 1). */
function ulpDistance(a: number, b: number): number {
  const d = ordinal(a) - ordinal(b);
  return Number(d < 0n ? -d : d);
}

const isNegZero = (x: number): boolean => x === 0 && 1 / x < 0;

// ---------------------------------------------------------------------------
// (a) Accuracy against the mpmath reference
// ---------------------------------------------------------------------------

interface Entry {
  x: string;
  sin: string;
  cos: string;
  xd: string;
}

const entries = (fixtures as { entries: Entry[] }).entries.map((e) => ({
  x: fromHex(e.x),
  sin: fromHex(e.sin),
  cos: fromHex(e.cos),
}));

// Measured at collection time so the maxima can go in the test names.
let maxSin = 0;
let maxCos = 0;
let worstSin = 0;
let worstCos = 0;
for (const e of entries) {
  const ds = ulpDistance(detSin(e.x), e.sin);
  const dc = ulpDistance(detCos(e.x), e.cos);
  if (ds > maxSin) [maxSin, worstSin] = [ds, e.x];
  if (dc > maxCos) [maxCos, worstCos] = [dc, e.x];
}
console.log(
  `[detmath] ${entries.length} fixtures: max error sin ${maxSin} ulp (x = ${worstSin}), ` +
    `cos ${maxCos} ulp (x = ${worstCos})`,
);

describe('detmath — accuracy against the correctly rounded reference', () => {
  it('the fixture file decodes to the inputs it was built from', () => {
    expect(entries.length).toBeGreaterThan(4000);
    expect(fixtures.count).toBe(entries.length);
    for (const e of (fixtures as { entries: Entry[] }).entries) {
      // xd is Python's repr: the shortest round-trip decimal, as JS's is.
      expect(toHex(Number(e.xd))).toBe(e.x);
    }
    for (const e of entries) expect(Math.abs(e.x)).toBeLessThanOrEqual(DETMATH_RANGE);
  });

  it(`detSin is within 1 ulp on every fixture (max observed: ${maxSin} ulp)`, () => {
    for (const e of entries) {
      const got = detSin(e.x);
      const d = ulpDistance(got, e.sin);
      if (d > 1) {
        throw new Error(`detSin(${e.x}) = ${got} [${toHex(got)}], ref ${e.sin} [${toHex(e.sin)}]: ${d} ulp`);
      }
    }
  });

  it(`detCos is within 1 ulp on every fixture (max observed: ${maxCos} ulp)`, () => {
    for (const e of entries) {
      const got = detCos(e.x);
      const d = ulpDistance(got, e.cos);
      if (d > 1) {
        throw new Error(`detCos(${e.x}) = ${got} [${toHex(got)}], ref ${e.cos} [${toHex(e.cos)}]: ${d} ulp`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Special values and the sign of zero
// ---------------------------------------------------------------------------

describe('detmath — special values', () => {
  it('NaN and ±Infinity give NaN', () => {
    const sc: SinCos = { s: 0, c: 0 };
    for (const x of [NaN, Infinity, -Infinity]) {
      expect(detSin(x)).toBeNaN();
      expect(detCos(x)).toBeNaN();
      detSinCos(x, sc);
      expect(sc.s).toBeNaN();
      expect(sc.c).toBeNaN();
    }
  });

  it('keeps the sign of zero: detSin(-0) is -0, detSin(0) is +0, detCos(±0) is 1', () => {
    expect(Object.is(detSin(0), 0)).toBe(true);
    expect(Object.is(detSin(-0), -0)).toBe(true);
    expect(detCos(0)).toBe(1);
    expect(detCos(-0)).toBe(1);
    const sc: SinCos = { s: 1, c: 0 };
    detSinCos(-0, sc);
    expect(isNegZero(sc.s)).toBe(true);
    expect(sc.c).toBe(1);
  });

  it('tiny inputs: sin(x) is x exactly, cos(x) is 1', () => {
    for (const x of [5e-324, 1e-300, 2.2250738585072014e-308, 7.450580596923827e-9]) {
      expect(detSin(x)).toBe(x);
      expect(Object.is(detSin(-x), -x)).toBe(true);
      expect(detCos(x)).toBe(1);
      expect(detCos(-x)).toBe(1);
    }
  });

  it('is odd / even bit for bit: sin(-x) === -sin(x), cos(-x) === cos(x)', () => {
    for (const e of entries) {
      expect(detSin(-e.x)).toBe(-detSin(e.x));
      expect(detCos(-e.x)).toBe(detCos(e.x));
    }
  });

  it('DETMATH_RANGE is the double nearest 2^19 * pi/2', () => {
    expect(toHex(DETMATH_RANGE)).toBe('412921fb54442d18');
    expect(DETMATH_RANGE).toBe(262144 * Math.PI); // a power-of-two scale is exact
  });
});

// ---------------------------------------------------------------------------
// (c) detSinCos is detSin / detCos, bit for bit
// ---------------------------------------------------------------------------

describe('detmath — detSinCos', () => {
  it('equals detSin / detCos bit for bit and returns `out`', () => {
    const sc: SinCos = { s: 0, c: 0 };
    const check = (x: number): void => {
      expect(detSinCos(x, sc)).toBe(sc);
      expect(Object.is(sc.s, detSin(x))).toBe(true);
      expect(Object.is(sc.c, detCos(x))).toBe(true);
    };
    for (const e of entries) check(e.x);
    const rng = createSeededRandom(7);
    for (let i = 0; i < 20000; i++) check((rng() * 2 - 1) * 1e3);
  });
});

// ---------------------------------------------------------------------------
// (d) Golden hash: any change in any bit fails
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a over the bytes of `detSinCos(x)` — `s` then `c`, each as its 8
 * IEEE 754 bytes in little-endian order — for 1,000,000 inputs
 * `x = (rng() * 2 - 1) * 1e4` from `createSeededRandom(1337)`. The loop lives in
 * `helpers/detmathGolden.ts` (vitest-free) so `npm run test:engines` runs the
 * same code in Chromium, Firefox and WebKit.
 */
function goldenHash(): number {
  return detSinCosGoldenHash({ detSinCos, createSeededRandom });
}

describe('detmath — golden hash', () => {
  it('1,000,000 seeded detSinCos results hash to the committed value', () => {
    // Produced once by running goldenHash() under Node 22.22 (V8) on the first
    // implementation (0.8.0 L1), after the 1-ulp fixture test passed; at that
    // point detSin / detCos also matched Node's own Math.sin / Math.cos (an
    // fdlibm port in Node's V8 build; Chromium's differs) bit for bit on every
    // fixture and on 1e6 random inputs.
    // It must be the same on every engine (L4's cross-engine run recomputes it
    // in Chromium, Firefox and WebKit). If it changes, the det math's bits
    // changed: that is a breaking change to every replay.
    expect(goldenHash()).toBe(GOLDEN);
  });

  it('the helper exports the same constant (what test:engines compares against)', () => {
    expect(DETSINCOS_GOLDEN).toBe(GOLDEN);
  });
});

/** See the test above: 0x7b8d985b. */
const GOLDEN = 2072877147;

/** detSinCos over `beyondRangeInputs()`: 0xeb1d515f. */
const BEYOND_GOLDEN = 3944567135;

// ---------------------------------------------------------------------------
// (e) Beyond the range: deterministic, warned once in development
// ---------------------------------------------------------------------------

describe('detmath — beyond DETMATH_RANGE', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const BEYOND = [
    fromHex('412921fb54442d19'), // the next double above DETMATH_RANGE
    1e6,
    -3e6,
    123456789.123,
    2684354560, // 1.25 * 2^31: n no longer fits an int32

    -1e15,
    1e300,
    -1.7976931348623157e308,
  ];

  it('gives the same bits for the same input, every time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const a = await import('../detmath');
    vi.resetModules();
    const b = await import('../detmath');
    expect(a.detSin).not.toBe(b.detSin); // two independent module instances
    const sc: SinCos = { s: 0, c: 0 };
    for (const x of BEYOND) {
      const s = a.detSin(x);
      const c = a.detCos(x);
      expect(Object.is(a.detSin(x), s)).toBe(true);
      expect(Object.is(a.detCos(x), c)).toBe(true);
      expect(Object.is(b.detSin(x), s)).toBe(true);
      expect(Object.is(b.detCos(x), c)).toBe(true);
      b.detSinCos(x, sc);
      expect(Object.is(sc.s, s)).toBe(true);
      expect(Object.is(sc.c, c)).toBe(true);
    }
  });

  it('just past the range is still close to Math.sin (error about |x| · 3.9e-17, not a cliff)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const x of [DETMATH_RANGE + 1, 1e6, -2e6]) {
      expect(Math.abs(detSin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(detCos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  // Every finite input beyond the range is reduced as `x % (2 * Math.PI)`
  // (exact in ECMAScript) before the in-range path runs.
  const TWO_PI_DOUBLE = 2 * Math.PI;
  const SWEEP: number[] = [
    ...BEYOND,
    2 ** 53,
    -(2 ** 53),
    2 ** 54,
    2 ** 60,
    -(2 ** 60),
    1e100,
    -1e100,
    1e300,
    -1e300,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    ...beyondRangeInputs(createSeededRandom),
  ];

  it('the sweep covers every binade past the range, up to ±MAX_VALUE', () => {
    expect(toHex(BEYOND[0])).toBe('412921fb54442d19');
    expect(beyondRangeInputs(createSeededRandom)[0]).toBe(BEYOND[0]);
    expect(SWEEP.length).toBeGreaterThan(10_000);
    for (const x of SWEEP) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Math.abs(x)).toBeGreaterThan(DETMATH_RANGE);
    }
    const exps = new Set(SWEEP.map((x) => parseInt(toHex(Math.abs(x)).slice(0, 3), 16)));
    for (let e = 1043; e <= 2046; e++) expect(exps.has(e), `biased exponent ${e}`).toBe(true);
  });

  it('is finite and in [-1, 1] for every finite input, with sin² + cos² within 1e-15 of 1', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sc: SinCos = { s: 0, c: 0 };
    for (const x of SWEEP) {
      const s = detSin(x);
      const c = detCos(x);
      detSinCos(x, sc);
      for (const v of [s, c, sc.s, sc.c]) {
        if (!(Number.isFinite(v) && Math.abs(v) <= 1)) throw new Error(`x = ${x}: ${v} out of [-1, 1]`);
      }
      expect(Math.abs(s * s + c * c - 1), `x = ${x}`).toBeLessThanOrEqual(1e-15);
      expect(Object.is(sc.s, s) && Object.is(sc.c, c), `detSinCos(${x})`).toBe(true);
    }
  });

  it('equals detSin / detCos of x % (2 * Math.PI) bit for bit', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toHex(TWO_PI_DOUBLE)).toBe('401921fb54442d18');
    for (const x of SWEEP) {
      const r = x % TWO_PI_DOUBLE;
      expect(Math.abs(r)).toBeLessThan(TWO_PI_DOUBLE);
      if (!Object.is(detSin(x), detSin(r)) || !Object.is(detCos(x), detCos(r))) {
        throw new Error(`x = ${x} [${toHex(x)}]: detSin ${detSin(x)} vs ${detSin(r)}, detCos ${detCos(x)} vs ${detCos(r)}`);
      }
    }
  });

  it(`the beyond-range golden: ${beyondRangeInputs(createSeededRandom).length} inputs hash to the committed value`, () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Produced under Node 22.22 when the `%` reduction went in (0.8.0 review
    // fix); `test:engines` recomputes it in Chromium, Firefox and WebKit.
    expect(detSinCosBeyondGoldenHash({ detSinCos, createSeededRandom })).toBe(BEYOND_GOLDEN);
    expect(DETSINCOS_BEYOND_GOLDEN).toBe(BEYOND_GOLDEN);
  });

  it('warns once in development, and not for in-range inputs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const m = await import('../detmath');
    m.detSin(DETMATH_RANGE);
    m.detCos(-DETMATH_RANGE);
    m.detSinCos(1e5, { s: 0, c: 0 });
    expect(warn).not.toHaveBeenCalled();
    m.detSin(1e6);
    m.detCos(-1e7);
    m.detSinCos(1e8, { s: 0, c: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/DETMATH_RANGE/);
  });

  it('is silent in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const m = await import('../detmath');
    m.detSin(1e6);
    m.detCos(1e7);
    m.detSinCos(1e8, { s: 0, c: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

describe('detmath — exports', () => {
  it('is the same module on the root, /patterns and /core entries', () => {
    for (const m of [Root, Patterns, Core]) {
      expect(m.detSin).toBe(detSin);
      expect(m.detCos).toBe(detCos);
      expect(m.detSinCos).toBe(detSinCos);
      expect(m.DETMATH_RANGE).toBe(DETMATH_RANGE);
    }
  });
});

// ---------------------------------------------------------------------------
// The source: constants as committed, nothing imported, no Math trig
// ---------------------------------------------------------------------------

describe('detmath — source', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async function source(): Promise<string> {
    const [fs, url] = await Promise.all([load('node:fs'), load('node:url')]);
    return fs.readFileSync(url.fileURLToPath(new URL('../detmath.ts', import.meta.url)), 'utf8');
  }

  it('every constant literal has exactly the bits its fdlibm comment gives', async () => {
    const src = await source();
    const re = /=\s*(-?[0-9.]+(?:e-?[0-9]+)?)\s*;\s*\/\/\s*0x([0-9A-F]{8}),\s*0x([0-9A-F]{8})/g;
    const found = [...src.matchAll(re)];
    // DETMATH_RANGE, TWO_PI_DOUBLE, invpio2, six pio2 parts, S1..S6, C1..C6
    expect(found.length).toBe(21);
    for (const [, literal, hi, lo] of found) {
      expect(toHex(Number(literal)), literal).toBe((hi + lo).toLowerCase());
    }
    // the inline 2^-27 threshold
    expect(src).toContain('7.450580596923828e-9 /* 2^-27: 0x3E400000, 0x00000000 */');
    expect(toHex(7.450580596923828e-9)).toBe('3e40000000000000');
  });

  it('imports nothing and calls no implementation-approximated Math function', async () => {
    const code = (await source()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(code).not.toMatch(
      /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b/,
    );
    expect(code).not.toMatch(/\*\*/);
    // NaN out is the `NaN` literal, never an arithmetic NaN such as `x - x`
    // (whose sign / payload bits are engine- and CPU-dependent).
    expect(code).not.toMatch(/\b(\w+)\s*-\s*\1\b/);
  });

  it('keeps the fdlibm notice as a legal comment (`/*!`), so the build keeps it', async () => {
    const src = await source();
    expect(src).toMatch(/\/\*![\s\S]*Copyright \(C\) 1993 by Sun Microsystems, Inc\.[\s\S]*?\*\//);
  });
});
