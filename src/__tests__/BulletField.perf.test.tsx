import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Matrix4, Vector3, type InstancedMesh } from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
} from '../BulletField';
import { acquire } from '../pool';
import { bulletGeometry } from '../render/geometry';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * `<BulletField>` — the perf-sanity criterion from the Testing section, in
 * tree at last. Phase 2 measured both halves in a throwaway harness (a
 * 1000-bullet burst into a 19,000/20,000-full pool at 0.38 ms) and then deleted
 * it, so the two claims the sparse set exists to make have never been guarded:
 *
 *  - **a burst into a near-full pool is O(burst), not O(burst × maxBullets)** —
 *    the spawn scan the design calls a hard prerequisite;
 *  - **a frame with ~10 active bullets in a 2000-slot pool does not touch 2000
 *    slots** — the O(active) frame loop, `forEachActive`, `activeCount` and
 *    `clear()` that the same structure buys.
 *
 * CPU-side only, exactly as the doc scopes it: nothing here asserts the GPU
 * rows (`mesh.count`, update ranges, the color-dirty flag).
 *
 * ## How these are measured, and why not with a stopwatch
 * A wall-clock budget is a promise about the machine, not about the code, and
 * it is the standard way a perf test becomes a flaky test. So the two claims
 * are put on the most boring footing that can still see the failure:
 *
 *  1. **Counted work, wherever the work is a write.** Every slot the field
 *     touches goes through `mesh.setMatrixAt`, so a spy on it counts touched
 *     slots exactly, with no clock involved. Holding the live set fixed and
 *     growing `maxBullets` by 16× must not move that count at all — which is
 *     the whole of the O(active)/O(burst) claim for every path that writes.
 *  2. **A ratio, for the one dimension that is invisible to a counter.** The
 *     pre-sparse-set spawn cost was a *read* scan (`bullets[i].active` from 0
 *     for each bullet of the burst), and a read leaves no trace to count. That
 *     one is timed — but as small-pool cost versus big-pool cost, with the
 *     burst held constant and the two measurements interleaved, so machine
 *     speed divides out and only the scaling remains. Transient load does
 *     **not** divide out of a summed ratio, which is exactly what used to make
 *     this test flaky; the comparison is between the *fastest* round on each
 *     side instead. Both the statistic and the margin are argued at the
 *     assertion.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Motionless, effectively immortal bullets — the live set never moves on its own. */
function burstOf(n: number, payload = 1): PatternFactory {
  const specs = Array.from({ length: n }, () => payload);
  return () =>
    specs.map((p): BulletSpawnData => {
      const d = acquire();
      d.offset.set(0, 0, 0);
      d.velocity.set(0, 0, 0);
      d.acceleration.set(0, 0, 0);
      d.delay = 0;
      d.life = 1000;
      d.color = null;
      d.payload = p;
      d.scale = 1;
      return d;
    });
}

const FIELD: Omit<BulletFieldProps, 'children'> = {
  maxBullets: 2000,
  boundsLimit: 25,
  bulletRadius: 0.12,
  fadeTime: 0,
  fadeCurve: 'linear',
  paused: false,
  reducedMotion: false,
};

const DT = 0.1; // must stay ≤ 0.1: the frame loop clamps to Math.min(delta, 0.1)
const ORIGIN = new Vector3(0, 0, 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

/** A bare field with no emitters: every spawn in this file is imperative. */
async function mountBareField(maxBullets: number): Promise<{
  renderer: Renderer;
  field: () => BulletFieldHandle;
}> {
  let ref: React.RefObject<BulletFieldHandle | null> | null = null;
  const Wrapper = () => {
    const r = useRef<BulletFieldHandle | null>(null);
    ref = r;
    return <BulletField ref={r} {...FIELD} maxBullets={maxBullets} />;
  };
  const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
  return { renderer, field: () => ref!.current! };
}

/**
 * Record every slot index the field writes a matrix to, until the returned
 * `stop()` is called. This is the counter the whole first half of the file
 * rests on: one call per slot touched, no sampling, no clock.
 */
function recordTouchedSlots(mesh: InstancedMesh): {
  slots: number[];
  stop: () => void;
} {
  const slots: number[] = [];
  const original = mesh.setMatrixAt.bind(mesh);
  const patched = (index: number, matrix: Matrix4) => {
    slots.push(index);
    original(index, matrix);
  };
  (mesh as unknown as { setMatrixAt: typeof patched }).setMatrixAt = patched;
  return {
    slots,
    stop: () => {
      (mesh as unknown as { setMatrixAt: typeof original }).setMatrixAt = original;
    },
  };
}

/** Fill `n` slots, so the pool under test is genuinely near-full. */
async function fill(field: BulletFieldHandle, n: number): Promise<void> {
  const pattern = burstOf(n, 99);
  await ReactThreeTestRenderer.act(async () => {
    field.fireAt(ORIGIN, pattern, 1);
  });
}

// ===========================================================================
// 1. The frame loop is O(active), not O(maxBullets)
// ===========================================================================

describe('BulletField — a frame does not touch the whole pool', () => {
  it('touches 10 slots for 10 active bullets in a 2000-slot pool', async () => {
    const { renderer, field } = await mountBareField(2000);
    await fill(field(), 10);

    const mesh = meshOf(renderer);
    const rec = recordTouchedSlots(mesh);
    await renderer.advanceFrames(1, DT);
    rec.stop();

    // The literal criterion: 10 bullets, 2000 slots, and the frame visited ten
    // of them. The pre-sparse-set loop ran `for (i = 0; i < maxBullets; i++)`
    // and wrote a matrix for every live slot it found along the way — same
    // writes, 200× the walk — so the count below is the part that can be seen
    // from outside, and the walk is pinned by the same-count-at-16×-capacity
    // test that follows.
    expect(field().activeCount).toBe(10);
    expect(rec.slots).toHaveLength(10);
    expect(new Set(rec.slots).size).toBe(10); // each live bullet exactly once
    expect(rec.slots.length).toBeLessThan(2000);
  });

  it('touches the SAME 10 slots when the pool is 16× larger', async () => {
    // Capacity is the independent variable and the live set is held fixed, so
    // any per-slot work in the frame path shows up as a difference here and
    // machine speed never enters the comparison.
    const small = await mountBareField(2000);
    const big = await mountBareField(32000);
    await fill(small.field(), 10);
    await fill(big.field(), 10);

    const smallRec = recordTouchedSlots(meshOf(small.renderer));
    const bigRec = recordTouchedSlots(meshOf(big.renderer));
    await small.renderer.advanceFrames(3, DT);
    await big.renderer.advanceFrames(3, DT);
    smallRec.stop();
    bigRec.stop();

    // Three frames, ten bullets: thirty touches, at both capacities.
    expect(smallRec.slots).toHaveLength(30);
    expect(bigRec.slots).toHaveLength(smallRec.slots.length);
  });

  it('walks only the live set in forEachActive, activeCount and clear()', async () => {
    // The other three O(active) reads from the design's CPU table. A walk that
    // was still O(maxBullets) would visit — and, in `clear()`'s case, write —
    // slots that hold nothing.
    const { renderer, field } = await mountBareField(32000);
    await fill(field(), 12);

    let visited = 0;
    field().forEachActive(() => {
      visited++;
    });
    expect(visited).toBe(12);
    expect(field().activeCount).toBe(12);
    expect(field().activeCountFor(1)).toBe(12);

    const rec = recordTouchedSlots(meshOf(renderer));
    await ReactThreeTestRenderer.act(async () => {
      field().clear();
    });
    rec.stop();

    // Twelve hide-writes, not 32,000. (Phase 2's debt note: `clear()` no longer
    // rewrites free slots' matrices, only live ones.)
    expect(rec.slots).toHaveLength(12);
    expect(field().activeCount).toBe(0);
  });
});

// ===========================================================================
// 2. A burst into a near-full pool is O(burst), not O(burst × maxBullets)
// ===========================================================================

describe('BulletField — a burst into a near-full pool is O(burst)', () => {
  it('writes exactly `burst` slots regardless of how large the pool is', async () => {
    const BURST = 100;
    const small = await mountBareField(2000);
    const big = await mountBareField(32000);
    await fill(small.field(), 2000 - BURST); // near-full…
    await fill(big.field(), 32000 - BURST); // …at both capacities

    const smallRec = recordTouchedSlots(meshOf(small.renderer));
    const bigRec = recordTouchedSlots(meshOf(big.renderer));
    await ReactThreeTestRenderer.act(async () => {
      small.field().fireAt(ORIGIN, burstOf(BURST, 7), 2);
      big.field().fireAt(ORIGIN, burstOf(BURST, 7), 2);
    });
    smallRec.stop();
    bigRec.stop();

    expect(smallRec.slots).toHaveLength(BURST);
    expect(bigRec.slots).toHaveLength(BURST);
    expect(small.field().activeCountFor(2)).toBe(BURST);
    expect(big.field().activeCountFor(2)).toBe(BURST);
    // Both pools are now exactly full, which is what "near-full" was for: the
    // burst had to be served from the last free slots, not from open space.
    expect(small.field().activeCount).toBe(2000);
    expect(big.field().activeCount).toBe(32000);
  });

  it('costs no more at 64× the capacity — the free stack, not a scan from zero', async () => {
    // The one claim in this file a counter cannot make. Slot acquisition used
    // to be `for (i = 0; i < maxBullets; i++) if (!bullets[i].active)`, restarted
    // from zero for every bullet of the burst: reads only, so nothing observable
    // is written, and only the clock can tell the two implementations apart.
    //
    // The measurement is therefore a RATIO with the burst held constant, taken
    // from two live fields alternately so that whatever the machine is doing at
    // the time hits both sides equally:
    //
    //   O(burst)              → cost(32000) ≈ cost(500)          ratio ≈ 1
    //   O(burst × maxBullets) → cost(32000) ≈ 64 × cost(500)     ratio ≈ 64
    //
    // ---- the statistic: FASTEST round, not total ------------------------
    // This used to compare the SUM of 40 rounds per side, and that is what made
    // it flaky. One round is ~19 µs of real work, so the whole 40-round total is
    // under a millisecond — while a single scheduler preemption or GC pause on a
    // loaded box is 10–150 ms. That is not a proportional slowdown that divides
    // out of a ratio; it is one discrete event landing on one side, worth 500×
    // the entire measurement it lands in.
    //
    // Measured, rather than argued: 24 runs of this file under a 12-way CPU load
    // generator with six concurrent vitest processes gave sum-ratios spanning
    // **0.093 – 55.2** — the low ones being the same stall landing on the small
    // side instead, where a one-sided bound cannot see it — and one outright
    // failure. Across those same 24 runs the ratio of the FASTEST round on each
    // side spanned **0.82 – 0.99**.
    //
    // The minimum is the right statistic here for the reason it usually is in
    // microbenchmarks: noise is strictly additive and one-directional, so the
    // fastest of 40 rounds is the closest thing to the stall-free cost, and it
    // takes all 40 rounds being stalled to corrupt it. A genuinely slower box
    // still scales both sides together and still divides out.
    //
    // ---- the margin, measured rather than guessed -----------------------
    // Observed on the current implementation: **0.95 – 1.00** over eight
    // unloaded runs, and **0.82 – 0.99** over the 24 loaded ones above. The
    // true per-round cost is the same at both capacities, which is the claim,
    // and it does not drift under load.
    //
    // Observed with the old scan injected into `acquireSlot` (cost only, no
    // behaviour change): **46.7** — 2.50 ms against 0.054 ms — and this
    // assertion was the *only* one in the whole suite that reddened.
    //
    // The bound stays 10: ~10× above the worst clean run and ~4.7× below the
    // broken one, with the failure it guards two orders of magnitude away in
    // absolute terms (19 µs of work per round becomes 2.5 ms).
    const SMALL = 500;
    const BIG = 32000; // 64× the capacity, identical burst
    const BURST = 100;
    const ROUNDS = 40;
    const WARMUP = 5;

    const small = await mountBareField(SMALL);
    const big = await mountBareField(BIG);
    await fill(small.field(), SMALL - BURST);
    await fill(big.field(), BIG - BURST);

    const pattern = burstOf(BURST, 7);

    /** One burst into a pool with exactly `BURST` slots left, timed alone. */
    const round = (handle: BulletFieldHandle): number => {
      const t0 = performance.now();
      handle.fireAt(ORIGIN, pattern, 2);
      const dt = performance.now() - t0;
      handle.clear(2); // restore the near-full state — deliberately untimed
      return dt;
    };

    for (let i = 0; i < WARMUP; i++) {
      round(small.field());
      round(big.field());
    }

    // Fastest round per side, tracked as we go — no arrays, no sorting, nothing
    // between the two clock reads that the other side does not also pay.
    let tSmall = Infinity;
    let tBig = Infinity;
    for (let i = 0; i < ROUNDS; i++) {
      const s = round(small.field());
      const b = round(big.field());
      if (s < tSmall) tSmall = s;
      if (b < tBig) tBig = b;
    }

    // A guard on the measurement itself: if the small side did not resolve on
    // the clock at all, the ratio below would be meaningless rather than green.
    expect(tSmall).toBeGreaterThan(0);
    expect(tBig).toBeLessThan(tSmall * 10);
  }, 30_000);
});

// ===========================================================================
// 3. orient='velocity' and 'camera' cost a bounded multiple of 'none'
// ===========================================================================

describe('BulletField — orientation stays within a sane per-frame budget', () => {
  // ---- What is measured ---------------------------------------------------
  // One whole frame — `advanceFrames(1)` over 2,000 live, moving bullets —
  // with `orient` the only difference between the two fields. That includes
  // the test renderer's own per-frame overhead, which is identical on both
  // sides and so only ever pulls the ratio toward 1: the bound below is a
  // ceiling on what orientation ADDS, not a microbenchmark of it.
  //
  // ---- Statistic and margin -------------------------------------------------
  // The same discipline as the O(burst) test above, for the same reasons: the
  // two fields are measured alternately so machine load hits both, and the
  // FASTEST round per side is compared, because scheduler and GC noise is
  // additive and one-directional.
  //
  // Measured on the current implementation, 2,000 bullets, fastest of 30:
  //
  //   unloaded, 8 runs:   none 0.07 – 0.09 ms/frame (renderer overhead
  //                       included); velocity / none 1.64 – 1.70;
  //                       camera / none 1.11 – 1.22
  //   2 CPUs saturated by spinners + 3 concurrent vitest processes, 3 runs:
  //                       velocity / none 1.56 – 1.68; camera / none 1.20 – 1.22
  //
  // So 'velocity' adds roughly 25 ns per bullet — a handful of multiplies,
  // four square roots on scalars, and a 3-float heading store — and 'camera'
  // adds almost nothing, because the camera's rotation is read once per frame,
  // not per bullet. Neither allocates (pinned by
  // `BulletField.render.alloc.test.tsx`).
  //
  // The bound is 2.5×: ~1.5× above the worst observed run. Observed with the
  // obvious mistake injected — camera mode calling `getWorldQuaternion` per
  // bullet instead of once per frame — **3.39×**, and the camera assertion
  // reddens. Per-bullet allocation is not this test's job; the alloc test
  // counts constructions directly.
  const N = 2000;
  const ROUNDS = 30;
  const WARMUP = 5;

  /** 2,000 slow, immortal bullets fanned around the XZ plane. */
  const fan: PatternFactory = () => {
    const out: BulletSpawnData[] = [];
    for (let k = 0; k < N; k++) {
      const d = acquire();
      const a = (k / N) * Math.PI * 2;
      d.offset.set(0, 0, 0);
      d.velocity.set(Math.cos(a) * 0.05, (k % 7) * 0.001, Math.sin(a) * 0.05);
      d.acceleration.set(0, 0, 0);
      d.delay = 0;
      d.life = 1e6;
      d.color = null;
      d.payload = k;
      d.scale = 1;
      out.push(d);
    }
    return out;
  };

  async function mountOriented(
    orient: NonNullable<BulletFieldProps['orient']>,
    extra: Partial<BulletFieldProps> = {},
  ): Promise<{ renderer: Renderer; field: () => BulletFieldHandle }> {
    let ref: React.RefObject<BulletFieldHandle | null> | null = null;
    const Wrapper = () => {
      const r = useRef<BulletFieldHandle | null>(null);
      ref = r;
      return (
        <BulletField
          ref={r}
          {...FIELD}
          maxBullets={N}
          boundsLimit={1000}
          orient={orient}
          {...extra}
        />
      );
    };
    const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
    await ReactThreeTestRenderer.act(async () => {
      ref!.current!.fireAt(ORIGIN, fan, 1);
    });
    return { renderer, field: () => ref!.current! };
  }

  async function fastestFrame(a: Renderer, b: Renderer): Promise<[number, number]> {
    for (let i = 0; i < WARMUP; i++) {
      await a.advanceFrames(1, 0.016);
      await b.advanceFrames(1, 0.016);
    }
    let ta = Infinity;
    let tb = Infinity;
    for (let i = 0; i < ROUNDS; i++) {
      let t0 = performance.now();
      await a.advanceFrames(1, 0.016);
      const da = performance.now() - t0;
      t0 = performance.now();
      await b.advanceFrames(1, 0.016);
      const db = performance.now() - t0;
      if (da < ta) ta = da;
      if (db < tb) tb = db;
    }
    return [ta, tb];
  }

  it("orient='velocity' over 2,000 bullets costs under 2.5× orient='none'", async () => {
    const none = await mountOriented('none');
    const vel = await mountOriented('velocity');
    expect(none.field().activeCount).toBe(N);
    expect(vel.field().activeCount).toBe(N);

    const [tNone, tVel] = await fastestFrame(none.renderer, vel.renderer);
    expect(tNone).toBeGreaterThan(0);
    expect(tVel).toBeLessThan(tNone * 2.5);
    // Every bullet was still drawn and still alive: the comparison is like
    // for like, not a field that quietly culled its work.
    expect(vel.field().activeCount).toBe(N);
  }, 30_000);

  it("orient='camera' over 2,000 bullets costs under 2.5× orient='none'", async () => {
    const none = await mountOriented('none');
    const cam = await mountOriented('camera');
    const [tNone, tCam] = await fastestFrame(none.renderer, cam.renderer);
    expect(tNone).toBeGreaterThan(0);
    expect(tCam).toBeLessThan(tNone * 2.5);
  }, 30_000);

  // 0.7.0: the sprite-atlas path a pixel-art game uses — a quad, a frame per
  // bullet from its payload (half of them upright), and the screen-heading
  // roll. Measured 1.45–1.66× 'none' over 3 runs (fastest of 30, unloaded);
  // the extra over 'camera' is one callback pair, one attribute store and one
  // roll quaternion per bullet. Bound 3×.
  it("orient='camera-velocity' + frames over 2,000 bullets costs under 3× orient='none'", async () => {
    const none = await mountOriented('none');
    const framed = await mountOriented('camera-velocity', {
      geometry: bulletGeometry.quad(),
      frames: { columns: 4, rows: 4, frame: (_i, p) => p & 15, upright: (f) => (f & 1) === 1 },
    });
    const [tNone, tFramed] = await fastestFrame(none.renderer, framed.renderer);
    expect(tNone).toBeGreaterThan(0);
    expect(tFramed).toBeLessThan(tNone * 3);
    expect(framed.field().activeCount).toBe(N);
  }, 30_000);
});
