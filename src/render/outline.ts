import {
  BackSide,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  MeshBasicMaterial,
  type ColorRepresentation,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { OUTLINE_DIRECTION_ATTRIBUTE } from './geometry';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * How the outline shell is grown from the bullet's own geometry.
 *
 * - `'hull'` — inverted hull: vertices pushed out along their **normals**,
 *   back faces only. For closed 3D geometry (the default sphere).
 * - `'extrude'` — vertices pushed out along the geometry's
 *   `outlineDirection` attribute, a mitred in-plane offset every
 *   `bulletGeometry` helper provides. Uniform rim width on flat polygons.
 * - `'scale'` — the shape scaled about its origin by `(R + width) / R`, `R`
 *   being its bounding radius. For a flat geometry with no `outlineDirection`.
 *   Exact for a circle; for anything else the rim is thinner where the
 *   outline sits closer to the origin than `R`.
 * - `'alpha'` — for **alpha-textured sprites**. The quad is grown as above and
 *   the outline samples the main material's `map` alpha at 16 offsets around
 *   each fragment, so the rim follows the sprite's silhouette rather than the
 *   quad's. Requires the planar UVs `bulletGeometry.quad()` uses.
 * - `'auto'` (default) — `'alpha'` if the bullet material has a `map` and is
 *   alpha-tested or transparent; else `'extrude'` if the geometry has an
 *   `outlineDirection` attribute; else `'scale'` if the geometry is flat
 *   (no extent on Y) or has no normals; else `'hull'`.
 */
export type OutlineMode = 'auto' | 'hull' | 'extrude' | 'scale' | 'alpha';

/** {@link OutlineMode} with `'auto'` resolved. */
export type ResolvedOutlineMode = Exclude<OutlineMode, 'auto'>;

/**
 * A dark rim drawn behind every bullet in a field, for readability.
 *
 * Rendered by a second instanced mesh that **shares the field's
 * `instanceMatrix` attribute and live `count`** — the per-bullet CPU work is
 * done once, for the bullet, and the outline rides along for one extra draw
 * call. So it moves, rotates, scales and fades with its bullet for free.
 */
export interface BulletOutline {
  /** Outline color, uniform across the field. */
  color: ColorRepresentation;
  /**
   * Rim width in **world units at the bullet's base size** — `bulletRadius`,
   * `mod.scale(1)`, unfaded. It scales with the instance like the rest of the
   * bullet: a `mod.scale(2)` bullet gets a rim twice as wide, and the rim
   * shrinks to nothing with the fade. `0` hides the outline.
   */
  width: number;
  /** How the shell is grown. @default 'auto' */
  mode?: OutlineMode;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

/** A geometry is "flat" when its Y extent is this small relative to X/Z. */
const FLAT_EPSILON = 1e-6;

/** The `map` an alpha-dilation outline should sample, if the material has one. */
export function spriteMapOf(material: Material | Material[] | null | undefined): Texture | null {
  if (!material || Array.isArray(material)) return null;
  const map = (material as Material & { map?: Texture | null }).map;
  return map ?? null;
}

/**
 * Resolve `'auto'` against the bullet's actual geometry and material. Pure,
 * cheap after the first call per geometry (three caches the bounding box on
 * the geometry), and allocation-free once that box exists.
 */
export function resolveOutlineMode(
  requested: OutlineMode | undefined,
  geometry: BufferGeometry,
  material: Material | Material[] | null | undefined,
): ResolvedOutlineMode {
  if (requested && requested !== 'auto') return requested;

  const map = spriteMapOf(material);
  if (map && !Array.isArray(material) && material && (material.alphaTest > 0 || material.transparent)) {
    return 'alpha';
  }
  if (geometry.getAttribute(OUTLINE_DIRECTION_ATTRIBUTE)) return 'extrude';
  if (isFlat(geometry)) return 'scale';
  // A hull is pushed along normals; with none, GL would hand the shader a zero
  // vector to normalize. Scaling is the safe fallback.
  if (!geometry.getAttribute('normal')) return 'scale';
  return 'hull';
}

function isFlat(geometry: BufferGeometry): boolean {
  if (!geometry.getAttribute('position')) return false;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  const ey = b.max.y - b.min.y;
  const exz = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
  return exz > 0 && ey <= exz * FLAT_EPSILON;
}

/** Largest distance from the geometry's origin to any of its vertices (bound). */
function boundingRadiusAboutOrigin(geometry: BufferGeometry): number {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const s = geometry.boundingSphere!;
  return s.center.length() + s.radius;
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

/**
 * Patch `MeshBasicMaterial`'s shaders into an outline shell. Exported for the
 * test suite, which runs it against three's real `ShaderLib.basic` sources to
 * prove the anchors it hooks into exist in the installed three.
 *
 * Only two anchors are used, both stable across the package's peer range:
 * `#include <begin_vertex>` (which declares `transformed`, before the instance
 * matrix is applied in `project_vertex`) and `#include <alphatest_fragment>`.
 * Everything else is declared here rather than borrowed from three's chunks,
 * so a renamed `vUv`/`vMapUv` between three versions cannot break it.
 */
export function patchOutlineShader(shader: {
  vertexShader: string;
  fragmentShader: string;
}): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
uniform float outlineWidth;
uniform float outlineScale;
#ifdef OUTLINE_EXTRUDE
  attribute vec3 ${OUTLINE_DIRECTION_ATTRIBUTE};
#endif
#ifdef OUTLINE_ALPHA
  varying vec2 vOutlineUv;
#endif`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#if defined( OUTLINE_HULL )
  transformed += normalize( normal ) * outlineWidth;
#elif defined( OUTLINE_EXTRUDE )
  transformed += ${OUTLINE_DIRECTION_ATTRIBUTE} * outlineWidth;
#else
  transformed *= outlineScale;
#endif
#ifdef OUTLINE_ALPHA
  vOutlineUv = vec2( 0.5 + transformed.x * 0.5, 0.5 - transformed.z * 0.5 );
#endif`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
#ifdef OUTLINE_ALPHA
  uniform sampler2D outlineMap;
  uniform mat3 outlineUvTransform;
  uniform float outlineAlphaTest;
  uniform float outlineUvRadius;
  varying vec2 vOutlineUv;
  float outlineTap( vec2 uv ) {
    // Outside the sprite's own [0, 1] square is empty, not a clamped edge.
    if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return 0.0;
    return texture2D( outlineMap, ( outlineUvTransform * vec3( uv, 1.0 ) ).xy ).a;
  }
  float outlineDilatedAlpha( vec2 uv ) {
    float r = outlineUvRadius;
    float h = r * 0.5;
    float d = r * 0.70710678;
    float e = h * 0.70710678;
    float a = outlineTap( uv );
    a = max( a, outlineTap( uv + vec2(  r, 0.0 ) ) );
    a = max( a, outlineTap( uv + vec2( -r, 0.0 ) ) );
    a = max( a, outlineTap( uv + vec2( 0.0,  r ) ) );
    a = max( a, outlineTap( uv + vec2( 0.0, -r ) ) );
    a = max( a, outlineTap( uv + vec2(  d,  d ) ) );
    a = max( a, outlineTap( uv + vec2( -d,  d ) ) );
    a = max( a, outlineTap( uv + vec2(  d, -d ) ) );
    a = max( a, outlineTap( uv + vec2( -d, -d ) ) );
    a = max( a, outlineTap( uv + vec2(  h, 0.0 ) ) );
    a = max( a, outlineTap( uv + vec2( -h, 0.0 ) ) );
    a = max( a, outlineTap( uv + vec2( 0.0,  h ) ) );
    a = max( a, outlineTap( uv + vec2( 0.0, -h ) ) );
    a = max( a, outlineTap( uv + vec2(  e,  e ) ) );
    a = max( a, outlineTap( uv + vec2( -e,  e ) ) );
    a = max( a, outlineTap( uv + vec2(  e, -e ) ) );
    a = max( a, outlineTap( uv + vec2( -e, -e ) ) );
    return a;
  }
#endif`,
    )
    .replace(
      '#include <alphatest_fragment>',
      `#ifdef OUTLINE_ALPHA
  if ( outlineDilatedAlpha( vOutlineUv ) < outlineAlphaTest ) discard;
#endif
#include <alphatest_fragment>`,
    );
}

// ---------------------------------------------------------------------------
// Outline mesh
// ---------------------------------------------------------------------------

/** Uniform objects shared by reference with the compiled program. */
interface OutlineUniforms {
  outlineWidth: { value: number };
  outlineScale: { value: number };
  outlineMap: { value: Texture | null };
  outlineUvTransform: { value: Matrix3 };
  outlineAlphaTest: { value: number };
  outlineUvRadius: { value: number };
}

/** Per-outline bookkeeping that is not on the three objects themselves. */
interface OutlineState {
  uniforms: OutlineUniforms;
  /** The mode the current program was compiled for. `null` until first sync. */
  mode: ResolvedOutlineMode | null;
  /** Whether `'alpha'` is pushing along `outlineDirection` (vs. scaling). */
  alphaExtrudes: boolean;
  /** Geometry the cached radius belongs to. */
  radiusOf: BufferGeometry | null;
  radius: number;
  /** Requested config, refreshed on every render of the field. */
  color: Color;
  width: number;
  requested: OutlineMode;
  /** The fallback attribute/geometry, used only while detached. */
  ownMatrix: InstancedBufferAttribute;
  ownGeometry: BufferGeometry;
}

/**
 * The outline's instanced mesh: an `InstancedMesh` whose `instanceMatrix`,
 * `count` and `geometry` are **read from its parent** — the field's bullet
 * mesh — rather than stored.
 *
 * That is the whole design. Mounted as a child of the bullet mesh it:
 *
 * - shares the parent's `instanceMatrix` **attribute object**, so three's
 *   attribute cache uploads it once per version and both draws read the same
 *   GPU buffer — every per-bullet write the field makes is the outline's too;
 * - reports the parent's live `count`, so the high-water mark bounds both
 *   draws and an empty field draws neither;
 * - draws the parent's current `geometry`, whichever one that is;
 * - inherits the parent's world transform as its own (its local is identity).
 *
 * Detached (parent `null`), the accessors fall back to an empty attribute, a
 * zero count and a placeholder geometry it owns, so a stray render or
 * `dispose()` can never reach the bullet mesh's buffers.
 */
export type OutlineMesh = InstancedMesh & { readonly __outline: OutlineState };

/** Name stamped on the outline mesh, for debugging and for tests. */
export const OUTLINE_MESH_NAME = 'r3f-projectiles:outline';

function parentInstanced(o: InstancedMesh): InstancedMesh | null {
  const p = o.parent as InstancedMesh | null;
  return p && p.isInstancedMesh ? p : null;
}

/**
 * Build an outline mesh with its own material. Owned by the caller, and torn
 * down with {@link disposeOutlineMesh} — never by `mesh.dispose()` alone.
 */
export function createOutlineMesh(): OutlineMesh {
  const uniforms: OutlineUniforms = {
    outlineWidth: { value: 0 },
    outlineScale: { value: 1 },
    outlineMap: { value: null },
    outlineUvTransform: { value: new Matrix3() },
    outlineAlphaTest: { value: 0.5 },
    outlineUvRadius: { value: 0 },
  };

  const material = new MeshBasicMaterial({ fog: false });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    patchOutlineShader(shader);
  };

  // Count 0: the constructor's own instanceMatrix is an empty placeholder, so
  // building an outline costs nothing per slot.
  const mesh = new InstancedMesh(undefined, material, 0);
  mesh.name = OUTLINE_MESH_NAME;
  mesh.frustumCulled = false;
  // One raycast hit per bullet is the bullet mesh's job. Without this a
  // raycast against the field would report every bullet twice.
  mesh.raycast = () => {};

  const state: OutlineState = {
    uniforms,
    mode: null,
    alphaExtrudes: false,
    radiusOf: null,
    radius: 1,
    color: material.color,
    width: 0,
    requested: 'auto',
    ownMatrix: mesh.instanceMatrix,
    ownGeometry: mesh.geometry,
  };

  Object.defineProperties(mesh, {
    __outline: { value: state },
    instanceMatrix: {
      get(this: InstancedMesh) {
        return parentInstanced(this)?.instanceMatrix ?? state.ownMatrix;
      },
      set(v: InstancedBufferAttribute) {
        state.ownMatrix = v;
      },
      configurable: true,
    },
    count: {
      get(this: InstancedMesh) {
        return parentInstanced(this)?.count ?? 0;
      },
      // three never needs to set it on this mesh; ignore rather than throw.
      set() {},
      configurable: true,
    },
    geometry: {
      get(this: InstancedMesh) {
        return parentInstanced(this)?.geometry ?? state.ownGeometry;
      },
      set(v: BufferGeometry) {
        state.ownGeometry = v;
      },
      configurable: true,
    },
  });

  return mesh as unknown as OutlineMesh;
}

/** Store the consumer's config. Called on every render of the field. */
export function configureOutline(
  outline: OutlineMesh,
  color: ColorRepresentation,
  width: number,
  mode: OutlineMode | undefined,
): void {
  const s = outline.__outline;
  s.color.set(color);
  s.width = width;
  s.requested = mode ?? 'auto';
}

/**
 * Keep the outline glued to the bullet mesh: re-parent it if R3F rebuilt the
 * mesh (a `maxBullets` change does), resolve the mode against the mesh's
 * current geometry and material, and refresh uniforms.
 *
 * Runs once per frame, so it is written to be allocation-free in the steady
 * state: a program recompile happens only when the resolved mode changes, and
 * the geometry's radius is recomputed only when the geometry does.
 *
 * @param baseScale - The field's base instance scale (`1` for the default
 * sphere, `bulletRadius` for a consumer geometry). The outline is grown in the
 * geometry's own space, before the instance matrix, so a world-unit width is
 * divided by it here.
 */
export function syncOutline(
  outline: OutlineMesh,
  mesh: InstancedMesh | null,
  baseScale: number,
): void {
  if (!mesh) return;
  if (outline.parent !== mesh) mesh.add(outline);

  const s = outline.__outline;
  const material = outline.material as MeshBasicMaterial;
  const geometry = mesh.geometry;

  outline.visible = s.width > 0;
  const width = s.width / (baseScale || 1);

  const mode = resolveOutlineMode(s.requested, geometry, mesh.material);
  const alphaExtrudes =
    mode === 'alpha' && !!geometry.getAttribute(OUTLINE_DIRECTION_ATTRIBUTE);
  if (mode !== s.mode || alphaExtrudes !== s.alphaExtrudes) {
    s.mode = mode;
    s.alphaExtrudes = alphaExtrudes;
    applyMode(material, mode, alphaExtrudes);
  }

  if (s.radiusOf !== geometry) {
    s.radiusOf = geometry;
    s.radius = boundingRadiusAboutOrigin(geometry) || 1;
  }

  const u = s.uniforms;
  u.outlineWidth.value = width;
  u.outlineScale.value = 1 + width / s.radius;

  if (mode === 'alpha') {
    const main = mesh.material as Material;
    const map = spriteMapOf(main);
    u.outlineMap.value = map;
    // Bound by reference, and refreshed here rather than trusted to the main
    // material's render: that may come after this outline's draw, which would
    // leave an animated atlas offset a frame behind. `updateMatrix` writes in
    // place — no allocation.
    if (map) {
      if (map.matrixAutoUpdate) map.updateMatrix();
      u.outlineUvTransform.value = map.matrix;
    }
    u.outlineAlphaTest.value = main.alphaTest > 0 ? main.alphaTest : 0.5;
    // Unit space spans 2 per UV unit (x ∈ [-1, 1] ↔ u ∈ [0, 1]).
    u.outlineUvRadius.value = width * 0.5;
  }
}

function applyMode(
  material: MeshBasicMaterial,
  mode: ResolvedOutlineMode,
  alphaExtrudes: boolean,
): void {
  const defines: Record<string, string> = {};
  if (mode === 'hull') defines.OUTLINE_HULL = '';
  else if (mode === 'extrude' || alphaExtrudes) defines.OUTLINE_EXTRUDE = '';
  else defines.OUTLINE_SCALE = '';
  if (mode === 'alpha') defines.OUTLINE_ALPHA = '';
  material.defines = defines;

  if (mode === 'hull') {
    // Classic inverted hull: only the grown shell's back faces, which the
    // bullet's own front faces cover everywhere except the rim.
    material.side = BackSide;
    material.polygonOffset = false;
  } else {
    // A flat shell is coplanar with its bullet. Push it back in depth so the
    // bullet always wins the depth test against its own outline, while the
    // outline still writes depth and so is not painted over by the ground.
    material.side = DoubleSide;
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 4;
  }
  material.needsUpdate = true;
}

/**
 * Tear an outline down: detach it from the bullet mesh **first**, so the
 * accessors fall back to the outline's own placeholders, and only then
 * dispose it.
 *
 * The order is the whole point. `InstancedMesh.dispose()` makes three's
 * renderer delete the GL buffer behind `instanceMatrix` — and attached, that
 * is the *bullet mesh's* buffer. Detached, it is an empty placeholder, while
 * the outline's own VAOs are still released. The outline's material and
 * placeholder geometry are the field's and are disposed; the bullet geometry
 * is never touched, because it was never the outline's.
 */
export function disposeOutlineMesh(outline: OutlineMesh): void {
  outline.removeFromParent();
  outline.dispose();
  (outline.material as Material).dispose();
  outline.__outline.ownGeometry.dispose();
}
