import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { useThree } from '@react-three/fiber';
import {
  DataTexture,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  ShaderLib,
  Vector3,
  type BufferGeometry,
  type Camera,
} from 'three';
import { BulletField, type BulletFieldHandle, type BulletFieldProps } from '../BulletField';
import { BulletManager } from '../BulletManager';
import { createBulletSimulation } from '../core';
import { acquire } from '../pool';
import { bulletGeometry } from '../render/geometry';
import { InstanceWriter } from '../render/orient';
import { OUTLINE_MESH_NAME, patchOutlineShader, type OutlineMesh } from '../render/outline';
import {
  FRAME_ATTRIBUTE,
  createFrameGeometry,
  disposeFrameGeometry,
  frameAttributeOf,
  frameGrid,
  isFramePatched,
  patchFrameMaterial,
  patchFrameShader,
  unpatchFrameMaterial,
  type BulletFrames,
} from '../render/frames';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * 0.7.0 — per-bullet sprite frames from one atlas (`frames`) and the
 * `'camera-velocity'` billboard. The pure pieces (shader patches, the material
 * patch, the geometry view, the writer's rotation math) are pinned directly;
 * the mounted field pins which geometry the mesh draws, what lands in the frame
 * attribute at both write sites, and that removing `frames` restores the
 * consumer's objects untouched.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Spec {
  payload?: number;
  velocity?: [number, number, number];
}

function burst(specs: Spec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(0, 0, 0);
      d.velocity.set(...(s.velocity ?? [1, 0, 0]));
      d.acceleration.set(0, 0, 0);
      d.delay = 0;
      d.life = 1000;
      d.color = null;
      d.payload = s.payload ?? 0;
      d.scale = 1;
      return d;
    });
}

const ORIGIN = new Vector3();
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

/** The game-style camera: 45° yaw, 55° pitch down. */
function isoQuaternion(): Quaternion {
  return new Quaternion().setFromEuler(new Euler(-(55 * Math.PI) / 180, Math.PI / 4, 0, 'YXZ'));
}

function atlas(): DataTexture {
  return new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
}

function expectVec(actual: Vector3, expected: Vector3, digits = 5) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

const cameraBox: { current: Camera | null } = { current: null };
function CameraGrab() {
  const camera = useThree((s) => s.camera);
  React.useLayoutEffect(() => {
    cameraBox.current = camera;
  }, [camera]);
  return null;
}

type FieldProps = Omit<BulletFieldProps, 'children'>;

async function mountField(props: FieldProps) {
  const ref = React.createRef<BulletFieldHandle>();
  const el = (p: FieldProps) => (
    <>
      <BulletField ref={ref} maxBullets={16} boundsLimit={1000} fadeTime={0} {...p} />
      <CameraGrab />
    </>
  );
  const renderer = await ReactThreeTestRenderer.create(el(props));
  return {
    renderer,
    field: () => ref.current!,
    render: (next: FieldProps) => renderer.update(el(next)),
  };
}

/** slot -> payload of every live bullet. */
function liveSlots(field: BulletFieldHandle): Map<number, number> {
  const out = new Map<number, number>();
  field.forEachActive((i, _p, payload) => {
    out.set(i, payload);
  });
  return out;
}

// ===========================================================================
// 1. Pure pieces
// ===========================================================================

describe('frames — grid and shader patches', () => {
  it('frameGrid floors positive sizes and rejects unusable ones', () => {
    const f = (columns: number, rows: number): BulletFrames => ({ columns, rows, frame: () => 0 });
    expect(frameGrid(f(4, 2))).toEqual([4, 2]);
    expect(frameGrid(f(4.7, 2.2))).toEqual([4, 2]);
    expect(frameGrid(f(0, 2))).toBeNull();
    expect(frameGrid(f(NaN, 2))).toBeNull();
    expect(frameGrid(f(Infinity, 2))).toBeNull();
    expect(frameGrid(undefined)).toBeNull();
  });

  it("patches three's real basic vertex shader at both anchors", () => {
    const shader = { vertexShader: ShaderLib.basic.vertexShader };
    patchFrameShader(shader);
    expect(shader.vertexShader).toContain(`attribute float ${FRAME_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain('vec2 r3fpFrameUv(');
    expect(shader.vertexShader).toContain(
      `vMapUv = ( mapTransform * vec3( r3fpFrameUv( MAP_UV, ${FRAME_ATTRIBUTE}, r3fpFrameGrid ), 1.0 ) ).xy;`,
    );
    // The remap comes AFTER three's own UV chunk, so it wins.
    const chunk = shader.vertexShader.indexOf('#include <uv_vertex>');
    const remap = shader.vertexShader.indexOf('r3fpFrameUv( MAP_UV');
    expect(chunk).toBeGreaterThanOrEqual(0);
    expect(remap).toBeGreaterThan(chunk);
  });

  it('the alpha outline patch samples the instance cell when OUTLINE_FRAMES is defined', () => {
    const shader = { vertexShader: ShaderLib.basic.vertexShader, fragmentShader: ShaderLib.basic.fragmentShader };
    patchOutlineShader(shader);
    expect(shader.vertexShader).toContain(`vOutlineFrame = ${FRAME_ATTRIBUTE};`);
    expect(shader.fragmentShader).toContain('uv = r3fpFrameUv( uv, vOutlineFrame, outlineFrameGrid );');
    // The out-of-cell test runs before the remap: a tap past the cell's edge is
    // empty, never the neighbouring cell.
    const edge = shader.fragmentShader.indexOf('uv.x > 1.0');
    const remap = shader.fragmentShader.indexOf('uv = r3fpFrameUv(');
    expect(edge).toBeGreaterThan(0);
    expect(remap).toBeGreaterThan(edge);
  });
});

describe('frames — material patch', () => {
  it('chains the material\'s own onBeforeCompile and extends its cache key', () => {
    const m = new MeshBasicMaterial({ map: atlas(), alphaTest: 0.5 });
    const own = vi.fn();
    m.onBeforeCompile = own;
    const plainKey = m.customProgramCacheKey();

    patchFrameMaterial(m, [4, 2]);
    expect(isFramePatched(m)).toBe(true);
    expect(m.defines).toHaveProperty('R3FP_BULLET_FRAMES');
    expect(m.customProgramCacheKey()).not.toBe(plainKey);
    expect(m.customProgramCacheKey().startsWith(plainKey)).toBe(true);

    const shader = {
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.onBeforeCompile(shader as any, {} as any);
    expect(own).toHaveBeenCalledTimes(1);
    expect(shader.vertexShader).toContain('r3fpFrameUv( MAP_UV');
    expect((shader.uniforms.r3fpFrameGrid.value as { x: number; y: number }).x).toBe(4);

    // Idempotent; the grid updates in place.
    patchFrameMaterial(m, [8, 1]);
    expect((shader.uniforms.r3fpFrameGrid.value as { x: number }).x).toBe(8);

    unpatchFrameMaterial(m);
    expect(isFramePatched(m)).toBe(false);
    expect(m.onBeforeCompile).toBe(own);
    expect(m.customProgramCacheKey()).toBe(plainKey);
    expect(m.defines).toBeUndefined();
  });

  it('keeps a consumer cache key and defines across patch / unpatch', () => {
    const m = new MeshBasicMaterial();
    m.customProgramCacheKey = () => 'mine';
    m.defines = { MINE: '' };
    patchFrameMaterial(m, [2, 2]);
    expect(m.customProgramCacheKey()).toBe('mine|r3f-projectiles:frames');
    expect(m.defines).toEqual({ MINE: '', R3FP_BULLET_FRAMES: '' });
    unpatchFrameMaterial(m);
    expect(m.customProgramCacheKey()).toBe('mine');
    expect(m.defines).toEqual({ MINE: '' });
  });

  it('two patched materials with different own hooks never share a cache key', () => {
    const a = new MeshBasicMaterial();
    const b = new MeshBasicMaterial();
    a.onBeforeCompile = (s) => void s;
    b.onBeforeCompile = (s) => void s.uniforms;
    patchFrameMaterial(a, [2, 2]);
    patchFrameMaterial(b, [2, 2]);
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
  });
});

describe('frames — the geometry view', () => {
  it("shares the source's index and attribute objects and adds its own instanced cell", () => {
    const quad = bulletGeometry.quad();
    const view = createFrameGeometry(quad, 32);
    expect(view).not.toBe(quad);
    expect(view.index).toBe(quad.index);
    for (const name of Object.keys(quad.attributes)) expect(view.attributes[name]).toBe(quad.attributes[name]);
    const frame = frameAttributeOf(view)!;
    expect(frame).toBeInstanceOf(InstancedBufferAttribute);
    expect(frame.count).toBe(32);
    expect(frame.itemSize).toBe(1);
    expect(quad.getAttribute(FRAME_ATTRIBUTE)).toBeUndefined();
    expect(frameAttributeOf(quad)).toBeNull();
  });

  it('disposes only its own attribute: the dispose event never lists the shared buffers', () => {
    const quad = bulletGeometry.quad();
    const view = createFrameGeometry(quad, 4);
    let seen: string[] = [];
    let seenIndex: unknown = 'unset';
    view.addEventListener('dispose', () => {
      // What three's WebGLGeometries would delete GL buffers for.
      seen = Object.keys(view.attributes);
      seenIndex = view.index;
    });
    const quadDispose = vi.spyOn(quad, 'dispose');
    disposeFrameGeometry(view);
    expect(seen).toEqual([FRAME_ATTRIBUTE]);
    expect(seenIndex).toBeNull();
    expect(quadDispose).not.toHaveBeenCalled();
    // Restored afterwards: the view stays usable (StrictMode replays effects).
    expect(view.index).toBe(quad.index);
    expect(view.attributes.position).toBe(quad.attributes.position);
  });
});

// ===========================================================================
// 2. The writer: frames and the 'camera-velocity' billboard
// ===========================================================================

function writerSetup(orient: 'velocity' | 'camera-velocity', frames: BulletFrames | null = null) {
  const geometry = bulletGeometry.quad();
  const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 8);
  const writer = new InstanceWriter();
  const cam = new PerspectiveCamera();
  cam.quaternion.copy(isoQuaternion());
  cam.updateMatrixWorld(true);
  writer.configure(orient, 1, 8, () => cam);
  const attr = new InstancedBufferAttribute(new Float32Array(8), 1);
  writer.configureFrames(frames, frames ? attr : null);
  writer.syncCamera(cam);
  const m = new Matrix4();
  const write = (slot: number, v: Vector3, payload = 0) => {
    writer.write(mesh, slot, ORIGIN, v, 1, payload);
    mesh.getMatrixAt(slot, m);
    return m;
  };
  const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const toward = new Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
  return { writer, write, attr, right, up, toward, cam };
}

const dirUnder = (m: Matrix4, local: Vector3) => local.clone().transformDirection(m);

describe("orient='camera-velocity'", () => {
  it('faces the camera and turns local +X onto the on-screen heading', () => {
    const { write, right, up, toward } = writerSetup('camera-velocity');
    const headings: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0, 0, -1],
      [0.6, 0, -0.8],
      [-0.3, 0, -0.954],
      [1, 1, 1],
      // Exactly along screen-left: the antiparallel case of the half angle.
      [-right.x, -right.y, -right.z],
    ];
    for (const [x, y, z] of headings) {
      const v = new Vector3(x, y, z);
      const m = write(0, v);
      const sx = v.dot(right);
      const sy = v.dot(up);
      const len = Math.hypot(sx, sy);
      const expected = right.clone().multiplyScalar(sx / len).addScaledVector(up, sy / len);
      expectVec(dirUnder(m, X), expected);
      expectVec(dirUnder(m, Y), toward);
      for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
    }
  });

  it('keeps the last heading through a stop, and draws a plain billboard for a heading with no screen extent', () => {
    const { write, right, up, toward, writer, cam } = writerSetup('camera-velocity');
    const v = new Vector3(0, 0, 1);
    const moving = dirUnder(write(3, v).clone(), X);
    const stopped = dirUnder(write(3, new Vector3()), X);
    expectVec(stopped, moving);

    // Straight at the camera: no on-screen direction, so no roll.
    const m = write(4, toward.clone().negate());
    expectVec(dirUnder(m, X), right);
    expectVec(dirUnder(m, new Vector3(0, 0, -1)), up);
    void writer;
    void cam;
  });

  it("an upright frame skips the roll ('camera' billboard) and a turning one rolls", () => {
    const frames: BulletFrames = { columns: 2, rows: 1, frame: (_i, p) => p, upright: (f) => f === 1 };
    const { write, right, attr } = writerSetup('camera-velocity', frames);
    const v = new Vector3(0, 0, 1);
    const turning = write(0, v, 0).clone();
    const upright = write(1, v, 1).clone();
    expect(attr.array[0]).toBe(0);
    expect(attr.array[1]).toBe(1);
    expect(dirUnder(turning, X).dot(right)).toBeLessThan(0.99);
    expectVec(dirUnder(upright, X), right);
  });

  it("orient='velocity': an upright frame is unrotated but its heading is remembered", () => {
    let frame = 1;
    const frames: BulletFrames = { columns: 2, rows: 1, frame: () => frame, upright: (f) => f === 1 };
    const { write } = writerSetup('velocity', frames);
    const m = write(2, new Vector3(0, 0, 1));
    expectVec(dirUnder(m, X), X);
    // The cell changes to a turning one while the bullet is stopped: it points
    // the way it was last going, not along +X.
    frame = 0;
    const later = write(2, new Vector3());
    expectVec(dirUnder(later, X), new Vector3(0, 0, 1));
  });

  it('frame() receives the slot and the payload and its value lands in the attribute', () => {
    const calls: Array<[number, number]> = [];
    const frames: BulletFrames = {
      columns: 4,
      rows: 4,
      frame: (i, p) => {
        calls.push([i, p]);
        return p * 2;
      },
    };
    const { write, attr } = writerSetup('camera-velocity', frames);
    write(5, X, 3);
    expect(calls).toEqual([[5, 3]]);
    expect(attr.array[5]).toBe(6);
  });
});

// ===========================================================================
// 3. Mounted fields
// ===========================================================================

const FRAMES: BulletFrames = { columns: 2, rows: 2, frame: (_i, payload) => payload & 3 };

function spriteMaterial() {
  return <meshBasicMaterial map={atlas()} alphaTest={0.5} />;
}

describe('<BulletField frames> — external simulation', () => {
  it('draws a frames view of the geometry and writes each bullet\'s cell from its payload', async () => {
    const quad = bulletGeometry.quad();
    const sim = createBulletSimulation({ maxBullets: 16, boundsLimit: Infinity });
    sim.fireAt(ORIGIN, burst([{ payload: 0 }, { payload: 1 }, { payload: 2 }, { payload: 3 }]), 1);
    const { renderer } = await mountField({
      simulation: sim,
      geometry: quad,
      material: spriteMaterial(),
      frames: FRAMES,
      orient: 'camera-velocity',
      outline: { color: 'black', width: 0.05 },
    });
    await renderer.advanceFrames(1, 0.016);

    const mesh = meshOf(renderer);
    expect(mesh.geometry).not.toBe(quad);
    expect(mesh.geometry.attributes.position).toBe(quad.attributes.position);
    expect(quad.getAttribute(FRAME_ATTRIBUTE)).toBeUndefined();
    const attr = frameAttributeOf(mesh.geometry)!;
    expect(attr).not.toBeNull();
    expect(attr.version).toBeGreaterThan(0);
    const live = new Map<number, number>();
    sim.forEachActive((i, _p, payload) => {
      live.set(i, payload);
    });
    expect(live.size).toBe(4);
    for (const [slot, payload] of live) expect(attr.array[slot]).toBe(payload);

    // The material is patched, the alpha outline follows the frame.
    expect(isFramePatched(mesh.material as MeshBasicMaterial)).toBe(true);
    const outline = mesh.children.find((c) => c.name === OUTLINE_MESH_NAME) as OutlineMesh;
    expect((outline.material as MeshBasicMaterial).defines).toHaveProperty('OUTLINE_ALPHA');
    expect((outline.material as MeshBasicMaterial).defines).toHaveProperty('OUTLINE_FRAMES');
    // The outline draws the parent's (frames) geometry, so it sees the cell too.
    expect(outline.geometry).toBe(mesh.geometry);
  });

  it('rewrites cells as payloads change (the frame follows setPayload on the next write)', async () => {
    const sim = createBulletSimulation({ maxBullets: 8, boundsLimit: Infinity, interpolation: true });
    sim.fireAt(ORIGIN, burst([{ payload: 0 }]), 1);
    const { renderer } = await mountField({
      simulation: sim,
      interpolate: () => 1,
      geometry: bulletGeometry.quad(),
      material: spriteMaterial(),
      frames: FRAMES,
    });
    await renderer.advanceFrames(1, 0.016);
    const attr = frameAttributeOf(meshOf(renderer).geometry)!;
    let slot = -1;
    sim.forEachActive((i) => {
      slot = i;
    });
    expect(attr.array[slot]).toBe(0);
    sim.setPayload(slot, 3);
    sim.step(1 / 60);
    await renderer.advanceFrames(1, 0.016);
    expect(attr.array[slot]).toBe(3);
  });

  it('removing frames restores the consumer geometry and unpatches the material', async () => {
    const quad = bulletGeometry.quad();
    const sim = createBulletSimulation({ maxBullets: 8 });
    const material = new MeshBasicMaterial({ map: atlas(), alphaTest: 0.5 });
    const own = material.onBeforeCompile;
    const { renderer, render } = await mountField({
      simulation: sim,
      geometry: quad,
      material: <primitive object={material} attach="material" />,
      frames: FRAMES,
    });
    await renderer.advanceFrames(1, 0.016);
    expect(isFramePatched(material)).toBe(true);

    await render({ simulation: sim, geometry: quad, material: <primitive object={material} attach="material" /> });
    await renderer.advanceFrames(1, 0.016);
    expect(meshOf(renderer).geometry).toBe(quad);
    expect(isFramePatched(material)).toBe(false);
    expect(material.onBeforeCompile).toBe(own);
  });

  it('never disposes the consumer geometry when the frames view goes away', async () => {
    const quad = bulletGeometry.quad();
    const dispose = vi.spyOn(quad, 'dispose');
    const sim = createBulletSimulation({ maxBullets: 8 });
    const { renderer } = await mountField({ simulation: sim, geometry: quad, material: spriteMaterial(), frames: FRAMES });
    const view = meshOf(renderer).geometry as BufferGeometry;
    let viewDisposed = false;
    view.addEventListener('dispose', () => {
      viewDisposed = true;
    });
    await renderer.unmount();
    expect(viewDisposed).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('is ignored, with one warning, on the default sphere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = createBulletSimulation({ maxBullets: 8 });
    const { renderer } = await mountField({ simulation: sim, frames: FRAMES });
    await renderer.advanceFrames(1, 0.016);
    expect(frameAttributeOf(meshOf(renderer).geometry)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('frames'))).toBe(true);
    warn.mockRestore();
  });
});

describe('<BulletField frames> — owned field', () => {
  it('writes cells at the spawn write site and on every step', async () => {
    const seen: number[] = [];
    const frames: BulletFrames = {
      columns: 4,
      rows: 1,
      frame: (_i, payload) => {
        seen.push(payload);
        return payload;
      },
    };
    const { renderer, field } = await mountField({
      geometry: bulletGeometry.quad(),
      material: spriteMaterial(),
      frames,
      paused: true,
    });
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burst([{ payload: 2 }, { payload: 3 }]), 1);
    });
    // Paused: the spawn write is the only one, and it carries the cell.
    const attr = frameAttributeOf(meshOf(renderer).geometry)!;
    for (const [slot, payload] of liveSlots(field())) expect(attr.array[slot]).toBe(payload);
    expect(seen.sort()).toEqual([2, 3]);
  });

  it('BulletManager forwards frames to its field', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <BulletManager
        geometry={bulletGeometry.quad()}
        frames={FRAMES}
        pattern="ring"
        fireRate={0}
      >
        <meshBasicMaterial map={atlas()} alphaTest={0.5} />
      </BulletManager>,
    );
    expect(frameAttributeOf(meshOf(renderer).geometry)).not.toBeNull();
  });
});

describe("<BulletField orient='camera-velocity'> — mounted", () => {
  it('rolls each bullet toward its on-screen heading under the frame camera', async () => {
    const { renderer, field } = await mountField({ orient: 'camera-velocity', geometry: bulletGeometry.quad() });
    const cam = cameraBox.current!;
    cam.quaternion.copy(isoQuaternion());
    cam.updateMatrixWorld(true);
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burst([{ payload: 7, velocity: [0, 0, 2] }]), 1);
    });
    await renderer.advanceFrames(1, 0.016);
    const [[slot]] = [...liveSlots(field())];
    const m = new Matrix4();
    meshOf(renderer).getMatrixAt(slot, m);
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const v = new Vector3(0, 0, 1);
    const sx = v.dot(right);
    const sy = v.dot(up);
    const len = Math.hypot(sx, sy);
    expectVec(dirUnder(m, X), right.multiplyScalar(sx / len).addScaledVector(up, sy / len));
    expectVec(dirUnder(m, Y), new Vector3(0, 0, 1).applyQuaternion(cam.quaternion));
  });
});
