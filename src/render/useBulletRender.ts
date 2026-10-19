import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { BufferGeometry, InstancedMesh, Material } from 'three';
import { InstanceWriter, orientUsesCamera, type BulletOrient } from './orient';
import {
  createFrameGeometry,
  disposeFrameGeometry,
  frameAttributeOf,
  frameGrid,
  patchFrameMaterial,
  unpatchFrameMaterial,
  type BulletFrames,
} from './frames';
import { DEV } from '../dev';
import {
  configureOutline,
  createOutlineMesh,
  disposeOutlineMesh,
  syncOutline,
  type BulletOutline,
  type OutlineMesh,
} from './outline';

/** The render-side props `<BulletField>` forwards here, already defaulted. */
export interface BulletRenderOptions {
  maxBullets: number;
  bulletRadius: number;
  geometry: BufferGeometry | undefined;
  orient: BulletOrient;
  outline: BulletOutline | undefined;
  /** Per-bullet sprite frames (0.7.0). Needs `geometry`. */
  frames?: BulletFrames | undefined;
}

/** What the field needs back from {@link useBulletRender}. */
export interface BulletRender {
  /** Composes every matrix that shows a bullet. Stable for the field's life. */
  writer: InstanceWriter;
  /**
   * The geometry the mesh must draw: the consumer's own, or — with `frames` —
   * a view of it carrying the per-instance frame attribute. `undefined` for
   * the default sphere.
   */
  geometry: BufferGeometry | undefined;
}

/**
 * Everything `<BulletField>` renders beyond "one sphere per bullet", kept out
 * of the field's own module so the frame loop only gains two call sites.
 *
 * Returns the field's {@link InstanceWriter} — a stable object, created once —
 * and manages, as side effects:
 *
 * - **Writer config.** `orient`, base scale and pool capacity are pushed into
 *   the writer in a layout effect, so they are current before any frame or
 *   imperative spawn can read them, without a ref write during render.
 * - **Camera sync** for `orient="camera"`: one `getWorldQuaternion` per frame,
 *   from a `useFrame` at priority `-1` so it runs before the field's own loop
 *   writes any matrix. Negative priorities never take over rendering in R3F.
 * - **The outline mesh**, when `outline` is set: created once, parented to
 *   the bullet mesh (re-parented if R3F rebuilds it on a `maxBullets` change),
 *   synced per frame, and torn down — material and all — when the prop is
 *   removed or the field unmounts.
 *
 * A no-op beyond one cheap `useFrame` callback when neither `orient` nor
 * `outline` is in use.
 */
export function useBulletRender(
  meshRef: RefObject<InstancedMesh | null>,
  { maxBullets, bulletRadius, geometry, orient, outline, frames }: BulletRenderOptions,
): BulletRender {
  const writer = useMemo(() => new InstanceWriter(), []);
  const getState = useThree((s) => s.get);
  const outlineRef = useRef<OutlineMesh | null>(null);
  const hasOutline = outline !== undefined && outline !== null;

  // ---- Frames (0.7.0): a geometry view with a per-instance cell ------------
  // Built when frames are on and there is a consumer geometry to view; the
  // grid itself may change freely without rebuilding it.
  const wantFrames = frames !== undefined && frames !== null && geometry !== undefined;
  const framesView = useMemo(
    () => (wantFrames && geometry ? createFrameGeometry(geometry, maxBullets) : null),
    [wantFrames, geometry, maxBullets],
  );
  useEffect(() => {
    if (!framesView) return;
    return () => disposeFrameGeometry(framesView);
  }, [framesView]);
  const grid = frameGrid(frames);
  /** The live grid (null: frames off), refreshed by the config effect below. */
  const gridRef = useRef<[number, number] | null>(null);
  /** The material we patched last, so a swap unpatches the old one. */
  const patchedRef = useRef<Material | null>(null);

  if (DEV && frames && !geometry) warnOnce('frames-geometry', '[r3f-projectiles] <BulletField frames> needs a `geometry` with quad UVs (e.g. bulletGeometry.quad()); ignored on the default sphere.');
  if (DEV && frames && !grid) warnOnce('frames-grid', '[r3f-projectiles] <BulletField frames> needs positive integer `columns` and `rows`; frames are off.');

  // ---- Writer config (every render) ---------------------------------------
  useLayoutEffect(() => {
    writer.configure(
      orient,
      // The default sphere bakes `bulletRadius` into its vertices; a consumer
      // geometry is unit-sized and takes it in the instance matrix instead.
      geometry ? bulletRadius : 1,
      maxBullets,
      () => getState().camera,
    );
    gridRef.current = framesView ? grid : null;
    writer.configureFrames(
      framesView && grid ? (frames ?? null) : null,
      framesView && grid ? frameAttributeOf(framesView) : null,
    );
  });

  // ---- Frames material patch (follows the mesh's current material) --------
  const syncFrameMaterial = (): void => {
    const mesh = meshRef.current;
    const material = mesh && !Array.isArray(mesh.material) ? (mesh.material as Material) : null;
    const g = gridRef.current;
    const want = g !== null ? material : null;
    if (patchedRef.current && patchedRef.current !== want) {
      unpatchFrameMaterial(patchedRef.current);
      patchedRef.current = null;
    }
    if (want && g) {
      patchFrameMaterial(want, g);
      patchedRef.current = want;
    }
  };
  useLayoutEffect(syncFrameMaterial);
  useEffect(
    () => () => {
      if (patchedRef.current) unpatchFrameMaterial(patchedRef.current);
      patchedRef.current = null;
    },
    [],
  );

  // ---- Outline lifecycle (only when the prop appears / disappears) --------
  useLayoutEffect(() => {
    if (!hasOutline) return;
    const o = createOutlineMesh();
    outlineRef.current = o;
    return () => {
      outlineRef.current = null;
      disposeOutlineMesh(o);
    };
  }, [hasOutline]);

  // ---- Outline config (every render) --------------------------------------
  useLayoutEffect(() => {
    const o = outlineRef.current;
    if (!o || !outline) return;
    configureOutline(o, outline.color, outline.width, outline.mode);
    syncOutline(o, meshRef.current, writer.baseScale, gridRef.current);
  });

  // ---- Per frame, ahead of the simulation ----------------------------------
  useFrame((state) => {
    if (orientUsesCamera(writer.orient)) writer.syncCamera(state.camera);
    if (gridRef.current !== null || patchedRef.current !== null) syncFrameMaterial();
    const o = outlineRef.current;
    if (o) syncOutline(o, meshRef.current, writer.baseScale, gridRef.current);
  }, -1);

  return { writer, geometry: framesView ?? geometry };
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
