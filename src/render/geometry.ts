import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';

// ---------------------------------------------------------------------------
// Ready-made bullet geometries
// ---------------------------------------------------------------------------
//
// ## The convention every bullet geometry follows
//
// - **Forward is local +X.** `orient="velocity"` rotates local +X onto the
//   bullet's direction of travel, so an arrow must point along +X.
// - **Up is local +Y.** Flat shapes lie in the XZ plane and face +Y — the way
//   a ground decal does in a Y-up world. `orient="camera"` turns that +Y face
//   toward the camera.
// - **Unit size.** Shapes span roughly `[-1, 1]` along X. A custom geometry is
//   scaled by the field's `bulletRadius` (and per bullet by `mod.scale`), so
//   `bulletRadius` keeps meaning "half the bullet's length".
//
// ## Planar UVs
// Every helper maps object XZ onto UV the same way:
//
//     u = 0.5 + x / 2        v = 0.5 − z / 2
//
// so a texture's **right edge is the shape's forward** and its top edge is
// local −Z (which a top-down camera shows as "up"). Draw sprite art pointing
// right. The alpha-dilation outline relies on this mapping — see
// `outline.ts`.
//
// ## Ownership
// Each call builds and returns a **new** geometry, and it is yours: the field
// never disposes a geometry it did not create. Build one per look with
// `useMemo`, share it between as many fields as you like, and dispose it when
// you are done with it.

/**
 * Name of the optional per-vertex attribute that tells the outline pass which
 * way is "outward" for a flat shape: a vector in the shape's plane such that
 * pushing the vertex by `width × outlineDirection` moves both adjacent edges
 * out by exactly `width` (a mitred offset). Every `bulletGeometry` helper
 * writes it. A custom flat geometry without it still gets an outline, scaled
 * about its origin instead — see {@link BulletOutline}.
 */
export const OUTLINE_DIRECTION_ATTRIBUTE = 'outlineDirection';

/**
 * Longest a mitred outline offset may get, as a multiple of the outline width.
 * A sharp tip's miter grows like `1 / sin(θ/2)`; clamping it keeps a needle
 * arrow from sprouting a spike, at the cost of a slightly thinner rim right at
 * the tip.
 */
const MITER_LIMIT = 2.5;

/**
 * Build a flat, +Y-facing geometry from a polygon given in "screen" coordinates
 * — `x` forward, `y` toward local −Z — counter-clockwise.
 *
 * Triangulated with three's earcut, then every triangle's winding is checked
 * against +Y and flipped if needed, so the front face is up regardless of what
 * the triangulator handed back.
 */
function flatPolygon(points: ReadonlyArray<readonly [number, number]>): BufferGeometry {
  const n = points.length;
  const contour = points.map(([x, y]) => new Vector2(x, y));
  const faces = ShapeUtils.triangulateShape(contour, []);

  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const outline = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const [x, y] = points[i];
    const z = 0 - y; // `0 - 0` is +0; `-0` would be -0
    position[i * 3] = x;
    position[i * 3 + 1] = 0;
    position[i * 3 + 2] = z;
    normal[i * 3 + 1] = 1;
    uv[i * 2] = 0.5 + x / 2;
    uv[i * 2 + 1] = 0.5 - z / 2;

    // ---- mitred outward offset -------------------------------------------
    // For a CCW polygon the outward normal of edge (dx, dy) is (dy, −dx).
    const [px, py] = points[(i + n - 1) % n];
    const [nx, ny] = points[(i + 1) % n];
    let e1x = x - px;
    let e1y = y - py;
    let e2x = nx - x;
    let e2y = ny - y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    e1x /= l1;
    e1y /= l1;
    e2x /= l2;
    e2y /= l2;
    const n1x = e1y;
    const n1y = -e1x;
    const n2x = e2y;
    const n2y = -e2x;
    const denom = 1 + n1x * n2x + n1y * n2y;
    let mx = denom > 1e-6 ? (n1x + n2x) / denom : n1x;
    let my = denom > 1e-6 ? (n1y + n2y) / denom : n1y;
    const ml = Math.hypot(mx, my);
    if (ml > MITER_LIMIT) {
      mx *= MITER_LIMIT / ml;
      my *= MITER_LIMIT / ml;
    }
    outline[i * 3] = mx;
    outline[i * 3 + 1] = 0;
    outline[i * 3 + 2] = 0 - my;
  }

  const index: number[] = [];
  for (const [a, b, c] of faces) {
    // y-component of (B − A) × (C − A) in 3D; positive means the face is up.
    const abx = position[b * 3] - position[a * 3];
    const abz = position[b * 3 + 2] - position[a * 3 + 2];
    const acx = position[c * 3] - position[a * 3];
    const acz = position[c * 3 + 2] - position[a * 3 + 2];
    const up = abz * acx - abx * acz;
    if (up >= 0) index.push(a, b, c);
    else index.push(a, c, b);
  }

  const g = new BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute(OUTLINE_DIRECTION_ATTRIBUTE, new Float32BufferAttribute(outline, 3));
  g.computeBoundingSphere();
  return g;
}

/** Options for {@link bulletGeometry.arrow}. All lengths are in unit space. */
export interface ArrowGeometryOptions {
  /** Length of the head, from the tip back. @default 0.9 */
  headLength?: number;
  /** Half-width of the head at its base. @default 0.75 */
  headWidth?: number;
  /** Half-width of the shaft. @default 0.28 */
  shaftWidth?: number;
}

/** Options for {@link bulletGeometry.diamond}. */
export interface DiamondGeometryOptions {
  /** Half-width across the forward axis. `1` is a square diamond. @default 0.5 */
  width?: number;
}

/**
 * Ready-made flat bullet geometries. See the convention at the top of this
 * module: forward is +X, up is +Y, unit size, planar UVs, and **each call
 * returns a new geometry you own**.
 *
 * ```tsx
 * const arrow = useMemo(() => bulletGeometry.arrow(), []);
 * useEffect(() => () => arrow.dispose(), [arrow]);
 * <BulletField geometry={arrow} orient="velocity" bulletRadius={0.3} />
 * ```
 */
export const bulletGeometry = {
  /**
   * A unit quad, `[-1, 1]` on X and Z, lying in the XZ plane and facing +Y,
   * with UVs (`u` along +X, `v` along −Z). The canvas for a textured sprite:
   * pair it with a `map` + `alphaTest` material, art drawn pointing right.
   */
  quad(): BufferGeometry {
    return flatPolygon([
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]);
  },

  /**
   * A flat arrow pointing along +X: tip at `x = 1`, tail at `x = −1`.
   */
  arrow(options: ArrowGeometryOptions = {}): BufferGeometry {
    const hl = options.headLength ?? 0.9;
    const hw = options.headWidth ?? 0.75;
    const sw = Math.min(options.shaftWidth ?? 0.28, hw);
    const base = 1 - hl;
    return flatPolygon([
      [1, 0],
      [base, hw],
      [base, sw],
      [-1, sw],
      [-1, -sw],
      [base, -sw],
      [base, -hw],
    ]);
  },

  /**
   * A flat diamond — a shard — pointing along +X: tips at `x = ±1`, half-width
   * `width` across. Narrow it (`width: 0.3`) for a needle.
   */
  diamond(options: DiamondGeometryOptions = {}): BufferGeometry {
    const w = options.width ?? 0.5;
    return flatPolygon([
      [1, 0],
      [0, w],
      [-1, 0],
      [0, -w],
    ]);
  },
};
