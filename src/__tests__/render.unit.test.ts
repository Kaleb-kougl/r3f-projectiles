import { describe, it, expect } from 'vitest';
import {
  BufferGeometry,
  DataTexture,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  ShaderLib,
  SphereGeometry,
  Vector3,
  BackSide,
  DoubleSide,
} from 'three';
import { bulletGeometry, OUTLINE_DIRECTION_ATTRIBUTE } from '../render/geometry';
import { InstanceWriter } from '../render/orient';
import {
  createOutlineMesh,
  configureOutline,
  disposeOutlineMesh,
  patchOutlineShader,
  resolveOutlineMode,
  syncOutline,
} from '../render/outline';

/**
 * The 0.5.0 render pieces in isolation — no React, no field. What a mounted
 * `<BulletField>` does with them is in `BulletField.render.test.tsx`.
 */

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

function expectVec(actual: Vector3, expected: Vector3, digits = 5) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

// ===========================================================================
// bulletGeometry
// ===========================================================================

describe('bulletGeometry', () => {
  const shapes = {
    quad: () => bulletGeometry.quad(),
    arrow: () => bulletGeometry.arrow(),
    diamond: () => bulletGeometry.diamond(),
    'narrow arrow': () => bulletGeometry.arrow({ headLength: 0.6, headWidth: 0.4, shaftWidth: 0.1 }),
  };

  for (const [name, make] of Object.entries(shapes)) {
    describe(name, () => {
      const g = make();
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      const nrm = g.getAttribute('normal');
      const dir = g.getAttribute(OUTLINE_DIRECTION_ATTRIBUTE);
      const index = g.getIndex()!;

      it('has position, normal, uv, outlineDirection and an index', () => {
        expect(pos.itemSize).toBe(3);
        expect(nrm.itemSize).toBe(3);
        expect(uv.itemSize).toBe(2);
        expect(dir.itemSize).toBe(3);
        expect(index.count % 3).toBe(0);
        expect(index.count).toBeGreaterThanOrEqual(6);
      });

      it('lies flat in XZ, within unit size, facing +Y', () => {
        for (let i = 0; i < pos.count; i++) {
          expect(pos.getY(i)).toBe(0);
          expect(Math.abs(pos.getX(i))).toBeLessThanOrEqual(1);
          expect(Math.abs(pos.getZ(i))).toBeLessThanOrEqual(1);
          expect(nrm.getY(i)).toBe(1);
        }
        // Every triangle's front face is up.
        const a = new Vector3();
        const b = new Vector3();
        const c = new Vector3();
        for (let t = 0; t < index.count; t += 3) {
          a.fromBufferAttribute(pos, index.getX(t));
          b.fromBufferAttribute(pos, index.getX(t + 1));
          c.fromBufferAttribute(pos, index.getX(t + 2));
          const n = b.clone().sub(a).cross(c.clone().sub(a));
          expect(n.y).toBeGreaterThan(0);
        }
      });

      it('maps UVs planarly: u = 0.5 + x/2, v = 0.5 − z/2', () => {
        for (let i = 0; i < pos.count; i++) {
          expect(uv.getX(i)).toBeCloseTo(0.5 + pos.getX(i) / 2, 6);
          expect(uv.getY(i)).toBeCloseTo(0.5 - pos.getZ(i) / 2, 6);
        }
      });

      it('offsets outward, in-plane, by at least one width per vertex', () => {
        for (let i = 0; i < dir.count; i++) {
          expect(dir.getY(i)).toBe(0);
          const len = Math.hypot(dir.getX(i), dir.getZ(i));
          expect(len).toBeGreaterThanOrEqual(1 - 1e-6);
          expect(len).toBeLessThanOrEqual(2.5 + 1e-6);
        }
      });

      it('returns a new geometry every call', () => {
        expect(make()).not.toBe(make());
      });
    });
  }

  it('quad spans [-1, 1]² and its corners mitre to (±1, 0, ±1)', () => {
    const g = bulletGeometry.quad();
    const pos = g.getAttribute('position');
    const dir = g.getAttribute(OUTLINE_DIRECTION_ATTRIBUTE);
    expect(pos.count).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(pos.getX(i))).toBe(1);
      expect(Math.abs(pos.getZ(i))).toBe(1);
      expect(dir.getX(i)).toBeCloseTo(pos.getX(i), 6);
      expect(dir.getZ(i)).toBeCloseTo(pos.getZ(i), 6);
    }
  });

  it('arrow and diamond point along +X: the forward-most vertex is (1, 0, 0)', () => {
    for (const g of [bulletGeometry.arrow(), bulletGeometry.diamond()]) {
      const pos = g.getAttribute('position');
      let best = 0;
      for (let i = 1; i < pos.count; i++) if (pos.getX(i) > pos.getX(best)) best = i;
      expect(pos.getX(best)).toBe(1);
      expect(pos.getZ(best)).toBe(0);
    }
  });

  it("a diamond's mitred offset moves each edge out by exactly one width", () => {
    // Edge from tip (1,0,0) to side (0,0,-w); offset both ends, measure the
    // distance from the moved edge's midpoint to the original edge line.
    const g = bulletGeometry.diamond({ width: 0.5 });
    const pos = g.getAttribute('position');
    const dir = g.getAttribute(OUTLINE_DIRECTION_ATTRIBUTE);
    const W = 0.1;
    const p = (i: number) => new Vector3().fromBufferAttribute(pos, i);
    const d = (i: number) => new Vector3().fromBufferAttribute(dir, i);
    for (let i = 0; i < pos.count; i++) {
      const j = (i + 1) % pos.count;
      const a = p(i);
      const b = p(j);
      const am = a.clone().addScaledVector(d(i), W);
      const bm = b.clone().addScaledVector(d(j), W);
      const mid = am.add(bm).multiplyScalar(0.5);
      const edge = b.clone().sub(a).normalize();
      const rel = mid.clone().sub(a);
      const dist = rel.sub(edge.multiplyScalar(rel.dot(edge))).length();
      expect(dist).toBeCloseTo(W, 6);
    }
  });
});

// ===========================================================================
// InstanceWriter
// ===========================================================================

describe('InstanceWriter', () => {
  function rig(orient: 'none' | 'velocity' | 'camera', baseScale = 1) {
    const mesh = new InstancedMesh(new BufferGeometry(), undefined, 8);
    const w = new InstanceWriter();
    w.configure(orient, baseScale, 8, null);
    const m = new Matrix4();
    const read = (slot: number) => {
      mesh.getMatrixAt(slot, m);
      return m;
    };
    return { mesh, w, read };
  }
  const P = new Vector3(1, 2, 3);
  const ZERO = new Vector3();

  it("'none' composes position × identity × (base · scale), like Object3D", () => {
    const { mesh, w, read } = rig('none', 0.5);
    w.write(mesh, 0, P, new Vector3(0, 0, 9), 3);
    const o = new Object3D();
    o.position.copy(P);
    o.scale.setScalar(1.5);
    o.updateMatrix();
    expect(read(0).elements).toEqual(
      Array.from(new Float32Array(o.matrix.elements)),
    );
  });

  it("'velocity' rotates +X onto the heading for a spread of directions", () => {
    const { mesh, w, read } = rig('velocity');
    const dirs = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [3, -4, 12],
      [-1, 1e-9, 0],
      [-1, 0, 1e-4],
      [0.2, 0.3, -0.9],
    ];
    for (const v of dirs) {
      const vel = new Vector3(...(v as [number, number, number]));
      w.write(mesh, 1, P, vel, 2);
      const m = read(1);
      for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
      expectVec(X.clone().transformDirection(m), vel.clone().normalize());
      expect(new Vector3().setFromMatrixColumn(m, 0).length()).toBeCloseTo(2, 5);
      expectVec(new Vector3().setFromMatrixPosition(m), P);
    }
  });

  it("'velocity' in XZ is a pure rotation about Y (flat shapes stay face-up)", () => {
    const { mesh, w, read } = rig('velocity');
    for (let a = 0; a < Math.PI * 2; a += 0.37) {
      w.write(mesh, 2, P, new Vector3(Math.cos(a), 0, Math.sin(a)), 1);
      expectVec(Y.clone().transformDirection(read(2)), Y);
    }
  });

  it("'velocity' never rolls a flat shape face-down — the case shortest-arc gets wrong", () => {
    // setFromUnitVectors(+X, (-1, 0.01, 0)) maps +Y to (-0.01, -1, 0): a
    // face-up sprite turned face-down. Yaw-then-pitch keeps up in the vertical
    // plane through the heading, so up·Y = cos(pitch) ≥ 0 for every heading.
    const { mesh, w, read } = rig('velocity');
    const v = new Vector3();
    for (let i = 0; i < 400; i++) {
      // Deterministic spread over the sphere (golden-angle spiral).
      const y = 1 - (2 * (i + 0.5)) / 400;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.399963229728653;
      v.set(Math.cos(a) * r, y, Math.sin(a) * r);
      w.write(mesh, 6, P, v, 1);
      const m = read(6);
      const up = Y.clone().transformDirection(m);
      expect(up.y).toBeCloseTo(Math.sqrt(1 - y * y), 5);
      expectVec(X.clone().transformDirection(m), v);
    }
    w.write(mesh, 6, P, new Vector3(-1, 0.01, 0), 1);
    expect(Y.clone().transformDirection(read(6)).y).toBeGreaterThan(0.99);
  });

  it("'velocity' in XZ matches setFromUnitVectors exactly where both are right", () => {
    const { mesh, w, read } = rig('velocity');
    const q = new Quaternion();
    const expected = new Matrix4();
    for (let a = 0.05; a < Math.PI * 2; a += 0.41) {
      const d = new Vector3(Math.cos(a), 0, Math.sin(a));
      w.write(mesh, 7, P, d, 1);
      q.setFromUnitVectors(X, d);
      expected.compose(P, q, new Vector3(1, 1, 1));
      const got = read(7).elements;
      expected.elements.forEach((e, k) => expect(got[k]).toBeCloseTo(e, 5));
    }
  });

  it("'velocity' straight up or down pitches without NaN", () => {
    const { mesh, w, read } = rig('velocity');
    for (const vy of [1, -1]) {
      w.write(mesh, 0, P, new Vector3(0, vy * 3, 0), 1);
      const m = read(0);
      for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
      expectVec(X.clone().transformDirection(m), new Vector3(0, vy, 0));
    }
  });

  it("'velocity' keeps the LAST heading at zero velocity — not the spawn one", () => {
    const { mesh, w, read } = rig('velocity');
    w.prime(3, new Vector3(1, 0, 0)); // spawned heading +X
    w.write(mesh, 3, P, new Vector3(0, 0, 5), 1); // turned to +Z
    w.write(mesh, 3, P, ZERO, 1); // stopped
    expectVec(X.clone().transformDirection(read(3)), new Vector3(0, 0, 1));
  });

  it("'velocity' primes from spawn data and resets a recycled slot", () => {
    const { mesh, w, read } = rig('velocity');
    w.write(mesh, 4, P, new Vector3(0, 0, -1), 1);
    w.prime(4, new Vector3(0, 0, 2)); // new occupant, aimed +Z
    w.write(mesh, 4, P, ZERO, 1);
    expectVec(X.clone().transformDirection(read(4)), new Vector3(0, 0, 1));

    w.prime(4, ZERO); // new occupant with no heading at all
    w.write(mesh, 4, P, ZERO, 1);
    expectVec(X.clone().transformDirection(read(4)), X);
  });

  it('grows its heading array past the capacity hint instead of throwing', () => {
    const mesh = new InstancedMesh(new BufferGeometry(), undefined, 64);
    const w = new InstanceWriter();
    w.configure('velocity', 1, 2, null);
    w.write(mesh, 40, P, new Vector3(0, 0, 1), 1);
    w.write(mesh, 40, P, ZERO, 1);
    const m = new Matrix4();
    mesh.getMatrixAt(40, m);
    expectVec(X.clone().transformDirection(m), new Vector3(0, 0, 1));
  });

  it("'camera' uses the camera's world rotation × (+Y → toward camera)", () => {
    const { mesh, w, read } = rig('camera');
    const parent = new Object3D();
    parent.rotation.set(0, 0.4, 0);
    const cam = new OrthographicCamera();
    cam.rotation.set(-0.9, 0.3, 0, 'YXZ');
    parent.add(cam);
    parent.updateMatrixWorld(true);

    w.syncCamera(cam);
    w.write(mesh, 5, P, new Vector3(1, 0, 0), 1);
    const world = cam.getWorldQuaternion(new Quaternion());
    const m = read(5);
    expectVec(Y.clone().transformDirection(m), new Vector3(0, 0, 1).applyQuaternion(world));
    expectVec(X.clone().transformDirection(m), new Vector3(1, 0, 0).applyQuaternion(world));
  });

  it("'camera' pulls the camera from its source when no frame has synced one", () => {
    const mesh = new InstancedMesh(new BufferGeometry(), undefined, 2);
    const w = new InstanceWriter();
    const cam = new OrthographicCamera();
    cam.quaternion.setFromAxisAngle(Y, 1);
    w.configure('camera', 1, 2, () => cam);
    w.write(mesh, 0, P, ZERO, 1);
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    expectVec(X.clone().transformDirection(m), X.clone().applyQuaternion(cam.quaternion));
  });
});

// ===========================================================================
// Outline: mode resolution, shader patch, sync
// ===========================================================================

describe('resolveOutlineMode', () => {
  const plain = new MeshBasicMaterial();
  const tex = new DataTexture(new Uint8Array(4), 1, 1);

  it("'auto' picks hull for closed 3D geometry", () => {
    expect(resolveOutlineMode('auto', new SphereGeometry(1, 6, 6), plain)).toBe('hull');
  });

  it("'auto' picks extrude for a helper shape", () => {
    expect(resolveOutlineMode(undefined, bulletGeometry.arrow(), plain)).toBe('extrude');
  });

  it("'auto' picks scale for a flat geometry with no outlineDirection", () => {
    const flat = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    expect(resolveOutlineMode('auto', flat, plain)).toBe('scale');
  });

  it("'auto' picks alpha for an alpha-tested or transparent textured material", () => {
    const quad = bulletGeometry.quad();
    expect(resolveOutlineMode('auto', quad, new MeshBasicMaterial({ map: tex, alphaTest: 0.5 }))).toBe('alpha');
    expect(resolveOutlineMode('auto', quad, new MeshBasicMaterial({ map: tex, transparent: true }))).toBe('alpha');
    // An opaque textured quad has a rectangular silhouette: extrude is right.
    expect(resolveOutlineMode('auto', quad, new MeshBasicMaterial({ map: tex }))).toBe('extrude');
  });

  it("'auto' never picks hull for a 3D geometry without normals", () => {
    const g = new SphereGeometry(1, 6, 6);
    g.deleteAttribute('normal');
    expect(resolveOutlineMode('auto', g, plain)).toBe('scale');
  });

  it('an explicit mode wins', () => {
    expect(resolveOutlineMode('scale', new SphereGeometry(), plain)).toBe('scale');
  });
});

describe('patchOutlineShader', () => {
  it("hooks into three's real meshbasic sources at both anchors", () => {
    const shader = {
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    };
    patchOutlineShader(shader);
    expect(shader.vertexShader).toContain('uniform float outlineWidth;');
    expect(shader.vertexShader).toContain('transformed += normalize( normal ) * outlineWidth;');
    expect(shader.vertexShader).toContain(`transformed += ${OUTLINE_DIRECTION_ATTRIBUTE} * outlineWidth;`);
    expect(shader.vertexShader).toContain('transformed *= outlineScale;');
    expect(shader.vertexShader).toContain('vOutlineUv =');
    expect(shader.fragmentShader).toContain('float outlineDilatedAlpha( vec2 uv )');
    expect(shader.fragmentShader).toContain('< outlineAlphaTest ) discard;');
    // The originals are kept, once each, and the injections come after them.
    expect(shader.vertexShader.split('#include <begin_vertex>')).toHaveLength(2);
    expect(shader.fragmentShader.split('#include <alphatest_fragment>')).toHaveLength(2);
    expect(shader.vertexShader.indexOf('#include <begin_vertex>')).toBeLessThan(
      shader.vertexShader.indexOf('outlineWidth;\n#elif'),
    );
  });
});

describe('syncOutline', () => {
  it('derives side, depth offset and uniforms from the resolved mode', () => {
    const tex = new DataTexture(new Uint8Array(4), 1, 1);
    const mainMat = new MeshBasicMaterial({ map: tex, alphaTest: 0.3 });
    const quad = bulletGeometry.quad();
    const mesh = new InstancedMesh(quad, mainMat, 4);
    const o = createOutlineMesh();
    const mat = o.material as MeshBasicMaterial;

    configureOutline(o, 'black', 0.05, undefined);
    syncOutline(o, mesh, 0.25);
    expect(o.parent).toBe(mesh);
    expect(mat.defines).toHaveProperty('OUTLINE_ALPHA');
    expect(mat.defines).toHaveProperty('OUTLINE_EXTRUDE'); // quad has directions
    expect(mat.side).toBe(DoubleSide);
    expect(mat.polygonOffset).toBe(true);
    const u = o.__outline.uniforms;
    expect(u.outlineWidth.value).toBeCloseTo(0.2, 6); // 0.05 / 0.25
    expect(u.outlineUvRadius.value).toBeCloseTo(0.1, 6);
    expect(u.outlineMap.value).toBe(tex);
    expect(u.outlineUvTransform.value).toBe(tex.matrix);
    expect(u.outlineAlphaTest.value).toBeCloseTo(0.3, 6);

    // Swap to a sphere: hull, back faces, no offset, and a recompile.
    const version = mat.version;
    mesh.geometry = new SphereGeometry(0.12, 6, 6);
    mesh.material = new MeshBasicMaterial();
    syncOutline(o, mesh, 1);
    expect(mat.defines).toEqual({ OUTLINE_HULL: '' });
    expect(mat.side).toBe(BackSide);
    expect(mat.polygonOffset).toBe(false);
    expect(mat.version).toBeGreaterThan(version);

    // A steady-state sync does not recompile.
    const steady = mat.version;
    syncOutline(o, mesh, 1);
    expect(mat.version).toBe(steady);

    // 'scale' uses the bounding radius about the origin.
    const flat = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2); // corners at √2
    mesh.geometry = flat;
    configureOutline(o, 'black', 0.1, 'scale');
    syncOutline(o, mesh, 1);
    expect(o.__outline.uniforms.outlineScale.value).toBeCloseTo(1 + 0.1 / Math.SQRT2, 6);

    disposeOutlineMesh(o);
    expect(o.parent).toBeNull();
  });
});
