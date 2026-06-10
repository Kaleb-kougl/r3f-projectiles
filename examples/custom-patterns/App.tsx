/**
 * Custom Patterns example — compose your own bullet patterns.
 *
 * Demonstrates using `gen`, `mod`, and `compose` to create unique patterns
 * and passing them as `PatternFactory` functions to BulletManager.
 */

import { useState } from 'react';
import { Vector3 } from 'three';
import { Canvas } from '@react-three/fiber';
import {
  BulletManager,
  gen, mod, compose,
  type PatternFactory,
} from '@k9kbdev/r3f-projectiles';

// ---------------------------------------------------------------------------
// Custom pattern factories
// ---------------------------------------------------------------------------

/** Fast red ring with forward acceleration */
const redAccelRing: PatternFactory = () =>
  compose(
    gen.ring(80, 4),
    mod.color(0xff2222),
    mod.accelerate(2.0),
  );

/** Sequenced helix with lateral drift and purple tint */
const driftingHelix: PatternFactory = () =>
  compose(
    gen.helix(120, 1.5, 6, 3),
    mod.color(0xcc44ff),
    mod.sequence(0.008),
    mod.accelerate(0.3, 1.5),
  );

/** Tilted torus knot with cyan glow */
const tiltedKnot: PatternFactory = () =>
  compose(
    gen.torusKnot(200, 3, 5, 2),
    mod.color(0x33ffff),
    mod.rotate(new Vector3(1, 0, 0), Math.PI / 4),
  );

/** Galaxy with staggered spawn for a wave effect */
const waveGalaxy: PatternFactory = () =>
  compose(
    gen.galaxy(180, 5, 4, 3),
    mod.color(0x6688ff),
    mod.sequence(0.005),
  );

// ---------------------------------------------------------------------------
// Pattern selector
// ---------------------------------------------------------------------------

const PATTERNS: Record<string, PatternFactory> = {
  'Red Accel Ring': redAccelRing,
  'Drifting Helix': driftingHelix,
  'Tilted Knot': tiltedKnot,
  'Wave Galaxy': waveGalaxy,
};

function Scene({ pattern }: { pattern: PatternFactory }) {
  return (
    <BulletManager pattern={pattern} fireRate={1.2} maxBullets={2000}>
      <meshBasicMaterial fog={false} />
    </BulletManager>
  );
}

export default function App() {
  const [selected, setSelected] = useState<string>('Red Accel Ring');

  return (
    <>
      <div style={{ position: 'absolute', zIndex: 1, padding: 16, display: 'flex', gap: 8 }}>
        {Object.keys(PATTERNS).map((name) => (
          <button
            key={name}
            onClick={() => setSelected(name)}
            style={{
              padding: '8px 16px',
              background: selected === name ? '#39ff14' : '#222',
              color: selected === name ? '#000' : '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <Canvas camera={{ position: [0, 6, 14], fov: 60 }}>
        <Scene pattern={PATTERNS[selected]} />
      </Canvas>
    </>
  );
}
