/**
 * Zustand Integration example — reactive pattern switching via a global store.
 *
 * Demonstrates wiring BulletManager to Zustand so that UI controls
 * reactively update the bullet simulation without prop drilling.
 */

import { useRef } from 'react';
import { create } from 'zustand';
import { Canvas } from '@react-three/fiber';
import {
  BulletManager,
  gen, mod, compose,
  PATTERN_LABELS,
  type PatternKey,
  type PatternFactory,
  type BulletManagerHandle,
} from '@k9kbdev/r3f-projectiles';

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

interface BulletStore {
  pattern: PatternKey | PatternFactory;
  fireRate: number;
  paused: boolean;
  activeCount: number;

  setPattern: (p: PatternKey | PatternFactory) => void;
  setFireRate: (r: number) => void;
  togglePause: () => void;
  setActiveCount: (n: number) => void;
}

const useStore = create<BulletStore>((set) => ({
  pattern: 'fibonacciSphere',
  fireRate: 1.5,
  paused: false,
  activeCount: 0,

  setPattern: (pattern) => set({ pattern }),
  setFireRate: (fireRate) => set({ fireRate }),
  togglePause: () => set((s) => ({ paused: !s.paused })),
  setActiveCount: (activeCount) => set({ activeCount }),
}));

// ---------------------------------------------------------------------------
// A custom pattern wired through the store
// ---------------------------------------------------------------------------

const customRing: PatternFactory = () =>
  compose(gen.ring(64, 3), mod.color(0xff6600), mod.accelerate(1));

// ---------------------------------------------------------------------------
// Scene — reads from store imperatively where needed
// ---------------------------------------------------------------------------

function Scene() {
  const ref = useRef<BulletManagerHandle>(null);
  const { pattern, fireRate, paused, setActiveCount } = useStore();

  return (
    <BulletManager
      ref={ref}
      pattern={pattern}
      fireRate={fireRate}
      paused={paused}
      onBulletCount={setActiveCount}
    />
  );
}

// ---------------------------------------------------------------------------
// UI overlay
// ---------------------------------------------------------------------------

function Controls() {
  const {
    pattern,
    fireRate,
    paused,
    activeCount,
    setPattern,
    setFireRate,
    togglePause,
  } = useStore();

  const patternKeys = Object.keys(PATTERN_LABELS) as PatternKey[];

  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 1,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: '#fff',
        fontFamily: 'monospace',
      }}
    >
      {/* Pattern selector */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {patternKeys.map((key) => (
          <button
            key={key}
            onClick={() => setPattern(key)}
            style={{
              padding: '6px 12px',
              background: pattern === key ? '#39ff14' : '#333',
              color: pattern === key ? '#000' : '#ccc',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {PATTERN_LABELS[key]}
          </button>
        ))}
        <button
          onClick={() => setPattern(customRing)}
          style={{
            padding: '6px 12px',
            background: pattern === customRing ? '#ff6600' : '#333',
            color: pattern === customRing ? '#000' : '#ccc',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Custom Ring
        </button>
      </div>

      {/* Fire rate slider */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Fire rate: {fireRate.toFixed(1)}/s
        <input
          type="range"
          min="0.5"
          max="5"
          step="0.1"
          value={fireRate}
          onChange={(e) => setFireRate(parseFloat(e.target.value))}
        />
      </label>

      {/* Pause toggle */}
      <button
        onClick={togglePause}
        style={{
          padding: '6px 12px',
          background: paused ? '#ff3333' : '#333',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          width: 'fit-content',
        }}
      >
        {paused ? '▶ Resume' : '⏸ Pause'}
      </button>

      {/* Active bullet count (updated per frame via onBulletCount) */}
      <div style={{ fontSize: 14 }}>
        Active bullets: <strong>{activeCount}</strong>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <>
      <Controls />
      <Canvas camera={{ position: [0, 6, 14], fov: 60 }}>
        <Scene />
      </Canvas>
    </>
  );
}
