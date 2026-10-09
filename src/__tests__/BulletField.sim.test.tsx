import React, { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Matrix4, Vector3, type InstancedMesh } from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
} from '../BulletField';
import { Emitter } from '../Emitter';
import { BulletManager } from '../BulletManager';
import { acquire } from '../pool';
import { gen, mod, compose } from '../patterns';
import { definePayload } from '../payload';
import type {
  BulletManagerHandle,
  BulletSpawnData,
  PatternFactory,
} from '../types';

/**
 * 0.5.0 simulation features: manual stepping, bounds options, and the
 * `setPayload` write-back that payload bitfields need.
 *
 *  - **`stepMode="manual"`** — the frame loop advances nothing; `step(dt)`
 *    advances exactly `dt`; the upload is once per rendered frame however many
 *    steps ran; and the simulation is a pure function of the step / fire /
 *    consume sequence, independent of how steps are grouped into frames.
 *  - **Bounds** — what `boundsLimit` actually measures (a per-axis cube in the
 *    field's local space, pinned here because the old docs said "distance"),
 *    `Infinity` to disable it, and `boundsCenter` to move it.
 *  - **`setPayload`** — the write-back half of `forEachActive`.
 *
 * As everywhere else in this suite, slot assignment order is not part of the
 * contract — EXCEPT in the determinism tests, where "two fields agree on which
 * slot every bullet is in" is exactly the property being claimed.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

interface Spec {
  offset?: V3;
  velocity?: V3;
  acceleration?: V3;
  delay?: number;
  life?: number;
  payload?: number;
}

/** A burst built field by field, so a test states exactly what each bullet does. */
function burst(specs: Spec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(...(s.offset ?? [0, 0, 0]));
      d.velocity.set(...(s.velocity ?? [0, 0, 0]));
      d.acceleration.set(...(s.acceleration ?? [0, 0, 0]));
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = null;
      d.payload = s.payload ?? 0;
      d.scale = 1;
      return d;
    });
}

const FIELD: Omit<BulletFieldProps, 'children'> = {
  maxBullets: 1000,
  boundsLimit: 25,
  fadeTime: 0,
};

const ZERO = new Vector3(0, 0, 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

interface Row {
  index: number;
  payload: number;
  emitterId: number;
  pos: V3;
}

/** Non-destructive walk of every visible bullet, in walk order. */
function census(handle: BulletFieldHandle): Row[] {
  const rows: Row[] = [];
  handle.forEachActive((index, pos, payload, emitterId) => {
    rows.push({ index, payload, emitterId, pos: [pos.x, pos.y, pos.z] });
  });
  return rows;
}

/** Census sorted by payload — for tests that identify bullets by payload. */
function byPayload(handle: BulletFieldHandle): Row[] {
  return census(handle).sort((a, b) => a.payload - b.payload);
}

/**
 * Bit-for-bit equality of two censuses. `toEqual` treats `0` and `-0` as
 * different but is otherwise value equality; `Object.is` per coordinate is the
 * claim actually being made, so it is spelled out.
 */
function expectBitIdentical(a: Row[], b: Row[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].index).toBe(b[i].index);
    expect(a[i].payload).toBe(b[i].payload);
    expect(a[i].emitterId).toBe(b[i].emitterId);
    for (let k = 0; k < 3; k++) {
      expect(Object.is(a[i].pos[k], b[i].pos[k])).toBe(true);
    }
  }
}

/** Mount a field (and whatever children) and capture its handle. */
async function mount(
  props: Partial<BulletFieldProps> = {},
  children?: React.ReactNode,
): Promise<{
  renderer: Renderer;
  field: () => BulletFieldHandle;
  rerender: (next: Partial<BulletFieldProps>) => Promise<void>;
}> {
  let ref: React.RefObject<BulletFieldHandle | null> | null = null;
  const Wrapper = ({ p }: { p: Partial<BulletFieldProps> }) => {
    const r = useRef<BulletFieldHandle | null>(null);
    ref = r;
    return (
      <BulletField ref={r} {...FIELD} {...p}>
        {children}
      </BulletField>
    );
  };
  const renderer = await ReactThreeTestRenderer.create(<Wrapper p={props} />);
  return {
    renderer,
    field: () => ref!.current!,
    rerender: async (next) => {
      await renderer.update(<Wrapper p={next} />);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * This library's own warnings out of a `console.warn` spy. three logs its own
 * (a `THREE.Clock` deprecation at mount, under recent builds), and those are
 * not what these tests count.
 */
function ourWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith('[r3f-projectiles]'));
}

// ===========================================================================
// 1. Manual mode: frames advance nothing
// ===========================================================================

describe('stepMode="manual" — the frame loop does not advance the simulation', () => {
  it('moves, counts down, expires and culls nothing on frames alone', async () => {
    const { renderer, field } = await mount({ stepMode: 'manual' });
    field().fireAt(
      ZERO,
      burst([
        { payload: 1, velocity: [1, 0, 0], acceleration: [0, 1, 0] }, // moving
        { payload: 2, delay: 0.05 }, // delayed
        { payload: 3, life: 0.05 }, // nearly dead
        { payload: 4, offset: [100, 0, 0] }, // already out of bounds
      ]),
    );
    const before = byPayload(field());

    await renderer.advanceFrames(20, 0.1); // two seconds of frames

    expect(field().activeCount).toBe(4); // nothing expired, nothing culled
    // The delayed bullet is still delayed, so still invisible to the walk.
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1, 3, 4]);
    expectBitIdentical(byPayload(field()), before); // nothing moved
  });

  it('does not auto-fire an emitter or advance its cadence on frames', async () => {
    const { renderer, field } = await mount(
      { stepMode: 'manual' },
      <Emitter pattern={burst([{ payload: 7 }])} fireRate={100} rotationSpeed={0} />,
    );

    await renderer.advanceFrames(30, 0.1);
    expect(field().activeCount).toBe(0);

    // The cadence did not accumulate in the background either: the first
    // step is the first 1/100 s the emitter has ever seen, and fires once.
    field().step(0.01);
    expect(field().activeCount).toBe(1);
  });

  it('raises onBulletCount only on frames in which a step ran', async () => {
    const onBulletCount = vi.fn();
    const { renderer, field } = await mount({ stepMode: 'manual', onBulletCount });
    field().fireAt(ZERO, burst([{}, {}]));

    await renderer.advanceFrames(3, 0.1);
    expect(onBulletCount).not.toHaveBeenCalled();

    field().step(0.01);
    field().step(0.01);
    await renderer.advanceFrames(1, 0.1);
    expect(onBulletCount).toHaveBeenCalledTimes(1); // per frame, not per step
    expect(onBulletCount).toHaveBeenLastCalledWith(2);

    await renderer.advanceFrames(1, 0.1);
    expect(onBulletCount).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. step(dt) advances exactly dt
// ===========================================================================

describe('step(dt) — advances exactly dt seconds of simulation', () => {
  it('integrates acceleration and velocity over exactly dt', async () => {
    const { field } = await mount({ stepMode: 'manual' });
    field().fireAt(
      ZERO,
      burst([{ payload: 1, velocity: [2, 0, 0], acceleration: [0, 1, 0] }]),
    );

    field().step(0.25);

    // Same semi-implicit Euler as the frame loop: v += a·dt, then p += v·dt.
    // Every value here is exact in binary, so `toBe` is honest.
    const [row] = census(field());
    expect(row.pos).toEqual([0.5, 0.0625, 0]);
  });

  it('does not apply the auto loop\'s 0.1 s clamp — the caller owns the clock', async () => {
    const { field } = await mount({ stepMode: 'manual' });
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [2, 0, 0] }]));

    field().step(0.5);
    expect(census(field())[0].pos[0]).toBe(1); // clamped would be 0.2
  });

  it('counts down delay, life and the fade on simulation time', async () => {
    const { renderer, field } = await mount({ stepMode: 'manual', fadeTime: 1 });
    field().fireAt(
      ZERO,
      burst([
        { payload: 1, delay: 0.2 },
        { payload: 2, life: 0.75 },
      ]),
    );

    field().step(0.1);
    expect(census(field()).map((r) => r.payload)).toEqual([2]); // still delayed
    field().step(0.1);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1, 2]);

    // Payload 2 has 0.55 s of life left: 55% of the 1 s linear fade. The fade
    // was written by the step, and the frame merely uploads it.
    await renderer.advanceFrames(1, 0.1);
    const two = byPayload(field())[1];
    expect(meshOf(renderer).instanceMatrix.array[two.index * 16]).toBeCloseTo(0.55, 5);

    for (let i = 0; i < 6; i++) field().step(0.1);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1]); // 2 expired
  });

  it('runs exactly what an auto frame runs: one manual step(dt) ≡ one auto frame of dt', async () => {
    // Everything the frame loop advances, at once: the built-in orbit (no
    // origin), cadence, a sequenced and accelerated pattern, life, the fade
    // and bounds. Run one field on frames and one on steps; they must agree to
    // the bit, matrices included.
    const pattern = () =>
      compose(gen.ring(6, 3), mod.accelerate(1, 0.5), mod.sequence(0.03), mod.payload(5));
    const children = <Emitter pattern={pattern} fireRate={7} rotationSpeed={0.9} />;
    const props = { fadeTime: 0.4, boundsLimit: 4 };

    const auto = await mount({ ...props }, children);
    const manual = await mount({ ...props, stepMode: 'manual' }, children);

    for (let i = 0; i < 40; i++) {
      await auto.renderer.advanceFrames(1, 0.05);
      manual.field().step(0.05);
      await manual.renderer.advanceFrames(1, 0.05);
    }

    expect(auto.field().activeCount).toBeGreaterThan(0);
    expectBitIdentical(census(manual.field()), census(auto.field()));
    expect(Array.from(meshOf(manual.renderer).instanceMatrix.array)).toEqual(
      Array.from(meshOf(auto.renderer).instanceMatrix.array),
    );
  });
});

// ===========================================================================
// 3. Grouping independence and determinism
// ===========================================================================

describe('step(dt) — determinism', () => {
  const DT = 1 / 60;

  it('N steps of dt give the same result however they are grouped into frames', async () => {
    const pattern = () => compose(gen.ring(8, 3), mod.accelerate(0.7, 0.3), mod.sequence(0.01));
    const groupings = [
      Array(24).fill(1), // one step per frame
      Array(8).fill(3), // three per frame
      [5, 0, 1, 7, 2, 0, 0, 9], // ragged, including frames with no step
      [24], // all in one frame
    ];

    const results: Row[][] = [];
    for (const groups of groupings) {
      const { renderer, field } = await mount(
        { stepMode: 'manual', boundsLimit: 3 },
        <Emitter pattern={pattern} fireRate={20} rotationSpeed={0.5} />,
      );
      for (const n of groups) {
        for (let s = 0; s < n; s++) field().step(DT);
        await renderer.advanceFrames(1, 0.1);
      }
      results.push(census(field()));
    }

    expect(results[0].length).toBeGreaterThan(0);
    for (const r of results.slice(1)) expectBitIdentical(r, results[0]);
  });

  it('two fields fed the same step / fire / consume sequence agree bit-for-bit', async () => {
    // The replay / co-op claim. The script is the "input log"; each field
    // plays it with a different, deliberately awkward frame grouping. Emitter
    // origins move per step, fireAt fires mid-sequence, and forEachActive
    // consumes and rewrites payloads — every input the contract names.
    const Shot = definePayload({ hp: 3, tag: 4 });
    const pattern = () =>
      compose(gen.arc(5, Math.PI / 3, 4), mod.accelerate(0.5), mod.payload(Shot.pack({ hp: 2, tag: 1 })));
    const spray = burst([
      { velocity: [0, 0, 3], payload: Shot.pack({ hp: 1, tag: 2 }) },
      { velocity: [0.5, 0, 3], acceleration: [0, 0.2, 0], delay: 0.05, payload: Shot.pack({ hp: 3, tag: 2 }) },
    ]);

    const play = async (frameEvery: (step: number) => boolean) => {
      const origin = { current: new Vector3(0, 0, 0) };
      const { renderer, field } = await mount(
        { stepMode: 'manual', boundsLimit: 6 },
        <Emitter origin={origin} pattern={pattern} fireRate={12} />,
      );
      const f = field();
      const hitPlane = new Vector3();
      for (let step = 0; step < 90; step++) {
        origin.current.set(Math.sin(step * 0.1), 0, step * 0.01);
        if (step % 7 === 0) f.fireAt(hitPlane.set(step * 0.03, 0, -1), spray, 0);
        f.step(DT);
        // "Collision": anything past z = 1.5 loses a hit point, and dies at 0.
        f.forEachActive((i, pos, payload) => {
          if (pos.z <= 1.5) return;
          const hp = Shot.get(payload, 'hp');
          if (hp <= 1) return true;
          f.setPayload(i, Shot.with(payload, 'hp', hp - 1));
        });
        if (frameEvery(step)) await renderer.advanceFrames(1, 0.1);
      }
      await renderer.advanceFrames(1, 0.1);
      return census(f);
    };

    const a = await play(() => true); // one step per frame
    const b = await play((s) => s % 4 === 3); // four per frame
    const c = await play((s) => s % 11 === 0 || s % 13 === 0); // irregular

    expect(a.length).toBeGreaterThan(0);
    expect(a.some((r) => Shot.get(r.payload, 'hp') < 2)).toBe(true); // writes happened
    expectBitIdentical(b, a);
    expectBitIdentical(c, a);
  });
});

// ===========================================================================
// 4. One upload per rendered frame
// ===========================================================================

describe('step(dt) — the GPU upload is once per rendered frame, not once per step', () => {
  it('five steps flag instanceMatrix once, with one update range covering every write', async () => {
    const { renderer, field } = await mount({ stepMode: 'manual' });
    field().fireAt(
      ZERO,
      burst(Array.from({ length: 10 }, (_, i) => ({ payload: i, velocity: [1, i, 0] as V3 }))),
    );
    await renderer.advanceFrames(1, 0.1); // settle the spawn's own flush

    const mesh = meshOf(renderer);
    const attr = mesh.instanceMatrix;
    attr.clearUpdateRanges();
    const v0 = attr.version;
    const addRange = vi.spyOn(attr, 'addUpdateRange');

    for (let i = 0; i < 5; i++) field().step(0.01);

    // Steps write on the CPU and flag nothing.
    expect(attr.version).toBe(v0);
    expect(addRange).not.toHaveBeenCalled();
    expect(attr.updateRanges).toHaveLength(0);

    await renderer.advanceFrames(1, 0.1);

    // One frame, one version bump, one range — spanning all ten live slots.
    expect(attr.version).toBe(v0 + 1);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(attr.updateRanges).toHaveLength(1);
    const slots = census(field()).map((r) => r.index);
    const { start, count } = attr.updateRanges[0];
    expect(start).toBeLessThanOrEqual(Math.min(...slots) * 16);
    expect(start + count).toBeGreaterThanOrEqual((Math.max(...slots) + 1) * 16);

    // A frame with no step uploads nothing.
    await renderer.advanceFrames(1, 0.1);
    expect(attr.version).toBe(v0 + 1);
  });

  it('flags instanceColor once for a frame whose steps spawned several times', async () => {
    const { renderer, field } = await mount(
      { stepMode: 'manual' },
      <Emitter pattern={burst([{ payload: 1 }])} fireRate={100} rotationSpeed={0} />,
    );
    await renderer.advanceFrames(1, 0.1);
    const colors = meshOf(renderer).instanceColor!;
    const v0 = colors.version;

    for (let i = 0; i < 4; i++) field().step(0.01); // four auto-shots
    expect(field().activeCount).toBe(4);
    expect(colors.version).toBe(v0);

    await renderer.advanceFrames(1, 0.1);
    expect(colors.version).toBe(v0 + 1);
  });

  it('does per-step work proportional to live bullets, not to the pool', async () => {
    // The counted-work footing perf.test uses: every slot a step touches goes
    // through setMatrixAt. 10 live bullets × 5 steps = 50 writes, in a pool
    // of 32,000 — and none of them a GPU flag.
    const { renderer, field } = await mount({ stepMode: 'manual', maxBullets: 32000 });
    field().fireAt(ZERO, burst(Array.from({ length: 10 }, () => ({ velocity: [0, 0, 1] as V3 }))));
    await renderer.advanceFrames(1, 0.1);

    const mesh = meshOf(renderer);
    const touched: number[] = [];
    const original = mesh.setMatrixAt.bind(mesh);
    (mesh as unknown as { setMatrixAt: (i: number, m: Matrix4) => void }).setMatrixAt = (i, m) => {
      touched.push(i);
      original(i, m);
    };
    for (let i = 0; i < 5; i++) field().step(0.01);

    expect(touched).toHaveLength(50);
    expect(new Set(touched).size).toBe(10);
  });
});

// ===========================================================================
// 5. step() refusals — documented no-ops, never throws
// ===========================================================================

describe('step(dt) — refusals', () => {
  it('is a no-op in auto mode, warning once in development', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { field } = await mount(); // stepMode defaults to 'auto'
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [1, 0, 0] }]));

    field().step(0.1);
    field().step(0.1);

    expect(census(field())[0].pos).toEqual([0, 0, 0]);
    expect(ourWarnings(warn)).toHaveLength(1);
    expect(ourWarnings(warn)[0]).toMatch(/stepMode/);
  });

  it('is a no-op while paused, and the step is dropped rather than queued', async () => {
    const { field, rerender } = await mount({ stepMode: 'manual', paused: true });
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [1, 0, 0] }]));

    field().step(0.5);
    expect(census(field())[0].pos[0]).toBe(0);

    await rerender({ stepMode: 'manual', paused: false });
    field().step(0.25);
    expect(census(field())[0].pos[0]).toBe(0.25); // not 0.75
  });

  it('ignores a dt that is not a finite number > 0, warning once for NaN / negative / Infinity', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { field } = await mount({ stepMode: 'manual' });
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [1, 0, 0] }]));

    field().step(0); // legitimate degenerate step: silent
    expect(ourWarnings(warn)).toHaveLength(0);

    for (const dt of [NaN, -0.1, Infinity, -Infinity]) field().step(dt);
    expect(census(field())[0].pos).toEqual([0, 0, 0]);
    expect(ourWarnings(warn)).toHaveLength(1);
    expect(ourWarnings(warn)[0]).toMatch(/dt must be a finite number/);
  });

  it('switches modes at runtime without resetting anything', async () => {
    const { renderer, field, rerender } = await mount({ stepMode: 'manual' });
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [1, 0, 0] }]));
    field().step(0.25);

    await rerender({ stepMode: 'auto' });
    await renderer.advanceFrames(1, 0.0625);
    expect(census(field())[0].pos[0]).toBe(0.3125);
  });
});

// ===========================================================================
// 6. <BulletManager> passes it all through
// ===========================================================================

describe('<BulletManager> — stepMode, boundsCenter and step() pass through', () => {
  it('stops on frames and advances on step()', async () => {
    let ref: React.RefObject<BulletManagerHandle | null> | null = null;
    const Wrapper = () => {
      const r = useRef<BulletManagerHandle | null>(null);
      ref = r;
      return (
        <BulletManager
          ref={r}
          stepMode="manual"
          pattern={burst([{ payload: 9 }])}
          fireRate={100}
          rotationSpeed={0}
        />
      );
    };
    const renderer = await ReactThreeTestRenderer.create(<Wrapper />);

    await renderer.advanceFrames(10, 0.1);
    expect(ref!.current!.activeCount).toBe(0);

    ref!.current!.step(0.01);
    expect(ref!.current!.activeCount).toBe(1);
  });

  it('forwards boundsCenter and setPayload', async () => {
    const center = { current: new Vector3(0, 100, 0) };
    let ref: React.RefObject<BulletManagerHandle | null> | null = null;
    const Wrapper = () => {
      const r = useRef<BulletManagerHandle | null>(null);
      ref = r;
      // spawnCenterY 100: the orbit fires at y = 100, far outside a box on
      // the origin but dead centre of one moved to `center`.
      return (
        <BulletManager
          ref={r}
          boundsCenter={center}
          pattern={burst([{ payload: 1 }])}
          fireRate={10}
          spawnCenterY={100}
          rotationSpeed={0}
        />
      );
    };
    const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
    await renderer.advanceFrames(2, 0.1);
    expect(ref!.current!.activeCount).toBeGreaterThan(0);

    ref!.current!.forEachActive((i) => ref!.current!.setPayload(i, 77));
    const seen: number[] = [];
    ref!.current!.forEachActive((_i, _p, payload) => {
      seen.push(payload);
    });
    expect(seen.every((p) => p === 77)).toBe(true);
  });
});

// ===========================================================================
// 7. Bounds — what boundsLimit measures, Infinity, boundsCenter
// ===========================================================================

describe('boundsLimit — what it measures (pinned, because the old docs said "distance")', () => {
  it('is a per-axis cube, not a sphere', async () => {
    const { renderer, field } = await mount({ boundsLimit: 25 });
    field().fireAt(
      ZERO,
      burst([
        // |(20, 20, 20)| ≈ 34.6 > 25, but no single axis exceeds 25: survives.
        { payload: 1, offset: [20, 20, 20] },
        { payload: 2, offset: [-24.9, 24.9, -24.9] }, // a corner, inside
        { payload: 3, offset: [0, 25.01, 0] }, // one axis out: culled
        { payload: 4, offset: [0, 0, -25.01] },
      ]),
    );
    await renderer.advanceFrames(1, 0.1);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1, 2]);
  });

  it('is measured in the field\'s local coordinates, not world space', async () => {
    let ref: React.RefObject<BulletFieldHandle | null> | null = null;
    const Wrapper = () => {
      const r = useRef<BulletFieldHandle | null>(null);
      ref = r;
      return (
        <group position={[100, 0, 0]}>
          <BulletField ref={r} {...FIELD} boundsLimit={25} />
        </group>
      );
    };
    const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
    ref!.current!.fireAt(
      ZERO,
      burst([
        { payload: 1, offset: [10, 0, 0] }, // world x = 110: inside locally
        { payload: 2, offset: [30, 0, 0] }, // local x = 30: culled
      ]),
    );
    await renderer.advanceFrames(1, 0.1);
    expect(byPayload(ref!.current!).map((r) => r.payload)).toEqual([1]);
  });
});

describe('boundsLimit={Infinity} — disables bounds culling', () => {
  it('never culls, however far a bullet flies; lifetime still despawns', async () => {
    const { renderer, field } = await mount({ boundsLimit: Infinity });
    field().fireAt(
      ZERO,
      burst([
        { payload: 1, velocity: [1e4, -1e4, 1e4] },
        { payload: 2, offset: [1e9, 0, 0] },
        { payload: 3, life: 0.25 },
      ]),
    );
    await renderer.advanceFrames(10, 0.1);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1, 2]);
    expect(byPayload(field())[0].pos[0]).toBeCloseTo(1e4, 3);
  });

  it('control: the same flight is culled under the default limit', async () => {
    const { renderer, field } = await mount();
    field().fireAt(ZERO, burst([{ payload: 1, velocity: [1e4, 0, 0] }]));
    await renderer.advanceFrames(1, 0.1);
    expect(field().activeCount).toBe(0);
  });
});

describe('boundsCenter — moves the cull box', () => {
  it('centres culling on the ref, re-read every step, falling back to the origin on null', async () => {
    const center: { current: Vector3 | null } = { current: new Vector3(100, 0, 0) };
    const { renderer, field } = await mount({ boundsLimit: 25, boundsCenter: center });
    field().fireAt(
      ZERO,
      burst([
        { payload: 1, offset: [100, 0, 0] }, // centre of the moved box
        { payload: 2, offset: [0, 0, 0] }, // the field origin: 100 away
      ]),
    );
    await renderer.advanceFrames(1, 0.1);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1]);

    // Follow the "player" — the box moves with the ref, no re-render needed.
    center.current!.set(110, 0, 0);
    await renderer.advanceFrames(1, 0.1);
    expect(field().activeCount).toBe(1); // 10 from the new centre

    center.current = null; // back to the origin
    await renderer.advanceFrames(1, 0.1);
    expect(field().activeCount).toBe(0);
  });

  it('works under manual stepping too', async () => {
    const center = { current: new Vector3(0, 0, 50) };
    const { field } = await mount({ stepMode: 'manual', boundsLimit: 5, boundsCenter: center });
    field().fireAt(ZERO, burst([{ payload: 1, offset: [0, 0, 50] }, { payload: 2 }]));
    field().step(0.01);
    expect(byPayload(field()).map((r) => r.payload)).toEqual([1]);
  });
});

// ===========================================================================
// 8. setPayload
// ===========================================================================

describe('setPayload — the write-back half of forEachActive', () => {
  it('rewrites a live bullet in place, mid-walk, and is ignored for a free slot', async () => {
    const Shot = definePayload({ damage: 8, pierce: 3 });
    const { field } = await mount({ stepMode: 'manual' });
    field().fireAt(ZERO, burst([{ payload: Shot.pack({ damage: 12, pierce: 2 }) }]));

    // Three "hits": pierce 2 → 1 → 0, then consumed on the third.
    let hits = 0;
    for (let frame = 0; frame < 5; frame++) {
      field().forEachActive((i, _pos, payload) => {
        hits++;
        const pierce = Shot.get(payload, 'pierce');
        if (pierce === 0) return true;
        field().setPayload(i, Shot.with(payload, 'pierce', pierce - 1));
      });
    }
    expect(hits).toBe(3);
    expect(field().activeCount).toBe(0);

    // The slot is free now: a stale write is dropped, and so are nonsense indices.
    field().setPayload(0, 123);
    field().setPayload(-1, 123);
    field().setPayload(1e9, 123);
    field().setPayload(0.5, 123);
    field().fireAt(ZERO, burst([{ payload: 5 }]));
    expect(census(field()).map((r) => r.payload)).toEqual([5]);
  });

  it('is on the ref with step, alongside the original seven members', async () => {
    const { field } = await mount();
    expect(typeof field().step).toBe('function');
    expect(typeof field().setPayload).toBe('function');
  });
});
