// ---------------------------------------------------------------------------
// r3f-projectiles — A standalone R3F instanced-mesh projectile system.
// ---------------------------------------------------------------------------

// Components
//
// `<BulletManager>` is the one-emitter convenience and stays, permanently.
// `<BulletField>` + `<Emitter>` are the N-emitter form: one mesh, one pool, one
// frame loop, many emitters — plus an imperative `fireAt` for emitters that are
// pool rows rather than components.
export { BulletManager } from './BulletManager';
export { BulletField } from './BulletField';
export { Emitter } from './Emitter';

// Headless simulation (0.6.0) — the one implementation of the bullet sim,
// React-free, also on the `/core` entry. `<BulletField>` runs one internally,
// or renders yours through its `simulation` prop.
export { createBulletSimulation } from './core/simulation';
export type {
  BulletSimulation,
  BulletSimulationOptions,
  BoundsCenterSource,
  ForEachActiveCallback,
  PoolExhaustedCallback,
  Vector3Like,
} from './core/simulation';

// Pattern system
export { gen, mod, compose } from './patterns';
// Seeded generator for deterministic `gen.galaxy` / `gen.rose3D` (0.6.0).
export { createSeededRandom } from './rng';
export { BUILTIN_PATTERNS, resolvePattern } from './presets';

// Payload bitfields — several small fields in the one per-bullet integer.
// Also on the React-free `/patterns` entry.
export { definePayload } from './payload';
export type { PayloadLayout, PayloadSchema, PayloadValues } from './payload';

// Easing (bullet fade-out)
export { EASING } from './easing';
export type { EasingFn, EasingName } from './easing';

// Pool
export { acquire, releaseSpawnData } from './pool';

// Types
export type {
  BulletSpawnData,
  PatternKey,
  PatternFactory,
  BulletManagerProps,
  BulletManagerHandle,
  Modifier,
} from './types';
export { PATTERN_LABELS } from './types';

// Field / emitter types. Type-only, so they are invisible to the barrel's
// exact-set export test by design (see its comment at `:24`).
//
// `BulletFieldHandle` is the field's PUBLIC surface only. The registry plumbing
// (`register` / `unregister` / `fire`) lives on the unexported
// `EmitterRegistryHandle`, because all three name `EmitterEntry`, which is not
// exported here — and a public type must not name one that is not.
export type {
  BulletFieldProps,
  BulletFieldHandle,
  EmitterProps,
  PoolExhaustionReason,
} from './BulletField';
export type { StepMode } from './stepping';
export type { EmitterHandle } from './Emitter';

// Rendering: bullet geometry, orientation, outlines (0.5.0)
export { bulletGeometry } from './render/geometry';
export type {
  ArrowGeometryOptions,
  DiamondGeometryOptions,
} from './render/geometry';
export type { BulletOrient } from './render/orient';
export type { BulletOutline, OutlineMode } from './render/outline';

// Utilities
export { ProjectileTelemetry } from './ProjectileTelemetry';
export type { ProjectileTelemetryProps } from './ProjectileTelemetry';
