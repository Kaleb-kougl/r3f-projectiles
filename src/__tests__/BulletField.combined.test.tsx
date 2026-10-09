import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Matrix4, Vector3, type InstancedMesh } from 'three';
import { BulletField, type BulletFieldHandle, type BulletFieldProps } from '../BulletField';
import { acquire } from '../pool';
import { bulletGeometry } from '../render/geometry';
import { OUTLINE_MESH_NAME, type OutlineMesh } from '../render/outline';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * 0.5.0 merge check: the simulation features (manual stepping) and the render
 * features (geometry, orient, outline) were built in parallel. These tests
 * exercise them together, which neither branch's suite does on its own.
 */

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

const single = (velocity: [number, number, number]): PatternFactory => () => {
  const d: BulletSpawnData = acquire();
  d.offset.set(0, 0, 0);
  d.velocity.set(...velocity);
  d.acceleration.set(0, 0, 0);
  d.delay = 0;
  d.life = 1000;
  d.color = null;
  d.payload = 1;
  d.scale = 1;
  return [d];
};

async function mount(props: Partial<BulletFieldProps>) {
  let ref: React.RefObject<BulletFieldHandle | null> | null = null;
  const Wrapper = () => {
    const r = useRef<BulletFieldHandle | null>(null);
    ref = r;
    return <BulletField ref={r} maxBullets={64} boundsLimit={25} fadeTime={0} {...props} />;
  };
  const renderer: Renderer = await ReactThreeTestRenderer.create(<Wrapper />);
  const mesh = renderer.scene.children[0].instance as unknown as InstancedMesh;
  return { renderer, mesh, field: () => ref!.current! };
}

function firstIndex(h: BulletFieldHandle): number {
  let idx = -1;
  h.forEachActive((i) => {
    if (idx < 0) idx = i;
  });
  return idx;
}

describe('manual stepping + orient + geometry + outline', () => {
  it('steps a velocity-oriented arrow and uploads it with its outline', async () => {
    const geometry = bulletGeometry.arrow();
    const { renderer, mesh, field } = await mount({
      stepMode: 'manual',
      orient: 'velocity',
      geometry,
      bulletRadius: 0.5,
      outline: { color: 0x000000, width: 0.05 },
    });

    field().fireAt(new Vector3(0, 0, 0), single([0, 0, 2]));
    for (let i = 0; i < 5; i++) field().step(1 / 60);
    await renderer.advanceFrames(1, 1 / 60);

    const i = firstIndex(field());
    expect(i).toBeGreaterThanOrEqual(0);

    const m = new Matrix4();
    mesh.getMatrixAt(i, m);
    const pos = new Vector3().setFromMatrixPosition(m);
    expect(pos.z).toBeCloseTo((2 * 5) / 60, 6);

    // Local +X (the geometry's forward axis) now points along the velocity (+Z).
    const forward = new Vector3(1, 0, 0).transformDirection(m);
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(1, 6);

    const outline = mesh.children.find((c) => c.name === OUTLINE_MESH_NAME) as OutlineMesh | undefined;
    expect(outline).toBeDefined();
    expect(outline!.instanceMatrix).toBe(mesh.instanceMatrix);
    expect(outline!.count).toBe(mesh.count);
    expect(mesh.geometry).toBe(geometry);

    await renderer.unmount();
    // The field does not own a geometry it was given.
    expect(geometry.getAttribute('position')).toBeDefined();
    geometry.dispose();
  });

  it('writes bit-identical oriented matrices however steps are grouped into frames', async () => {
    const a = await mount({ stepMode: 'manual', orient: 'velocity', geometry: bulletGeometry.diamond() });
    const b = await mount({ stepMode: 'manual', orient: 'velocity', geometry: bulletGeometry.diamond() });

    for (const h of [a.field(), b.field()]) {
      h.fireAt(new Vector3(0, 0, 0), single([1.5, 0, -0.75]));
      h.fireAt(new Vector3(1, 0, 1), single([-0.25, 0, 2]));
    }

    // A: 12 steps, one per frame. B: the same 12 steps in frames of 5, 5 and 2.
    for (let k = 0; k < 12; k++) {
      a.field().step(1 / 60);
      await a.renderer.advanceFrames(1, 1 / 60);
    }
    for (const n of [5, 5, 2]) {
      for (let k = 0; k < n; k++) b.field().step(1 / 60);
      await b.renderer.advanceFrames(1, 1 / 60);
    }

    const slots: number[] = [];
    a.field().forEachActive((i) => {
      slots.push(i);
    });
    expect(slots.length).toBe(2);
    const ma = new Matrix4();
    const mb = new Matrix4();
    for (const i of slots) {
      a.mesh.getMatrixAt(i, ma);
      b.mesh.getMatrixAt(i, mb);
      for (let k = 0; k < 16; k++) expect(Object.is(ma.elements[k], mb.elements[k])).toBe(true);
    }
  });
});
