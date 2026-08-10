# Design — `<BulletField>` + `<Emitter>` split

**Status:** implemented — all six phases landed; shipped in v0.4.0 (additive, one documented divergence) · **Written:** 2026-08-09
**Revised:** 2026-08-09 — adversarial review folded in. `emitterId` reversed to field-issued;
pool-structure table split CPU/GPU; fifth release site added; three fidelity gaps in
`fire()` and `reducedMotion` named; test inventory corrected.

> **Scope discipline.** This is library work that earns its place on its own merits, not
> prototype work for OVERLORD. OVERLORD's M5 can ship its four-pre-mounted-manager
> workaround without any of this. "The library becomes the project" is a named risk on
> that project; nothing here should be pulled forward to satisfy it.

---

## The problem

`<BulletManager>` binds five things together that don't have to be: **one mesh, one pool,
one origin, one pattern, one cadence.** Mounting one allocates its entire pool in a
`useEffect` keyed on `maxBullets` (`src/BulletManager.tsx:146`, "Pool initialization").

So N simultaneous shooters means N managers — N pools, N draw calls, and pool
reallocation churn every time a shooter appears or dies mid-combat. Every shoot-'em-up
hits this wall the moment something other than the player shoots.

### The workaround it replaces

OVERLORD's archers sidestep it: four managers pre-mounted at `maxBullets={64}`, handed to
archers on spawn, reclaimed with `clear()` on death, concurrent shooters hard-capped at
four. That is a kludge with a cap baked into the game design.

---

## Design

`<BulletField>` owns the mesh, the pool, and the single frame loop. Emitters are
weightless — they contribute an origin, a pattern, and a cadence, and render nothing.

```tsx
<BulletField
  maxBullets={2000}
  bulletRadius={0.2}
  material={<meshStandardMaterial emissive="hotpink" emissiveIntensity={2} />}
>
  <Emitter origin={bossRef}   pattern={bossPattern}   fireRate={3} />
  <Emitter origin={turretRef} pattern={turretPattern} fireRate={1} />
</BulletField>
```

**The material moves from `children` to a `material` prop.** It has to: today `children`
*is* the material override (`src/types.ts:178`, rendered inside the `instancedMesh` at
`src/BulletManager.tsx:454`, tested at `src/__tests__/BulletManager.test.tsx:227`), and
this design needs `children` for emitters. `<BulletField>` is new so nothing breaks;
`<BulletManager>` keeps `children`-as-material in the wrapper. The prop form also states
"one field, one material" in the type signature instead of in a paragraph nobody reads.

### Two consumption paths, not one

This is the part the one-line roadmap entry misses, and it matters.

`<Emitter>` suits **stable, few, declarative** emitters — the player's weapon, fixed
turrets. It does *not* suit a swarm: mounting and unmounting a React component per enemy
reintroduces exactly the per-entity-component churn that pooled games avoid (OVERLORD's
own architecture rule 3 forbids it outright).

So the field's imperative handle must also expose direct spawning, for consumers whose
emitters are pool rows rather than components:

```ts
interface BulletFieldHandle {
  /** Issue a fresh, never-recycled emitter id. See decision 7. */
  acquireEmitter(): number;
  /** Retire an id. Does NOT clear its bullets — call clear(id) first if you want that. */
  releaseEmitter(id: number): void;

  /** Spawn one burst at an arbitrary origin. For pool-driven emitters — no React. */
  fireAt(origin: Vector3, pattern: PatternKey | PatternFactory, emitterId?: number): void;
  /** Deactivate bullets and reset the matching emitter cadence(s). Omit to clear all. */
  clear(emitterId?: number): void;

  readonly activeCount: number;
  activeCountFor(emitterId: number): number;
  forEachActive(cb: (i: number, pos: Vector3, payload: number, emitterId: number) => boolean | void): void;
}
```

> Shipped exactly as sketched, and that turned out to matter. Phase 4 gave the public handle
> `register` / `unregister` / `fire(entry)` as well, so that the registry context could carry
> one object; all three name `EmitterEntry`, which the barrel does not export, so the public
> type advertised three methods no consumer could call. Phase 6 put it back to these seven
> and moved the plumbing to an unexported `EmitterRegistryHandle`. Type-level only — there is
> still one handle object, because the context value's identity must stay stable.

A game with 100 archers acquires an id per archer on spawn, calls `fireAt` from its own
frame loop, and releases on death. No components, no mount churn, no cap.

The fourth `forEachActive` argument is additive in JS — existing three-parameter callbacks
keep working untouched. That is what makes the `BulletManager` wrapper possible without a
major bump.

### Wiring

- **Context carries an imperative registry, never state.** `<BulletField>` provides a
  context object with `register(entry)` / `unregister(entry)`. `<Emitter>` builds a stable
  entry via `useRef`, registers in a mount `useEffect`, and refreshes the entry's fields on
  every render — the same `propsRef` pattern `BulletManager` already uses. Registration must
  never trigger a re-render.
- **`material`, `<Emitter>`, and context registration are one atomic unit.** This is not
  obvious and it broke the original phasing. `<BulletManager>` is the *parent* of
  `<BulletField>`, so it sits outside the provider its own child renders and can never
  consume that context. The only context-based registration path is an `<Emitter>` rendered
  as a child — which requires `children` to be free for emitters — which requires the
  `material` prop. So the wrapper's target shape,
  `<BulletField material={children}><Emitter {...emitterProps} /></BulletField>`, needs all
  three or none. They cannot be phased apart.

  The escape hatch, used to land the field extraction on its own: register through the
  field's **imperative handle** instead of context. The registry object and both signatures
  are identical either way, so the swap is mechanical.

  > Landed in 3b. One correction: the context value is the field's whole imperative handle,
  > not a two-method registry — `<BulletManager>.fire()` stops being able to reach its
  > emitter's entry once `<Emitter>` owns it, so `<Emitter>` needs decision 4's `fire()`
  > handle, which needs `fire(entry)` on the context. See Implementation status.
  >
  > Phase 6 refined that to a **type-level** distinction: the context is typed
  > `EmitterRegistryHandle` (the public handle *plus* `register` / `unregister` / `fire`) and
  > the ref is typed `BulletFieldHandle`. Same object, two views — splitting the object is
  > what would break the identity stability this bullet depends on.
- **The field owns the only `useFrame`.** Emitters must not each run one, for two reasons:
  a single pass over the registry is cheaper, and one loop means one place where emission
  order is decided.
- **Emitter service order is registration order, and it is specified.** Be honest about
  what that does and does not buy. Registration happens in a mount `useEffect`, so
  registration order *is* mount order, which *is* JSX order — the same dependency that
  per-emitter `useFrame` would have created. Specifying it does not eliminate that
  dependency; it makes it visible, single-sourced, and testable, which is the actual
  improvement.

  The alternative was leaving it unspecified, and that does not survive contact with a
  shared pool that can exhaust: if order is unspecified *and* spawning drops when full,
  then which emitter loses bullets is nondeterministic by specification — untestable, and
  unfair in a fixed way anyway (first-registered always wins).

  Two consequences to document rather than hide: an emitter that unmounts and remounts
  moves to the **tail** of the registry and therefore to last service priority under a full
  pool; and consumers should read nothing into service order except exhaustion behaviour.

### Data model

Two new fields on the internal `BulletState`:

| Field | Why |
|---|---|
| `emitterId: number` | Provenance. Enables `clear(emitterId)`, per-emitter counts, and lets `forEachActive` tell a consumer which emitter fired a bullet — something the library legitimately knows and the consumer cannot otherwise recover. Field-issued and never recycled; see decision 7. |
| `scale: number` | Per-bullet size multiplier, default `1`. Written at two sites, not one; see decision 2. |

Neither field is a faction or team concept: they are slots the consumer gives meaning to.
Same boundary the `payload` slot already draws.

Per-bullet **color** already works (`setColorAt` per slot at spawn), so mixed-hue emitters
share one mesh for free.

### Prop partition

"The wrapper is thin" is a claim that has to be shown, not asserted. The fourteen current
props do not split evenly, and two of them land on the non-obvious side:

| Field props | Emitter props |
|---|---|
| `maxBullets` | `pattern` |
| `boundsLimit` | `fireRate` |
| `fadeTime` | `origin` |
| `fadeCurve` | `spawnCenterY` |
| `bulletRadius` | `rotationSpeed` |
| `paused` | |
| `reducedMotion` | |
| `onBulletCount` | |
| `material` (was `children`) | |

`rotationSpeed` exists only to drive the built-in Y-axis orbit fallback when no `origin`
ref is supplied (`src/BulletManager.tsx:371-377`) — an origin concern, so it is an emitter
prop.

`spawnCenterY` is an emitter prop too, but it is *not* purely an orbit concern: it is also
the unconditional snapshot centre under reduced motion (`src/BulletManager.tsx:342`) and
the fallback centre in `fire()` (`:258`). Under the split it stays per-emitter and each
emitter resolves its own centre in all three paths, which keeps the three consistent for
the first time. See decision 5.

`paused` and `reducedMotion` are whole-field early-returns today
(`src/BulletManager.tsx:333`, `:339`), so they stay field-level — but `reducedMotion`
services every emitter once before it freezes. See decision 5.

---

## Backwards compatibility

**`BulletManager` becomes a one-emitter field** — a thin wrapper with its current props
surface, forwarding to `<BulletField><Emitter/></BulletField>`, splitting props per the
table above and passing `children` through as `material`.

The wrapper maps cleanly for a reason worth stating: with exactly one emitter, field props
and emitter props are indistinguishable from the outside. Every ambiguity the split
introduces — service order, exhaustion fairness, per-emitter clear — is invisible at N=1.

Additive, so v0.4.0 — a minor for the new surface, not a major. **One deliberate
divergence**, in decision 5; it is behavioural, narrow, and gets a changelog line.

### The regression gate is 9 tests, not 118

The earlier draft leaned on "the 118 existing tests are the regression suite." The suite
does have 118 passing tests across 8 files, but **only `BulletManager.test.tsx` exercises
the component, and it holds 9 of them.**

Per-file counts at the **118 baseline** (`npx vitest run --reporter=verbose`, before any phase
landed). Phases 1 and 2 have since added to this — see Implementation status — but the shape
of the argument is unchanged, and the 118 figure is what "unmodified" refers to:

| File | Tests @118 | Relevance |
|---|---|---|
| `patterns.test.ts` | 52 | inert |
| `easing.test.ts` | 36 | inert |
| `pool.test.ts` | 11 | inert — but see decision 2, `scale` needs a reset here |
| `BulletManager.test.tsx` | **9** | the actual gate |
| `presets.test.ts` | 4 | inert |
| `ProjectileTelemetry.test.tsx` | 4 | inert (imports `'../ProjectileTelemetry'` only) |
| `types.test.ts` | 1 | inert |
| `index.test.ts` | 1 | **not inert — see below** |

Those 9 assert almost entirely on `activeCount` and mount behaviour. None assert slot
indices, per-bullet color, or matrix contents.

That has one good consequence and one bad one:

- **Good:** nothing pins slot-assignment order, so the pool-structure work in phase 2 is
  genuinely invisible to the existing suite.
- **Bad:** a gate that cannot see slot assignment also cannot see it break.

So phase 1 is now characterization tests, not the pool refactor. Write the tests that pin
today's behaviour *before* changing the thing they describe — but see the trap in phase 1
about what those tests must **not** pin.

### The barrel test blocks "unmodified" at phase 4

`src/__tests__/index.test.ts:40` is an **exact-set** assertion:

```
39  // Ensure no unexpected internal functions or objects leak
40  expect(actualExports.sort()).toEqual(expectedExports.sort());
```

against the hardcoded list at `:6-29`, whose only component entry is `'BulletManager'`
(`:8`). `src/index.ts:6` is the sole value component export today.

- **Phase 3 is unaffected.** `<BulletField>` can stay unexported; its tests import
  `'../BulletField'` directly, exactly as `ProjectileTelemetry.test.tsx:4` already does.
- **Phase 4 must edit it.** A public `<Emitter>` and `<BulletField>` are barrel exports, so
  the expected list has to grow. That is two strings, and a red `toEqual` set-diff names the
  offending keys, so it is self-diagnosing — but it means "all 118 pass unmodified" is true
  only through phase 3.

`fireAt` and `onPoolExhausted` cannot trigger this — a handle method and a prop are not
barrel exports. Type-only exports are invisible to the test by design (`index.ts:20-27` are
absent from the expected list, per the test's own comment at `:24`).

---

## Prerequisite: pool structure (not just a free list)

The roadmap lists "free-list instead of linear slot scan" as an independent nicety. **It is
not independent — it is a hard prerequisite.** But a free list alone is also not enough,
and shipping only a free list would land a measurable regression.

`spawnBullets` scans from index 0 for every bullet in a burst
(`src/BulletManager.tsx:196-204`):

```
for each bullet in burst:
    for i in 0..maxBullets:          // restarts at 0 every time
        if !bullets[i].active: take it
```

That is O(burst × maxBullets). A 100-bullet burst into a near-full 2000-slot pool is
~200,000 iterations, per emitter, per shot.

The split takes `maxBullets` from 4×64 to one×2000 — roughly 8×. That multiplies **eight**
costs, not one, and they do not all have the same fix. Separating them matters, because the
sparse set is sold as fixing everything and it does not.

### CPU-side — all five fixed by the sparse set

| Site | Cost today |
|---|---|
| Spawn scan (`src/BulletManager.tsx:197-204`) | O(burst × maxBullets) per shot |
| Frame loop (`:390`) | O(maxBullets) per frame |
| `activeCount` getter (`:287`) | O(maxBullets) per read |
| `forEachActive` (`:305`) | O(maxBullets) per frame — OVERLORD's collision step calls it every frame |
| `clear()` (`:273`) | O(maxBullets) |

**One structure fixes all five: a sparse set.**

- `dense: Int32Array` — active slot indices, packed
- `slotToDense: Int32Array` — reverse map, for O(1) swap-remove
- `free: Int32Array` + `freeTop` — LIFO stack of available slots

Acquire and release become O(1); the other four become O(active). About 40 lines, and it
strictly subsumes the free list.

**A sixth CPU cost the sparse set does not touch:** `releaseSpawnData` runs an
`_pool.includes(item)` linear scan **per item** against a free list of up to 20,000
(`src/pool.ts:69-72`). Long-standing and harmless at one manager firing 1.5×/second — but
this design puts 100 archers through it every frame via `fireAt`, each releasing a whole
burst. That is O(burst × poolSize) per release, in the exact path the library advertises as
allocation-free. A `Set`, or a monotonic release token, or simply trusting the caller not to
double-release, all fix it. Out of scope for phase 2 as scoped, but it should not survive
phase 4.

**Iterate `dense` backwards in `forEachActive`.** Swap-remove moves the last live entry
into the vacated position, so a forward walk skips one live bullet per consumption — a
silent, load-dependent miss in the consumer's collision pass. Backwards iteration is
immune. Specify it; do not leave it to whoever writes the loop.

### GPU-side — three separate fixes, none of them the sparse set

| Site | Cost today | Fix |
|---|---|---|
| `mesh.count` left at construction capacity | every parked instance runs the vertex shader — 2000 × ~60 verts of nothing | high-water mark on `mesh.count`, decayed when the field empties |
| `instanceMatrix.needsUpdate = true` (`:437`) | unconditional full-buffer upload, ~128 KB/frame at 2000 slots | `addUpdateRange` over the touched slots — three merges scattered ranges by design |
| `instanceColor.needsUpdate` — **three sites**, `:264` (`fire()`), `:349` (reduced motion), `:438` (frame loop) | unconditional full-buffer upload, ~24 KB/frame — and colors are only ever written at spawn (`:225`), never in the frame loop | flag dirty only when a spawn actually happened |

Setting `mesh.count` bounds the **draw**, not the upload. The earlier draft's single table
row conflated the two; they are independent and need independent fixes.

Three things learned implementing this, all of which bind on later phases:

- **There is no `mesh.count` assignment site to change.** `:450` is the
  `args={[undefined, undefined, maxBullets]}` JSX line; `count` came only from the
  constructor. The high-water mark means introducing `count` writes from scratch — and that
  exposes a trap: `InstancedMesh.setColorAt` sizes `instanceColor` from `this.count` on
  first call, so `count` must sit at **full capacity during pool init** or the color buffer
  is allocated too small and per-bullet color breaks.
- **The `instanceMatrix` fix is not local, and this is the important one.** The three GPU
  fixes are independent *of each other*, but once *any* site adds an update range, **every**
  site that flags `instanceMatrix` dirty must add one too — otherwise its writes are skipped
  whenever another site left a range pending. All six matrix-dirty sites now route through a
  single `markMatrixDirty` helper. **Phase 3 must carry that invariant into `<BulletField>`:
  never set `instanceMatrix.needsUpdate` directly.**
- **`addUpdateRange` needs feature detection, not a fallback.** It is r159+; the package's
  peer range is `three >= 0.150`. The earlier draft said pre-r159 "exposes the same thing as
  singular `updateRange`" — but in the installed three (0.184.0) the singular `updateRange`
  is *gone*, so there is no shared API to write against. Detect the method; when absent,
  skip the optimisation and upload the whole buffer exactly as before.

The perf-sanity criterion in Testing is stated purely in CPU terms and remains accurate as
written — nothing in the gate passes falsely because of the GPU rows.

### Release happens at five sites, and all five must be wired

This is the real risk in the pool phase, and missing one leaks slots silently:

1. frame loop, lifetime expiry (`src/BulletManager.tsx:417`)
2. frame loop, out of bounds (same branch)
3. `forEachActive` consumption (`:309`)
4. `clear()` (`:274`)
5. **the `maxBullets` reallocation effect (`:147-180`)** — a mass release by array swap at
   `:164`, touching none of the other four

Site 5 self-heals today because `active` lives inside the array being discarded. A sparse
set moves that state into sibling refs that the swap does not touch, so the effect must
reset `dense`, `slotToDense`, `freeTop`, and the high-water mark explicitly. The existing
test `handles dynamic maxBullets re-allocation gracefully`
(`BulletManager.test.tsx:134-161`) exercises exactly this path and asserts `activeCount === 0`
at `:160`, so a miss here does go red — the one place the existing gate happens to help.

---

## Decisions

Every question the earlier draft left open, settled. Reasons recorded so they are not
silently relitigated.

### 1. Pool exhaustion → drop-newest, with an **optional** `onPoolExhausted`

Recycle-oldest is disqualified by `forEachActive`, not by cost. That callback hands the
consumer a slot index, a *live* internal position vector, and a payload; OVERLORD runs its
collision step through it every frame. Recycling a slot mid-frame rewrites `payload` and
`emitterId` underneath a consumer holding that index — phantom hits, wrong damage,
attributed to the wrong emitter.

That hazard is not hypothetical, and it is worth recording why: consumer code runs
**synchronously inside the callback** (`src/BulletManager.tsx:308`), `fire()` and
`forEachActive` sit on the same handle (`src/types.ts:198-216`), and neither has a
reentrancy guard. A consumer that fires a retaliation shot from inside a hit test is doing
something entirely reasonable and would trip it. This design makes it *more* reachable, not
less, because `fireAt` exists precisely so consumers spawn from their own loops.

Drop-newest also preserves a property worth naming explicitly: **an emitter can never
destroy another emitter's bullets.** That is what lets 100 archers share one pool without
reasoning about each other, and it keeps `fireAt` a pure try with no cross-emitter side
effects. Decision 7 exists to keep that property true; caller-supplied ids broke it.

The starvation cost is real: a high-cadence emitter registered first can crowd out one
registered later. The answer to that is a per-emitter reserve if it ever bites, not
recycling.

`onPoolExhausted(emitterId, requested, spawned, reason)` fires **once per burst, not per
bullet** — a 100-bullet burst into a full pool must not produce 100 callbacks in one frame.
It is raised after the spawn loop returns, where `spawnData.length` and the spawned counter
are both in hand.

The heading of this decision said "required" through phase 4. **It ships optional**, and
that is the right call rather than a slip: exhaustion is not an error, it is the specified
behaviour of a finite pool, and a required callback would make every `<BulletField>` declare
a handler for a condition most fields never reach. "Silent unless you ask, and this is how
you ask" is the contract — which is also why the prop is the *only* way to observe it.

`reason` is a `PoolExhaustionReason` — `'pool-full'` or `'reduced-motion-budget'` — added
after phase 5. Decision 5 makes budget truncation report through this same callback so that
exhaustion has one semantics rather than two, and that is still right; but one semantics is
not one **remedy**. `'pool-full'` says raise `maxBullets` or slow an emitter down;
`'reduced-motion-budget'` says nothing can be done, because that cap is deliberately not
configurable (decision 5) and the pool may be nearly empty at the time. Without the
discriminator a consumer's only actionable response is a guess, and the obvious guess is
wrong half the time. The reduced-motion snapshot is the only path where either constraint can
bind, and it reports whichever actually did — distinguishable without asking the pool,
because the spawn loop checks its budget `cap` before touching the free stack, so returning
the whole budget can only mean the budget was what stopped it.

### 2. Per-emitter bullet size → yes, as per-*bullet* scale on `BulletSpawnData`

The question framed this as an emitter prop. That is the wrong seam. The library already
has the right slot: alongside `color` and `payload` on `BulletSpawnData`, set by a
`mod.scale(n)` modifier, composing exactly like every other per-bullet property.
`bulletRadius` stays the geometry base with a `1` default multiplier, so nothing changes
for existing consumers.

**It is two write sites, not one.** The earlier draft said "one multiply into the existing
fade line" and that is wrong in a way that would ship a silent bug:

1. **Fade path** — `src/BulletManager.tsx:431`, `_dummy.scale.set(fade, fade, fade)` →
   `set(s, s, s)` where `s = fade * b.scale`.
2. **No-delay spawn path** — `src/BulletManager.tsx:230`, a hardcoded
   `_dummy.scale.set(1, 1, 1)` that writes the instance matrix directly at spawn.

Site 2 is the one that matters, because two paths never reach the fade line at all:
`reducedMotion` spawns at `:344` and returns at `:351`, above the simulate loop; `paused`
returns at `:333`, so a `fire()` while paused writes only `:230` for as long as `paused`
stays true. Both call `resolvePattern`, so a `mod.scale(n)` would be populated and then
silently discarded — **`mod.scale` would be a permanent no-op in the accessibility
snapshot.** Nothing in the suite can see it.

Every other scale write is genuinely inert: `:171` parks pool init off-screen, and `:235`,
`:276`, `:312`, `:419` all write `scale(0,0,0)` to hide a delayed, cleared, or despawned
slot.

One rider in `pool.ts`, easy to miss: `acquire()` resets every field on **both** branches
(`pool.ts:34-41` and `:44-52`) and spawn-data objects are module-scope pooled (`pool.ts:9`),
so a missed reset leaks a scale across bursts and across fields.

**Make `scale` required, and do not write `data.scale ?? 1` at the spawn site.** An earlier
draft called for that `??`, mirroring `data.color ?? 0xff3333` at `:224`. It is wrong here,
and the difference is instructive: `color` is legitimately `number | null`, so its `??` is a
real default. `scale` is required and set by `acquire()` on both branches, so it can never
be `undefined` for pool-sourced data. The only way to reach the multiply with `undefined` is
a hand-rolled `PatternFactory` building bare object literals instead of calling `acquire()` —
and TypeScript rejects that at compile time, which is the protection you actually want. A
`??` would convert that compile error into a silently tolerated runtime path.

Ships with `emitterId` — same edit to the same struct.

### 3. Per-emitter material → no. Mount a second field.

Confirms the proposed answer, and the `material` prop makes it structural rather than a
docs footnote: one field takes one material, visibly, in the type.

The corollary is the part worth documenting, because it is the non-obvious guidance: two
materials means two fields, which means two pools — the exact cost this whole design exists
to avoid. So **partition emitters by material, not by faction or entity type.** Stated that
way it reads as a design rule; stated as "no per-emitter materials" it reads as an
oversight.

### 4. `<Emitter>` imperative handle → yes, `fire()` only

`fireAt(origin, pattern)` makes the caller re-specify what the `<Emitter>` already
declares. The canonical case is a player weapon that auto-fires on a cadence *and* fires on
click — the library's single most common consumer shape — and without `fire()` that
consumer holds the origin ref and pattern in two places and keeps them in sync by hand.

**It is not "the same call the frame loop makes."** The earlier draft said that and named
the `timeAccum` reset as the only fidelity gap. There are five, and `fire()` must be
specified as its own operation to preserve all of them:

| Behaviour | Today's `fire()` | Today's frame loop |
|---|---|---|
| Origin fallback when no `origin` ref | static `(0, spawnCenterY, 0)` (`:256-258`) | Y-axis orbit (`:371-377`) |
| `sourceRotation` | untouched | advanced (`:371`) |
| `timeAccum` | untouched | consumed (`:361-362`) |
| Runs while `paused` | yes — outside the guard | no — returns at `:333` |
| `needsUpdate` flush | inline, immediately (`:263-264`) | batched at end of frame (`:437-438`) |

So `Emitter.fire()` is defined as: resolve this entry's origin the **manual** way (its
`origin` ref, else its static `(0, spawnCenterY, 0)`), spawn one burst, advance neither
`sourceRotation` nor `timeAccum`, work while the field is paused, and flush `needsUpdate`
inline — because when the field is paused the frame loop will not flush for you.

Only `clear()` resets the cadence timer (`:280`), and `clear(emitterId)` must reset that
emitter's timer to keep the one-emitter wrapper faithful.

**Field-wide `clear()` is not just "clear every emitter."** The earlier draft only discussed
`clear(emitterId)` and left the no-arg form implicit. It has to reset *every* registered
emitter's `timeAccum` **and** reduced-motion guard **and** the shared reduced-motion budget
from decision 5 — miss any one and the one-emitter wrapper stops being faithful, because
today's `clear()` resets all three at once (`:280-281`).

### 5. `reducedMotion` under N emitters → one frozen burst each, field-wide cap

Every registered emitter is serviced exactly once, from its own origin, at zero velocity —
then the field freezes. A reduced-motion snapshot of a three-turret scene should show three
turrets' worth of bullets, not one; anything else silently drops emitters from the picture.

**This is the one deliberate behavioural divergence in the wrapper.** Today's reduced-motion
branch is unconditionally `_sourcePos.set(0, props.spawnCenterY, 0)`
(`src/BulletManager.tsx:342`) — it never reads `props.origin`, unlike `fire()` (`:256-258`)
and auto-fire (`:367-378`). So a `<BulletManager origin={ref} reducedMotion>` today snapshots
at the world origin rather than at the emitter, and under this design it would snapshot at
the emitter.

Taking the divergence, for three reasons: the current behaviour is arguably a bug (a moving
emitter's accessibility snapshot appearing somewhere the emitter is not); it is the only
generalization that makes sense at N>1; and it makes the three origin-resolution paths
consistent for the first time. The affected surface is `origin` **and** `reducedMotion`
together, which no existing test uses — `BulletManager.test.tsx:49-84` passes no `origin` —
so nothing goes red. It still gets a changelog line, because "nothing goes red" is not the
same as "nothing changed."

Three details follow:

- **The 200-bullet cap stays field-wide, not per-emitter — and it must be stateful across
  frames.** Its purpose is keeping the static snapshot modest
  (`src/BulletManager.tsx:19-20`), which is a whole-scene concern. Emitters are serviced in
  registration order and later ones truncate — the same drop-newest, order-determined
  behaviour as decision 1, so exhaustion has exactly one semantics in this library rather
  than two.

  The stateful part is easy to miss and follows from this decision's own next bullet: if an
  emitter mounting *after* reduced motion engaged still gets its snapshot, then emitters are
  serviced on **different frames**, so the cap can no longer be the per-call `cap` argument
  it is today. It has to be a field-level budget drawn down in registration order, reset
  when reduced motion toggles off and by `clear()`. That is a fourth piece of reduced-motion
  state, alongside the per-entry guard, the per-entry origin, and the toggle-off reset.
- **The "already spawned" guard moves per-emitter.** Today it is one field-wide ref
  (`src/BulletManager.tsx:102`, `:340`) because there is one emitter. Per-emitter, an
  `<Emitter>` that mounts *after* reduced motion engaged still gets its snapshot instead of
  being invisible forever. The reset-on-toggle-off at `:355` moves with it.
- **`clear()` resets the guard** (`:281`), so `clear(emitterId)` resets only that emitter's
  and re-arms its snapshot.

Per-bullet `scale` must be honoured here, which is what makes decision 2's site 2 load-bearing.

### 6. Per-emitter reserve → no. Document the behaviour instead.

Decision 1 plus specified service order means a first-registered high-cadence emitter can
crowd out later ones when the pool is full. That is a real property, and the answer is to
write it down, not to build a budgeting system for it.

A reserve would mean per-emitter quotas, a policy for unclaimed reserve, and a new failure
mode where a field with free slots refuses to spawn into them. That is a lot of mechanism
for a problem whose honest fix is usually "raise `maxBullets`" or "give the greedy emitter
a slower `fireRate`."

So the README states plainly: **the pool is first-come, first-served in registration order;
a full field drops the newest burst.** Consumers who need a guarantee get it from
`onPoolExhausted` (decision 1) and their own cadence, and `activeCountFor(emitterId)` is
there to make the situation observable. Revisit only if it bites in practice.

### 7. `emitterId` → field-issued and never recycled. **Reverses the earlier decision.**

The earlier draft made `emitterId` caller-supplied, on the reasoning that a swarm's archers
already have pool-row indices and round-tripping them through the field is friction. That is
wrong, and it breaks decision 1's headline invariant.

**The break:** pool rows are *recycled*. Archer A dies holding row 7 with bullets still in
flight; archer B spawns into row 7 and calls `clear(7)` on its own death — destroying
archer A's bullets. So "an emitter can never destroy another emitter's bullets" becomes
false in exactly the use case the draft named as motivation. Two `<Emitter id={1}>` in the
same JSX do the same thing more obviously.

**The second break:** "the field auto-assigns from a range that cannot collide with consumer
ids" is unsatisfiable. `emitterId` is a plain `number`; every value is a legal consumer id.
There is no reservable range, and the obvious `fireAt` default of `0` is the first pool-row
index.

**The fix** is an acquire/release handle over a monotonic counter that never recycles:

- `acquireEmitter(): number` returns the next id, starting at `1`.
- `releaseEmitter(id)` retires it. It does **not** clear bullets — a dying archer that wants
  its bullets gone calls `clear(id)` first, and one that wants them to finish their flight
  does not. Separating the two is the whole point of provenance.
- `<Emitter>`'s registration **is** the acquire, and unmount is the release. No `id` prop.
- `fireAt`'s `emitterId` stays optional, defaulting to the reserved id `0` — "anonymous."
  `clear(0)` clears anonymous bullets only. That closes the range question by construction.

The friction this reintroduces is one integer stored next to a pool row, on consumers that
are already doing acquire/release bookkeeping for the row itself. That is a fair price for
an invariant the design elsewhere depends on. Consumers who want an id that *means*
something already have `payload` — the same boundary, held.

---

## Phasing

1. **Characterization tests.** Pin today's behaviour where the existing 9 tests don't:
   per-bullet color at spawn, that a despawned slot becomes reusable, `forEachActive`
   consumption freeing a slot, `clear()` resetting the cadence timer, `fire()` *not*
   resetting it, delayed bullets skipped by `forEachActive`. No production change.

   > **Trap — do not pin slot identity.** Today's scan is lowest-free-first
   > (`src/BulletManager.tsx:198-204`); a LIFO free stack is last-released-first; and slot
   > index is externally visible as `forEachActive`'s first argument. A "slot reuse" test
   > written the obvious way pins ascending order, and **phase 2 then breaks the test phase 1
   > exists to write.** Assert that capacity is recovered and the bullet count is right —
   > never *which* index came back. Slot assignment order is explicitly not part of the
   > contract; say so in the test's own comment.

2. **Pool structure.** Sparse set + free stack (CPU), plus the three independent GPU fixes.
   All five release sites wired, including the `maxBullets` realloc. Backwards iteration in
   `forEachActive`. Self-contained, no API change.
3. **Extract the field**, in three gated steps. The original single phase 3 was wrong: it
   listed `material` and `<Emitter>` as separable, and they are not (see Wiring).

   - **3a — structure only.** Move mesh/pool/frame-loop and the emitter registry into
     `<BulletField>`; rebuild `BulletManager` as a one-entry wrapper registering through the
     field's imperative handle. No new features, no behaviour change. `<BulletField>` stays
     unexported.
   - **3b — `material` + `<Emitter>` + context, together.** Add the `material` prop, which
     frees `children`; add `<Emitter>`; wrap the field's JSX in the registry provider; reshape
     the wrapper to `<BulletField material={children}><Emitter … /></BulletField>`. Still no
     behaviour change — the gate stays green on the same tests.
   - **3c — new per-bullet state.** `emitterId`; per-bullet `scale` at **both** write sites;
     decision 5's reduced-motion divergence and its stateful budget; field-wide `clear()`
     semantics. This is the first step that intentionally changes behaviour.

4. **Imperative surface + barrel.** `fireAt`, `acquireEmitter`/`releaseEmitter`,
   `activeCountFor`, `onPoolExhausted`. **Includes updating the public barrel
   (`src/index.ts`) and the expected-exports list at `src/__tests__/index.test.ts:6-29`** —
   `:40` is an exact-set match, so this is the one phase where an existing test must change.
   Also decide where prop defaults live once `<BulletField>` is public, and retire
   `releaseSpawnData`'s `includes()` scan.
5. **Docs.** README section, the partition-by-material rule, the first-come-first-served pool
   statement from decision 6, the acquire/release contract from decision 7, the reduced-motion
   changelog line from decision 5, and the roadmap table in the consuming project's scoping doc.

Each phase is releasable on its own.

### Implementation status

| Phase | State | Suite |
|---|---|---|
| 1 — characterization tests | **done** — `src/__tests__/BulletManager.characterization.test.tsx`, 7 tests, all six behaviours pinned, none unpinnable | 132 pass |
| 2 — decision 2 data layer (pulled forward from 3) | **done** — `scale` on `BulletSpawnData`, reset on both `acquire()` branches, `mod.scale(n)`, 7 tests. Barrel untouched (`mod` is a namespace object) | included above |
| 2 — pool structure | **done** — sparse set + all five release sites + all three GPU fixes, `BulletManager.tsx` only, no API change | 132 pass, `tsc` + lint clean |
| 3a — extract the field | **done** — `src/BulletField.tsx` (new, unexported) owns mesh/pool/frame loop + the emitter registry; `BulletManager.tsx` rebuilt as a 160-line one-entry wrapper. No new features. | 132 pass, `tsc` + lint clean |
| 3b — `material` + `<Emitter>` + context | **done** — `material` prop on `<BulletField>`, new `src/Emitter.tsx`, field JSX wrapped in the registry provider, wrapper reshaped to `<BulletField material={children}><Emitter …/></BulletField>`. No behaviour change. Both still unexported. | 132 pass, `tsc` + lint clean |
| 3c — `emitterId` + `scale` write sites + decision 5 divergence | **done** — `emitterId` + `scale` on `BulletState`, both `scale` write sites wired, `forEachActive` gains a 4th argument, reduced-motion snapshot resolves each emitter's own `origin`. New `src/__tests__/BulletField.test.tsx`, 14 tests. Barrel untouched. **First phase that changes behaviour** — see the divergence list below. | 146 pass, `tsc` + lint clean |
| 4 — imperative surface + barrel | **done** — `fireAt`, `acquireEmitter`/`releaseEmitter`, `activeCountFor`, `clear(emitterId)`, `onPoolExhausted`; `<BulletField>` + `<Emitter>` and their types barrelled; defaults moved down out of the wrapper; `releaseSpawnData`'s `includes()` scan replaced with a `WeakSet`. New `src/__tests__/BulletField.imperative.test.tsx`, 41 tests. **`index.test.ts:6-29` is the only existing test content changed** — two strings. | 187 pass, `tsc` + lint clean |
| 5 — docs | **done** — README section `<BulletField>` + `<Emitter>` (both prop tables, the two consumption paths, decision 7's id contract, decision 6's first-come-first-served statement, decision 3's partition-by-material rule, `BulletFieldHandle`), `mod.scale` added to the modifier table, `forEachActive`'s 4th argument documented, reduced-motion origin resolution noted in Accessibility and Architecture, and a new `CHANGELOG.md` starting at 0.4.0 with the three consumer-visible changes from 3c. Every README example type-checked against `src/` with `tsc --noEmit` (harness verified to reject a wrong `fireAt` argument order, then deleted). No `src/` change. | 188 pass, docs only |
| 6 — API defects: handle narrowing + exhaustion `reason` | **done** — `BulletFieldHandle` narrowed to the seven consumer members (the shape this document's own Design sketch proposed at `:69-83`); the plumbing moved to an unexported `EmitterRegistryHandle extends BulletFieldHandle, EmitterRegistry` that the registry context now carries. Type-level split only: one `useMemo` handle, one object, unchanged identity. `onPoolExhausted` gains a 4th argument, `PoolExhaustionReason` (`'pool-full'` \| `'reduced-motion-budget'`), barrelled type-only. New `src/__tests__/BulletFieldHandle.types.ts` — a type-level test whose runner is `tsc --noEmit`, since `tsconfig.json` excludes `.test.ts` from the program — plus 4 runtime tests. **The `onPoolExhausted` call-shape assertions in `BulletField.imperative.test.tsx` and `BulletField.sharing.test.tsx` are the only existing test content changed** — 9 assertions, each gaining its concrete reason. | 203 pass (199 before), `tsc` + lint clean |

> The suite reads **188** at phase 5, not the 187 phase 4 recorded. The extra test is
> `src/__tests__/zprobe.test.tsx` — a leftover scene-shape probe that logs a tree and asserts
> `expect(true).toBe(true)`. It is debugging scaffolding, not a gate; delete it.

Phase 3a was verified beyond its gate: a throwaway differential harness ran the phase-2
component and the new one side by side across 12 scenarios (orbit and `origin`-ref auto-fire,
`fire`/`clear`/cadence interplay, `fire()` while paused, reduced motion with an `origin` set,
the 200-cap against a 300-bullet pattern, `forEachActive` consumption and respawn,
delay+fade+expiry, `maxBullets` realloc, degenerate `fireRate`/`boundsLimit`, pool exhaustion,
`onBulletCount` sequences), comparing `activeCount`, `mesh.count`, every visited slot to 6 dp,
the full `instanceMatrix` and `instanceColor` arrays, and `updateRanges`. **Byte-identical on
all 12.** The 16-test gate is thin; this is what actually established the refactor was clean.

Phase 3b was verified the same way: the 3a component was copied verbatim alongside the new
one and the same 12-scenario differential harness re-run against it, plus a hand-written
lifecycle pair (unmount/remount an `<Emitter>` mid-run) and a scene-graph shape check.
**Byte-identical on all 12**, and the harness was re-confirmed to have teeth against the
final tree — a 0.1 % drift in the fade scale reddens 9 of the 12 (the other 3 are paused or
frozen and never reach the fade line). Harness deleted afterwards.

**What 3c actually changed for an existing consumer — the changelog source:**

1. **Reduced motion now reads `origin`** (decision 5). `<BulletManager origin={ref} reducedMotion>`
   snapshots at `origin.current` instead of at `(0, spawnCenterY, 0)`. The no-`origin` fallback is
   byte-identical. The design's claim that no existing test pairs `origin` with `reducedMotion`
   was verified and is **stronger than stated**: no test in the suite passes `origin` to
   `<BulletManager>` at all.
2. **`mod.scale(n)` stopped being inert.** Previously the `scale` field was carried and discarded.
   Both write sites are now live, so any consumer already calling `mod.scale(n)` sees bullets
   change size. `scale` defaults to `1` on both `acquire()` branches, so consumers who never call
   it see no change at any site — verified by an explicit test.
3. **`forEachActive` passes a 4th argument.** Purely additive; three-parameter callbacks are
   unaffected in both TS and JS, which is also asserted.
4. **Nothing else moved.** `activeCount`, slot assignment, `mesh.count`, colors, cadence, `fire()`'s
   five fidelity differences, and the pool-exhaustion behaviour are untouched.

**Corrections and constraints discovered in 6:**

- **A type-level test cannot live in a `.test.ts` file here.** `tsconfig.json` excludes
  `.test.ts` / `.test.tsx` from the program and vitest transpiles with esbuild without
  type-checking, so a `@ts-expect-error` written in the test suite is checked by *nothing* —
  verified by putting a deliberate type error in `types.test.ts` and watching
  `tsc --noEmit` exit 0. The handle-narrowing assertions therefore live in
  `src/__tests__/BulletFieldHandle.types.ts`, which `include: ["src"]` makes a root file of
  the default program. It is imported by nothing, deliberately: `tsc --noEmit` is its runner.
- **The narrowing must not be a runtime split, and no runtime test can see it.** The context
  value and the ref value are the same `useMemo` object by construction (3b), so `register` /
  `unregister` / `fire` are still present on the object a `ref` receives. Confirmed by
  mutation: re-widening the public type leaves all 203 runtime tests green and reddens only
  `tsc`.
- **A reduced-motion emitter that finds the budget already at zero reports nothing at all.**
  The snapshot loop `continue`s above the spawn when `budget <= 0`, so it never learns what
  that emitter would have requested — `resolvePattern` has not been called, and calling it
  just to report would allocate a burst in order to throw it away. Left as-is; it is
  pre-existing and out of scope for the reason work, but it means "every truncated burst is
  reported" is true only for emitters that got *some* budget. A fifth emitter behind four
  full ones is dropped silently.
- **`<Emitter>.fire()` had no exhaustion assertion of any kind** before this pass — mutating
  its reason constant killed nothing. Closed with one test; the other four spawn paths were
  already covered.

**Corrections to the design discovered in 4:**

- **Decisions 1 and 7 leave a hole in `fireAt`'s open `emitterId`.** Decision 7 kills
  caller-supplied ids for `<Emitter>` but leaves `fireAt(origin, pattern, emitterId?)` accepting
  any number, and decision 7's own "there is no reservable range" argument applies to it
  unchanged: a consumer that passes `500` and a field whose counter later reaches `500` produce
  exactly the collision the decision exists to prevent. Resolved by making the counter an upper
  bound on every id the field has *seen*, not just every id it has issued — `fireAt` and
  `releaseEmitter` both advance it past any larger id handed to them. Cheap, invisible to
  in-contract callers (`0` is below the floor of `1`), and it keeps decision 1's invariant true
  even for a consumer that freelances.
- **`releaseEmitter` has no reclamation work, and that is not a bug.** Its whole content is the
  upper-bound line above; a never-recycling counter has nothing to free. Its real contract is
  negative — it must not clear, must not re-attribute, must not touch other emitters — and that
  is what the tests assert and what mutation testing kills.
- **Decision 4 specifies `clear()` and `clear(emitterId)` but not what per-emitter clear does to
  decision 5's field-wide reduced-motion budget.** Re-arming it outright would hand every *other*
  emitter a second snapshot's worth of allowance; leaving it alone means a re-armed emitter can
  find the budget spent and silently snapshot nothing. Resolved as a **refund of exactly what the
  clear released**, clamped to the cap. Invisible outside `reducedMotion`, since the frame loop
  re-arms the budget every normal frame anyway.
- **`onPoolExhausted` fires from the reduced-motion path too.** Decision 1 describes it as a pool
  callback, but decision 5 explicitly makes budget truncation "the same drop-newest,
  order-determined behaviour … so exhaustion has exactly one semantics in this library rather than
  two." Reporting a budget-truncated snapshot through the same callback is that sentence taken at
  its word; reporting it through nothing would be a second semantics by omission.
- **Defaults moved down, not copied.** Phase 3a's debt note asked phase 4 to *decide*; the decision
  is that `<BulletField>` and `<Emitter>` own their defaults and `<BulletManager>` restates none of
  them, forwarding `undefined` through so the single definition applies. The wrapper's fourteen
  `@default` tags are unchanged and are now pinned by a test that reads the same defaults through
  both doors and requires them to agree — the drift the debt note was about.

**Corrections to the design discovered in 3c:**

- **Two thirds of "change 3 and 4" were already done in 3b.** The stateful field-level
  reduced-motion budget (`reducedMotionBudgetRef`, drawn down in registration order, re-armed on
  toggle-off) and the three-part field-wide `clear()` both landed in 3b. That was legitimately "no
  behaviour change" — at N=1 a stateful budget and a per-call `cap` of 200 are indistinguishable,
  and so are the three `clear()` resets. 3c's real delta in decision 5 is the origin resolution
  alone. Both were re-verified by mutation rather than assumed.
- **Decision 7's `acquireEmitter(): number` does not fit the registration path.** Registration *is*
  the acquire, but `register(entry)` stamps `entry.id` rather than returning a number — the id has
  to live where the frame loop can read it. Phase 4's standalone `acquireEmitter()` is therefore a
  second entry point onto the same counter, not the same method. The counter and the `emitterId`
  parameter on `spawnBullets` are already in place for it.
- **Decision 7 does not say what an emitter's `fire()` does before registration.** There is a real
  window: registration happens in a mount `useEffect`, so a `fire()` between commit and the passive
  flush finds `entry.id === 0`. Resolved as **anonymous** — id `0`, per decision 7's own reserved
  value — rather than by pre-assigning an id at render, which would leak ids on a discarded render.
  `unregister` symmetrically returns the entry to `0`.
- **`scale` is honoured only where the bullet is shown.** The delayed-spawn branch keeps its
  `scale(0,0,0)`, as do all four hide sites. A delayed bullet picks its `scale` up when the delay
  expires and it reaches the fade line — so under `paused` or `reducedMotion` a *delayed* bullet
  stays invisible forever, exactly as before.

**Constraints and corrections discovered in 3b — all binding on 3c and 4:**

- **The `instancedMesh` must have no later JSX sibling, or `maxBullets` realloc silently
  breaks.** This is the one thing 3b hit that the design did not predict, and it is not
  obvious. R3F v9's `commitUpdate` queues an `args` reconstruction into a module-level
  `reconstructed` array and flushes it **only** from the tail of an updated sibling run
  (`const isTailSibling = fiber.sibling === null || (fiber.flags & Update) === NoFlags;
  if (isTailSibling) swapInstances()` — the sole call site of `swapInstances`). Rendering
  `{children}` after the mesh gives it a sibling fiber, so the queued replacement mesh is
  never swapped in and the field keeps its old capacity forever. `BulletManager.test.tsx:157`
  catches it. The fix is one bare fragment around the mesh, which puts it alone at its own
  fiber level while keeping it first in the scene. **Do not remove that fragment, and do not
  add a scene sibling after the mesh.**
- **The context value has to be the field's handle object, not a fresh literal.** It is built
  by `useMemo` and passed to both `useImperativeHandle` and the provider, so it is created
  once. A provider value rebuilt per render would re-run `<Emitter>`'s registration effect on
  every render — which is exactly the "moves to the tail of the service order" hazard the
  design warns about, arriving through the back door.
- **The registry context carries `fire(entry)` as well as `register`/`unregister`.** The
  Wiring section says the context object is `register` / `unregister` and that the swap from
  the imperative handle is mechanical. It is mechanical, but two-thirds of a swap: with the
  entry now owned by `<Emitter>`, `<BulletManager>.fire()` can no longer reach it, so
  `<Emitter>` needs decision 4's `fire()` handle to exist already. That is why the context
  value is the whole `BulletFieldHandle`. Decision 4's remaining content (the five fidelity
  differences) was already implemented in 3a and is unchanged.
- **No second hook may live in `BulletField.tsx`.** The registry context is exported raw and
  `<Emitter>` does its own `useContext` + null check, because adding a `useEmitterRegistry`
  hook to `BulletField.tsx` switches on `eslint-plugin-react-hooks` v7's compiler pass for
  that module, which then errors on the two mutations the frame loop is built on: the
  `propsRef` write during render (`react-hooks/refs`) and the reused `_spawnRange` out-param
  (`react-hooks/immutability`). Bisected: `useMemo`-handle, fragment, and provider are each
  clean on their own; the hook alone flips it. Phase 4 should expect the same trap if it adds
  helpers there.

**Debt and constraints from 3a:**

- **Defaults live in `<BulletManager>`, and `BulletFieldProps` is required-except-`children`.**
  Splitting fourteen props naively would duplicate every default across wrapper and field and
  let them drift. Single source of truth for now — but **phase 4 must decide where defaults
  live when `<BulletField>` goes public**, rather than copy-pasting them.

  > **Reversed in phase 4, and this bullet is history, not the shipped shape.** Defaults moved
  > *down* into `<BulletField>` and `<Emitter>`, and **`BulletFieldProps` ships fully
  > optional** — every field prop including `children`. The wrapper restates none of them and
  > forwards `undefined` through, which is exactly what selects a destructuring default, so
  > there is still one definition per default and nothing to drift. See the phase-4 status row
  > and "Defaults moved down, not copied" above.
- **`fadeCurve` resolution must stay in the field's render**, not `useFrame` — the
  unknown-easing-name test requires the throw during render, with a stack pointing at the JSX.
- **New ordering dependency:** the emitter registers in a mount `useEffect`, so a frame driven
  between commit and passive-effect flush sees an empty registry and skips auto-fire. The
  pool-init effect already had this dependency and both R3F and the test renderer flush
  effects first, so nothing changes in practice — but the cadence specifically can now be a
  frame late in a way it could not before.

Phase 2 measured: a 1000-bullet burst into a 19,000/20,000-full pool takes **0.38 ms** — the
O(burst) claim verified, not asserted.

**Debt phase 2 leaves for phase 3, all deliberate:**

- **`BulletState.active` is now write-only.** Maintained at all four in-loop release sites so
  it can never go stale, but nothing reads it — `dense` membership is the authority. Delete
  it in phase 3; do not reintroduce it as a loop condition.
- **One small per-frame allocation.** `addUpdateRange` does `updateRanges.push({start, count})`,
  so the frame loop now allocates one two-field object per dirty flush, against ~128 KB of
  upload saved. That contradicts the component docblock's literal "zero per-frame
  allocations" claim (`src/BulletManager.tsx:49-50`). Either mutate a reused range object in
  place or amend the docblock — do not leave the claim standing as-is.
- **The update range is a contiguous `[min, max]` merge**, not per-slot ranges — per-slot
  would allocate per bullet per frame. So a live set spread across the whole buffer
  degenerates to a full upload. Never worse than before, but the win only lands when the live
  set is clustered, which the LIFO free stack tends to produce.
- **`clear()` no longer rewrites free slots' matrices**, only live ones. A never-used slot
  keeps its pool-init scale of `(1,1,1)` rather than being forced to `(0,0,0)`. Nothing
  renders differently — both are off-screen and `count` is 0 — but `instanceMatrix` is no
  longer byte-identical after `clear()`.
- **`mesh.count` is externally visible and now reads 0 on an empty field** instead of
  capacity. Not in the public API, but a consumer inspecting the mesh or raycasting sees it.
- **The high-water mark decays only on full empty**, per spec. A field that peaks at 2000 and
  settles at 5 keeps `count` at 2000 until it empties completely.

Baseline was 118. The `scale` data layer added 7 and phase 1 added 7, so "all existing tests
pass unmodified" now means **132**, of which the original 118 are untouched.

**Two constraints discovered while writing phase 1, binding on phase 3:**

1. **Exactly one `instancedMesh`, and it must remain the first child of the wrapper's scene
   subtree.** The per-bullet-color characterization test is the one behaviour not observable
   through the imperative handle — it reads `renderer.scene.children[0].instance.instanceColor`.
   That is inside the public surface (the r3f scene graph), but it means restructuring the
   scene tree breaks that test for a reason unrelated to color. The Testing section's
   "Sharing" criterion already requires one `instancedMesh`, so the two are consistent —
   just do not add a wrapping `<group>`.
2. **`advanceFrames(n, delta)` invokes `useFrame` with exactly `delta`**, no clock — which is
   what makes the cadence arithmetic exact. But the component clamps to
   `Math.min(delta, 0.1)` (`src/BulletManager.tsx:335`), so any test built on a delta above
   0.1 silently computes the wrong schedule. Keep test deltas ≤ 0.1.

---

## Testing

- **Characterization (phase 1):** the six behaviours listed above, written against today's
  `BulletManager` and carried unmodified through the wrapper. None of them may assert a slot
  index.
- **Regression:** all 118 existing tests pass unmodified **through phase 3**. Phase 4 edits
  `index.test.ts:6-29` and nothing else. Note what the gate does and does not cover — see
  "The regression gate is 9 tests, not 118."
- **Sharing:** two emitters at different cadences draw from one pool and one mesh;
  `activeCount` is the sum; one `instancedMesh` in the scene graph.
- **Lifecycle:** mounting/unmounting an `<Emitter>` mid-run registers and unregisters
  without disturbing in-flight bullets from other emitters; a remounted emitter lands at the
  registry tail.
- **Provenance:** `forEachActive` reports the correct `emitterId`; `clear(id)` removes only
  that emitter's bullets and resets only that emitter's cadence.
- **Id lifecycle (decision 7):** `acquireEmitter` never returns a live id; `releaseEmitter`
  followed by `acquireEmitter` returns a *different* id; bullets from a released emitter
  survive `releaseEmitter` and are still correctly attributed; `clear(newId)` does not touch
  the retired emitter's bullets.
- **Imperative path:** `fireAt` spawns without any `<Emitter>` mounted, and defaults to
  emitter id `0`.
- **Exhaustion:** a full pool drops the newest burst, leaves every existing bullet's
  `emitterId`/`payload` untouched, and fires `onPoolExhausted` exactly once per burst.
- **Exhaustion reason:** a snapshot truncated by a pool too small for the budget reports
  `'pool-full'`; one truncated by the budget with the pool half empty reports
  `'reduced-motion-budget'`; both still fire exactly once. The reduced-motion path is the only
  one where the reason can be wrong, so both directions are asserted there.
- **Public handle surface:** `register` / `unregister` / `fire` are *not* on
  `BulletFieldHandle` and the seven consumer members are. Type-level — the runtime object
  still carries all ten — so `tsc --noEmit` is the gate, not vitest.
- **Reentrancy:** firing from inside a `forEachActive` callback does not corrupt the walk or
  misattribute a bullet. This is the hazard decision 1 is built on; assert it rather than
  assuming it.
- **Swap-remove:** consuming bullets from inside `forEachActive` visits every live bullet
  exactly once — the forward-walk skip is the specific failure being guarded.
- **Service order:** registration order, asserted — it is specified now, so it is testable.
- **Reduced motion:** three emitters produce three frozen bursts from three origins; the
  field-wide 200 cap truncates the last emitter rather than thinning all three; an
  `<Emitter>` mounted after reduced motion engaged still gets its snapshot; and per-bullet
  `scale` is honoured in the snapshot (decision 2's site 2 — this is the only test that can
  see it).
- **Realloc:** changing `maxBullets` resets the sparse set, not just the bullet array
  (release site 5).
- **Perf sanity:** a burst into a near-full pool is O(burst), not O(burst × maxBullets);
  a frame with 10 active bullets in a 2000-slot pool does not touch 2000 slots. CPU-side
  only — the GPU rows are not asserted here and are not claimed to be.

---

## Open questions

None. Every question is settled above; nothing is waiting on a decision before
implementation starts. Decision 7 reverses an earlier call — if it is re-reversed, decision
1's cross-emitter invariant has to be weakened to match.

---

## Non-goals

- Per-bullet materials or geometry. One field, one mesh, one look.
- Homing, collision resolution, factions, damage. The boundary holds: the field carries
  `payload`, `emitterId`, and `scale`, and interprets none of them.
- Replacing `BulletManager`. It stays, permanently, as the one-emitter convenience.
