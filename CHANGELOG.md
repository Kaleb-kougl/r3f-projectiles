# Changelog

Notable changes to `@k9kbdev/r3f-projectiles`. Versions follow semver. This file starts at
0.4.0 and does not reconstruct earlier releases. Git tags cover through `v0.3.8`; 0.3.9–0.3.12
were published without tags, so the packaged tarballs are the only record of those.

---

## Unreleased (0.7.0)

### Sprite atlases: per-bullet frames; screen-facing velocity billboards

For pixel-art games that draw every bullet as a sprite: many looks in one field, chosen per bullet from its payload,
and sprites that face where they fly without leaving the screen plane. Additive and backwards compatible — all 385
pre-existing tests pass unmodified apart from the barrel's exact-export list (below); with `frames` unset and no new
`orient` value, every matrix and buffer write is the 0.6.0 one.

#### Added

- **`frames?: BulletFrames`** on `<BulletField>` and `<BulletManager>` — `{ columns, rows, frame(index, payload),
  upright?(frame) }`. The material's `map` is read as a `columns × rows` atlas (cell 0 top-left, `v = 1` at the top)
  and `frame` picks each bullet's cell whenever its matrix is written: at spawn, on every step it moves, and every
  frame while an external simulation is interpolated. One field, one material, one draw call — any number of looks.
  - The field draws a **view** of the consumer geometry that shares its index and attribute objects by reference
    plus a per-instance `bulletFrame` attribute, uploaded with `addUpdateRange` over the same slots as
    `instanceMatrix`. The consumer geometry is never modified or disposed; the view's dispose releases only its own
    buffer (the shared ones are hidden from three's dispose path for that synchronous event, then restored).
  - The consumer **material is patched** (`onBeforeCompile`, chained after the material's own; program cache key =
    the original's + a suffix, so patched and unpatched materials never share a program; a define) so `vMapUv` picks
    the cell. Unpatched when `frames` is removed or the material changes. Needs three r151+ (`vMapUv` / `MAP_UV`);
    the patch's anchors are tested against the installed three's `ShaderLib`.
  - The **`'alpha'` outline follows the cell**: it dilates the bullet's own cell and treats every tap past the cell's
    edge as empty, so a neighbouring cell never bleeds into a rim.
  - `upright(frame)` exempts cells from `orient`'s velocity rotation (`'velocity'` draws them unrotated,
    `'camera-velocity'` as plain `'camera'` billboards) while still recording their heading.
  - Ignored, with one development warning, on the default sphere or with a non-positive grid.
- **`orient: 'camera-velocity'`** — the `'camera'` billboard rolled in the screen plane so local +X points along the
  velocity as projected onto the camera's right / up axes: screen-aligned sprites, exact pixel size under an
  orthographic camera, still facing their heading. Square roots only (no trig), allocation-free, the camera read once
  per frame. No on-screen extent → unrolled; zero velocity keeps the last heading.
- **Exports**: `FRAME_ATTRIBUTE` (`'bulletFrame'`), `OUTLINE_DIRECTION_ATTRIBUTE` (`'outlineDirection'`, previously
  hard-coded by consumers building their own flat shapes), type `BulletFrames`. The barrel's exact-export list gains
  the two constants.

#### Performance

Fastest of 30 frames over 2,000 moving bullets (test-renderer overhead included), three runs:
`orient="camera-velocity"` with `frames` (half the cells upright) costs 1.45–1.66× `orient="none"` on the default
sphere; the perf suite bounds it at 3×. The allocation suite's new case (atlas + alpha outline + camera-velocity)
constructs nothing per frame.

#### Tests

385 → 408. New `frames.test.tsx` (grid validation; the vertex and outline patches against three's real `ShaderLib`;
the material patch's chaining, cache key, defines and restore; the geometry view's sharing and its dispose never
listing shared buffers; the writer's screen-heading math at eight headings including the antiparallel one, stops,
headings at the camera, `upright` in both velocity modes; mounted fields — external and owned — writing each bullet's
cell from its payload at both write sites, following `setPayload`, the outline's `OUTLINE_FRAMES`, removal restoring
the consumer's geometry and material, the sphere warning, `<BulletManager>` forwarding), a perf case and an alloc case.

---

## 0.6.0

### Headless simulation core; `<BulletField>` renders external simulations

For games whose gameplay runs on a fixed, deterministic tick that must also run where React
does not — a replay check re-running recorded input in a plain function, a co-op peer, a
server, a test. The bullet simulation now lives in a React-free core, and `<BulletField>` is
built on it: there is one implementation, not a component and a port. Additive and backwards
compatible — all 338 pre-existing tests pass unmodified apart from the barrel's exact-export
list, which exists to be updated (below).

#### Added

- **`createBulletSimulation(options?)`** → **`BulletSimulation`**, from the package root and
  the new **`@k9kbdev/r3f-projectiles/core`** entry. The slot pool and sparse set, spawning
  (offset, delay, life, payload, scale, color), semi-implicit Euler motion with acceleration,
  expiry, bounds culling, the emitter-id counter, `forEachActive` consumption and fade
  bookkeeping — with no React, no renderer, no DOM. API: `step(dt)`, `fireAt(origin,
  pattern, emitterId?)` (returns the spawned count), `acquireEmitter()` / `releaseEmitter(id)`,
  `clear(emitterId?)` (returns the freed count), `activeCount`, `activeCountFor(id)`,
  `forEachActive(cb)`, `setPayload(i, payload)`, `stepCount`; mutable `boundsLimit`,
  `boundsCenter` (a `{ current }` ref, a getter, or a live vector), `fadeTime`, `fadeCurve`,
  `onPoolExhausted`; per-slot read access for renderers (`positionAt`, `velocityAt`,
  `previousPositionAt`, `lifeAt`, `delayAt`, `payloadAt`, `emitterIdAt`, `scaleAt`, `fadeAt`,
  `colorAt`, `isLive`, `isVisible`, `highWater`) and render-sync bookkeeping (`dirtyMin` /
  `dirtyMax`, `spawnedSinceSync(i)`, `markSynced()`). Options: `maxBullets` (fixed),
  `boundsLimit`, `boundsCenter`, `fadeTime`, `fadeCurve`, `interpolation`, `onPoolExhausted`.
  Allocates nothing per step or per bullet; a sinkless step is motion, life and culling only.
- **State hashing**: `writeStateHash(out)` appends `index, x, y, z, vx, vy, vz, life,
  payload, emitterId` per live bullet in ascending slot order, for a game's own state hash;
  `hashState()` is a 32-bit FNV-style hash over the exact IEEE-754 bits of the same values
  (endianness fixed, so it agrees across machines), allocation-free.
- **`<BulletField simulation={sim}>`** — render a simulation you own. The field never steps,
  spawns or culls it; once per rendered frame it syncs the simulation's dirty slot range
  through the 0.5.0 `InstanceWriter` (so `geometry`, `orient`, `outline`, `material`,
  `bulletRadius` all apply) and uploads once. The handle forwards every member to the
  simulation except `step()`, a no-op with one development warning. Simulation props
  (`maxBullets`, `boundsLimit`, `boundsCenter`, `fadeTime`, `fadeCurve`, `paused`,
  `reducedMotion`, `stepMode`, `onPoolExhausted`) are ignored, with one development warning
  naming any passed. **`<Emitter>` inside such a field throws during render.** `onBulletCount`
  is raised once per frame in which the simulation stepped.
- **`interpolate?: () => number`** on `<BulletField>` — with `simulation` created with
  `interpolation: true`, draws each bullet at `previous + (current − previous) × alpha`.
  Position only; rewrites every slot up to the high-water mark per frame; zero allocation.
  Ignored, with a development warning, without `simulation` or without `interpolation`.
- **`createSeededRandom(seed)`** — mulberry32, pure 32-bit integer arithmetic, so its stream
  is bit-identical on every engine. From the root, `/patterns` and `/core`.
- **`gen.galaxy(…, rng?)`** and **`gen.rose3D(…, rng?)`** take an optional last argument,
  `rng: () => number`, default `Math.random` (unchanged behaviour, still two draws per
  bullet). Pass a seeded generator and both replay exactly. The `'galaxy'` and `'rose3D'`
  presets stay random.
- **Types** `BulletSimulation`, `BulletSimulationOptions`, `BoundsCenterSource`,
  `ForEachActiveCallback`, `PoolExhaustedCallback`, `Vector3Like` (root and `/core`);
  `PoolExhaustionReason` is now also on `/core`.

#### Decisions

- **Emitters stay in React.** `<Emitter>` cadence, the orbit and the reduced-motion snapshot
  remain `<BulletField>`'s; the core spawns only through `fireAt`. A fixed-tick game owns
  cadence as gameplay state, and a library-owned timer would be one more thing to serialize.
- **An owned field writes matrices inline, an external one is pulled.** The owned field
  attaches an internal render sink to its core, called at exactly the points 0.5.0 wrote
  matrices — so its GPU writes (slots, order, values, writes per step, update ranges,
  versions) are unchanged; this was checked byte-for-byte against 0.5.0 on a scripted trace,
  as well as by the existing suites. An external simulation has no sink and pays for no
  matrix work per step; its renderer syncs once per frame instead.

#### Changed

- Internal: `<BulletField>` holds no simulation state of its own. Its pool, sparse set,
  spawn, step body, `clear`, `forEachActive`, `setPayload` and id counter are the core's;
  the field keeps the emitter registry, cadences, reduced motion, `paused` / `stepMode`, the
  per-frame flush and the handle. `PoolExhaustionReason` is defined beside the core and
  re-exported from `BulletField` unchanged.
- Internal: the React-free pattern types (`BulletSpawnData`, `PatternKey`, `PatternFactory`,
  `Modifier`) moved from `src/types.ts` to `src/patternTypes.ts`, which `src/types.ts`
  re-exports. The `/patterns` and `/core` declaration chunks therefore no longer reference
  the global `React` namespace (they previously shared one with `BulletManagerProps`), so a
  headless consumer type-checks without `@types/react`.
- The barrel's exact-export list gains `createBulletSimulation` and `createSeededRandom`.

#### Performance

Measured with a throwaway harness run against both builds: each case is the fastest of 300
rounds, each build was run five times alternately, and the table shows the median of those
five (jsdom + `@react-three/test-renderer`, so frame figures include the test renderer's own
overhead):

| Case | 0.5.0 | 0.6.0 |
|---|---|---|
| Auto frame, 2,000 moving bullets, `orient="none"` | 0.080 ms | 0.086 ms |
| Auto frame, 2,000 moving bullets, `orient="velocity"` | 0.142 ms | 0.152 ms |
| Five manual `step()`s, 2,000 bullets | 0.41 ms | 0.47 ms |
| `forEachActive` over 2,000 (no consumption) | 0.0040 ms | 0.0046 ms |
| 100-bullet `fireAt` + `clear` into a near-full 32,000 pool | 0.160 ms | 0.106 ms |

Read honestly: the owned field's step and frame paths measure 6–13 % slower, `forEachActive`
~0.6 µs slower per 2,000 bullets, and bursts ~34 % faster. The step-path gap is not
clearly structural — run in one process, the 0.5.0 loop and the core's loop traded places
depending on which the JIT saw first (0.070 vs 0.082 ms in one order, 0.087 vs 0.084 ms in the
other) — but it is reported as measured rather than rounded to "parity". A headless step with
no renderer attached is ~0.025 ms for 2,000 bullets: it composes no matrices. The existing perf,
alloc and O(active) suites pass unchanged.

#### Tests

338 → 385. New: `core.simulation.test.ts` (the core with no React renderer — `react` and
`@react-three/fiber` are mocked to throw on import, in a `node` environment),
`core.determinism.test.tsx` (two simulations, one hash; rendering under four frame groupings
with interpolation never perturbs the simulation; an owned manual field and a headless
simulation end one script in identical slots and doubles), `BulletField.external.test.tsx`
(matrices match the simulation's positions × scale × fade; dirty-range upload once per frame;
colors; byte-identical buffers versus an owned field with `orient`, `geometry` and `outline`;
interpolation; the handle; the `<Emitter>` error; warnings) and `core.entry.test.ts` (builds
with the package's tsup config and checks that everything `core.js`, `core.cjs` and
`core.d.ts` load, transitively, is `three` — then runs the built `core.js`).

---

## 0.5.0 — 2026-10-09

### Simulation: manual stepping, bounds options, payload helpers

Simulation-side features for fixed-timestep and deterministic games: manual stepping, bounds
options, and payload bitfields. Additive and backwards compatible — with every new prop at its
default, the frame loop's observable behaviour is unchanged, and all 203 pre-existing tests pass
unmodified apart from the two export-surface lists that exist to be updated (below).

#### Added

- **`stepMode?: 'auto' | 'manual'`** on `<BulletField>` and `<BulletManager>`, default
  `'auto'` (today's loop). Under `'manual'` the field's `useFrame` advances nothing — cadence
  timers, emitter auto-fire, orbit phase, spawn delays, motion, life, bounds culling, the fade,
  the reduced-motion snapshot — and **`step(dt)`** on the handle advances exactly `dt` seconds
  of all of it, any number of times per rendered frame. `dt` is not clamped.

  The GPU upload stays **once per rendered frame**: a step writes instance matrices on the CPU
  but never flags them, and the frame callback uploads the union of everything written since
  the previous frame in one `needsUpdate` and one `addUpdateRange` record. Five steps cost one
  upload. Call `step()` before the field's frame callback runs (a negative-priority `useFrame`
  or outside R3F's loop); a later step is uploaded on the following frame.

  **Deterministic**: the same sequence of `step(dt)`, `fire()` / `fireAt()`, `forEachActive`
  consumption and `setPayload` calls produces bit-identical positions, slots and payloads
  however the steps are grouped into frames. Within one JS engine on one platform — the `Math`
  trig functions are implementation-approximated and differ across engines — and only with
  deterministic patterns: `gen.galaxy` and `gen.rose3D` use `Math.random()`. See the README's
  "Deterministic stepping".

  `step()` is a no-op in `'auto'` mode (one development warning per field), while `paused`
  (dropped, not queued), before mount, and for a `dt` that is not a finite number `> 0`
  (`NaN`, negative and infinite values warn once in development). It never throws.
  `onBulletCount` is raised once per rendered frame in which at least one step ran.
- **`boundsCenter?: { current: Vector3 | null }`** on `<BulletField>` and `<BulletManager>` —
  centres the bounds cull box on a moving point (player, camera), re-read once per step.
  Omitted or `null`: the field's origin, as before.
- **`boundsLimit={Infinity}` is now a documented way to disable bounds culling** (it always
  worked: no finite coordinate exceeds `Infinity`). It also skips the per-bullet test. `0` is
  deliberately not given a special meaning.
- **`definePayload(schema)`** — named bitfields over the per-bullet payload integer:
  `pack(values)`, `get(payload, field)`, `with(payload, field, value)`, `max(field)`, `bits`,
  `fields`. Declaration order, lowest bits first; at most 31 bits, so every payload is a
  non-negative integer. Bad schemas throw a `RangeError` at definition time. Out-of-range
  values and unknown field names throw in development builds; production skips the checks
  and masks each value to its field's width, so an overflow can never bleed into a
  neighbouring field. Exported from the package root and the React-free `/patterns` entry,
  with types `PayloadLayout`, `PayloadSchema`, `PayloadValues`.
- **`setPayload(index, payload)`** on `BulletFieldHandle` and `BulletManagerHandle` — the
  write-back half of `forEachActive`, without which a payload "pierce counter" could not
  actually count — `with()` returns a new integer and would otherwise have nowhere to put it.
  Ignored for a slot that is not live.
- **`step(dt)`** on `BulletManagerHandle`, forwarding to the field.
- **Type** `StepMode`.

#### Changed

- **Documentation only: `boundsLimit` was described as a "distance from origin".** It is, and
  always has been, the half-extent of an axis-aligned **cube** — a bullet is culled when any
  one coordinate is more than `boundsLimit` from the centre — measured in the field's
  **local** coordinates. Behaviour is unchanged; the props tables and JSDoc now say so.
- `BulletFieldHandle` is now nine members (`step`, `setPayload` added), and
  `BulletManagerHandle` gains the same two. Additive for callers; code that *implements*
  either interface itself (a hand-rolled mock, say) must add them. The type-level test and the
  barrel's exact-export list were updated accordingly.

#### Internal

- The frame loop's body moved, in place, into a `useCallback` step function that both the
  auto frame loop and `step()` call. It folds its dirty slot span into a per-field pending
  range instead of flagging the upload itself; the frame callback flushes once per frame. In
  `'auto'` mode that is one fold and one flush per frame — the same GPU writes as before.
- The `paused` frame now also runs the (empty) flush: `syncMeshCount` is idempotent and an
  empty range marks nothing, so nothing observable changes.
- New internal modules `src/stepping.ts` and `src/dev.ts`, and `src/payload.ts`.

### Rendering: custom geometry, orientation, outlines

Bullets that are shapes rather than spheres: a custom **`geometry`**, an **`orient`** that points
each bullet along its velocity or at the camera, and an **`outline`** drawn from the field's own
instance matrices. All three are new props on `<BulletField>` and `<BulletManager>`, all optional,
and with none of them set the field's output is unchanged — the instance matrix written for a
visible bullet is bit-for-bit the 0.4.0 one, and a test compares the stored floats to prove it.

#### Added

- **`geometry?: BufferGeometry`** — replaces the default sphere. The convention: forward is local
  +X, up is local +Y (flat shapes lie in XZ facing +Y), authored at unit size. A custom geometry is
  scaled by `bulletRadius` and per bullet by `mod.scale` through the instance matrix; the default
  sphere still bakes `bulletRadius` into its vertices, so its matrices are unchanged.

  **The field never disposes a geometry it did not create** — not on unmount, not when the prop
  changes. One geometry can be shared by any number of fields, and disposing it is the caller's
  job. Only the default sphere is the field's to dispose, and it still is.
- **`bulletGeometry`** — ready-made flat shapes, each call returning a new geometry the caller
  owns: `quad()` (unit quad with planar UVs, the canvas for a textured sprite), `arrow({
  headLength?, headWidth?, shaftWidth? })` and `diamond({ width? })`, both pointing along +X.
  Every helper also carries an `outlineDirection` attribute, a mitred in-plane offset the outline
  pass uses for an even rim.
- **`orient?: 'none' | 'velocity' | 'camera'`**, default `'none'`.
  - `'velocity'` turns local +X onto the bullet's current velocity, every frame — a yaw about
    world Y, then a pitch, never a roll. In the XZ plane that is a pure rotation about Y, so flat
    shapes stay face-up; a 3D heading tilts the nose without rolling the shape over. This is
    deliberately not the shortest-arc rotation, which turns a face-up sprite heading
    `(−1, 0.01, 0)` upside-down. Zero velocity keeps the last heading, a bullet that never moved
    stays unrotated, and nothing produces `NaN`. The reduced-motion snapshot aims each frozen
    bullet along its pattern's velocity.
  - `'camera'` billboards: every instance takes the camera's world rotation, with local +Y toward
    the camera. Screen-aligned, read once per frame.

  Allocation-free in both modes, and cheap: over 2,000 moving bullets `'velocity'` measures about
  1.6–1.7× the `'none'` frame and `'camera'` about 1.1–1.2×, test-renderer overhead included.
- **`outline?: { color, width, mode? }`** — a uniform-color rim behind every bullet, rendered by a
  second instanced mesh that shares the bullet mesh's `instanceMatrix` attribute object and reads
  its live `count`. No per-bullet CPU work and one extra draw call; it moves, rotates, scales and
  fades with its bullet. `width` is world units at the bullet's base size and scales with the
  instance. `mode` (`'auto'` by default) picks how the rim is grown: `'alpha'` dilates an
  alpha-tested sprite's own silhouette, `'extrude'` pushes along `outlineDirection`, `'scale'`
  scales flat shapes about their origin, `'hull'` is an inverted hull for 3D geometry. The field
  creates, owns and disposes the outline mesh and its material, and never the shared buffer.
- **Types**: `BulletOrient`, `BulletOutline`, `OutlineMode`, `ArrowGeometryOptions`,
  `DiamondGeometryOptions`.
- **`examples/sprite-bullets`** (`npm run dev:sprites`) — arrows, shards and billboarded orbs from
  canvas-generated 16×16 textures, tinted per bullet with `mod.color`, outlined, under a 45° / 55°
  orthographic camera rendering at 480×270.

#### Known limits

Stated in the README under [Outlines](./README.md#outlines) and
[Orientation](./README.md#orientation), and repeated here so they are not discovered:

- The `'alpha'` outline assumes `bulletGeometry.quad()`'s planar UVs (atlas `offset`/`repeat`
  honoured) and dilates with 16 texture taps — right for pixel-art widths, gappy for very wide
  rims across thin features. For a pixel-perfect rim, bake it into the sprite.
- `'scale'` outlines are exact only for circles; `'hull'` needs smooth normals.
- The outline material is its own solid `MeshBasicMaterial` and does not inherit the bullet
  material's fog, clipping planes, blending or opacity.
- Orientation is written with the matrix, so a `paused` field's billboards keep facing where the
  camera was when it paused.

#### Internal

- Both "show" write sites — the spawn-time write and the per-frame fade write — now go through one
  `InstanceWriter` (`src/render/orient.ts`) that composes translation, rotation and base scale.
  The "hide" writes are untouched. `orient="none"` composes `position × identity × scale`, the same
  call `Object3D.updateMatrix()` made for the old scratch `_dummy`.
- The outline mesh is a three.js child of the bullet mesh, added imperatively, so the field still
  contributes exactly one scene node and `scene.children[0]` is still the bullet mesh.
- New tests: render integration (geometry ownership, bit-identical default matrices, heading and
  billboard math at both write sites, outline wiring and disposal), pure unit tests for the
  helpers, writer, mode resolution and shader patch, a ratio perf test for `orient`, and an
  allocation test that counts every three.js construction the library's own code makes.

---

## 0.4.0 — 2026-08-09

The N-emitter form: **`<BulletField>` + `<Emitter>`**. One mesh, one pool, and one frame
loop shared by any number of emitters, plus an imperative `fireAt` for emitters that are
pool rows rather than components.

Additive. `<BulletManager>` keeps its entire props surface, its documented defaults, and its
imperative handle; it is now internally a one-emitter field, and it is neither deprecated nor
going anywhere. Three consumer-visible behaviour changes, below — everything else is
byte-identical.

### Changed

- **`reducedMotion` now snapshots from an emitter's `origin` when one is supplied**, instead
  of unconditionally from `(0, spawnCenterY, 0)`. Previously a `<BulletManager origin={ref}
  reducedMotion>` drew its accessibility snapshot at the world origin rather than at the
  emitter — a snapshot of a moving emitter's bullets somewhere the emitter is not.

  This is the release's **one deliberate divergence**. It is the only generalization that
  means anything at more than one emitter, and it makes the three origin-resolution paths —
  manual `fire()`, auto-fire, and the snapshot — agree for the first time. Consumers who
  pass no `origin` see byte-identical behaviour.

- **`mod.scale(n)` is no longer inert.** The per-bullet `scale` field was previously carried
  through the pool and then discarded at render. It now applies at both write sites: the
  spawn-time matrix write and the per-frame fade write. So it is honoured in normal flight,
  under `paused`, and in the reduced-motion snapshot — the last two being paths that never
  reach the fade line at all — and it composes with the fade rather than replacing it, so a
  `mod.scale(3)` bullet fades from 3 to 0 exactly as a default one fades from 1 to 0.

  `scale` defaults to `1` on both `acquire()` branches, so consumers who never call
  `mod.scale` see no change at any site.

- **`forEachActive` invokes its callback with a fourth argument, `emitterId`.** Purely
  additive: JavaScript ignores arguments a callback does not declare, so existing
  three-parameter callbacks are unaffected in both TypeScript and JavaScript.

### Added

- **`<BulletField>`** — owns the `<instancedMesh>`, the slot pool, and the single `useFrame`.
  Field-level props (`maxBullets`, `boundsLimit`, `bulletRadius`, `fadeTime`, `fadeCurve`,
  `paused`, `reducedMotion`, `onBulletCount`) behave as they always have; `children` carries
  emitters.
- **`<Emitter>`** — an origin, a pattern, and a cadence (`pattern`, `fireRate`, `origin`,
  `spawnCenterY`, `rotationSpeed`). Renders nothing, registers imperatively, and keeps its own
  cadence, orbit phase, and reduced-motion snapshot. Its `ref` exposes `fire()`, with the same
  four differences from the frame loop that `<BulletManager>.fire()` has always had. Mounted
  outside a `<BulletField>` it throws during render.
- **`material` prop on `<BulletField>`** — the shared mesh's material, defaulting to
  `<meshBasicMaterial fog={false} />`. It is a prop rather than a child because `children` is
  needed for emitters, and because "one field, one material" is then stated by the type.
  `<BulletManager>` keeps `children`-as-material, unchanged.
- **`fireAt(origin, pattern, emitterId?)`** on the field handle — spawn one burst at an
  arbitrary origin, with no component per emitter. The origin is copied and never retained;
  it works while the field is paused; it advances no cadence, because it has none.
  `emitterId` defaults to the reserved anonymous id `0`.
- **`acquireEmitter()` / `releaseEmitter(id)`** — emitter ids for imperative consumers, drawn
  from the same monotonic counter `<Emitter>` registration uses. Ids start at `1` and are
  never recycled. `releaseEmitter` deliberately does **not** clear that emitter's bullets:
  they stay in flight and stay correctly attributed. Call `clear(id)` first if you want them
  gone.
- **`clear(emitterId?)`** on the field handle — the field-wide form is the existing
  `clear()`; passing an id narrows it to one emitter's bullets, cadence, and snapshot guard,
  leaving every other emitter's bullets untouched.
- **`activeCountFor(emitterId)`** — live bullets carrying an id, delayed ones included.
  `O(active)`.
- **`onPoolExhausted(emitterId, requested, spawned, reason)`** — raised once per burst that
  could not be filled, never once per dropped bullet, from every spawn path including a
  budget-truncated reduced-motion snapshot. The pool is first-come, first-served in
  registration order, and a full field drops the newest burst rather than recycling a live
  slot.

  `reason` is a `PoolExhaustionReason`: `'pool-full'` when the shared slot pool ran out, and
  `'reduced-motion-budget'` when the field-wide 200-bullet snapshot allowance did. Exhaustion
  has one semantics in this library rather than two, but it does not have one remedy —
  `'pool-full'` says raise `maxBullets` or slow an emitter down, and `'reduced-motion-budget'`
  says nothing can be done, because that cap is deliberately not configurable and the pool may
  be almost empty. Without the discriminator the obvious lever is also the wrong one half the
  time. The reduced-motion path is the only one where either constraint can bind, and it
  reports whichever actually did.
- **`mod.scale(n)`** and a required `scale` field on `BulletSpawnData`, alongside `color` and
  `payload`. A per-bullet multiplier against the field's `bulletRadius`, not a replacement
  for it.
- **Types**: `BulletFieldProps`, `BulletFieldHandle`, `EmitterProps`, `EmitterHandle`,
  `PoolExhaustionReason`.

  `BulletFieldHandle` is exactly the seven-member consumer surface above — `fireAt`, `clear`,
  `acquireEmitter`, `releaseEmitter`, `activeCount`, `activeCountFor`, `forEachActive` — and
  nothing else. The registry plumbing an `<Emitter>` registers through (`register`,
  `unregister`, `fire(entry)`) is **not** on it: all three take an emitter-entry type this
  package does not export, so naming them in a public type would advertise methods no consumer
  can call — `fire(entry)` most misleadingly of all, since it reads as the way to fire an
  emitter. Fire a declared emitter through a `ref` on the `<Emitter>`; fire without one through
  `fireAt`. This is a type-level distinction only: there is still exactly one handle object at
  runtime, because it is also the registry context value and its identity has to stay stable.

### Internal

None of this changes the public API, and all of it is covered by the byte-identical claim
above except where noted:

- The linear slot scan is replaced by a sparse set over the pool. Acquire and release are
  `O(1)`; the frame loop, `clear()`, `activeCount`, and `forEachActive` are `O(active)`
  rather than `O(maxBullets)`. A 1000-bullet burst into a 19,000-of-20,000-full pool measures
  0.38 ms.
- GPU uploads are narrowed: `instanceMatrix` uses `addUpdateRange` over the slots actually
  written (three r159+; older builds upload the whole buffer exactly as before), and
  `instanceColor` is flagged dirty only when a spawn happened.
- `mesh.count` now tracks a high-water mark instead of sitting at construction capacity, so
  parked instances no longer run the vertex shader. **Observable if you inspect the mesh
  directly**: an empty field's `count` now reads `0` rather than `maxBullets`. It is not part
  of the public API, but a consumer raycasting or reading the mesh will see it.
- `clear()` no longer rewrites the matrices of slots that were never used, only of live
  bullets. Nothing renders differently — both states are off-screen with `count` at `0` — but
  `instanceMatrix` is no longer byte-identical after a `clear()`.
- `releaseSpawnData`'s per-item `includes()` scan over the free list is replaced with a
  `WeakSet` membership check, which matters now that `fireAt` puts a burst release in a
  per-frame path.
