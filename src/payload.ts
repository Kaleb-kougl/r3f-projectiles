import { DEV } from './dev';

// ---------------------------------------------------------------------------
// Payload bitfields
// ---------------------------------------------------------------------------

/**
 * Field name → bit width. Declaration order is bit order: the first field
 * occupies the lowest bits.
 *
 * @example `{ damage: 8, pierce: 3, faction: 2 }` — 13 bits in all.
 */
export type PayloadSchema = Readonly<Record<string, number>>;

/** The fields of a {@link PayloadSchema}, as the value object `pack` reads. */
export type PayloadValues<S extends PayloadSchema> = {
  readonly [K in keyof S]?: number;
};

/**
 * A fixed bit layout over the single integer each bullet carries as its
 * `payload` — see {@link definePayload}.
 *
 * Every method is a handful of integer operations on precomputed shifts and
 * masks. None allocates, so `get` and `with` are safe inside a
 * `forEachActive` callback at any bullet count.
 */
export interface PayloadLayout<S extends PayloadSchema> {
  /** Total bits the layout occupies. Always in `1 … 31`. */
  readonly bits: number;
  /** Field names in bit order, lowest bits first. */
  readonly fields: readonly (keyof S & string)[];
  /** Largest value `field` can hold: `2 ** width - 1`. */
  max(field: keyof S & string): number;
  /**
   * Pack named values into one payload integer. Omitted fields are `0`.
   *
   * Reads `values` and keeps nothing, so a single object can be reused. It is
   * meant for pattern-build time — `mod.payload(Shot.pack({ … }))` — rather
   * than per bullet, because the object literal at the call site is an
   * allocation of the caller's.
   *
   * **Out-of-range values** — anything that is not an integer in
   * `0 … max(field)` — throw a `RangeError` in development builds, as does a
   * key the layout does not define. In production nothing is checked and each
   * value is masked to its field's width: an overflow wraps within its own
   * field and can never bleed into a neighbour's bits.
   */
  pack(values: PayloadValues<S>): number;
  /** Read one field out of a payload. Pure; never allocates. */
  get(payload: number, field: keyof S & string): number;
  /**
   * A copy of `payload` with `field` replaced by `value` — a new integer; the
   * payload you passed is a number and is not changed. Range handling is
   * exactly `pack`'s: a `RangeError` in development, masked in production.
   *
   * A bullet's stored payload changes only if you write the result back, with
   * the field handle's `setPayload(index, payload)`.
   */
  with(payload: number, field: keyof S & string, value: number): number;
}

/** Hard ceiling on a layout's total width — see {@link definePayload}. */
const MAX_BITS = 31;

/** `2 ** 31 - 1` — every bit a layout can own. */
const MAX_PAYLOAD = 0x7fffffff;

/**
 * Define a bit layout for the per-bullet `payload` integer.
 *
 * The library carries a bullet's payload but never interprets it, and keeps it
 * a single number so pooling stays allocation-free. This is the zero-allocation
 * way to put several small fields in that one number without hand-writing
 * shifts and masks:
 *
 * ```ts
 * const Shot = definePayload({ damage: 8, pierce: 3, faction: 2 });
 *
 * Shot.pack({ damage: 12, pierce: 2, faction: 1 }); // → one integer
 * Shot.get(payload, 'damage');                       // → 12
 * Shot.with(payload, 'pierce', 1);                   // → a new integer
 * Shot.max('pierce');                                // → 7
 * ```
 *
 * ## Layout
 * Fields are packed **in declaration order, lowest bits first**, and the
 * layout is fixed at definition, so the same schema always produces the same
 * integers — safe to record in a replay or send over the wire, provided both
 * ends define the schema identically. Reordering or resizing fields changes
 * every packed value.
 *
 * ## Why 31 bits, not 32
 * A payload is a JavaScript number, and the operators that make bitfields
 * cheap (`<<`, `&`, `|`) work in signed 32-bit. Keeping bit 31 clear means
 * every packed payload is a **non-negative** integer, so it survives being
 * compared, sorted, logged or stored as a plain number with no sign surprises.
 *
 * @throws `RangeError` at definition time if the schema has no fields, a width
 * is not a positive integer, the widths total more than 31 bits, or a field
 * name is an integer-like string such as `"0"` (JavaScript orders those keys
 * numerically ahead of every other key, which would silently move that field
 * to the bottom of the layout).
 */
export function definePayload<const S extends PayloadSchema>(
  schema: S,
): PayloadLayout<S> {
  type F = keyof S & string;

  const names = Object.keys(schema) as F[];
  if (names.length === 0) {
    throw new RangeError('[r3f-projectiles] definePayload: the schema has no fields.');
  }

  // Lookups keyed by field name. Prototype-less, so a field called
  // `toString` or `constructor` resolves to its own entry and an unknown name
  // resolves to `undefined` rather than to something inherited.
  const shifts: Record<string, number> = Object.create(null);
  const masks: Record<string, number> = Object.create(null);

  let bits = 0;
  for (const name of names) {
    if (/^(0|[1-9]\d*)$/.test(name)) {
      throw new RangeError(
        `[r3f-projectiles] definePayload: field name "${name}" is integer-like. ` +
          'JavaScript orders such keys ahead of all others, which would silently ' +
          'reorder the layout — use a non-numeric name.',
      );
    }
    const width = schema[name];
    if (!Number.isInteger(width) || width <= 0) {
      throw new RangeError(
        `[r3f-projectiles] definePayload: field "${name}" has width ${String(width)}; ` +
          'widths must be positive integers.',
      );
    }
    shifts[name] = bits;
    // `2 ** width - 1`, written as exact integer ops (the det-math lint bans
    // `**`): the shift form is exact for widths 1 … 30 but goes negative at
    // 31, so 31 takes the 31-bit constant. A wider field never gets a usable
    // mask: the total-bits check below rejects its layout.
    masks[name] = width >= MAX_BITS ? MAX_PAYLOAD : (1 << width) - 1;
    bits += width;
  }
  if (bits > MAX_BITS) {
    throw new RangeError(
      `[r3f-projectiles] definePayload: fields total ${bits} bits; a payload holds ` +
        `at most ${MAX_BITS}.`,
    );
  }

  /** Dev-only: reject a name the layout does not define. */
  const checkField = (field: string): void => {
    if (masks[field] === undefined) {
      throw new RangeError(
        `[r3f-projectiles] payload field "${field}" is not in this layout ` +
          `(${names.join(', ')}).`,
      );
    }
  };

  /** Dev-only: reject a value that does not fit its field. */
  const checkValue = (field: string, value: number): void => {
    checkField(field);
    const max = masks[field];
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(
        `[r3f-projectiles] payload field "${field}" holds integers 0…${max}; ` +
          `got ${String(value)}.`,
      );
    }
  };

  const layout: PayloadLayout<S> = {
    bits,
    fields: Object.freeze(names.slice()),

    max(field) {
      if (DEV) checkField(field);
      return masks[field];
    },

    pack(values) {
      if (DEV) {
        for (const key in values) {
          if (values[key] !== undefined) checkValue(key, values[key] as number);
        }
      }
      let out = 0;
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const v = values[name];
        if (v === undefined) continue;
        out |= (v & masks[name]) << shifts[name];
      }
      return out;
    },

    get(payload, field) {
      if (DEV) checkField(field);
      return (payload >>> shifts[field]) & masks[field];
    },

    with(payload, field, value) {
      if (DEV) checkValue(field, value);
      const shift = shifts[field];
      const mask = masks[field];
      // `& MAX_PAYLOAD` keeps bit 31 clear even when handed a payload that was
      // not produced by this layout.
      return (
        ((payload & ~(mask << shift)) | ((value & mask) << shift)) & MAX_PAYLOAD
      );
    },
  };

  return Object.freeze(layout);
}
