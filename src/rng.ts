// ---------------------------------------------------------------------------
// Seeded random numbers — for deterministic patterns
// ---------------------------------------------------------------------------

/**
 * A seeded pseudo-random generator: returns a function that yields the same
 * sequence of numbers in `[0, 1)` every time it is created with the same
 * `seed` — the drop-in replacement for `Math.random` that `gen.galaxy` and
 * `gen.rose3D` accept as their `rng` argument.
 *
 * The algorithm is mulberry32: 32 bits of state, a period of 2³², and nothing
 * but 32-bit integer arithmetic (`Math.imul`, shifts, xor) followed by one
 * exact division by 2³². Every one of those operations is exactly specified by
 * ECMAScript, so — unlike anything built on `Math.sin` — the sequence is
 * **bit-identical on every engine and platform**, not just within one build.
 * It is a fast statistical generator for gameplay variety, not a source of
 * secrets: never use it for anything cryptographic.
 *
 * The state lives in the returned closure, so each call to this function is
 * an independent stream. Create one per stream you need to replay (one per
 * boss, say, seeded from your match seed), and advance it only from your fixed
 * simulation step — a stream that is also read from a render-rate callback is
 * consumed a frame-rate-dependent number of times and stops being replayable.
 *
 * ```ts
 * const rng = createSeededRandom(matchSeed);
 * const pattern = () => compose(gen.galaxy(120, 4, 3, 2, rng), mod.color(0x6666ff));
 * sim.fireAt(bossPos, pattern, bossId); // same bullets on every replay
 * ```
 *
 * @param seed - Any number; it is reduced to an unsigned 32-bit integer
 * (`seed >>> 0`), so `1` and `2 ** 32 + 1` name the same stream.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
