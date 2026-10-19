import {
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Material,
  Vector2,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-bullet **sprite frames** from one texture atlas (0.7.0).
 *
 * The field's material `map` is read as a grid of `columns × rows` equal
 * cells, numbered left to right, top to bottom (cell `0` is the top-left of the
 * image as three samples it, i.e. `v = 1` is the top). Every time a bullet's
 * instance matrix is written, {@link frame} picks its cell, so one field — one
 * mesh, one draw call — can show arrows, orbs and shards side by side, chosen
 * from anything the payload says.
 *
 * Needs a consumer `geometry` with the planar UVs `bulletGeometry.quad()` has
 * (`u = 0.5 + x/2`, `v = 0.5 − z/2`); ignored, with a development warning, on
 * the default sphere. The material's `map` transform (`offset` / `repeat`) is
 * applied after the cell is picked, so the grid may itself sit in a region of a
 * larger texture. The `'alpha'` outline follows the frame: it dilates the
 * bullet's own cell, never a neighbour.
 */
export interface BulletFrames {
  /** Cells across the atlas. A positive integer. */
  columns: number;
  /** Cells down the atlas. A positive integer. */
  rows: number;
  /**
   * The cell a bullet shows, `0 … columns × rows − 1`. Called whenever the
   * bullet's matrix is written — at spawn, on every step it moves, and every
   * frame while an external simulation is interpolated — with the slot index
   * and the bullet's payload. Keep it cheap and allocation-free; it runs once
   * per drawn bullet. Non-integers are rounded in the shader, and an index
   * outside the grid wraps.
   */
  frame: (index: number, payload: number) => number;
  /**
   * Cells that never turn. For a bullet whose cell this returns `true` for,
   * the rotation `orient` would apply for its velocity is skipped:
   * `'velocity'` draws it unrotated, `'camera-velocity'` draws it as a plain
   * `'camera'` billboard. For round sprites (orbs, rings) in a field of
   * arrows, which look the same at every heading and are crisper unrotated.
   * Omit: every cell turns.
   */
  upright?: (frame: number) => boolean;
}

// ---------------------------------------------------------------------------
// The per-instance attribute
// ---------------------------------------------------------------------------

/** Name of the per-instance frame attribute a frames field adds to its geometry view. */
export const FRAME_ATTRIBUTE = 'bulletFrame';

/** Define switched on in a material patched for frames. */
const FRAMES_DEFINE = 'R3FP_BULLET_FRAMES';

/** Appended to a patched material's program cache key. */
const CACHE_KEY_SUFFIX = '|r3f-projectiles:frames';

/** A positive integer grid size, or `null` if the config is unusable. */
export function frameGrid(frames: BulletFrames | null | undefined): [number, number] | null {
  if (!frames) return null;
  const c = Math.floor(frames.columns);
  const r = Math.floor(frames.rows);
  if (!(c >= 1) || !(r >= 1) || !Number.isFinite(c) || !Number.isFinite(r)) return null;
  return [c, r];
}

/**
 * The geometry a frames field actually draws: a **view** of the consumer's
 * geometry that shares its index and every attribute object by reference —
 * so three uploads them once, for every field using that geometry — plus the
 * field's own per-instance {@link FRAME_ATTRIBUTE}.
 *
 * A view rather than an attribute added to the consumer's geometry, because
 * that geometry may be shared by several fields, each with its own frames.
 * It mirrors the geometry's attributes as they are when it is built; replace
 * the `geometry` prop, rather than swapping attributes on it in place.
 */
export function createFrameGeometry(source: BufferGeometry, capacity: number): BufferGeometry {
  const view = new BufferGeometry();
  view.name = 'r3f-projectiles:frames';
  view.index = source.index;
  for (const name of Object.keys(source.attributes)) view.attributes[name] = source.attributes[name];
  view.morphAttributes = source.morphAttributes;
  view.morphTargetsRelative = source.morphTargetsRelative;
  for (const g of source.groups) view.addGroup(g.start, g.count, g.materialIndex);
  view.setDrawRange(source.drawRange.start, source.drawRange.count);
  if (!source.boundingBox) source.computeBoundingBox();
  if (!source.boundingSphere) source.computeBoundingSphere();
  view.boundingBox = source.boundingBox ? source.boundingBox.clone() : null;
  view.boundingSphere = source.boundingSphere ? source.boundingSphere.clone() : null;
  const frame = new InstancedBufferAttribute(new Float32Array(Math.max(1, capacity)), 1);
  frame.setUsage(DynamicDrawUsage);
  view.setAttribute(FRAME_ATTRIBUTE, frame);
  return view;
}

/** The view's frame attribute, if `geometry` is a frames view. */
export function frameAttributeOf(geometry: BufferGeometry | null | undefined): InstancedBufferAttribute | null {
  const a = geometry?.getAttribute(FRAME_ATTRIBUTE);
  return a && (a as InstancedBufferAttribute).isInstancedBufferAttribute ? (a as InstancedBufferAttribute) : null;
}

/**
 * Release a view's GPU resources **without touching the shared ones**.
 *
 * `geometry.dispose()` makes three delete the GL buffer of every attribute
 * the geometry lists — and a view lists the consumer's. Another mesh still
 * drawing that geometry would then hold a vertex-array object pointing at a
 * deleted buffer. So the view is narrowed to its own frame attribute for the
 * (synchronous) dispose event, then restored: the object stays intact and
 * usable, which StrictMode's effect replay relies on.
 */
export function disposeFrameGeometry(view: BufferGeometry): void {
  const attributes = view.attributes;
  const index = view.index;
  const own = attributes[FRAME_ATTRIBUTE];
  view.attributes = own ? { [FRAME_ATTRIBUTE]: own } : {};
  view.index = null;
  view.dispose();
  view.attributes = attributes;
  view.index = index;
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

/**
 * GLSL for one frame cell: maps a cell-local UV (`[0, 1]²`, `v = 1` at the top)
 * into the atlas. Shared by the bullet material and the alpha outline.
 */
export const FRAME_UV_GLSL = `
vec2 r3fpFrameUv( vec2 uv, float frame, vec2 grid ) {
  float f = floor( frame + 0.5 );
  float cells = grid.x * grid.y;
  f = f - cells * floor( f / cells );
  float col = f - grid.x * floor( f / grid.x );
  float row = floor( f / grid.x );
  return vec2( ( col + uv.x ) / grid.x, 1.0 - ( row + 1.0 - uv.y ) / grid.y );
}`;

/** Uniform objects a patched material shares by reference with its program. */
export interface FrameUniforms {
  r3fpFrameGrid: { value: Vector2 };
}

export function createFrameUniforms(): FrameUniforms {
  return { r3fpFrameGrid: { value: new Vector2(1, 1) } };
}

/**
 * Patch a built-in material's vertex shader (`MeshBasicMaterial` and friends)
 * so its `map` UV picks the instance's cell. Exported for the test suite,
 * which runs it against three's real `ShaderLib` sources to prove the two
 * anchors exist in the installed three: `#include <common>` and
 * `#include <uv_vertex>` (three r151+, where `vMapUv` and `MAP_UV` exist).
 */
export function patchFrameShader(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
#ifdef ${FRAMES_DEFINE}
  attribute float ${FRAME_ATTRIBUTE};
  uniform vec2 r3fpFrameGrid;
  ${FRAME_UV_GLSL}
#endif`,
    )
    .replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#if defined( ${FRAMES_DEFINE} ) && defined( USE_MAP )
  vMapUv = ( mapTransform * vec3( r3fpFrameUv( MAP_UV, ${FRAME_ATTRIBUTE}, r3fpFrameGrid ), 1.0 ) ).xy;
#endif`,
    );
}

interface PatchRecord {
  uniforms: FrameUniforms;
  onBeforeCompile: Material['onBeforeCompile'];
  ownCacheKey: (() => string) | null;
  hadOwnCacheKey: boolean;
  defines: Record<string, unknown> | undefined;
}

const patched = new WeakMap<Material, PatchRecord>();

/** Whether `material` currently carries a frames patch. */
export function isFramePatched(material: Material): boolean {
  return patched.has(material);
}

/**
 * Patch a consumer material for frames, chaining any `onBeforeCompile` it
 * already had and extending its program cache key, so a patched and an
 * unpatched material of the same type never share a program. Idempotent; the
 * grid is updated in place on later calls. Undone by {@link unpatchFrameMaterial}.
 */
export function patchFrameMaterial(material: Material, grid: [number, number]): void {
  let rec = patched.get(material);
  if (!rec) {
    const uniforms = createFrameUniforms();
    const prev = material.onBeforeCompile;
    const hadOwnCacheKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
    const ownCacheKey = hadOwnCacheKey ? material.customProgramCacheKey : null;
    // The default key is the source of `onBeforeCompile`; ours would be the
    // same for every patched material, so keep the original's in the key.
    const prevSource = prev.toString();
    rec = { uniforms, onBeforeCompile: prev, ownCacheKey, hadOwnCacheKey, defines: material.defines };
    patched.set(material, rec);
    material.onBeforeCompile = function onBeforeCompileFrames(
      this: Material,
      shader: WebGLProgramParametersWithUniforms,
      renderer: WebGLRenderer,
    ) {
      prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      patchFrameShader(shader);
    };
    material.customProgramCacheKey = () =>
      (ownCacheKey ? ownCacheKey.call(material) : prevSource) + CACHE_KEY_SUFFIX;
    material.defines = { ...(material.defines ?? {}), [FRAMES_DEFINE]: '' };
    material.needsUpdate = true;
  }
  rec.uniforms.r3fpFrameGrid.value.set(grid[0], grid[1]);
}

/** Remove a frames patch, restoring the material's own hooks. A no-op if unpatched. */
export function unpatchFrameMaterial(material: Material): void {
  const rec = patched.get(material);
  if (!rec) return;
  patched.delete(material);
  material.onBeforeCompile = rec.onBeforeCompile;
  if (rec.hadOwnCacheKey && rec.ownCacheKey) material.customProgramCacheKey = rec.ownCacheKey;
  else delete (material as Partial<Material>).customProgramCacheKey;
  if (material.defines) {
    const { [FRAMES_DEFINE]: _drop, ...rest } = material.defines;
    void _drop;
    material.defines = rec.defines === undefined && Object.keys(rest).length === 0 ? undefined : rest;
  }
  material.needsUpdate = true;
}
