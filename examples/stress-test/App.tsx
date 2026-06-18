/**
 * Stress Test example — BulletManager with ProjectileTelemetry.
 *
 * Copy this into a React + R3F project to see 2000+ bullets at 60fps.
 *
 * ```bash
 * npm install react react-dom three @react-three/fiber @k9kbdev/r3f-projectiles
 * ```
 */

import React, { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stats } from '@react-three/drei';
import { BulletManager, ProjectileTelemetry, type BulletManagerHandle } from '@k9kbdev/r3f-projectiles';
import { useControls } from 'leva';

export default function App() {
  const managerRef = useRef<BulletManagerHandle>(null);

  const { pattern, fireRate, maxBullets, paused, reducedMotion, boundsLimit, spawnCenterY, rotationSpeed } = useControls('Bullet System', {
    pattern: {
      options: ['fibonacciSphere', 'torusKnot', 'galaxy', 'helix', 'rose3D', 'ring'],
      value: 'galaxy',
    },
    fireRate: { value: 2.5, min: 0.1, max: 50.0, step: 0.1 },
    maxBullets: { value: 2500, min: 100, max: 20000, step: 100 },
    paused: false,
    reducedMotion: false,
    boundsLimit: { value: 25, min: 5, max: 100, step: 1 },
    spawnCenterY: { value: 3, min: 0, max: 20, step: 0.5 },
    rotationSpeed: { value: 0.3, min: 0, max: 5, step: 0.05 },
  });

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Telemetry overlay sits outside the Canvas */}
      <ProjectileTelemetry 
        getCount={() => managerRef.current?.activeCount ?? 0} 
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px'
        }}
      />

      <Canvas camera={{ position: [0, 8, 20], fov: 60 }}>
        <BulletManager
          ref={managerRef}
          pattern={pattern as any}
          fireRate={fireRate}
          maxBullets={maxBullets}
          paused={paused}
          reducedMotion={reducedMotion}
          boundsLimit={boundsLimit}
          spawnCenterY={spawnCenterY}
          rotationSpeed={rotationSpeed}
        />
        
        {/* Simple floor for perspective */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]}>
          <planeGeometry args={[50, 50]} />
          <meshBasicMaterial color="#111" />
        </mesh>

        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 10, 5]} />

        <Stats className="stats-panel" />
      </Canvas>
    </div>
  );
}
