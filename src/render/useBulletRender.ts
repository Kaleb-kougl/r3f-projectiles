import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { BufferGeometry, InstancedMesh } from 'three';
import { InstanceWriter, type BulletOrient } from './orient';
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
  { maxBullets, bulletRadius, geometry, orient, outline }: BulletRenderOptions,
): InstanceWriter {
  const writer = useMemo(() => new InstanceWriter(), []);
  const getState = useThree((s) => s.get);
  const outlineRef = useRef<OutlineMesh | null>(null);
  const hasOutline = outline !== undefined && outline !== null;

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
  });

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
    syncOutline(o, meshRef.current, writer.baseScale);
  });

  // ---- Per frame, ahead of the simulation ----------------------------------
  useFrame((state) => {
    if (writer.orient === 'camera') writer.syncCamera(state.camera);
    const o = outlineRef.current;
    if (o) syncOutline(o, meshRef.current, writer.baseScale);
  }, -1);

  return writer;
}
