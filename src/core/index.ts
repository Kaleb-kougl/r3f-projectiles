// ---------------------------------------------------------------------------
// @k9kbdev/r3f-projectiles/core — the React-free entry
// ---------------------------------------------------------------------------
//
// The headless bullet simulation, for games that step bullets on their own
// fixed tick and must be able to replay them without React, a renderer or a
// DOM: a replay check in a plain function, a dedicated server, a test.
//
// Imports `three`'s math classes and nothing else outside this package. Pair it
// with `@k9kbdev/r3f-projectiles/patterns` (gen / mod / compose /
// definePayload), which is React-free too; render the same simulation with
// `<BulletField simulation={sim} />` from the package root.

export { createBulletSimulation } from './simulation';
export type {
  BulletSimulation,
  BulletSimulationOptions,
  BoundsCenterSource,
  ForEachActiveCallback,
  PoolExhaustedCallback,
  PoolExhaustionReason,
  Vector3Like,
} from './simulation';

export { createSeededRandom } from '../rng';
