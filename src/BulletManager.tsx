import React, { useRef, useMemo, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Object3D,
  Color,
  Vector3,
  DynamicDrawUsage,
  type InstancedMesh as InstancedMeshType,
} from 'three';
import { resolvePattern } from './presets';
import { releaseSpawnData } from './pool';
import type { BulletManagerProps, BulletManagerHandle, BulletSpawnData } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bullet cap under reduced-motion mode to keep the static snapshot modest. */
const REDUCED_MOTION_MAX = 200;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BulletState {
  active: boolean;
  position: Vector3;
  velocity: Vector3;
  acceleration: Vector3;
  delay: number;
  life: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `<BulletManager>` — a fully props-driven R3F instanced-mesh bullet system.
 *
 * Renders thousands of projectiles using a single `<instancedMesh>` with
 * zero per-frame allocations. All configuration is controlled via props;
 * there is **no** internal Zustand, Context, or Next.js dependency.
 *
 * ## Performance characteristics
 * - **Zero-allocation frame loop**: all scratch `Vector3` / `Object3D` /
 *   `Color` objects are created once via `useMemo` and reused every frame.
 * - **Frame-rate independent**: physics uses `addScaledVector(v, dt)` with
 *   `dt` clamped to `Math.min(delta, 0.1)`.
 * - **Batched GPU writes**: `needsUpdate = true` is set **once** after the
 *   full bullet loop, never per-bullet.
 * - **DynamicDrawUsage**: GPU buffer hint applied on mount.
 * - **Pool init at (0, −999, 0)**: prevents first-frame flash.
 *
 * ## Material override
 * Pass a child element to replace the default `<meshBasicMaterial fog={false} />`:
 *
 * ```tsx
 * <BulletManager pattern="galaxy">
 *   <meshStandardMaterial emissive="hotpink" emissiveIntensity={2} />
 * </BulletManager>
 * ```
 *
 * ## Imperative handle
 * Use a ref to access `fire()`, `clear()`, and `activeCount`:
 *
 * ```tsx
 * const ref = useRef<BulletManagerHandle>(null);
 * <BulletManager ref={ref} pattern="ring" />
 * ```
 *
 * @see {@link BulletManagerProps} for the full prop list.
 * @see {@link BulletManagerHandle} for the imperative API.
 */
export const BulletManager = forwardRef<BulletManagerHandle, BulletManagerProps>(
  function BulletManager(
    {
      maxBullets = 2000,
      pattern = 'fibonacciSphere',
      fireRate = 1.5,
      paused = false,
      reducedMotion = false,
      boundsLimit = 25,
      spawnCenterY = 3,
      rotationSpeed = 0.3,
      children,
      onBulletCount,
    },
    ref,
  ) {
    const meshRef = useRef<InstancedMeshType | null>(null);
    const bulletsRef = useRef<BulletState[]>([]);
    const timeAccum = useRef(0);
    const sourceRotation = useRef(0);
    const reducedMotionSpawned = useRef(false);

    // ---- Prop refs for reading inside useFrame without stale closures ------
    const propsRef = useRef({
      pattern,
      fireRate,
      paused,
      reducedMotion,
      boundsLimit,
      spawnCenterY,
      rotationSpeed,
      onBulletCount,
    });
    propsRef.current = {
      pattern,
      fireRate,
      paused,
      reducedMotion,
      boundsLimit,
      spawnCenterY,
      rotationSpeed,
      onBulletCount,
    };

    // ---- Scratch objects (allocated ONCE, reused every frame) --------------
    const { _dummy, _tempColor, _sourcePos } = useMemo(
      () => ({
        _dummy: new Object3D(),
        _tempColor: new Color(),
        _sourcePos: new Vector3(),
      }),
      [],
    );

    // ---- Pool initialization (mount only) ----------------------------------
    useEffect(() => {
      const mesh = meshRef.current;
      if (!mesh) return;

      // Allocate the CPU-side bullet state array ONCE
      const pool: BulletState[] = new Array(maxBullets);
      for (let i = 0; i < maxBullets; i++) {
        pool[i] = {
          active: false,
          position: new Vector3(),
          velocity: new Vector3(),
          acceleration: new Vector3(),
          delay: 0,
          life: 0,
        };
      }
      bulletsRef.current = pool;

      // GPU buffer hint — tells the driver we'll update every frame
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);

      // Prevent first-frame flash: park every instance off-screen + black
      for (let i = 0; i < maxBullets; i++) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        mesh.setColorAt(i, _tempColor.set(0x000000));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maxBullets]);

    // ---- Internal spawn function (zero-allocation) -------------------------
    const spawnBullets = useMemo(() => {
      return (
        mesh: InstancedMeshType,
        bullets: BulletState[],
        sourcePos: Vector3,
        spawnData: BulletSpawnData[],
        zeroVelocity: boolean,
        cap?: number,
      ) => {
        let spawned = 0;
        for (let d = 0; d < spawnData.length; d++) {
          if (cap !== undefined && spawned >= cap) break;

          // Find an inactive slot
          let slotIdx = -1;
          for (let i = 0; i < bullets.length; i++) {
            if (!bullets[i].active) {
              slotIdx = i;
              break;
            }
          }
          if (slotIdx === -1) break; // pool exhausted

          const data = spawnData[d];
          const bullet = bullets[slotIdx];

          bullet.active = true;
          bullet.position.copy(sourcePos).add(data.offset);
          bullet.delay = data.delay;
          bullet.life = data.life;

          if (zeroVelocity) {
            bullet.velocity.set(0, 0, 0);
            bullet.acceleration.set(0, 0, 0);
          } else {
            bullet.velocity.copy(data.velocity);
            bullet.acceleration.copy(data.acceleration);
          }

          // Zero-allocation color set — reuse _tempColor scratch object
          _tempColor.set(data.color ?? 0xff3333);
          mesh.setColorAt(slotIdx, _tempColor);

          // If no delay, position immediately; otherwise hide at -999
          if (bullet.delay <= 0) {
            _dummy.position.copy(bullet.position);
            _dummy.scale.set(1, 1, 1);
            _dummy.updateMatrix();
            mesh.setMatrixAt(slotIdx, _dummy.matrix);
          } else {
            _dummy.position.set(0, -999, 0);
            _dummy.scale.set(0, 0, 0);
            _dummy.updateMatrix();
            mesh.setMatrixAt(slotIdx, _dummy.matrix);
          }

          spawned++;
        }
      };
    }, [_dummy, _tempColor]);

    // ---- Imperative handle -------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        /** Manually trigger one burst of the current pattern. */
        fire() {
          const mesh = meshRef.current;
          if (!mesh) return;
          const bullets = bulletsRef.current;
          const { pattern: pat, spawnCenterY: cy } = propsRef.current;

          _sourcePos.set(0, cy, 0);
          const spawnData = resolvePattern(pat);
          spawnBullets(mesh, bullets, _sourcePos, spawnData, false);
          releaseSpawnData(spawnData);

          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        },

        /** Deactivate all bullets and reset the simulation timer. */
        clear() {
          const mesh = meshRef.current;
          if (!mesh) return;
          const bullets = bulletsRef.current;

          for (let i = 0; i < bullets.length; i++) {
            bullets[i].active = false;
            _dummy.position.set(0, -999, 0);
            _dummy.scale.set(0, 0, 0);
            _dummy.updateMatrix();
            mesh.setMatrixAt(i, _dummy.matrix);
          }
          timeAccum.current = 0;
          reducedMotionSpawned.current = false;

          mesh.instanceMatrix.needsUpdate = true;
        },

        /** Number of bullets currently alive. */
        get activeCount(): number {
          let count = 0;
          const bullets = bulletsRef.current;
          for (let i = 0; i < bullets.length; i++) {
            if (bullets[i].active) count++;
          }
          return count;
        },
      }),
      [_dummy, _sourcePos, spawnBullets],
    );

    // ---- Frame loop --------------------------------------------------------
    useFrame((_state, delta) => {
      const mesh = meshRef.current;
      if (!mesh) return;

      const props = propsRef.current;

      // Respect paused prop
      if (props.paused) return;

      const dt = Math.min(delta, 0.1); // clamp to prevent spiral-of-death
      const bullets = bulletsRef.current;

      // ---- Reduced motion: spawn once, skip timer & rotation ----
      if (props.reducedMotion) {
        if (!reducedMotionSpawned.current) {
          reducedMotionSpawned.current = true;
          _sourcePos.set(0, props.spawnCenterY, 0);
          const spawnData = resolvePattern(props.pattern);
          spawnBullets(mesh, bullets, _sourcePos, spawnData, true, REDUCED_MOTION_MAX);
          releaseSpawnData(spawnData);

          // Flush the one-time update
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
        return; // no animation under reduced motion
      }

      // Reset flag if consumer toggles reduced motion off
      reducedMotionSpawned.current = false;

      // ---- Auto-fire timer ----
      timeAccum.current += dt;
      const fireInterval = 1 / props.fireRate;

      if (timeAccum.current >= fireInterval) {
        timeAccum.current -= fireInterval;

        // Orbit source position around Y axis
        sourceRotation.current += props.rotationSpeed * fireInterval;
        const rot = sourceRotation.current;
        _sourcePos.set(
          Math.cos(rot) * 2,
          props.spawnCenterY,
          Math.sin(rot) * 2,
        );

        const spawnData = resolvePattern(props.pattern);
        spawnBullets(mesh, bullets, _sourcePos, spawnData, false);
        releaseSpawnData(spawnData);
      }

      // ---- Update all active bullets ----
      let activeCount = 0;
      for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (!b.active) continue;

        // Handle delay countdown
        if (b.delay > 0) {
          b.delay -= dt;
          if (b.delay > 0) {
            activeCount++;
            // Still waiting — keep hidden
            continue;
          }
          // Delay just ended — fall through to normal update
        }

        // Frame-rate independent physics
        b.velocity.addScaledVector(b.acceleration, dt);
        b.position.addScaledVector(b.velocity, dt);
        b.life -= dt;

        // Deactivate: lifetime expired or out of bounds
        if (
          b.life <= 0 ||
          Math.abs(b.position.x) > props.boundsLimit ||
          Math.abs(b.position.y) > props.boundsLimit ||
          Math.abs(b.position.z) > props.boundsLimit
        ) {
          b.active = false;
          _dummy.position.set(0, -999, 0);
          _dummy.scale.set(0, 0, 0);
          _dummy.updateMatrix();
          mesh.setMatrixAt(i, _dummy.matrix);
          continue;
        }

        activeCount++;

        // Fade: scale down as life approaches 0
        const fade = Math.min(b.life, 1.0);
        _dummy.position.copy(b.position);
        _dummy.scale.set(fade, fade, fade);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
      }

      // ---- Batch GPU buffer updates (ONCE after full loop, never per-bullet)
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      // ---- Callback with active count ----
      if (props.onBulletCount) {
        props.onBulletCount(activeCount);
      }
    });

    // ---- JSX ---------------------------------------------------------------
    return (
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, maxBullets]}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.12, 6, 6]} />
        {children ?? <meshBasicMaterial fog={false} />}
      </instancedMesh>
    );
  },
);
