// ---------------------------------------------------------------------------
// r3f-projectiles — A standalone R3F instanced-mesh projectile system.
// ---------------------------------------------------------------------------

// Components
export { BulletManager } from './BulletManager';

// Pattern system
export { gen, mod, compose } from './patterns';
export { BUILTIN_PATTERNS, resolvePattern } from './presets';

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

// Utilities
export { ProjectileTelemetry } from './ProjectileTelemetry';
export type { ProjectileTelemetryProps } from './ProjectileTelemetry';
