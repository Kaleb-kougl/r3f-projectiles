# @k9kbdev/r3f-projectiles

A composable, GPU-instanced projectile system for React Three Fiber. Render 20,000 simultaneous bullets at 120 fps with a zero-allocation loop.

[![npm](https://img.shields.io/npm/v/@k9kbdev/r3f-projectiles)](https://www.npmjs.com/package/@k9kbdev/r3f-projectiles)
[![license](https://img.shields.io/npm/l/@k9kbdev/r3f-projectiles)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@k9kbdev/r3f-projectiles)](https://bundlephobia.com/package/@k9kbdev/r3f-projectiles)

```tsx
import { Canvas } from '@react-three/fiber';
import { BulletManager } from '@k9kbdev/r3f-projectiles';

export default function App() {
  return (
    <Canvas>
      <BulletManager pattern="fibonacciSphere" fireRate={2} />
    </Canvas>
  );
}
```

---

## Core Capabilities

- **Composable Patterns**: Chain `gen → mod → compose` to build complex bullet hells from simple math.
- **GPU Instancing**: Push 20,000 bullets at 120 fps through a single `<instancedMesh>`.
- **Zero Allocation**: I create scratch `Object3D`, `Vector3`, and `Color` objects once and reuse them every frame. No garbage collection spikes.
- **Object Pooling**: `acquire()` and `releaseSpawnData()` recycle object state to eliminate allocation pressure.
- **Accessibility Built-In**: Use `reducedMotion` to render a static, zero-velocity snapshot for motion-sensitive users.
- **Tree-Shakeable**: Import raw pattern math from `@k9kbdev/r3f-projectiles/patterns`. Leave React behind if you don't need it.
- **TypeScript Native**: Shipped with complete type definitions.

---

## Installation

```bash
npm install @k9kbdev/r3f-projectiles
```

### Peer dependencies

| Package | Version |
|---|---|
| `react` | `≥ 18` |
| `@react-three/fiber` | `≥ 8` |
| `three` | `≥ 0.150` |

---

## Stress Test

**[Play the live interactive demo here.](https://kaleb-kougl.github.io/r3f-projectiles/)**

![R3F Projectiles Demo](./assets/r3f-projectiles-demo.gif)

![20,000 entities at 120 FPS stress test](./assets/stress-test.png)

Run the built-in stress test to see it scale:

```bash
npm run dev:stress
```

Spin up a local Vite server. Toggle patterns, crank the fire rate, and spawn 20,000 bullets while monitoring framerate, render time, and memory usage.

---

## Quick Start

```tsx
import { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  BulletManager,
  gen, mod, compose,
  type BulletManagerHandle,
} from '@k9kbdev/r3f-projectiles';

function Scene() {
  const ref = useRef<BulletManagerHandle>(null);

  return (
    <>
      <BulletManager
        ref={ref}
        pattern={() => compose(gen.ring(80, 3), mod.color(0x39ff14))}
        fireRate={2}
        onBulletCount={(n) => console.log('active:', n)}
      />
      <mesh onClick={() => ref.current?.fire()}>
        <boxGeometry />
        <meshBasicMaterial color="white" />
      </mesh>
    </>
  );
}

export default function App() {
  return (
    <Canvas camera={{ position: [0, 6, 12] }}>
      <Scene />
    </Canvas>
  );
}
```

---

## API Reference

### `<BulletManager>`

A props-driven R3F component backed by a single `<instancedMesh>`. Pass a `ref` for imperative control.

#### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `maxBullets` | `number` | `2000` | Maximum concurrent bullet instances. |
| `pattern` | `PatternKey \| PatternFactory` | `'fibonacciSphere'` | Built-in pattern name or custom factory function. |
| `fireRate` | `number` | `1.5` | Shots per second. |
| `paused` | `boolean` | `false` | Freeze the simulation (bullets hold position). |
| `reducedMotion` | `boolean` | `false` | Spawn a single static snapshot with zero velocity. |
| `boundsLimit` | `number` | `25` | Distance from origin at which bullets are deactivated. |
| `spawnCenterY` | `number` | `3` | Y-coordinate of the spawn center. |
| `rotationSpeed` | `number` | `0.3` | Radians/second for the source-position orbit. |
| `children` | `ReactNode` | `<meshBasicMaterial fog={false} />` | Custom material override. |
| `onBulletCount` | `(count: number) => void` | — | Called once per frame with the active bullet count. |

#### Built-in `PatternKey` values

| Key | Description |
|---|---|
| `'fibonacciSphere'` | Golden-angle sphere — even omni-directional burst. |
| `'torusKnot'` | Parametric (2,3) torus knot. |
| `'galaxy'` | Logarithmic spiral-arm galaxy. |
| `'helix'` | DNA-style double helix. |
| `'rose3D'` | 3D rhodonea rose curve. |
| `'ring'` | Flat ring expanding outward. |

Human-readable labels for UI dropdowns are available via `PATTERN_LABELS`:

```ts
import { PATTERN_LABELS } from '@k9kbdev/r3f-projectiles';
// { fibonacciSphere: 'Fibonacci Sphere', torusKnot: 'Torus Knot', … }
```

---

### Pattern Generators (`gen.*`)

Generators yield pool-acquired `BulletSpawnData` arrays. Call `releaseSpawnData()` when finished.

| Generator | Signature | Description |
|---|---|---|
| `gen.fibonacciSphere` | `(count, radius)` | Golden-angle sphere distribution. |
| `gen.torusKnot` | `(count, p?, q?, radius?)` | Parametric torus knot (`p=2, q=3, radius=2`). |
| `gen.galaxy` | `(count, radius?, arms?, spin?)` | Spiral-arm galaxy (`radius=4, arms=3, spin=2`). |
| `gen.helix` | `(count, radius?, height?, turns?)` | Helix spiral (`radius=2, height=4, turns=2`). |
| `gen.rose3D` | `(count, k?, radius?)` | 3D rose/rhodonea curve (`k=4, radius=2`). |
| `gen.ring` | `(count, speed?, radius?)` | Flat expanding ring (`speed=2, radius=0`). |

---

### Pattern Modifiers (`mod.*`)

Modifiers are curried. Call them with a configuration to receive a `Modifier` function. They mutate spawn data in-place.

| Modifier | Signature | Description |
|---|---|---|
| `mod.color` | `(hex: number)` | Set a uniform color on every bullet. |
| `mod.accelerate` | `(forward: number, lateral?: number)` | Apply forward and/or lateral acceleration. |
| `mod.sequence` | `(delayStep: number)` | Stagger spawn times to sequence bullet appearance. |
| `mod.rotate` | `(axis: Vector3, angle: number)` | Rotate all offsets, velocities, and accelerations. |

---

### `compose()`

Pipe a generator result through multiple modifiers. Execution runs left-to-right, mutating the array in-place.

```ts
import { gen, mod, compose } from '@k9kbdev/r3f-projectiles';

const burst = compose(
  gen.ring(100, 3),
  mod.color(0x39ff14),
  mod.accelerate(1.5),
  mod.sequence(0.02),
);
```

**Signature:**

```ts
function compose(
  generatorResult: BulletSpawnData[],
  ...modifiers: Modifier[]
): BulletSpawnData[];
```

---

### Imperative Handle

Attach a ref to access imperative controls:

```tsx
import { useRef } from 'react';
import { BulletManager, type BulletManagerHandle } from '@k9kbdev/r3f-projectiles';

function Scene() {
  const ref = useRef<BulletManagerHandle>(null);

  return (
    <>
      <BulletManager ref={ref} pattern="galaxy" />
      <button onClick={() => ref.current?.fire()}>Fire!</button>
      <button onClick={() => ref.current?.clear()}>Clear</button>
      {/* ref.current?.activeCount exposes the live bullet count */}
    </>
  );
}
```

| Member | Type | Description |
|---|---|---|
| `fire()` | `() => void` | Manually trigger one burst of the current pattern. |
| `clear()` | `() => void` | Deactivate all bullets and reset the simulation timer. |
| `activeCount` | `readonly number` | Number of bullets currently alive. |

---

### Custom Material

Override the default `<meshBasicMaterial>` by passing a child material:

```tsx
<BulletManager pattern="galaxy">
  <meshStandardMaterial emissive="hotpink" emissiveIntensity={2} />
</BulletManager>
```

---

### Object Pool (`acquire` / `releaseSpawnData`)

The low-level API powering custom pattern generators.

```ts
import { acquire, releaseSpawnData } from '@k9kbdev/r3f-projectiles';

// Fetch a clean BulletSpawnData from the pool
const bullet = acquire();
bullet.offset.set(1, 0, 0);
bullet.velocity.set(0, 1, 0);

// Return the array to the pool when finished
const batch = [bullet];
releaseSpawnData(batch);
```

`acquire()` yields objects with zeroed vectors, no delay, and a standard life span. The pool strictly caps at 20,000 instances.

---

## Custom Patterns

### Radial Burst

```ts
import { gen, mod, compose } from '@k9kbdev/r3f-projectiles';

const redBurst = () => compose(
  gen.ring(64, 4),
  mod.color(0xff0000),
  mod.accelerate(0.5),
);
```

### Sequenced Helix with Drift

```ts
import { Vector3 } from 'three';
import { gen, mod, compose } from '@k9kbdev/r3f-projectiles';

const driftingHelix = () => compose(
  gen.helix(120, 1.5, 6, 3),
  mod.color(0xff66ff),
  mod.sequence(0.01),
  mod.accelerate(0.3, 1.2),
);
```

### Rotated Torus Knot

```ts
import { Vector3 } from 'three';
import { gen, mod, compose } from '@k9kbdev/r3f-projectiles';

const tiltedKnot = () => compose(
  gen.torusKnot(250, 3, 5, 2),
  mod.color(0x33ffff),
  mod.rotate(new Vector3(1, 0, 0), Math.PI / 4),
);
```

Apply your pattern using the `pattern` prop:

```tsx
<BulletManager pattern={driftingHelix} fireRate={1} />
```

---

## Zustand Integration

Bind `BulletManager` to a Zustand store for reactive pattern control:

```tsx
import { create } from 'zustand';
import { Canvas } from '@react-three/fiber';
import {
  BulletManager,
  gen, mod, compose,
  PATTERN_LABELS,
  type PatternKey,
  type PatternFactory,
} from '@k9kbdev/r3f-projectiles';

interface BulletStore {
  pattern: PatternKey | PatternFactory;
  fireRate: number;
  paused: boolean;
  setPattern: (p: PatternKey | PatternFactory) => void;
  setFireRate: (r: number) => void;
  togglePause: () => void;
}

const useStore = create<BulletStore>((set) => ({
  pattern: 'fibonacciSphere',
  fireRate: 1.5,
  paused: false,
  setPattern: (pattern) => set({ pattern }),
  setFireRate: (fireRate) => set({ fireRate }),
  togglePause: () => set((s) => ({ paused: !s.paused })),
}));

function Scene() {
  const { pattern, fireRate, paused } = useStore();
  return <BulletManager pattern={pattern} fireRate={fireRate} paused={paused} />;
}

export default function App() {
  const { setPattern, togglePause } = useStore();

  return (
    <>
      <div style={{ position: 'absolute', zIndex: 1, padding: 16 }}>
        {(Object.keys(PATTERN_LABELS) as PatternKey[]).map((key) => (
          <button key={key} onClick={() => setPattern(key)}>
            {PATTERN_LABELS[key]}
          </button>
        ))}
        <button onClick={togglePause}>⏯ Pause</button>
      </div>
      <Canvas camera={{ position: [0, 6, 14] }}>
        <Scene />
      </Canvas>
    </>
  );
}
```

---

## Architecture

### Zero-Allocation Render Loop

I update up to 2,000 bullet transforms per frame by default. The `useFrame` callback never allocates memory, preventing garbage collection stutters. Scratch objects (`Object3D`, `Vector3`, `Color`) initialize once in `useMemo` and recycle endlessly. Physics update in-place via `addScaledVector`.

### Object Pooling

Pattern generators call `acquire()` to fetch `BulletSpawnData` from the free list or allocate new memory if empty. Once consumed, `releaseSpawnData()` returns objects to the pool. I hard-cap the pool at 20,000 to strictly bound memory usage and eliminate per-burst allocation pressure.

### GPU Buffer Optimization

I hint `DynamicDrawUsage` to the GPU driver, acknowledging per-frame buffer writes. I flag `needsUpdate = true` exactly once after the full bullet loop, batching the entire GPU upload.

### Functional Composition

The pattern API uses a strict functional approach: generators produce data, modifiers transform it, and `compose()` connects them. This sidesteps inheritance for pure composition and guarantees tree-shaking.

### Motion Sensitivity

Setting `reducedMotion` to `true` spawns a single static snapshot of up to 200 bullets. Velocity locks at zero. No animation runs. This respects system-level `prefers-reduced-motion` preferences while retaining the pattern's visual identity.

---

## Accessibility

Respect user preferences with the `reducedMotion` prop:

```tsx
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

<BulletManager pattern="galaxy" reducedMotion={prefersReduced} />
```

This guarantees a static, non-animated snapshot safe for users sensitive to motion.

---

## Tree-Shaking

Access the raw pattern math as a standalone module independent of React and R3F:

```ts
import { gen, mod, compose } from '@k9kbdev/r3f-projectiles/patterns';
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Install dependencies: `npm install`
4. Run dev server: `npm run dev`
5. Run tests: `npm test`
6. Submit a PR against `main`

---

## License

MIT — [Kaleb Kougl](https://github.com/Kaleb-Kougl)
