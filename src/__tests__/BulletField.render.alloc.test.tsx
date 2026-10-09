import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The 0.5.0 render paths allocate nothing per frame and nothing per bullet.
 *
 * ## How this counts allocations
 * A wall-clock or heap-delta test cannot see a 48-byte `Quaternion` per bullet
 * reliably — V8's young generation swallows it until it doesn't. So this file
 * counts **constructions** instead, deterministically: `three` is mocked with
 * subclasses of its math and scene classes whose constructors bump a counter,
 * and every module under `src/` that does `new Vector3()` (or `Quaternion`,
 * `Matrix4`, …) gets the counting class.
 *
 * The scope is exactly the claim the README makes — what the library's own
 * code allocates. R3F and the test renderer are external to vitest's module
 * graph and keep the real `three`, so their internals are not counted; nor
 * are three's own internals, which use their module-local classes.
 *
 * Every construction is fair game in the measured window, including the
 * spawn path: after warm-up, `acquire()` serves `BulletSpawnData` from its
 * pool, so a steady stream of bursts constructs no `Vector3` either.
 *
 * Checked against the failure it exists for: with the heading quaternion
 * returned as `new Quaternion(…)` instead of the writer's scratch, the three
 * `'velocity'` cases redden and the rest stay green.
 */

const counts = vi.hoisted(() => ({ total: 0, byName: {} as Record<string, number> }));

vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const counting = <T extends new (...args: any[]) => object>(name: string, Base: T): T =>
    class extends Base {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        super(...args);
        counts.total++;
        counts.byName[name] = (counts.byName[name] ?? 0) + 1;
      }
    };
  return {
    ...THREE,
    Vector2: counting('Vector2', THREE.Vector2),
    Vector3: counting('Vector3', THREE.Vector3),
    Vector4: counting('Vector4', THREE.Vector4),
    Quaternion: counting('Quaternion', THREE.Quaternion),
    Euler: counting('Euler', THREE.Euler),
    Matrix3: counting('Matrix3', THREE.Matrix3),
    Matrix4: counting('Matrix4', THREE.Matrix4),
    Color: counting('Color', THREE.Color),
    Object3D: counting('Object3D', THREE.Object3D),
    InstancedMesh: counting('InstancedMesh', THREE.InstancedMesh),
    MeshBasicMaterial: counting('MeshBasicMaterial', THREE.MeshBasicMaterial),
    BufferGeometry: counting('BufferGeometry', THREE.BufferGeometry),
    InstancedBufferAttribute: counting('InstancedBufferAttribute', THREE.InstancedBufferAttribute),
  };
});

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { DataTexture, Vector3 } from 'three';
import { BulletField, type BulletFieldHandle, type BulletFieldProps } from '../BulletField';
import { acquire } from '../pool';
import { bulletGeometry } from '../render/geometry';
import type { BulletSpawnData, PatternFactory } from '../types';

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const N = 2000;
const ORIGIN = new Vector3(0, 0, 0);

/** `n` slow bullets fanned over a sphere — real 3D headings, all moving. */
function fan(n: number, life: number): PatternFactory {
  return () => {
    const out: BulletSpawnData[] = [];
    for (let k = 0; k < n; k++) {
      const d = acquire();
      const y = 1 - (2 * (k + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const a = k * 2.399963229728653;
      d.offset.set(0, 0, 0);
      d.velocity.set(Math.cos(a) * r * 0.05, y * 0.05, Math.sin(a) * r * 0.05);
      d.acceleration.set(0, -0.01, 0);
      d.delay = 0;
      d.life = life;
      d.color = 0xff00ff;
      d.payload = k;
      d.scale = 1;
      out.push(d);
    }
    return out;
  };
}

async function mount(props: Omit<BulletFieldProps, 'children'>): Promise<{
  renderer: Renderer;
  field: () => BulletFieldHandle;
}> {
  let ref: React.RefObject<BulletFieldHandle | null> | null = null;
  const Wrapper = () => {
    const r = useRef<BulletFieldHandle | null>(null);
    ref = r;
    return <BulletField ref={r} maxBullets={N + 200} boundsLimit={1000} fadeTime={0.5} {...props} />;
  };
  const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
  return { renderer, field: () => ref!.current! };
}

function reset() {
  counts.total = 0;
  counts.byName = {};
}

beforeEach(reset);

const CASES: Array<[string, Omit<BulletFieldProps, 'children'>]> = [
  ["orient='none' (the 0.4.0 path)", {}],
  ["orient='velocity'", { orient: 'velocity' }],
  ["orient='camera'", { orient: 'camera' }],
  [
    "orient='velocity' + arrow geometry + outline",
    {
      orient: 'velocity',
      geometry: bulletGeometry.arrow(),
      bulletRadius: 0.2,
      outline: { color: 0x120018, width: 0.04 },
    },
  ],
  ["outline on the default sphere", { outline: { color: 'black', width: 0.02 } }],
  [
    "textured sprite quad + 'alpha' outline + orient='camera'",
    {
      orient: 'camera',
      geometry: bulletGeometry.quad(),
      material: (
        <meshBasicMaterial map={new DataTexture(new Uint8Array(16), 2, 2)} alphaTest={0.5} />
      ),
      outline: { color: 'black', width: 0.05 },
    },
  ],
];

describe('render paths construct nothing per frame', () => {
  for (const [name, props] of CASES) {
    it(`${name}: 2,000 moving bullets, 20 frames, zero constructions`, async () => {
      const { renderer, field } = await mount(props);
      await ReactThreeTestRenderer.act(async () => {
        field().fireAt(ORIGIN, fan(N, 1e6), 1);
      });
      expect(field().activeCount).toBe(N);
      await renderer.advanceFrames(3, 0.016); // warm-up

      reset();
      await renderer.advanceFrames(20, 0.016);
      expect(counts.byName).toEqual({});
      expect(counts.total).toBe(0);
      expect(field().activeCount).toBe(N);
    });
  }

  it("orient='velocity' + outline: steady bursts and despawns construct nothing either", async () => {
    const { renderer, field } = await mount({
      orient: 'velocity',
      geometry: bulletGeometry.diamond(),
      outline: { color: 'black', width: 0.03 },
    });
    const burst = fan(100, 0.05); // dies within 4 frames
    const fire = () =>
      ReactThreeTestRenderer.act(async () => {
        field().fireAt(ORIGIN, burst, 1);
      });

    // Warm the BulletSpawnData pool and the heading array.
    for (let i = 0; i < 6; i++) {
      await fire();
      await renderer.advanceFrames(1, 0.016);
    }

    reset();
    for (let i = 0; i < 20; i++) {
      await fire();
      await renderer.advanceFrames(1, 0.016);
    }
    expect(counts.byName).toEqual({});
    expect(field().activeCount).toBeGreaterThan(0);
  });

  it('the counter does count: mounting a field constructs its scratch objects', async () => {
    // Guards the guard. If the mock silently stopped applying to `src/`, every
    // assertion above would pass vacuously.
    await mount({ orient: 'velocity', outline: { color: 'black', width: 0.02 } });
    expect(counts.byName.Object3D ?? 0).toBeGreaterThan(0); // the field's _dummy
    expect(counts.byName.Quaternion ?? 0).toBeGreaterThan(0); // the writer's scratch
    expect(counts.byName.InstancedMesh ?? 0).toBe(1); // the outline mesh
  });
});
