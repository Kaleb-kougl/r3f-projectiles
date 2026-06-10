/**
 * Basic example — minimal working BulletManager.
 *
 * Copy this into a React + R3F project to get started.
 *
 * ```bash
 * npm install react react-dom three @react-three/fiber @k9kbdev/r3f-projectiles
 * ```
 */

import { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { BulletManager, type BulletManagerHandle } from '@k9kbdev/r3f-projectiles';

function Scene() {
  const ref = useRef<BulletManagerHandle>(null);

  return (
    <>
      {/* Auto-fires at 1.5 shots/sec using the fibonacciSphere pattern */}
      <BulletManager
        ref={ref}
        pattern="fibonacciSphere"
        fireRate={1.5}
        maxBullets={2000}
      />

      {/* Click the cube to manually fire a burst */}
      <mesh position={[0, 0, 0]} onClick={() => ref.current?.fire()}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="white" />
      </mesh>

      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} />
    </>
  );
}

export default function App() {
  return (
    <Canvas camera={{ position: [0, 6, 12], fov: 60 }}>
      <Scene />
    </Canvas>
  );
}
