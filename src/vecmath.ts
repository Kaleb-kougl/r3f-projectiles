// ---------------------------------------------------------------------------
// Vector arithmetic the library owns, operation for operation (0.8.0)
// ---------------------------------------------------------------------------
//
// Internal: not exported from any entry.
//
// Generators and modifiers used to call three's `Vector3` / `Quaternion`
// methods (`normalize`, `crossVectors`, `setFromAxisAngle`, `applyQuaternion`).
// Their internal operation order is three's to change between releases (the
// library's peer range is `three >= 0.150`), so a three upgrade could move a
// pattern's bits. These helpers do the arithmetic here and only **store** into
// the vector's fields, so a result depends on the library version alone.
//
// Each helper replicates three r184's method exactly — the same operations in
// the same order — so on the three the library is tested against the results
// are bit-identical to calling three (`src/__tests__/patterns.detmath.test.ts`
// pins that against a verbatim copy of 0.7.0). The trig comes from
// `./detmath`, never `Math.sin` / `Math.cos`.
//
// Only `+ - * /` and `Math.sqrt` (correctly rounded by ECMAScript) are used.

import { detSinCos, type SinCos } from './detmath';

/** Anything with mutable numeric `x`, `y`, `z` — a `Vector3` included. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A rotation quaternion, `(x, y, z)` the vector part and `w` the scalar. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Normalize `v` in place and return it. Three's `Vector3.normalize()`:
 * `divideScalar(length() || 1)`, i.e. `s = 1 / (sqrt(x*x + y*y + z*z) || 1)`,
 * then each component `*= s`. A zero (or NaN) length divides by 1, so the
 * zero vector stays zero.
 */
export function normalize3<T extends Vec3Like>(v: T): T {
  const s = 1 / (Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1);
  v.x *= s;
  v.y *= s;
  v.z *= s;
  return v;
}

/**
 * `out = a × b`, returned. Three's `Vector3.crossVectors(a, b)`: every input
 * component is read before anything is written, so `out` may alias `a` or `b`.
 */
export function cross3<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like): T {
  const ax = a.x, ay = a.y, az = a.z;
  const bx = b.x, by = b.y, bz = b.z;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

const _sc: SinCos = { s: 0, c: 0 };

/**
 * Write the rotation of `angle` radians about `axis` into `out`, returned.
 * Three's `Quaternion.setFromAxisAngle(axis, angle)`: `halfAngle = angle / 2`,
 * `(x, y, z) = axis · sin(halfAngle)`, `w = cos(halfAngle)`, with
 * {@link detSinCos} for the trig. `axis` is assumed normalized and not
 * modified.
 */
export function quatFromAxisAngle(out: Quat, axis: Vec3Like, angle: number): Quat {
  const halfAngle = angle / 2;
  detSinCos(halfAngle, _sc);
  const s = _sc.s;
  out.x = axis.x * s;
  out.y = axis.y * s;
  out.z = axis.z * s;
  out.w = _sc.c;
  return out;
}

/**
 * Rotate `v` in place by the unit quaternion `q` and return it. Three's
 * `Vector3.applyQuaternion(q)` (r151+): `t = 2 · (q.xyz × v)`, then
 * `v + q.w · t + q.xyz × t`, summed left to right per component.
 */
export function applyQuat3<T extends Vec3Like>(v: T, q: Quat): T {
  const vx = v.x, vy = v.y, vz = v.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  v.x = vx + qw * tx + qy * tz - qz * ty;
  v.y = vy + qw * ty + qz * tx - qx * tz;
  v.z = vz + qw * tz + qx * ty - qy * tx;
  return v;
}
