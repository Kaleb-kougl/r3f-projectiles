import { describe, it, expect } from 'vitest';
import { EASING, resolveEasing, fadeScale } from '../easing';
import type { EasingName } from '../easing';

const NAMES = Object.keys(EASING) as EasingName[];

describe('EASING presets', () => {
  it.each(NAMES)('%s pins both endpoints', (name) => {
    expect(EASING[name](0)).toBeCloseTo(0, 10);
    expect(EASING[name](1)).toBeCloseTo(1, 10);
  });

  it.each(NAMES)('%s is monotonic non-decreasing across [0, 1]', (name) => {
    const f = EASING[name];
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it.each(NAMES)('%s stays within [0, 1] and finite', (name) => {
    const f = EASING[name];
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('easeIn fades later than linear, easeOut fades earlier', () => {
    // at the midpoint of the fade: easeIn has faded less, easeOut more
    expect(EASING.easeInCubic(0.5)).toBeLessThan(EASING.linear(0.5));
    expect(EASING.easeOutCubic(0.5)).toBeGreaterThan(EASING.linear(0.5));
  });
});

describe('resolveEasing', () => {
  it('resolves every built-in name', () => {
    for (const n of NAMES) expect(resolveEasing(n)).toBe(EASING[n]);
  });

  it('passes a custom function straight through', () => {
    const custom = (p: number) => p;
    expect(resolveEasing(custom)).toBe(custom);
  });

  it('throws on an unknown name, like resolvePattern does', () => {
    // @ts-expect-error — deliberately invalid at the type level
    expect(() => resolveEasing('bogus')).toThrow(/Unknown easing "bogus"/);
    // @ts-expect-error — deliberately invalid at the type level
    expect(() => resolveEasing('bogus')).toThrow(/Valid names:/);
  });
});

describe('fadeScale', () => {
  const linear = EASING.linear;

  it('is EXACTLY the pre-props behaviour at the defaults', () => {
    // The old hardcoded line was `Math.min(b.life, 1.0)`. This is the regression
    // guard for every existing consumer.
    for (let life = 0; life <= 5; life += 0.01) {
      expect(fadeScale(life, 1, linear)).toBeCloseTo(Math.min(life, 1.0), 12);
    }
  });

  it('disables fading at fadeTime <= 0', () => {
    for (const ft of [0, -1, NaN]) {
      expect(fadeScale(0.01, ft, linear)).toBe(1);
      expect(fadeScale(99, ft, linear)).toBe(1);
    }
  });

  it('is full size until the fade window opens', () => {
    expect(fadeScale(5, 0.5, linear)).toBe(1);
    expect(fadeScale(0.5, 0.5, linear)).toBe(1); // boundary: fade has not begun
    expect(fadeScale(0.49, 0.5, linear)).toBeLessThan(1);
  });

  it('reaches zero at end of life', () => {
    expect(fadeScale(0, 0.5, linear)).toBeCloseTo(0, 12);
  });

  it('scales the window with fadeTime', () => {
    // half-way through the fade is 0.5 regardless of how long the fade is
    expect(fadeScale(0.25, 0.5, linear)).toBeCloseTo(0.5, 12);
    expect(fadeScale(1.0, 2.0, linear)).toBeCloseTo(0.5, 12);
  });

  it('honours the curve shape', () => {
    // easeIn fades late → still large at the fade midpoint
    const easeIn = fadeScale(0.5, 1, EASING.easeInCubic);
    const lin = fadeScale(0.5, 1, linear);
    const easeOut = fadeScale(0.5, 1, EASING.easeOutCubic);
    expect(easeIn).toBeGreaterThan(lin);
    expect(easeOut).toBeLessThan(lin);
  });

  it('clamps a negative result to 0 but preserves overshoot above 1', () => {
    expect(fadeScale(0.5, 1, () => 2)).toBe(0); // would be -1
    expect(fadeScale(0.5, 1, () => -0.5)).toBeCloseTo(1.5, 12); // a deliberate "pop"
  });

  it('falls back to full size on a non-finite curve', () => {
    expect(fadeScale(0.5, 1, () => NaN)).toBe(1);
    expect(fadeScale(0.5, 1, () => Infinity)).toBe(1);
  });
});
