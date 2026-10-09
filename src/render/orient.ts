import {
  Matrix4,
  Quaternion,
  Vector3,
  type Camera,
  type InstancedMesh,
} from 'three';

/**
 * How each bullet instance is rotated.
 *
 * - `'none'` — no rotation; the instance matrix is translation × uniform
 *   scale, exactly as before 0.5.0. The default, and the cheapest.
 * - `'velocity'` — local **+X** is turned onto the bullet's current velocity,
 *   keeping local +Y as close to world +Y as the heading allows (yaw, then
 *   pitch — never roll). A velocity in the XZ plane is a pure rotation about
 *   Y, so a flat shape lying in XZ stays flat and keeps facing +Y; a 3D
 *   heading tilts it nose-up or nose-down without ever turning it face-down.
 *   Zero velocity keeps the bullet's last heading, and a bullet that has never
 *   moved stays unrotated.
 * - `'camera'` — billboard: every instance takes the camera's world rotation,
 *   with the shape's local **+Y** turned toward the camera, local +X to screen
 *   right and local −Z to screen up. A flat shape therefore looks on screen the
 *   way it would from directly above. Screen-aligned, not a per-instance
 *   `lookAt`: under a perspective camera, sprites near the frustum edge are
 *   parallel to the screen rather than turned toward the eye, which is the
 *   usual billboard trade and invisible at bullet sizes.
 */
export type BulletOrient = 'none' | 'velocity' | 'camera';

/** Below this squared speed a velocity is "zero" and carries no heading. */
const STILL_SQ = 1e-12;

/** A heading with less horizontal extent than this is straight up or down. */
const VERTICAL = 1e-9;

/** +90° about X: maps local +Y onto +Z (toward a camera) and −Z onto +Y. */
const FACE_CAMERA = /* @__PURE__ */ new Quaternion().setFromAxisAngle(
  /* @__PURE__ */ new Vector3(1, 0, 0),
  Math.PI / 2,
);

const EMPTY_DIRS = new Float32Array(0);

/**
 * The one place a **visible** bullet's instance matrix is composed.
 *
 * `<BulletField>` calls {@link write} from both "show" write sites — the
 * spawn-time write and the per-frame fade write — and keeps writing the
 * "hide" matrices itself. It owns three things the field does not:
 *
 * - **Orientation** ({@link BulletOrient}).
 * - **Base scale.** The default sphere has `bulletRadius` baked into its
 *   vertices, so its base scale is `1`. A consumer geometry is authored at unit
 *   size, so its base scale is `bulletRadius`. Either way the matrix scale is
 *   `base × mod.scale × fade`.
 * - **Last heading per slot**, for `'velocity'`: a `Float32Array` of
 *   `3 × maxBullets`, allocated on first use and only reallocated when the
 *   pool grows — never per frame.
 *
 * ## Allocation
 * None per call. All scratch is allocated once per writer, and the heading
 * quaternion is computed inline from scalars (square roots, no trig), so not
 * even a scratch `Vector3` is touched for the direction.
 *
 * ## `'none'` is byte-identical to 0.4.0
 * The `'none'` path is `Matrix4.compose(position, identity, (k, k, k))` — the
 * very call `Object3D.updateMatrix()` makes for the field's old scratch
 * `_dummy`, whose quaternion was never touched. Same inputs, same arithmetic,
 * same floats.
 */
export class InstanceWriter {
  /** Current orientation mode. Set by the owning hook, read per write. */
  orient: BulletOrient = 'none';
  /** `1` for the default sphere, `bulletRadius` for a consumer geometry. */
  baseScale = 1;
  /** Pool capacity hint, so the heading array is sized once. */
  capacity = 0;
  /**
   * Where `'camera'` mode finds the camera when a write happens before the
   * first frame has synced one (e.g. `fireAt` on a paused field at mount).
   */
  cameraSource: (() => Camera | null | undefined) | null = null;

  private readonly _m = new Matrix4();
  private readonly _q = new Quaternion();
  private readonly _s = new Vector3();
  private readonly _identity = new Quaternion();
  private readonly _cam = new Quaternion();
  private _camSynced = false;
  private _dirs: Float32Array = EMPTY_DIRS;

  /** Push the field's current render props in. Called by the owning hook. */
  configure(
    orient: BulletOrient,
    baseScale: number,
    capacity: number,
    cameraSource: (() => Camera | null | undefined) | null,
  ): void {
    if (orient !== 'camera') this._camSynced = false;
    this.orient = orient;
    this.baseScale = baseScale;
    this.capacity = capacity;
    this.cameraSource = cameraSource;
  }

  /**
   * Refresh the billboard rotation from `camera`'s **world** rotation. Called
   * once per frame (not per bullet) by the owning hook in `'camera'` mode;
   * `getWorldQuaternion` writes into the target it is given, so this allocates
   * nothing either.
   */
  syncCamera(camera: Camera): void {
    camera.getWorldQuaternion(this._cam).multiply(FACE_CAMERA);
    this._camSynced = true;
  }

  /**
   * Record a freshly spawned bullet's heading, before any matrix is written
   * for it. A recycled slot would otherwise inherit its previous occupant's
   * last heading — visible on a zero-velocity bullet, which has no heading of
   * its own to replace it.
   *
   * The field passes the **spawn data's** velocity, not the bullet's: in the
   * reduced-motion snapshot the bullet's velocity is forced to zero, and this is
   * what keeps those frozen arrows pointing the way the pattern aimed them.
   * A no-op unless `orient` is `'velocity'`.
   */
  prime(slot: number, velocity: Vector3): void {
    if (this.orient !== 'velocity') return;
    const dirs = this.dirsFor(slot);
    const o = slot * 3;
    const vx = velocity.x;
    const vy = velocity.y;
    const vz = velocity.z;
    const sq = vx * vx + vy * vy + vz * vz;
    if (sq > STILL_SQ) {
      const inv = 1 / Math.sqrt(sq);
      dirs[o] = vx * inv;
      dirs[o + 1] = vy * inv;
      dirs[o + 2] = vz * inv;
    } else {
      // (0, 0, 0) is "no heading yet" and reads back as unrotated.
      dirs[o] = 0;
      dirs[o + 1] = 0;
      dirs[o + 2] = 0;
    }
  }

  /**
   * Compose and store the matrix that **shows** a bullet: translation to
   * `position`, rotation per {@link orient}, uniform scale
   * `baseScale × scale`.
   *
   * Goes through `mesh.setMatrixAt`, never a direct buffer write, so the
   * perf suite's slot counter keeps seeing every write.
   */
  write(
    mesh: InstancedMesh,
    slot: number,
    position: Vector3,
    velocity: Vector3,
    scale: number,
  ): void {
    const k = scale * this.baseScale;
    this._s.set(k, k, k);

    let q = this._identity;
    if (this.orient === 'velocity') {
      q = this.headingQuaternion(slot, velocity);
    } else if (this.orient === 'camera') {
      if (!this._camSynced) {
        const cam = this.cameraSource?.();
        if (cam) this.syncCamera(cam);
      }
      q = this._cam;
    }

    this._m.compose(position, q, this._s);
    mesh.setMatrixAt(slot, this._m);
  }

  /**
   * The rotation taking local +X onto the bullet's heading **with local +Y kept
   * as close to world +Y as the heading allows** — a yaw about world Y to the
   * heading's horizontal direction, then a pitch about the yawed local Z up or
   * down to it. The Y-up `lookAt`, in other words, computed from scalars.
   *
   * ## Why not the shortest arc
   * `setFromUnitVectors(+X, d)` is the obvious tool and it is wrong for flat
   * shapes in a Y-up world: the arc rotates in the plane spanned by +X and
   * `d`, so any heading with a −X component and a little Y in it is reached by
   * rolling over the top. Measured: for `d = (−1, 0.01, 0)` it maps +Y to
   * (−0.01, **−1.00**, 0) — a face-up sprite turned face-down, which a
   * front-side material then culls. For headings in the XZ plane the two
   * constructions are the same rotation (a pure yaw), so a top-down game sees
   * no difference; the difference is entirely in what 3D patterns do.
   *
   * ## The math
   * With `h = √(dx² + dz²)`, the yaw ψ has `cos ψ = dx / h`,
   * `sin ψ = −dz / h`, and the pitch θ has `cos θ = h`, `sin θ = dy`. Half
   * angles come from `cos(a/2) = √((1 + cos a) / 2)` and its sine twin, so no
   * trig call is made, and `q = q_yaw · q_pitch` multiplies out to
   * `(sy·sp, sy·cp, cy·sp, cy·cp)`. Straight up or down (`h ≈ 0`) has no yaw;
   * it is taken as zero. Directly backwards (`d = −X`) is a half turn about Y,
   * and both signs of `sin ψ` there name the same rotation, so the result is
   * continuous through it.
   */
  private headingQuaternion(slot: number, velocity: Vector3): Quaternion {
    const dirs = this.dirsFor(slot);
    const o = slot * 3;
    let dx: number;
    let dy: number;
    let dz: number;

    const vx = velocity.x;
    const vy = velocity.y;
    const vz = velocity.z;
    const sq = vx * vx + vy * vy + vz * vz;
    if (sq > STILL_SQ) {
      const inv = 1 / Math.sqrt(sq);
      dx = vx * inv;
      dy = vy * inv;
      dz = vz * inv;
      dirs[o] = dx;
      dirs[o + 1] = dy;
      dirs[o + 2] = dz;
    } else {
      // Stopped: keep the last heading. Never normalizes a zero vector, so a
      // bullet at rest can never produce NaN.
      dx = dirs[o];
      dy = dirs[o + 1];
      dz = dirs[o + 2];
      if (dx === 0 && dy === 0 && dz === 0) return this._identity;
    }

    // Yaw half-angle (about world Y).
    const h = Math.sqrt(dx * dx + dz * dz);
    let cy = 1;
    let sy = 0;
    if (h > VERTICAL) {
      const cosYaw = dx / h;
      cy = Math.sqrt(Math.max(0, (1 + cosYaw) * 0.5));
      sy = Math.sqrt(Math.max(0, (1 - cosYaw) * 0.5));
      if (dz > 0) sy = -sy; // sin ψ = −dz / h
    }

    // Pitch half-angle (about the yawed local Z). cos θ = h ≥ 0, sin θ = dy.
    const hc = h > 1 ? 1 : h;
    const cp = Math.sqrt((1 + hc) * 0.5);
    let sp = Math.sqrt((1 - hc) * 0.5);
    if (dy < 0) sp = -sp;

    return this._q.set(sy * sp, sy * cp, cy * sp, cy * cp);
  }

  /** The heading array, grown (rarely, never per frame) to cover `slot`. */
  private dirsFor(slot: number): Float32Array {
    if ((slot + 1) * 3 > this._dirs.length) {
      const size = Math.max(this.capacity, slot + 1) * 3;
      const next = new Float32Array(size);
      next.set(this._dirs.subarray(0, Math.min(this._dirs.length, size)));
      this._dirs = next;
    }
    return this._dirs;
  }
}
