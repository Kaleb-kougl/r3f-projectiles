import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Color, type InstancedMesh } from 'three';
import { BulletManager } from '../BulletManager';
import { acquire } from '../pool';
import type { BulletManagerHandle, BulletSpawnData, PatternFactory } from '../types';

/**
 * Characterization tests — phase 1 of docs/bulletfield-emitter-split.md.
 *
 * These pin TODAY's observable behaviour of `<BulletManager>` in the places the
 * nine tests in `BulletManager.test.tsx` do not reach, so that the pool-structure
 * rewrite (phase 2) and the `<BulletField>` extraction (phase 3) have a gate that
 * can actually see a regression.
 *
 * ---------------------------------------------------------------------------
 * SLOT ASSIGNMENT ORDER IS EXPLICITLY NOT PART OF THE CONTRACT.
 *
 * `forEachActive` hands the consumer a slot index, so which index comes back is
 * externally visible — but it is NOT specified and nothing here may assert it.
 * Today the spawn scan is lowest-free-first (`BulletManager.tsx:196-204`); phase 2
 * replaces it with a LIFO free stack, which is last-released-first. Both are
 * correct. So these tests assert only that capacity is recovered and that the
 * counts and per-bullet data are right — never *which* index came back, never
 * that indices ascend, never index 0 specifically.
 *
 * Per-bullet identity is carried by `payload`, which IS part of the contract.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BulletSpec {
  color?: number;
  payload?: number;
  delay?: number;
  life?: number;
}

/**
 * A pattern of motionless, effectively immortal bullets. Zero velocity and zero
 * acceleration mean the frame loop never moves them out of bounds, and a huge
 * `life` means they never expire — so `activeCount` changes only when the code
 * under test spawns or frees a slot, never as simulation noise.
 *
 * Spawn data must come from `acquire()`: `BulletManager` calls
 * `releaseSpawnData()` on whatever the factory returns.
 */
function staticBurst(specs: BulletSpec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.velocity.set(0, 0, 0);
      d.acceleration.set(0, 0, 0);
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = s.color ?? null;
      d.payload = s.payload ?? 0;
      return d;
    });
}

/** Mount `<BulletManager>` and hand back its imperative handle plus the renderer. */
async function mountManager(
  props: React.ComponentProps<typeof BulletManager>,
): Promise<{
  renderer: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;
  handle: () => BulletManagerHandle;
  render: (next: React.ComponentProps<typeof BulletManager>) => Promise<void>;
}> {
  let ref: React.RefObject<BulletManagerHandle | null> | null = null;
  const Comp = (p: React.ComponentProps<typeof BulletManager>) => {
    const r = useRef<BulletManagerHandle>(null);
    ref = r;
    return <BulletManager ref={r} {...p} />;
  };
  const renderer = await ReactThreeTestRenderer.create(<Comp {...props} />);
  return {
    renderer,
    handle: () => ref!.current!,
    render: async (next) => {
      await renderer.update(<Comp {...next} />);
    },
  };
}

/** The real three.js `InstancedMesh` behind the test-renderer scene node. */
function meshOf(
  renderer: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>,
): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

/** Collect `[index, payload]` for every bullet `forEachActive` visits. */
function visited(handle: BulletManagerHandle): Array<{ index: number; payload: number }> {
  const seen: Array<{ index: number; payload: number }> = [];
  handle.forEachActive((index, _pos, payload) => {
    seen.push({ index, payload });
  });
  return seen;
}

// The manual-vs-automatic cadence tests below use an interval that is not a
// multiple of the frame delta, so every assertion sits ~0.05s clear of the
// firing threshold rather than on top of it.
const FIRE_INTERVAL = 0.85;
const CADENCE_FIRE_RATE = 1 / FIRE_INTERVAL;
const DT = 0.1;

// A `fireRate` low enough that auto-fire cannot possibly happen during a test
// that only advances a second or two of simulated time.
const NEVER_AUTO_FIRES = 0.01;

describe('BulletManager — characterization (phase 1)', () => {
  // -------------------------------------------------------------------------
  // 1. Per-bullet color is written per slot at spawn (BulletManager.tsx:224-225)
  // -------------------------------------------------------------------------
  it('writes each bullet\'s own color into its own instanceColor slot at spawn', async () => {
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00];
    // payload doubles as the bullet's identity: bullet k carries payload k and
    // expects colors[k]. That ties color to bullet without naming a slot index.
    const pattern = staticBurst(colors.map((color, k) => ({ color, payload: k })));

    const { renderer, handle } = await mountManager({
      maxBullets: 32,
      paused: true,
      pattern,
    });

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(colors.length);

    const mesh = meshOf(renderer);
    expect(mesh.instanceColor).toBeTruthy();
    const buf = mesh.instanceColor!.array;

    const seen = visited(handle());
    expect(seen).toHaveLength(colors.length);

    const expected = new Color();
    for (const { index, payload } of seen) {
      expected.set(colors[payload]);
      expect(buf[index * 3 + 0]).toBeCloseTo(expected.r, 5);
      expect(buf[index * 3 + 1]).toBeCloseTo(expected.g, 5);
      expect(buf[index * 3 + 2]).toBeCloseTo(expected.b, 5);
    }

    // Every payload showed up exactly once, so the four writes went to four
    // distinct slots — without asserting which four.
    expect(seen.map((s) => s.payload).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(seen.map((s) => s.index)).size).toBe(colors.length);
  });

  it('falls back to the default 0xff3333 when spawn data carries no color', async () => {
    const { renderer, handle } = await mountManager({
      maxBullets: 8,
      paused: true,
      pattern: staticBurst([{}, {}]),
    });

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });

    const buf = meshOf(renderer).instanceColor!.array;
    const fallback = new Color().set(0xff3333);
    const seen = visited(handle());
    expect(seen).toHaveLength(2);
    for (const { index } of seen) {
      expect(buf[index * 3 + 0]).toBeCloseTo(fallback.r, 5);
      expect(buf[index * 3 + 1]).toBeCloseTo(fallback.g, 5);
      expect(buf[index * 3 + 2]).toBeCloseTo(fallback.b, 5);
    }
  });

  // -------------------------------------------------------------------------
  // 2. A despawned slot becomes reusable — capacity is recovered
  // -------------------------------------------------------------------------
  it('recovers full capacity after bullets despawn — a freed slot is spawnable again', async () => {
    const SIZE = 8;
    // life just under one frame, so a single advanced frame retires the burst.
    const pattern = staticBurst(
      Array.from({ length: SIZE }, (_, k) => ({ payload: k, life: 0.05 })),
    );

    const { handle, renderer } = await mountManager({
      maxBullets: SIZE,
      fireRate: NEVER_AUTO_FIRES,
      pattern,
    });

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(SIZE);

    // Pool is full: a second burst finds no free slot and is dropped.
    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(SIZE);

    // One frame retires every bullet (life expiry, release site 1).
    await renderer.advanceFrames(1, DT);
    expect(handle().activeCount).toBe(0);

    // Capacity is fully recovered — a whole burst fits again. Which slots came
    // back is deliberately not asserted.
    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(SIZE);
    expect(visited(handle()).map((s) => s.payload).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SIZE }, (_, k) => k),
    );
  });

  // -------------------------------------------------------------------------
  // 3. forEachActive consumption frees the slot and drops activeCount
  // -------------------------------------------------------------------------
  it('frees a slot when forEachActive\'s callback returns true, and the slot is respawnable', async () => {
    const SIZE = 8;
    const CONSUMED = 3;
    const pattern = staticBurst(Array.from({ length: SIZE }, (_, k) => ({ payload: k })));

    const { handle } = await mountManager({
      maxBullets: SIZE,
      paused: true,
      pattern,
    });

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(SIZE);
    expect(visited(handle())).toHaveLength(SIZE);

    // Consume by payload, never by index.
    handle().forEachActive((_i, _pos, payload) => payload < CONSUMED);

    expect(handle().activeCount).toBe(SIZE - CONSUMED);
    const survivors = visited(handle());
    expect(survivors).toHaveLength(SIZE - CONSUMED);
    expect(survivors.every((s) => s.payload >= CONSUMED)).toBe(true);

    // The freed slots are genuinely reusable: a full burst into a pool with
    // exactly CONSUMED free slots fills them and drops the rest.
    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(SIZE);
  });

  // -------------------------------------------------------------------------
  // 4. clear() resets the cadence timer (BulletManager.tsx:280)
  // -------------------------------------------------------------------------
  it('clear() resets the auto-fire cadence timer', async () => {
    const BURST = 4;
    const { handle, renderer } = await mountManager({
      maxBullets: 64,
      fireRate: CADENCE_FIRE_RATE, // 0.85s between shots
      pattern: staticBurst(Array.from({ length: BURST }, (_, k) => ({ payload: k }))),
    });

    // 0.80s accumulated — just short of the first auto-shot.
    await renderer.advanceFrames(8, DT);
    expect(handle().activeCount).toBe(0);

    await ReactThreeTestRenderer.act(async () => {
      handle().clear();
    });

    // Another 0.80s. Un-reset, the timer would stand at 1.60s and would have
    // fired five frames ago; reset, it is back to 0.80s and has not.
    await renderer.advanceFrames(8, DT);
    expect(handle().activeCount).toBe(0);

    // ...and the timer is running, not dead: one more frame crosses 0.85s.
    await renderer.advanceFrames(1, DT);
    expect(handle().activeCount).toBe(BURST);
  });

  // -------------------------------------------------------------------------
  // 5. fire() does NOT reset the cadence timer — the asymmetry with clear()
  // -------------------------------------------------------------------------
  it('fire() does NOT reset the cadence timer — the next auto-shot lands on schedule', async () => {
    const BURST = 4;
    const { handle, renderer } = await mountManager({
      maxBullets: 64,
      fireRate: CADENCE_FIRE_RATE, // 0.85s between shots
      pattern: staticBurst(Array.from({ length: BURST }, (_, k) => ({ payload: k }))),
    });

    // Same 0.80s as the clear() test above — the contrast is the point.
    await renderer.advanceFrames(8, DT);
    expect(handle().activeCount).toBe(0);

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });
    expect(handle().activeCount).toBe(BURST);

    // One more frame reaches 0.85s. If fire() had zeroed the timer this frame
    // would sit at 0.10s and nothing would auto-fire, leaving BURST.
    await renderer.advanceFrames(1, DT);
    expect(handle().activeCount).toBe(BURST * 2);
  });

  // -------------------------------------------------------------------------
  // 6. Delayed bullets are skipped by forEachActive (BulletManager.tsx:307)
  // -------------------------------------------------------------------------
  it('forEachActive skips delayed bullets while they wait, and visits them once the delay elapses', async () => {
    const DELAY = 0.5;
    // payload 0 = visible immediately, payload 1 = delayed.
    const pattern = staticBurst([
      { payload: 0 },
      { payload: 0 },
      { payload: 0 },
      { payload: 0 },
      { payload: 1, delay: DELAY },
      { payload: 1, delay: DELAY },
      { payload: 1, delay: DELAY },
      { payload: 1, delay: DELAY },
    ]);
    const common = {
      maxBullets: 32,
      fireRate: NEVER_AUTO_FIRES,
      pattern,
    };

    const { handle, renderer, render } = await mountManager({ ...common, paused: true });

    await ReactThreeTestRenderer.act(async () => {
      handle().fire();
    });

    // All eight occupy a slot...
    expect(handle().activeCount).toBe(8);
    // ...but only the four undelayed ones are offered to the consumer, so a hit
    // test never lands on a parked instance.
    const early = visited(handle());
    expect(early).toHaveLength(4);
    expect(early.every((s) => s.payload === 0)).toBe(true);

    // Let the delay run out (0.6s > 0.5s); fireRate is too low to auto-fire.
    await render({ ...common, paused: false });
    await renderer.advanceFrames(6, DT);

    expect(handle().activeCount).toBe(8);
    const late = visited(handle());
    expect(late).toHaveLength(8);
    expect(late.filter((s) => s.payload === 1)).toHaveLength(4);
  });
});
