# Det math for the bullet library (implementation plan)

Covers two repos: **r3f-projectiles** (`@k9kbdev/r3f-projectiles`, `main` at 391864f, 0.7.0 on npm) and
**Kaleb-Vale** (`main` at 5a4d39dd, which depends on `^0.7.0`). Plan written 2026-10-23. Nothing here is built yet;
no code was changed. It comes from a read-only survey of the library's `src/` and every game call site.

| | |
| --- | --- |
| Done when | **A bullet burst gives bit-identical spawn data on every JS engine**, so a Kaleb-Vale run's hash is the same in V8 (Electron, Chrome), SpiderMonkey (Firefox) and JavaScriptCore (Safari, iOS) |
| Size | Library ~9 agent-days (0.8.0), game ~4 agent-days (one planned re-pin). Kaleb: review the accuracy report, publish 0.8.0, approve the re-pin (~½ day) |
| Depends on | Nothing |
| Feeds | Kaleb-Vale's sim README rule 10 (the known caveat goes away), E3.6's `simDetMath` guard, cross-engine replays and co-op (E5 mobile on WebKit, browser builds) |

## Goal

Today the game's own sim is trig-free, but every burst passes through the library's `gen.arc`, which calls
`Math.sin` / `Math.cos`. ECMAScript leaves those "implementation-approximated", so engines may round them
differently, and a recording made in Chrome may not replay bit-for-bit in Safari (Kaleb-Vale `src/sim/README.md`
rule 10; the library README says to "keep `Math.sin`-based patterns to one engine build").

Fix it in the library: a small **det math** module built only from operations ECMAScript defines exactly (`+ - * /`,
`Math.sqrt`, `Math.abs`, `Math.floor`, comparisons). Every pattern generator and modifier runs on it and on its own
plain-number vector arithmetic, with nothing from `three` that could change between three versions. Then the game
moves to 0.8.0 in one planned re-pin.

JavaScript makes this possible: unlike C, the language never fuses a multiply and an add (no FMA contraction) and
every double operation rounds once, so a fixed sequence of basic operations gives the same bits on every conforming
engine.

## Current state

### What the game calls

| Call | Where in Kaleb-Vale | Math inside the library |
| --- | --- | --- |
| `gen.arc(count, spread, speed, heading, radius)` | `src/sim/patterns.ts` `burstPattern` (every enemy, boss, weapon, skill and elite burst through `fireBurstRaw`), `src/sim/actors/archetypes/boss/miniboss.ts` `curvedPattern` | `Math.sin(angle)`, `Math.cos(angle)` per bullet: **the cross-engine hazard** |
| `mod.accelerate(forward, lateral)` | `miniboss.ts` (`fireCurved`: the mini-bosses' curving bullets) | `Vector3.normalize` (`Math.sqrt`), `crossVectors`: exact ops, but their op order is three's, not the library's |
| `compose`, `definePayload` | `patterns.ts` | none |
| `createBulletSimulation`, `step`, `fireAt`, `writeStateHash` | `src/sim/combat.ts`, `src/sim/skills/ricochet.ts` | position / velocity integration with `addScaledVector`, `Math.abs` culling, an FNV hash over exact bits: already deterministic |

Everything else the game turns into angles first and hands to `gen.arc`: `BurstSpec.spread` (radians), `FULL_RING`
(`Math.PI * 2`), Mirrored's half-slot `heading`, class skill spreads. The game then turns the arc onto a unit
direction itself (`finishBurst`, `turnOntoDir`: multiply-adds).

### Transcendental calls in the library's `src/`

| File | Calls | Reached from a deterministic sim? |
| --- | --- | --- |
| `patterns.ts` `gen.arc`, `gen.ring` | `Math.sin`, `Math.cos` | **yes** (the game) |
| `patterns.ts` `gen.fibonacciSphere`, `torusKnot`, `galaxy`, `helix`, `rose3D` | `Math.sin`, `Math.cos` | yes for any consumer who uses them in manual stepping (the README documents seeding `galaxy` / `rose3D` for replays) |
| `patterns.ts` `mod.rotate` | `Quaternion.setFromAxisAngle` (three: `Math.sin` / `Math.cos`), `applyQuaternion` | yes for consumers |
| `easing.ts` `easeInOutQuad`, `easeOutCubic`, `easeInOutCubic` | `Math.pow` | no: `fadeScale` is render-only (it never changes a despawn), but `fadeAt(index)` is a public accessor |
| `BulletField.tsx` built-in orbit (no `origin` given) | `Math.cos`, `Math.sin` | only in the field's own `'auto'` emitter path, frame-driven anyway |
| `render/geometry.ts` | `Math.hypot` | no (geometry building) |
| `rng.ts` (`createSeededRandom`, mulberry32 on `Math.imul`) | none | already bit-identical on every engine |

### Three-version hazard

The library's peer range is `three >= 0.150` and the game uses `^0.186.1`. Generators and modifiers write through
three's `Vector3` / `Quaternion` methods, whose internal op order is three's to change (methods like `applyQuaternion` have been
rewritten for speed in past releases). For bit-exact results the det paths do their own arithmetic and only **store** into the
`Vector3` fields (`v.x = …`), so the result depends on the library version and nothing else. The core simulation's
`addScaledVector` is one multiply-add per component and has been stable; a test pins it against a plain-number
reference (L4).

## Design

### The det math module (`src/detmath.ts`, exported from the root, `/patterns` and `/core`)

- `detSin(x)`, `detCos(x)`, `detSinCos(x, out)` (one range reduction for both; `out` is `{ s, c }`, no allocation).
- **Method:** a port of fdlibm's medium-range path (fdlibm is the reference most libms derive from; V8's own
  `Math.sin` is a port of it, which is why the results will match V8's closely):
  - range reduction by π/2 with a three-part Cody–Waite constant (`pio2_1`, `pio2_1t`, `pio2_2`, `pio2_2t`, `pio2_3`,
    `pio2_3t` as exact double literals): `n = Math.floor(x * invpio2 + 0.5)`, `r = ((x − n·p1) − n·p2) − n·p3` in that
    order;
  - the kernels `__kernel_sin` / `__kernel_cos` (degree 13 / 14 minimax polynomials, Horner order fixed in the
    source), the quadrant picked by `n & 3`.
- **Accuracy (decision 2):** within 1 ulp of the correctly rounded result for |x| ≤ 2^19·π/2 (~823,550 rad; the game's
  angles stay under ~8). Beyond that range the result is still **deterministic** (the same operations) but its accuracy
  drops; dev builds warn once. `NaN` and `±Infinity` give `NaN`; `-0` stays `-0`; `detSin(0) === 0` and
  `detCos(0) === 1` exactly.
- **Constants** are hex-exact double literals with a comment for each, never computed at load from `Math.*`.
  `Math.PI` itself is a fixed double and stays allowed.
- **License:** fdlibm's notice ("Permission to use, copy, modify, and distribute this software is freely granted,
  provided that this notice is preserved") goes in `detmath.ts`' header and `LICENSE` / README third-party section;
  MIT-compatible.
- Not now: `detAtan2`, `detPow`. Nothing in the library or the game needs them (integer powers become
  multiplications). Added later on demand.

### Generators and modifiers on det math (decision 1)

Every `gen.*` and `mod.*` keeps its signature and meaning; only the arithmetic changes:

- `gen.arc`, `gen.ring`: `detSinCos(angle)` per bullet, the angle formula unchanged (`heading + (i / count) · TAU`,
  `heading + (i / (count − 1) − 0.5) · spread`), so the shapes are the same to within an ulp. Offsets and velocities
  are written component by component (`v.x = s · speed`), not with `.set(…).multiplyScalar(…)`.
- `gen.fibonacciSphere`, `torusKnot`, `galaxy`, `helix`, `rose3D`: `detSin` / `detCos`; normalization through a library
  helper `normalize3(v)` = `len = Math.sqrt(x*x + y*y + z*z)`, then `x * (1 / len)` (three's current
  `divideScalar` order, so the bits match today's three where trig isn't involved).
- `mod.accelerate`: the same formula with `normalize3` and an explicit cross product, op for op three r186's current
  order. **Its results are bit-identical to 0.7.0 on the game's three**, so the mini-bosses' curves move only through
  `gen.arc`.
- `mod.rotate(axis, angle)`: the quaternion from `detSinCos(angle / 2)` and an explicit rotate (`v + 2w(q×v) +
  2q×(q×v)`, fixed order).
- `BulletField`'s built-in orbit: `detSinCos(rot)`.
- `easing.ts`: `Math.pow(a, 2)` / `Math.pow(a, 3)` become `a * a` / `a * a * a` (render only, but `fadeAt` is public).
- `render/geometry.ts` keeps `Math.hypot` (geometry building, never in a step); it is listed as the lint exception.

### Guard rails

- **ESLint** `no-restricted-properties` on `Math.sin / cos / tan / asin / acos / atan / atan2 / sinh / cosh / tanh /
  exp / expm1 / log / log1p / log2 / log10 / pow / hypot / cbrt / random`, and `no-restricted-syntax` on `**`,
  over all of `src/` except `render/**` (Math allowed: drawing only) and `dev.ts`. Three's
  `setFromAxisAngle` / `applyQuaternion` / `applyAxisAngle` are restricted the same way outside `render/`.
- **Bundle scan test:** after `npm run build`, `dist/patterns.js` and `dist/core.js` (and their `.cjs`) contain none of
  those names. It catches a trig call pulled in through an import.

### Proving it (decision 3)

1. **Reference accuracy:** `src/__tests__/fixtures/sincos.json`, ~4,000 inputs with their correctly rounded sin and
   cos, generated once offline with mpmath at 50 digits (`scripts/gen-sincos-fixtures.py`, committed for
   reproducibility, not run in CI). Inputs: 0, −0, ±k·π/2 and their neighbours (±1, ±2 ulp), tiny values (1e−300,
   denormals), every angle the game uses (`(i / count) · TAU` for count 1..64, the `TURN` steps, the class spreads),
   a uniform sweep to ±1e5 and a log sweep to the range limit. Test: error ≤ 1 ulp everywhere in range.
2. **Bit identity:** a golden FNV hash over `detSinCos` of 1,000,000 seeded inputs (`createSeededRandom(1337)`,
   scaled to ±1e4), and a golden hash of every generator's spawn data for fixed arguments. Both hashes are committed;
   any change in the bits fails.
3. **Cross-engine CI:** `npm run test:engines` (Playwright: Chromium, Firefox, WebKit) loads the built `dist/patterns.js`
   in a blank page, recomputes both golden hashes and compares them with Node's. It is a new CI job next to
   `build-and-test`. The cloud container and GitHub's `ubuntu-latest` both run Playwright's WebKit build, the closest
   CI gets to Safari / iOS JavaScriptCore.
4. **Not a speed regression:** a bench test, 100,000 `gen.arc(12, 2π, …)` bursts, within 1.5× of 0.7.0 (bursts are per
   volley, never per frame; the polynomial costs a few dozen flops).

### Versioning

**0.8.0** (decision 1: the default `gen` / `mod` switch, no second implementation). The CHANGELOG's "Changed" section
says the spawn data of the trig generators can differ from 0.7.0 in the last bit, so recordings made with 0.7.0
are not bit-identical under 0.8.0, and every pattern is now cross-engine. The README's determinism section loses "keep
`Math.sin`-based patterns to one engine build" and gains what is guaranteed: the core and all built-in patterns, on any
engine, for a given library version.

## Work breakdown

Every library step's gate: lint, typecheck, build, the full suite green, README / CHANGELOG
updated.

### Library (r3f-projectiles 0.8.0)

#### L1 · `detmath.ts` and its proofs — M (3)

- The port, constants, the dev-only range warning, exports from root / `/patterns` / `/core`.
- The fixture generator script, `sincos.json`, the ulp test, the special-value tests, the golden hash.

#### L2 · Generators and modifiers — M (2)

- `patterns.ts` on `detSinCos`, `normalize3`, explicit cross and quaternion rotate; `BulletField` orbit; `easing.ts`.
- Tests: per-generator golden spawn hashes; shapes equal 0.7.0's within 2 ulp (an `approx` sweep against a
  `Math.sin` copy kept in the test); `mod.accelerate` bit-identical to 0.7.0 on three r186; existing tests that pin
  exact numbers are updated, each with its reason in the diff.

#### L3 · Guard rails — S (1)

- The ESLint rules and the bundle scan test.

#### L4 · Cross-engine CI and the core pin — M (2)

- `test:engines` (Playwright, three engines), the CI job, the bench.
- A core test: a scripted `step` / `fireAt` run against a plain-number reference integrator (the documented
  `pos += vel · dt`, `vel += acc · dt` order), so a three upgrade that changed `addScaledVector` would fail it.

#### L5 · Docs and release — S (1)

- README determinism section, CHANGELOG 0.8.0, the fdlibm notice. Kaleb tags the release; `publish.yml` publishes.

### Game (Kaleb-Vale, after 0.8.0 is on npm)

#### G1 · Switch and re-pin — M (2)

- `package.json` `^0.8.0`. No game code changes: `patterns.ts` and `miniboss.ts` keep calling `gen.arc` /
  `mod.accelerate`, which are now det.
- **Equivalence report before the re-pin** (decision 4): each of the six pinned runs plus `ghosts.solo` and
  `bots.parity`, with 0.7.0 and 0.8.0, side by side: every burst's spawn velocities within 2 ulp; the run's outcome
  (ticks, kills, deaths, XP, damage taken, drops) equal; the first tick where the hash differs and why (expected: the
  first burst). A rare ulp-level miss that flips a graze is reported, not hidden.
- Then the re-pin: `solo.parity`, `soloConfig.parity` (only if a digest covers library output; config digests should
  not move), `progress.m1hash`, `ghosts.solo`, `bots.parity`, `hash.oracle`, and any other test that pins a
  hash, with "r3f-projectiles 0.8.0: det-math generators" in the commit.

#### G2 · Rules, guard and docs — S (1)

- `src/sim/README.md`: rule 10 now says bursts are cross-engine from 0.8.0; rule 3 points at the library's det math
  for anything that needs an angle.
- E3.6's `src/__repo/simDetMath.test.ts` also fails if `src/sim` imports `Quaternion` / `Euler` / `MathUtils` from
  `three`, or if the installed library version is below 0.8.0.
- docs/M3.md: a short "Det-math bullets" section with the equivalence report's numbers.

#### G3 · In-browser parity — S (1)

- A Playwright script (`scripts/engine-parity.mjs`, Chromium preinstalled in the cloud workspace; Firefox and WebKit
  via Playwright) runs two pinned runs (`act1.r3.waypoint`, `delve2.vanguard`) headless in each engine and compares
  their hashes with Node's. Run by hand before a release, not in the suite (it needs a build).

## Dependencies and sequencing

| With | Relation |
| --- | --- |
| E3.6 biome variants | its `simDetMath` guard and det-math rules apply to the game's own code; this plan covers the library. **G1 lands before E3.6's B0 re-pin** (decision 4), so B0's trace-equality check runs on det bullets |
| E3.4 Phase E | its own re-pin is later and unrelated |
| E5 mobile | the payoff: iOS / Safari (JavaScriptCore) can replay and, later, play co-op with desktop builds bit-for-bit |

## Risks

- **A port bug that is still deterministic.** Wrong but consistent sines would pass the identity tests. The ulp test
  against an independent mpmath reference is what catches it, which is why it is generated outside JS.
- **Engine bugs in basic ops** (historic x87 double-rounding on 32-bit builds). Modern engines on x64 / ARM64 use
  SSE2 / NEON doubles; the three-engine CI run is the check.
- **Hash moves surprise other users of the library.** It is a 0.x minor bump with a clear CHANGELOG line; the shapes
  are the same to within an ulp.
- **The game re-pin hides a real regression.** The equivalence report must show equal outcomes before any pin
  changes; a mismatch blocks G1.
- **Three upgrades** could still change `addScaledVector` in the core; L4's reference test fails first.

## Sizes

| Step | Agent build | Kaleb |
| --- | --- | --- |
| L1 det math, proofs | M (3) | read the ulp report |
| L2 generators, modifiers | M (2) | – |
| L3 guard rails | S (1) | – |
| L4 cross-engine CI, core pin | M (2) | – |
| L5 docs, release | S (1) | tag and publish 0.8.0 |
| **Library** | **~9 agent-days** | |
| G1 switch, equivalence, re-pin | M (2) | approve the re-pin |
| G2 rules, guard, docs | S (1) | – |
| G3 in-browser parity | S (1) | – |
| **Game** | **~4 agent-days** | **~½ day in all** |

## Decisions (for Kaleb; recommendations in bold)

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| 1 | Library API | (a) switch the default `gen` / `mod` to det math in 0.8.0; (b) add a separate `/det` entry and keep the `Math` versions; (c) an angle-free API (unit vectors and rotation pairs in, no radians) | **(a)**: one implementation, every consumer gets cross-engine patterns, shapes equal to within an ulp. (b) doubles the code and tests to keep bits nobody relies on across engines anyway; (c) means converting every spread and heading in the game's data |
| 2 | Accuracy | (a) fdlibm port, ≤ 1 ulp in range; (b) a shorter polynomial, ~1e−12 absolute error | **(a)**: the same cost class, a known-good reference, and shapes indistinguishable from `Math.sin` |
| 3 | Proof across engines | (a) Node only; (b) Playwright Chromium + Firefox + WebKit in CI | **(b)**: it is the point of the change, and the only way to see JavaScriptCore before an iOS build does |
| 4 | Game re-pin timing | (a) G1 as its own re-pin, before E3.6's B0; (b) folded into B0 | **(a)**: each re-pin keeps its own clean proof (outcome equality here, trace equality there) |
