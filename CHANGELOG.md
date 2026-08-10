# Changelog

Notable changes to `@k9kbdev/r3f-projectiles`. Versions follow semver. This file starts at
0.4.0 and does not reconstruct earlier releases. Git tags cover through `v0.3.8`; 0.3.9–0.3.12
were published without tags, so the packaged tarballs are the only record of those.

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
