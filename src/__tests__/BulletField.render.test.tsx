import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { useThree } from '@react-three/fiber';
import {
  Euler,
  Matrix4,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Camera,
  type InstancedMesh,
  type MeshBasicMaterial,
} from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
} from '../BulletField';
import { BulletManager } from '../BulletManager';
import { Emitter } from '../Emitter';
import { acquire } from '../pool';
import { bulletGeometry } from '../render/geometry';
import { OUTLINE_MESH_NAME, type OutlineMesh } from '../render/outline';
import type { BulletManagerHandle, BulletSpawnData, PatternFactory } from '../types';

/**
 * 0.5.0 render options — `geometry`, `orient`, `outline` — through a real
 * `<BulletField>`.
 *
 * The pure math (heading quaternion, mode resolution, shader patching, helper
 * geometry) is pinned in `render.unit.test.ts`; this file pins what only the
 * mounted field can show: which geometry the mesh actually draws and who
 * disposes it, what lands in `instanceMatrix` at both write sites, and how the
 * outline mesh is wired to the bullet mesh.
 *
 * ---------------------------------------------------------------------------
 * SLOT ASSIGNMENT ORDER IS EXPLICITLY NOT PART OF THE CONTRACT, as everywhere
 * else in this suite. Bullets are identified by `payload`; a slot index is only
 * ever used as a key into the instance matrix.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface BulletSpec {
  payload?: number;
  scale?: number;
  life?: number;
  delay?: number;
  velocity?: [number, number, number];
  acceleration?: [number, number, number];
}

function burst(specs: BulletSpec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(0, 0, 0);
      d.velocity.set(...(s.velocity ?? [0, 0, 0]));
      d.acceleration.set(...(s.acceleration ?? [0, 0, 0]));
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = null;
      d.payload = s.payload ?? 0;
      d.scale = s.scale ?? 1;
      return d;
    });
}

const FIELD: Omit<BulletFieldProps, 'children'> = {
  maxBullets: 64,
  boundsLimit: 1000,
  bulletRadius: 0.12,
  fadeTime: 0,
  fadeCurve: 'linear',
  paused: false,
  reducedMotion: false,
};

const DT = 0.1;
const ORIGIN = new Vector3(0, 0, 0);
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;
type FieldProps = Omit<BulletFieldProps, 'children'>;

function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

function outlineOf(mesh: InstancedMesh): OutlineMesh | undefined {
  return mesh.children.find((c) => c.name === OUTLINE_MESH_NAME) as
    | OutlineMesh
    | undefined;
}

/** Grabs R3F's default camera so a test can turn it. */
const cameraBox: { current: Camera | null } = { current: null };
function CameraGrab() {
  const camera = useThree((s) => s.camera);
  React.useLayoutEffect(() => {
    cameraBox.current = camera;
  }, [camera]);
  return null;
}

async function mountField(props: FieldProps = {}): Promise<{
  renderer: Renderer;
  field: () => BulletFieldHandle;
  render: (next: FieldProps) => Promise<void>;
}> {
  const ref = React.createRef<BulletFieldHandle>();
  const el = (p: FieldProps) => (
    <>
      <BulletField ref={ref} {...FIELD} {...p} />
      <CameraGrab />
    </>
  );
  const renderer = await ReactThreeTestRenderer.create(el(props));
  return {
    renderer,
    field: () => ref.current!,
    render: async (next) => {
      await renderer.update(el(next));
    },
  };
}

async function fireAt(field: BulletFieldHandle, pattern: PatternFactory) {
  await ReactThreeTestRenderer.act(async () => {
    field.fireAt(ORIGIN, pattern, 1);
  });
}

/** The instance matrix of the (only) live bullet carrying `payload`. */
function matrixOf(mesh: InstancedMesh, field: BulletFieldHandle, payload: number): Matrix4 {
  let slot = -1;
  field.forEachActive((i, _pos, p) => {
    if (p === payload) slot = i;
  });
  expect(slot).toBeGreaterThanOrEqual(0);
  const m = new Matrix4();
  mesh.getMatrixAt(slot, m);
  return m;
}

/** Where a local direction ends up under `m`, normalized (scale removed). */
function dirUnder(m: Matrix4, local: Vector3): Vector3 {
  return local.clone().transformDirection(m);
}

function scaleOf(m: Matrix4): number {
  return new Vector3().setFromMatrixColumn(m, 0).length();
}

function expectVec(actual: Vector3, expected: Vector3, digits = 5) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

function expectFinite(m: Matrix4) {
  for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
}

// ===========================================================================
// 1. geometry
// ===========================================================================

describe('BulletField — geometry', () => {
  it('draws the default sphere at bulletRadius when no geometry is given', async () => {
    const { renderer } = await mountField({ bulletRadius: 0.3 });
    const geo = meshOf(renderer).geometry as SphereGeometry;
    expect(geo.type).toBe('SphereGeometry');
    expect(geo.parameters.radius).toBe(0.3);
    expect(geo.parameters.widthSegments).toBe(6);
  });

  it('draws the consumer geometry instead of the sphere', async () => {
    const arrow = bulletGeometry.arrow();
    const { renderer } = await mountField({ geometry: arrow });
    expect(meshOf(renderer).geometry).toBe(arrow);
  });

  it('never disposes a consumer geometry — not on unmount, not on swap', async () => {
    const a = bulletGeometry.arrow();
    const b = bulletGeometry.diamond();
    const disposeA = vi.spyOn(a, 'dispose');
    const disposeB = vi.spyOn(b, 'dispose');

    const { renderer, render } = await mountField({ geometry: a });
    await render({ geometry: b });
    expect(meshOf(renderer).geometry).toBe(b);
    expect(disposeA).not.toHaveBeenCalled();

    // Back to the default: the field's own sphere comes back, b survives.
    await render({});
    expect(meshOf(renderer).geometry.type).toBe('SphereGeometry');
    expect(disposeB).not.toHaveBeenCalled();

    await render({ geometry: a });
    await renderer.unmount();
    expect(disposeA).not.toHaveBeenCalled();
    expect(disposeB).not.toHaveBeenCalled();
  });

  it('still disposes the default sphere it created', async () => {
    const { renderer, render } = await mountField({});
    const sphere = meshOf(renderer).geometry;
    const dispose = vi.spyOn(sphere, 'dispose');
    await render({ geometry: bulletGeometry.quad() });
    expect(dispose).toHaveBeenCalled();
  });

  it('scales a consumer geometry by bulletRadius × mod.scale (the sphere bakes its radius)', async () => {
    const quad = bulletGeometry.quad();
    const { renderer, field } = await mountField({
      geometry: quad,
      bulletRadius: 0.25,
      paused: true,
    });
    await fireAt(field(), burst([{ payload: 1, scale: 1 }, { payload: 2, scale: 3 }]));
    const mesh = meshOf(renderer);
    expect(scaleOf(matrixOf(mesh, field(), 1))).toBeCloseTo(0.25, 6);
    expect(scaleOf(matrixOf(mesh, field(), 2))).toBeCloseTo(0.75, 6);

    // The frame-loop write site agrees with the spawn-time one.
    const sphere = await mountField({ bulletRadius: 0.25 });
    await fireAt(sphere.field(), burst([{ payload: 1, scale: 3 }]));
    await sphere.renderer.advanceFrames(1, DT);
    expect(scaleOf(matrixOf(meshOf(sphere.renderer), sphere.field(), 1))).toBeCloseTo(3, 6);
  });

  it('follows a new geometry even when the material element is memoized', async () => {
    // R3F flushes a reconstructed child only from the tail sibling of an
    // updated run. One material ELEMENT reused across renders is never
    // "updated" (React bails out on identical props), so this pins that
    // swapping the geometry does not depend on the material re-committing.
    const a = bulletGeometry.arrow();
    const b = bulletGeometry.diamond();
    const material = <meshBasicMaterial />;
    const renderer = await ReactThreeTestRenderer.create(
      <BulletField {...FIELD} geometry={a} material={material} />,
    );
    expect(meshOf(renderer).geometry).toBe(a);
    await renderer.update(<BulletField {...FIELD} geometry={b} material={material} />);
    expect(meshOf(renderer).geometry).toBe(b);
  });
});

// ===========================================================================
// 2. orient — default output unchanged
// ===========================================================================

describe("BulletField — orient='none' is byte-identical to the 0.4.0 write", () => {
  it('stores exactly the floats Object3D.updateMatrix() used to, at both write sites', async () => {
    const { renderer, field } = await mountField({ bulletRadius: 0.12 });
    await fireAt(
      field(),
      burst([
        { payload: 1, scale: 1.7, velocity: [0.3, -0.2, 0.9] },
        { payload: 2, scale: 0.4, velocity: [-1, 0, 0] },
      ]),
    );
    const mesh = meshOf(renderer);
    const dummy = new Object3D();

    /** The 0.4.0 write, verbatim, run through the same Float32 store. */
    const check = (payload: number, s: number) => {
      let slot = -1;
      let pos: Vector3 | null = null;
      field().forEachActive((i, p, pl) => {
        if (pl === payload) {
          slot = i;
          pos = p.clone();
        }
      });
      dummy.position.copy(pos!);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      const expected = new Float32Array(16);
      dummy.matrix.toArray(expected);
      const actual = mesh.instanceMatrix.array.slice(slot * 16, slot * 16 + 16);
      // Bit-for-bit, sign of zero included.
      expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));
    };

    check(1, 1.7); // spawn-time write site
    await renderer.advanceFrames(2, DT);
    check(1, 1.7); // frame-loop write site
    check(2, 0.4);
  });
});

// ===========================================================================
// 3. orient='velocity'
// ===========================================================================

describe("BulletField — orient='velocity'", () => {
  it('turns local +X onto a +Z velocity, about Y, keeping +Y up', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity' });
    await fireAt(field(), burst([{ payload: 1, velocity: [0, 0, 2] }]));
    await renderer.advanceFrames(1, DT);
    const m = matrixOf(meshOf(renderer), field(), 1);
    expectVec(dirUnder(m, X), new Vector3(0, 0, 1));
    expectVec(dirUnder(m, Y), new Vector3(0, 1, 0)); // flat shapes stay flat
    expect(scaleOf(m)).toBeCloseTo(1, 6);
  });

  it('aims at the spawn write site too (paused field, no frame)', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity', paused: true });
    await fireAt(field(), burst([{ payload: 1, velocity: [-3, 0, 3] }]));
    const m = matrixOf(meshOf(renderer), field(), 1);
    expectVec(dirUnder(m, X), new Vector3(-1, 0, 1).normalize());
  });

  it('handles a general 3D velocity and the antiparallel case without NaN', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity' });
    await fireAt(
      field(),
      burst([
        { payload: 1, velocity: [1, 2, -3] },
        { payload: 2, velocity: [-5, 0, 0] },
      ]),
    );
    await renderer.advanceFrames(1, DT);
    const mesh = meshOf(renderer);
    const m1 = matrixOf(mesh, field(), 1);
    expectFinite(m1);
    expectVec(dirUnder(m1, X), new Vector3(1, 2, -3).normalize());
    const m2 = matrixOf(mesh, field(), 2);
    expectFinite(m2);
    expectVec(dirUnder(m2, X), new Vector3(-1, 0, 0));
    expectVec(dirUnder(m2, Y), new Vector3(0, 1, 0)); // half turn about Y
  });

  it('a bullet that was never moving stays unrotated, with no NaN', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity' });
    await fireAt(field(), burst([{ payload: 1 }]));
    await renderer.advanceFrames(2, DT);
    const m = matrixOf(meshOf(renderer), field(), 1);
    expectFinite(m);
    expectVec(dirUnder(m, X), X);
  });

  it('a bullet that stops keeps its last heading, then turns when it reverses', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity' });
    // v = (0, 0, 1) braking at 10/s²: 0.5 after one 0.05s frame, exactly zero
    // after the second, −0.5 after the third.
    await fireAt(
      field(),
      burst([{ payload: 1, velocity: [0, 0, 1], acceleration: [0, 0, -10] }]),
    );
    await renderer.advanceFrames(1, 0.05);
    expectVec(dirUnder(matrixOf(meshOf(renderer), field(), 1), X), new Vector3(0, 0, 1));

    await renderer.advanceFrames(1, 0.05); // the stopped frame
    const stopped = matrixOf(meshOf(renderer), field(), 1);
    expectFinite(stopped);
    expectVec(dirUnder(stopped, X), new Vector3(0, 0, 1));

    await renderer.advanceFrames(1, 0.05);
    expectVec(dirUnder(matrixOf(meshOf(renderer), field(), 1), X), new Vector3(0, 0, -1));
  });

  it('a recycled slot does not inherit its previous occupant\'s heading', async () => {
    const { renderer, field } = await mountField({ orient: 'velocity', maxBullets: 1 });
    await fireAt(field(), burst([{ payload: 1, velocity: [0, 0, 1] }]));
    await renderer.advanceFrames(1, DT);
    await ReactThreeTestRenderer.act(async () => field().clear());
    // Same (only) slot, zero velocity: must be unrotated, not aimed +Z.
    await fireAt(field(), burst([{ payload: 2 }]));
    await renderer.advanceFrames(1, DT);
    expectVec(dirUnder(matrixOf(meshOf(renderer), field(), 2), X), X);
  });

  it('keeps the reduced-motion snapshot aimed the way the pattern fired it', async () => {
    const pattern = burst([{ payload: 1, velocity: [0, 0, -4] }]);
    const renderer = await ReactThreeTestRenderer.create(
      <BulletField {...FIELD} reducedMotion orient="velocity">
        <Emitter pattern={pattern} fireRate={0.01} rotationSpeed={0} />
      </BulletField>,
    );
    await renderer.advanceFrames(1, DT);
    const mesh = meshOf(renderer);
    // One bullet, its velocity forced to zero by the snapshot, still aimed −Z.
    expect(mesh.count).toBeGreaterThan(0);
    const m = new Matrix4();
    let shown = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      if (scaleOf(m) === 0) continue;
      shown++;
      expectVec(dirUnder(m, X), new Vector3(0, 0, -1));
    }
    expect(shown).toBe(1);
  });
});

// ===========================================================================
// 4. orient='camera'
// ===========================================================================

describe("BulletField — orient='camera'", () => {
  it('turns local +Y toward the camera and +X to screen right', async () => {
    const { renderer, field } = await mountField({ orient: 'camera' });
    const cam = cameraBox.current!;
    // The game's camera: 45° yaw, 55° pitch down.
    cam.quaternion.setFromEuler(new Euler(-(55 * Math.PI) / 180, Math.PI / 4, 0, 'YXZ'));
    cam.updateMatrixWorld(true);

    await fireAt(field(), burst([{ payload: 1, velocity: [1, 0, 0] }]));
    await renderer.advanceFrames(1, DT);
    const m = matrixOf(meshOf(renderer), field(), 1);

    const toward = new Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    expectVec(dirUnder(m, Y), toward);
    expectVec(dirUnder(m, X), right);
    expectVec(dirUnder(m, new Vector3(0, 0, -1)), up);
  });

  it('follows the camera from frame to frame, once per frame', async () => {
    const { renderer, field } = await mountField({ orient: 'camera' });
    const cam = cameraBox.current!;
    await fireAt(field(), burst([{ payload: 1, velocity: [0.01, 0, 0] }]));

    cam.quaternion.setFromAxisAngle(Y, 0.7);
    await renderer.advanceFrames(1, DT);
    let m = matrixOf(meshOf(renderer), field(), 1);
    expectVec(dirUnder(m, Y), new Vector3(0, 0, 1).applyQuaternion(cam.quaternion));

    cam.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -1.2);
    await renderer.advanceFrames(1, DT);
    m = matrixOf(meshOf(renderer), field(), 1);
    expectVec(dirUnder(m, Y), new Vector3(0, 0, 1).applyQuaternion(cam.quaternion));
  });

  it('uses the camera even for a spawn before the first frame (paused field)', async () => {
    const { renderer, field } = await mountField({ orient: 'camera', paused: true });
    const cam = cameraBox.current!;
    cam.quaternion.copy(new Quaternion().setFromAxisAngle(Y, 1.1));
    await fireAt(field(), burst([{ payload: 1 }]));
    const m = matrixOf(meshOf(renderer), field(), 1);
    expectVec(dirUnder(m, X), new Vector3(1, 0, 0).applyQuaternion(cam.quaternion));
  });
});

// ===========================================================================
// 5. outline
// ===========================================================================

describe('BulletField — outline', () => {
  it('adds no outline mesh unless the prop is set', async () => {
    const { renderer } = await mountField({});
    expect(outlineOf(meshOf(renderer))).toBeUndefined();
    expect(meshOf(renderer).children).toHaveLength(0);
  });

  it('keeps the bullet mesh as scene.children[0]', async () => {
    const { renderer } = await mountField({ outline: { color: 'black', width: 0.03 } });
    expect(renderer.scene.children).toHaveLength(1);
    expect(meshOf(renderer).type).toBe('Mesh');
    expect(meshOf(renderer).isInstancedMesh).toBe(true);
  });

  it('shares the instanceMatrix attribute object, the geometry, and the live count', async () => {
    const { renderer, field } = await mountField({
      outline: { color: 0x110011, width: 0.03 },
    });
    const mesh = meshOf(renderer);
    const outline = outlineOf(mesh)!;
    expect(outline).toBeDefined();
    expect(outline.isInstancedMesh).toBe(true);
    expect(outline.instanceMatrix).toBe(mesh.instanceMatrix);
    expect(outline.geometry).toBe(mesh.geometry);
    expect(outline.instanceColor).toBeNull();
    expect(outline.count).toBe(0);

    await fireAt(field(), burst([{ payload: 1 }, { payload: 2 }, { payload: 3 }]));
    expect(mesh.count).toBe(3);
    expect(outline.count).toBe(mesh.count);

    await ReactThreeTestRenderer.act(async () => field().clear());
    expect(mesh.count).toBe(0);
    expect(outline.count).toBe(0);
  });

  it('applies color and width, and resolves the mode from the geometry', async () => {
    const { renderer, render } = await mountField({
      outline: { color: 0x221133, width: 0.03 },
    });
    const outline = outlineOf(meshOf(renderer))!;
    const mat = outline.material as MeshBasicMaterial;
    expect(mat.color.getHex()).toBe(0x221133);
    expect(mat.defines).toHaveProperty('OUTLINE_HULL'); // sphere → inverted hull
    expect(outline.__outline.uniforms.outlineWidth.value).toBeCloseTo(0.03, 6);

    // A helper shape is unit-sized, so a world width is divided by bulletRadius.
    await render({
      geometry: bulletGeometry.arrow(),
      bulletRadius: 0.2,
      outline: { color: 'black', width: 0.05 },
    });
    expect(mat.defines).toHaveProperty('OUTLINE_EXTRUDE');
    expect(outline.__outline.uniforms.outlineWidth.value).toBeCloseTo(0.25, 6);
    expect(mat.color.getHex()).toBe(0x000000);
    expect(outline.geometry).toBe(meshOf(renderer).geometry);
  });

  it('hides itself at width 0', async () => {
    const { renderer } = await mountField({ outline: { color: 'black', width: 0 } });
    await renderer.advanceFrames(1, DT);
    expect(outlineOf(meshOf(renderer))!.visible).toBe(false);
  });

  it('re-links to the rebuilt mesh when maxBullets changes', async () => {
    const { renderer, render, field } = await mountField({
      maxBullets: 16,
      outline: { color: 'black', width: 0.02 },
    });
    const before = meshOf(renderer);
    const outline = outlineOf(before)!;
    await render({ maxBullets: 32, outline: { color: 'black', width: 0.02 } });
    const after = meshOf(renderer);
    expect(after).not.toBe(before);
    expect(outlineOf(after)).toBe(outline); // same outline, moved over
    expect(outline.instanceMatrix).toBe(after.instanceMatrix);
    expect(outline.instanceMatrix.count).toBe(32);
    await fireAt(field(), burst([{ payload: 1 }]));
    expect(outline.count).toBe(after.count);
  });

  it('disposes its own material when removed — and leaves the bullet mesh alone', async () => {
    const geo = bulletGeometry.diamond();
    const geoDispose = vi.spyOn(geo, 'dispose');
    const { renderer, render } = await mountField({
      geometry: geo,
      outline: { color: 'black', width: 0.02 },
    });
    const mesh = meshOf(renderer);
    const outline = outlineOf(mesh)!;
    const matDispose = vi.spyOn(outline.material as MeshBasicMaterial, 'dispose');
    const meshMatrix = mesh.instanceMatrix;

    await render({ geometry: geo });
    expect(outlineOf(mesh)).toBeUndefined();
    expect(matDispose).toHaveBeenCalledTimes(1);
    expect(outline.parent).toBeNull();
    // Detached, the outline falls back to its own placeholders…
    expect(outline.instanceMatrix).not.toBe(meshMatrix);
    expect(outline.count).toBe(0);
    // …and nothing of the bullet mesh's was touched.
    expect(mesh.instanceMatrix).toBe(meshMatrix);
    expect(geoDispose).not.toHaveBeenCalled();
  });

  it('disposes on unmount, never firing the bullet buffer\'s dispose path', async () => {
    const { renderer } = await mountField({ outline: { color: 'black', width: 0.02 } });
    const mesh = meshOf(renderer);
    const outline = outlineOf(mesh)!;
    const matDispose = vi.spyOn(outline.material as MeshBasicMaterial, 'dispose');
    // three's renderer releases `instanceMatrix` from an instanced mesh's
    // 'dispose' event. Record which attribute the outline's event would name.
    let named: unknown = 'not disposed';
    outline.addEventListener('dispose', (e) => {
      named = (e.target as InstancedMesh).instanceMatrix;
    });
    const sharedMatrix = mesh.instanceMatrix;
    await renderer.unmount();
    expect(matDispose).toHaveBeenCalledTimes(1);
    expect(named).not.toBe('not disposed');
    expect(named).not.toBe(sharedMatrix);
  });
});

// ===========================================================================
// 6. <BulletManager> forwards all three
// ===========================================================================

describe('BulletManager — forwards geometry, orient, outline', () => {
  it('passes them through to its field', async () => {
    const quad = bulletGeometry.quad();
    let handle: BulletManagerHandle | null = null;
    const Comp = () => {
      const r = useRef<BulletManagerHandle>(null);
      React.useEffect(() => {
        handle = r.current;
      });
      return (
        <BulletManager
          ref={r}
          paused
          fireRate={0.01}
          geometry={quad}
          bulletRadius={0.5}
          orient="velocity"
          outline={{ color: 'black', width: 0.1 }}
          pattern={burst([{ payload: 1, velocity: [0, 0, 1] }])}
        />
      );
    };
    const renderer = await ReactThreeTestRenderer.create(<Comp />);
    const mesh = meshOf(renderer);
    expect(mesh.geometry).toBe(quad);
    expect(outlineOf(mesh)).toBeDefined();
    await ReactThreeTestRenderer.act(async () => handle!.fire());
    const m = new Matrix4();
    let slot = -1;
    handle!.forEachActive((i) => {
      slot = i;
    });
    mesh.getMatrixAt(slot, m);
    expectVec(dirUnder(m, X), new Vector3(0, 0, 1));
    expect(scaleOf(m)).toBeCloseTo(0.5, 6);
  });
});
