import React, { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Matrix4, Quaternion, Vector3, type InstancedMesh } from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
} from '../BulletField';
import { Emitter } from '../Emitter';
import { createBulletSimulation, type BulletSimulation } from '../core';
import { acquire } from '../pool';
import { gen, mod, compose } from '../patterns';
import { bulletGeometry } from '../render/geometry';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * `<BulletField simulation={sim}>` — a field that renders a simulation it does
 * not own: it never steps, spawns into or culls it, and once per rendered
 * frame syncs instance matrices (and fresh colors) over the simulation's dirty
 * range through the same writer an owned field uses, uploading once.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

interface Spec {
  offset?: V3;
  velocity?: V3;
  delay?: number;
  life?: number;
  payload?: number;
  scale?: number;
  color?: number;
}

function burst(specs: Spec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(...(s.offset ?? [0, 0, 0]));
      d.velocity.set(...(s.velocity ?? [0, 0, 0]));
      d.acceleration.set(0, 0, 0);
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = s.color ?? null;
      d.payload = s.payload ?? 0;
      d.scale = s.scale ?? 1;
      return d;
    });
}

const ZERO = new Vector3();

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

async function mount(
  props: Partial<BulletFieldProps>,
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
      <BulletField ref={r} {...p}>
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

/**
 * The matrix an unrotated (`orient="none"`) field must hold for slot `i`,
 * as float32 — what the GPU buffer stores.
 */
function expectedMatrix(sim: BulletSimulation, i: number, base = 1): number[] {
  const k = sim.fadeAt(i) * sim.scaleAt(i) * base;
  const m = new Matrix4().compose(
    sim.positionAt(i) as Vector3,
    new Quaternion(),
    new Vector3(k, k, k),
  );
  return Array.from(m.elements, (x) => Math.fround(x));
}

function matrixAt(mesh: InstancedMesh, i: number): number[] {
  return Array.from(mesh.instanceMatrix.array.slice(i * 16, i * 16 + 16));
}

function ourWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith('[r3f-projectiles]'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. It draws exactly the simulation's bullets
// ===========================================================================

describe('<BulletField simulation> — draws exactly the simulation\'s bullets', () => {
  it('writes each visible bullet at its position and scale × fade, parks the rest', async () => {
    const sim = createBulletSimulation({ maxBullets: 64, fadeTime: 1 });
    sim.fireAt(
      new Vector3(1, 2, 3),
      burst([
        { payload: 1, velocity: [1, 0, 0] },
        { payload: 2, velocity: [0, 0, -2], life: 0.6, scale: 2 }, // mid-fade
        { payload: 3, delay: 5 }, // delayed: hidden
        { payload: 4, velocity: [0, 1, 0] },
      ]),
    );
    sim.forEachActive((_i, _p, payload) => payload === 4 || undefined); // consumed: hidden
    sim.step(0.1);

    const { renderer } = await mount({ simulation: sim });
    await renderer.advanceFrames(1, 0.016);
    const mesh = meshOf(renderer);

    expect(mesh.count).toBe(sim.highWater);
    expect(mesh.instanceMatrix.count).toBe(64); // sized from sim.capacity
    let drawn = 0;
    for (let i = 0; i < sim.highWater; i++) {
      if (sim.isVisible(i)) {
        expect(matrixAt(mesh, i)).toEqual(expectedMatrix(sim, i));
        drawn++;
      } else {
        const m = matrixAt(mesh, i);
        expect(m[0]).toBe(0); // scale 0
        expect(m[13]).toBe(-999); // parked
      }
    }
    expect(drawn).toBe(2);
    // Payload 2's fade is visible in the matrix: 0.5 s left of a 1 s fade, ×2.
    const two = [0, 1, 2, 3].find((i) => sim.isLive(i) && sim.payloadAt(i) === 2)!;
    expect(matrixAt(mesh, two)[0]).toBeCloseTo(1, 5);
  });

  it('never steps, spawns or culls: frames alone change nothing', async () => {
    const sim = createBulletSimulation({ boundsLimit: 1 });
    sim.fireAt(ZERO, burst([{ velocity: [5, 0, 0], life: 0.05 }, { offset: [9, 0, 0] }]));
    const { renderer } = await mount({ simulation: sim }, null);

    await renderer.advanceFrames(30, 0.1);
    expect(sim.stepCount).toBe(0);
    expect(sim.activeCount).toBe(2); // neither expired nor culled
    expect(sim.positionAt(0).toArray()).toEqual([0, 0, 0]);
  });

  it('draws what an owned field draws for the same state — orient, geometry, outline and colors included', async () => {
    const render = {
      orient: 'velocity' as const,
      geometry: bulletGeometry.arrow(),
      bulletRadius: 0.3,
      outline: { color: 0x101010, width: 0.05 },
    };
    const pattern = () =>
      compose(gen.ring(24, 3), mod.sequence(0.02), mod.accelerate(1, 0.5), mod.color(0x22aaff));
    const spray = () => compose(gen.arc(9, 1, 5, 1), mod.scale(1.5), mod.color(0xffaa00));

    const sim = createBulletSimulation({ maxBullets: 300, boundsLimit: 3, fadeTime: 0.4 });
    const ext = await mount({ simulation: sim, ...render });
    const owned = await mount({ stepMode: 'manual', maxBullets: 300, boundsLimit: 3, fadeTime: 0.4, ...render });

    for (let t = 0; t < 50; t++) {
      const o = new Vector3(Math.sin(t * 0.2), 0, 0);
      for (const d of [sim, owned.field()]) {
        if (t % 4 === 0) d.fireAt(o, pattern, 1);
        if (t % 9 === 0) d.fireAt(o, spray, 2);
      }
      sim.step(1 / 30);
      owned.field().step(1 / 30);
      if (t % 7 === 3) {
        for (const d of [sim, owned.field()]) d.forEachActive((i) => i % 5 === 0 || undefined);
      }
      if (t % 2 === 0) {
        await ext.renderer.advanceFrames(1, 0.016);
        await owned.renderer.advanceFrames(1, 0.016);
      }
    }
    await ext.renderer.advanceFrames(1, 0.016);
    await owned.renderer.advanceFrames(1, 0.016);

    const a = meshOf(ext.renderer);
    const b = meshOf(owned.renderer);
    expect(sim.activeCount).toBeGreaterThan(10);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.instanceMatrix.array)).toEqual(Array.from(b.instanceMatrix.array));
    expect(Array.from(a.instanceColor!.array)).toEqual(Array.from(b.instanceColor!.array));
    // The outline shares the instance matrices and follows the count.
    const outline = a.children[0] as InstancedMesh;
    expect(outline.instanceMatrix).toBe(a.instanceMatrix);
    expect(outline.count).toBe(a.count);
  });
});

// ===========================================================================
// 2. Once per frame, over the dirty range
// ===========================================================================

describe('<BulletField simulation> — one upload per rendered frame', () => {
  it('uploads the dirty range once however many steps ran, and nothing on an idle frame', async () => {
    const sim = createBulletSimulation({ maxBullets: 1000 });
    sim.fireAt(ZERO, burst(Array.from({ length: 10 }, (_, i) => ({ velocity: [1, i, 0] as V3 }))));
    const { renderer } = await mount({ simulation: sim });
    await renderer.advanceFrames(1, 0.016); // the attach's full sync

    const mesh = meshOf(renderer);
    const attr = mesh.instanceMatrix;
    attr.clearUpdateRanges();
    const v0 = attr.version;
    const c0 = mesh.instanceColor!.version;
    const addRange = vi.spyOn(attr, 'addUpdateRange');

    for (let i = 0; i < 4; i++) sim.step(0.01);
    expect(attr.version).toBe(v0); // the sim knows nothing of the GPU

    await renderer.advanceFrames(1, 0.016);
    expect(attr.version).toBe(v0 + 1);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 10 * 16 }]);
    expect(mesh.instanceColor!.version).toBe(c0); // no spawn, no color upload
    for (let i = 0; i < 10; i++) expect(matrixAt(mesh, i)).toEqual(expectedMatrix(sim, i));

    await renderer.advanceFrames(3, 0.016); // nothing changed
    expect(attr.version).toBe(v0 + 1);
    expect(addRange).toHaveBeenCalledTimes(1);
  });

  it('uploads spawn colors once, and hides consumed bullets on the next frame', async () => {
    const sim = createBulletSimulation({ maxBullets: 100 });
    const { renderer } = await mount({ simulation: sim });
    await renderer.advanceFrames(1, 0.016);
    const mesh = meshOf(renderer);
    const c0 = mesh.instanceColor!.version;

    sim.fireAt(ZERO, burst([{ color: 0x00ff00, payload: 1 }, { color: 0x0000ff, payload: 2 }]));
    sim.fireAt(ZERO, burst([{ color: 0xff0000, payload: 3 }]));
    await renderer.advanceFrames(1, 0.016);
    expect(mesh.instanceColor!.version).toBe(c0 + 1);
    const col = mesh.instanceColor!.array;
    expect([col[0], col[1], col[2]]).toEqual([0, 1, 0]);
    expect([col[6], col[7], col[8]]).toEqual([1, 0, 0]);
    expect(mesh.count).toBe(3);

    sim.forEachActive((_i, _p, payload) => payload === 2 || undefined);
    await renderer.advanceFrames(1, 0.016);
    expect(mesh.instanceColor!.version).toBe(c0 + 1);
    expect(matrixAt(mesh, 1)[13]).toBe(-999);
    expect(matrixAt(mesh, 0)).toEqual(expectedMatrix(sim, 0));

    sim.clear();
    await renderer.advanceFrames(1, 0.016);
    expect(mesh.count).toBe(0);
  });

  it('raises onBulletCount once per frame in which the simulation stepped', async () => {
    const onBulletCount = vi.fn();
    const sim = createBulletSimulation();
    sim.fireAt(ZERO, burst([{}, {}, {}]));
    const { renderer } = await mount({ simulation: sim, onBulletCount });

    await renderer.advanceFrames(2, 0.016);
    expect(onBulletCount).not.toHaveBeenCalled();
    sim.step(0.01);
    sim.step(0.01);
    await renderer.advanceFrames(2, 0.016);
    expect(onBulletCount).toHaveBeenCalledTimes(1);
    expect(onBulletCount).toHaveBeenLastCalledWith(3);
  });
});

// ===========================================================================
// 3. Interpolation
// ===========================================================================

describe('<BulletField simulation interpolate> — drawing between steps', () => {
  it('draws previous + (current − previous) × alpha, clamped, every frame', async () => {
    const sim = createBulletSimulation({ interpolation: true, fadeTime: 0 });
    sim.fireAt(ZERO, burst([{ velocity: [4, 0, 0] }]));
    sim.step(0.25); // 0 → 1
    let alpha = 0.5;
    const { renderer } = await mount({ simulation: sim, interpolate: () => alpha });
    const mesh = meshOf(renderer);

    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(mesh, 0)[12]).toBe(0.5);
    alpha = 0.25; // no step: the in-between point still moves
    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(mesh, 0)[12]).toBe(0.25);
    alpha = 7;
    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(mesh, 0)[12]).toBe(1);
    alpha = NaN; // draws the current state
    sim.step(0.25); // 1 → 2
    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(mesh, 0)[12]).toBe(2);
    alpha = -1;
    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(mesh, 0)[12]).toBe(1);
  });

  it('is ignored, with one warning, on a simulation without interpolation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = createBulletSimulation({ fadeTime: 0 });
    sim.fireAt(ZERO, burst([{ velocity: [4, 0, 0] }]));
    sim.step(0.25);
    const { renderer } = await mount({ simulation: sim, interpolate: () => 0.5 });
    await renderer.advanceFrames(3, 0.016);

    expect(matrixAt(meshOf(renderer), 0)[12]).toBe(1);
    expect(ourWarnings(warn)).toHaveLength(1);
    expect(ourWarnings(warn)[0]).toMatch(/interpolation: true/);
  });
});

// ===========================================================================
// 4. The handle, the rules, and their errors
// ===========================================================================

describe('<BulletField simulation> — the handle forwards; the rules hold', () => {
  it('forwards every handle member to the simulation, and refuses step()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = createBulletSimulation();
    const { renderer, field } = await mount({ simulation: sim });
    const f = field();

    const id = f.acquireEmitter();
    expect(id).toBe(1);
    expect(sim.acquireEmitter()).toBe(2); // one counter
    f.fireAt(ZERO, burst([{ payload: 5, velocity: [1, 0, 0] }, { payload: 6 }]), id);
    expect(sim.activeCount).toBe(2);
    expect(f.activeCount).toBe(2);
    expect(f.activeCountFor(id)).toBe(2);

    f.forEachActive((i, _p, payload) => {
      if (payload === 5) f.setPayload(i, 50);
      else return true;
    });
    expect(sim.activeCount).toBe(1);
    expect(sim.payloadAt(0) + sim.payloadAt(1)).toBeGreaterThanOrEqual(50);

    f.step(0.5);
    f.step(0.5);
    expect(sim.stepCount).toBe(0);
    expect(ourWarnings(warn)).toHaveLength(1);
    expect(ourWarnings(warn)[0]).toMatch(/sim\.step/);

    f.releaseEmitter(40);
    expect(sim.acquireEmitter()).toBe(41);
    f.clear(id);
    expect(sim.activeCount).toBe(0);

    await renderer.advanceFrames(1, 0.016);
    expect(meshOf(renderer).count).toBe(0);
  });

  it('throws during render for an <Emitter> child', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sim = createBulletSimulation();
    await expect(
      ReactThreeTestRenderer.create(
        <BulletField simulation={sim}>
          <Emitter pattern="ring" />
        </BulletField>,
      ),
    ).rejects.toThrow(/<Emitter> cannot be rendered inside a <BulletField simulation/);
    error.mockRestore();
  });

  it('warns once about the simulation props it ignores', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = createBulletSimulation({ maxBullets: 10 });
    const { renderer } = await mount({ simulation: sim, maxBullets: 500, stepMode: 'manual', paused: true });
    await renderer.advanceFrames(2, 0.016);

    expect(meshOf(renderer).instanceMatrix.count).toBe(10); // the sim's capacity wins
    expect(ourWarnings(warn)).toHaveLength(1);
    expect(ourWarnings(warn)[0]).toMatch(/ignores maxBullets, paused, stepMode/);
  });

  it('redraws every live bullet of a simulation swapped in at runtime', async () => {
    const a = createBulletSimulation({ maxBullets: 50 });
    const b = createBulletSimulation({ maxBullets: 50 });
    a.fireAt(ZERO, burst([{ offset: [1, 0, 0] }]));
    b.fireAt(ZERO, burst([{ offset: [2, 0, 0] }, { offset: [3, 0, 0] }]));
    b.markSynced(); // as if another renderer had already consumed b's dirty range

    const { renderer, rerender } = await mount({ simulation: a });
    await renderer.advanceFrames(1, 0.016);
    expect(matrixAt(meshOf(renderer), 0)[12]).toBe(1);

    await rerender({ simulation: b });
    await renderer.advanceFrames(1, 0.016);
    const mesh = meshOf(renderer);
    expect(mesh.count).toBe(2);
    expect(matrixAt(mesh, 0)[12]).toBe(2);
    expect(matrixAt(mesh, 1)[12]).toBe(3);
  });
});
