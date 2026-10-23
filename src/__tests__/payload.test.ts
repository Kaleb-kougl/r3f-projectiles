import { describe, it, expect, vi, afterEach } from 'vitest';
import { definePayload } from '../payload';
import * as Root from '../index';
import * as Patterns from '../patterns';

/**
 * `definePayload` — bitfields over the single per-bullet payload integer.
 *
 * Pure functions, so no renderer: the bit math, the layout's stability, the
 * definition-time limits, and both halves of the range contract (a
 * `RangeError` in development, masking in production).
 */

const Shot = definePayload({ damage: 4, pierce: 3, faction: 2 });

// ===========================================================================
// 1. Layout
// ===========================================================================

describe('definePayload — layout', () => {
  it('reports total bits, field order and per-field max', () => {
    expect(Shot.bits).toBe(9);
    expect(Shot.fields).toEqual(['damage', 'pierce', 'faction']);
    expect(Shot.max('damage')).toBe(15);
    expect(Shot.max('pierce')).toBe(7);
    expect(Shot.max('faction')).toBe(3);
  });

  it('packs in declaration order, lowest bits first', () => {
    // damage → bits 0-3, pierce → bits 4-6, faction → bits 7-8.
    expect(Shot.pack({ damage: 1 })).toBe(0b000_000_0001);
    expect(Shot.pack({ pierce: 1 })).toBe(0b000_001_0000);
    expect(Shot.pack({ faction: 1 })).toBe(0b001_000_0000);
    expect(Shot.pack({ damage: 9, pierce: 5, faction: 2 })).toBe(9 | (5 << 4) | (2 << 7));
  });

  it('treats omitted fields as 0', () => {
    expect(Shot.pack({})).toBe(0);
    expect(Shot.get(Shot.pack({ pierce: 3 }), 'damage')).toBe(0);
  });

  it('round-trips every value of every field, independently of its neighbours', () => {
    for (let d = 0; d <= 15; d++) {
      for (let p = 0; p <= 7; p++) {
        for (let f = 0; f <= 3; f++) {
          const packed = Shot.pack({ damage: d, pierce: p, faction: f });
          expect(Shot.get(packed, 'damage')).toBe(d);
          expect(Shot.get(packed, 'pierce')).toBe(p);
          expect(Shot.get(packed, 'faction')).toBe(f);
        }
      }
    }
  });

  it('is stable: the same schema always produces the same integers', () => {
    const again = definePayload({ damage: 4, pierce: 3, faction: 2 });
    const v = { damage: 11, pierce: 6, faction: 3 };
    expect(again.pack(v)).toBe(Shot.pack(v));
  });
});

// ===========================================================================
// 2. with()
// ===========================================================================

describe('definePayload — with()', () => {
  it('returns a new integer with one field replaced and the others untouched', () => {
    const p = Shot.pack({ damage: 12, pierce: 2, faction: 1 });
    const q = Shot.with(p, 'pierce', 7);
    expect(Shot.get(q, 'pierce')).toBe(7);
    expect(Shot.get(q, 'damage')).toBe(12);
    expect(Shot.get(q, 'faction')).toBe(1);
    // `p` is a number, so of course it is unchanged — but the round trip back
    // must land on exactly the original integer.
    expect(Shot.with(q, 'pierce', 2)).toBe(p);
  });

  it('can count a field down to zero', () => {
    let p = Shot.pack({ damage: 5, pierce: 3 });
    for (let n = 3; n > 0; n--) p = Shot.with(p, 'pierce', Shot.get(p, 'pierce') - 1);
    expect(Shot.get(p, 'pierce')).toBe(0);
    expect(Shot.get(p, 'damage')).toBe(5);
  });
});

// ===========================================================================
// 3. The 31-bit ceiling
// ===========================================================================

describe('definePayload — 31 bits, all usable, all non-negative', () => {
  it('accepts exactly 31 bits and packs every one of them as a non-negative integer', () => {
    const Full = definePayload({ low: 1, mid: 15, high: 15 });
    expect(Full.bits).toBe(31);
    const all = Full.pack({ low: 1, mid: Full.max('mid'), high: Full.max('high') });
    expect(all).toBe(2 ** 31 - 1);
    expect(all).toBeGreaterThan(0);
    expect(Full.get(all, 'high')).toBe(2 ** 15 - 1);
  });

  it('handles a single 31-bit field — the width where `(1 << n) - 1` would go negative', () => {
    const Wide = definePayload({ id: 31 });
    expect(Wide.max('id')).toBe(2 ** 31 - 1);
    const p = Wide.pack({ id: 2 ** 31 - 1 });
    expect(p).toBe(2 ** 31 - 1);
    expect(Wide.get(p, 'id')).toBe(2 ** 31 - 1);
    expect(Wide.with(p, 'id', 5)).toBe(5);
  });

  it('gives every width 1 … 31 the mask `2 ** width - 1` exactly (the source avoids `**`)', () => {
    for (let width = 1; width <= 31; width++) {
      const expected = 2 ** width - 1;
      const L = definePayload({ low: width });
      expect(L.max('low')).toBe(expected);
      expect(L.pack({ low: expected })).toBe(expected);
      expect(L.get(expected, 'low')).toBe(expected);
      // The mask also bounds `get`: a set bit just above the field is dropped.
      if (width < 31) expect(L.get(expected + (expected + 1), 'low')).toBe(expected);
      // Same width at a shifted position: the mask is applied after the shift.
      if (width <= 30) {
        const S = definePayload({ pad: 1, f: width });
        expect(S.max('f')).toBe(expected);
        expect(S.get(S.pack({ f: expected }), 'f')).toBe(expected);
      }
    }
  });

  it('keeps bit 31 clear in with(), even on a payload this layout did not produce', () => {
    expect(Shot.with(-1, 'damage', 0)).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// 4. Definition-time errors
// ===========================================================================

describe('definePayload — definition-time errors', () => {
  it('throws when the widths total more than 31 bits', () => {
    expect(() => definePayload({ a: 16, b: 16 })).toThrow(RangeError);
    expect(() => definePayload({ a: 32 })).toThrow(/32 bits/);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('throws for a width of %s', (w) => {
    expect(() => definePayload({ a: w })).toThrow(RangeError);
  });

  it('throws for an empty schema', () => {
    expect(() => definePayload({})).toThrow(/no fields/);
  });

  it('throws for an integer-like field name, which JavaScript would reorder', () => {
    expect(() => definePayload({ hp: 3, 7: 2 })).toThrow(/integer-like/);
  });

  it('allows names that collide with Object.prototype members', () => {
    const P = definePayload({ toString: 2, constructor: 3 });
    expect(P.get(P.pack({ toString: 3, constructor: 5 }), 'constructor')).toBe(5);
  });
});

// ===========================================================================
// 5. Range handling — development
// ===========================================================================

describe('definePayload — out-of-range values throw in development', () => {
  it.each([
    ['negative', -1],
    ['over max', 16],
    ['fractional', 1.5],
    ['NaN', NaN],
  ])('pack rejects a %s value', (_label, v) => {
    expect(() => Shot.pack({ damage: v })).toThrow(RangeError);
  });

  it('with() rejects an out-of-range value — e.g. counting a pierce field below 0', () => {
    const p = Shot.pack({ pierce: 0 });
    expect(() => Shot.with(p, 'pierce', Shot.get(p, 'pierce') - 1)).toThrow(/0…7/);
    expect(() => Shot.with(p, 'pierce', 8)).toThrow(RangeError);
  });

  it('rejects a field the layout does not define — in pack, get, with and max', () => {
    // A typo'd key would otherwise pack silently as 0.
    expect(() => Shot.pack({ damgae: 3 } as never)).toThrow(/not in this layout/);
    expect(() => Shot.get(0, 'nope' as never)).toThrow(RangeError);
    expect(() => Shot.with(0, 'nope' as never, 1)).toThrow(RangeError);
    expect(() => Shot.max('nope' as never)).toThrow(RangeError);
  });

  it('ignores explicitly undefined values, like omitted ones', () => {
    expect(Shot.pack({ damage: undefined, pierce: 2 })).toBe(Shot.pack({ pierce: 2 }));
  });
});

// ===========================================================================
// 6. Range handling — production
// ===========================================================================

describe('definePayload — production masks instead of throwing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('wraps an overflow within its own field and never bleeds into a neighbour', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { definePayload: prodDefine } = await import('../payload');
    const P = prodDefine({ damage: 4, pierce: 3, faction: 2 });

    const p = P.pack({ damage: 17, pierce: 7, faction: 3 }); // 17 & 15 = 1
    expect(P.get(p, 'damage')).toBe(1);
    expect(P.get(p, 'pierce')).toBe(7);
    expect(P.get(p, 'faction')).toBe(3);

    const q = P.with(p, 'pierce', -1); // -1 & 7 = 7: wraps, does not touch damage
    expect(P.get(q, 'pierce')).toBe(7);
    expect(P.get(q, 'damage')).toBe(1);
    expect(P.get(q, 'faction')).toBe(3);
  });

  it('still throws at definition time — a bad schema is never a runtime value', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { definePayload: prodDefine } = await import('../payload');
    expect(() => prodDefine({ a: 20, b: 20 })).toThrow(RangeError);
  });
});

// ===========================================================================
// 7. Exports
// ===========================================================================

describe('definePayload — exports', () => {
  it('is exported from the package root and from the React-free /patterns entry', () => {
    expect(Root.definePayload).toBe(definePayload);
    expect(Patterns.definePayload).toBe(definePayload);
  });
});
