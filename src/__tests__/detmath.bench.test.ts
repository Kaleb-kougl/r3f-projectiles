// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { gen } from '../patterns';
import { releaseSpawnData } from '../pool';
import { gen070 } from './fixtures/patterns070';

/**
 * Det math is not a speed regression (0.8.0, docs/detmath-plan.md "Proving it"
 * item 4): 100,000 `gen.arc(12, 2π, 3, 0, 0)` bursts take at most 1.5× as long
 * as the same bursts through 0.7.0's `Math.sin` / `Math.cos` generator
 * (`fixtures/patterns070.ts`).
 *
 * Bursts are per volley, never per frame, so the budget is generous; the point
 * is to catch a pathological slowdown (an accidental allocation per call, a
 * slow-path reduction for ordinary angles), not a few percent.
 *
 * Each burst's spawn data goes back to the pool right away, as the library's
 * own emitters do (`releaseSpawnData` once a burst is consumed), so both sides
 * run on a warm pool and neither pays the allocator. The two sides share that
 * pool and run interleaved (in 10,000-burst slices), five rounds of 100,000
 * each after a warm-up, and the assertion takes the median of the five
 * per-round ratios: machine speed
 * divides out, and one round hit by a GC or a noisy neighbour cannot decide it.
 */

const BURSTS = 100_000;
const WARMUP_BURSTS = 20_000;
const ROUNDS = 5;
const CHUNKS = 10;
const TAU = Math.PI * 2;

/**
 * Defeats dead-code elimination: a value read from every burst. An object
 * field, not a module `let`: V8 boxes a double stored in a module variable,
 * which would add an allocation per burst to both sides.
 */
const sink = { value: 0 };

// Two separate functions, not one taking the generator as an argument: each
// call site then sees one target and is optimized for it alone, as a real
// caller's would be.
function runDet(bursts: number): number {
  const t0 = performance.now();
  for (let i = 0; i < bursts; i++) {
    const spawns = gen.arc(12, TAU, 3, 0, 0);
    sink.value += spawns[i % 12].velocity.x;
    releaseSpawnData(spawns);
  }
  return performance.now() - t0;
}

function runOld(bursts: number): number {
  const t0 = performance.now();
  for (let i = 0; i < bursts; i++) {
    const spawns = gen070.arc(12, TAU, 3, 0, 0);
    sink.value += spawns[i % 12].velocity.x;
    releaseSpawnData(spawns);
  }
  return performance.now() - t0;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe('det math — burst cost vs 0.7.0', () => {
  it(`${BURSTS.toLocaleString('en-US')} gen.arc(12, 2π) bursts: within 1.5× of 0.7.0 (median of ${ROUNDS})`, () => {
    // Warm-up: tier both up in the JIT and fill the pool.
    for (let w = 0; w < 5; w++) {
      runDet(WARMUP_BURSTS);
      runOld(WARMUP_BURSTS);
    }

    // Each run of 100,000 bursts is taken in CHUNKS slices, the two sides
    // alternating slice by slice, so a burst of machine load lands on both.
    const tDet: number[] = [];
    const tOld: number[] = [];
    const slice = BURSTS / CHUNKS;
    for (let r = 0; r < ROUNDS; r++) {
      let d = 0;
      let o = 0;
      for (let c = 0; c < CHUNKS; c++) {
        // Alternate which side goes first, so neither always follows the other's garbage.
        if ((r + c) % 2 === 0) {
          d += runDet(slice);
          o += runOld(slice);
        } else {
          o += runOld(slice);
          d += runDet(slice);
        }
      }
      tDet.push(d);
      tOld.push(o);
    }

    // Each round's two totals are interleaved in time, so their ratio cancels
    // the load the machine was under then; the median of the five ratios is
    // the statistic asserted. The ratio of the two medians is printed alongside.
    const ratio = median(tDet.map((t, r) => t / tOld[r]));
    const fmt = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(', ');
    console.log(
      `[detmath bench] ${BURSTS} x gen.arc(12, 2π): 0.8.0 median ${median(tDet).toFixed(1)} ms ` +
        `[${fmt(tDet)}], 0.7.0 median ${median(tOld).toFixed(1)} ms [${fmt(tOld)}], ` +
        `median per-round ratio ${ratio.toFixed(3)} (ratio of medians ${(median(tDet) / median(tOld)).toFixed(3)})`,
    );
    expect(Number.isFinite(sink.value)).toBe(true);
    expect(ratio).toBeLessThanOrEqual(1.5);
  }, 120_000);
});
