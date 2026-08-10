/**
 * Type-level test for the **public** shape of {@link BulletFieldHandle}.
 *
 * ## `tsc --noEmit` is the runner, not vitest
 * This file is deliberately **not** named `*.test.ts`. `tsconfig.json`'s
 * `exclude` drops every `.test.ts` and `.test.tsx` file from the *default*
 * program (they must stay out of `dist`), and vitest transpiles with esbuild
 * rather than type-checking. Naming it `.types.ts` keeps it inside
 * `include: ["src"]`, which makes it a root file of the default program — so
 * plain `npx tsc --noEmit` goes red if any assertion below regresses, whether
 * or not anything imports it.
 *
 * `tsconfig.test.json` (`npm run typecheck:tests`) now type-checks the vitest
 * files too, so a type assertion in a `.test.ts` is no longer checked by
 * nothing. This file still earns its name: it holds no runtime assertions, so
 * as a `.test.ts` vitest would report it as a file with no test suite, and it
 * would drop out of the default `tsc --noEmit` that guards the shipped build.
 * Both checks covering it is the point, not an accident.
 *
 * ## Why the property needs a type-level test at all
 * At runtime the field builds exactly **one** handle object, carrying the
 * registry plumbing (`register` / `unregister` / `fire`) alongside the consumer
 * surface, because the same object is also the registry context value and its
 * identity must stay stable. The narrowing is therefore entirely in the types:
 * `forwardRef<BulletFieldHandle, …>` hands the object out through a type that
 * does not name those three methods. A runtime test would find all three
 * present on the object and could only ever assert the opposite of the
 * contract.
 *
 * ## What is being protected
 * `register`, `unregister` and `fire` all take an `EmitterEntry`, and
 * `EmitterEntry` is not exported from `src/index.ts`. A public type that names
 * a type consumers cannot import is broken by construction — and `fire(entry)`
 * is the sharp end of it, reading as the obvious way to fire an emitter while
 * being the one method a consumer has no way to call.
 */
import type {
  BulletFieldHandle,
  EmitterRegistryHandle,
} from '../BulletField';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Fails to instantiate — and so reddens `tsc` — for anything but `true`. */
type AssertTrue<T extends true> = T;

/**
 * Invariant (not merely bidirectionally assignable) type identity. The
 * two-conditional trick is what makes it exact: assignability alone would let
 * an extra member through in one direction.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// ---------------------------------------------------------------------------
// The seven consumer members — and ONLY those seven
// ---------------------------------------------------------------------------

/** The consumer surface, spelled out so the assertion below can be exact. */
export type ConsumerSurface =
  | 'fireAt'
  | 'clear'
  | 'acquireEmitter'
  | 'releaseEmitter'
  | 'activeCountFor'
  | 'activeCount'
  | 'forEachActive';

/**
 * Both directions at once: nothing consumer-facing has been dropped, and
 * nothing internal has crept back in. Re-widening `BulletFieldHandle` to
 * `extends EmitterRegistry` reddens exactly here.
 */
export type _KeysAreExactlyTheConsumerSurface = AssertTrue<
  Exact<keyof BulletFieldHandle, ConsumerSurface>
>;

/**
 * The positive half again, member by member, so that *removing* one produces
 * an error naming the member rather than an opaque `false`-does-not-satisfy.
 */
export type _EveryConsumerMemberResolves = {
  [K in ConsumerSurface]: BulletFieldHandle[K];
};

// ---------------------------------------------------------------------------
// The three that must NOT be reachable through the public handle
// ---------------------------------------------------------------------------
//
// `@ts-expect-error` is the assertion: it errors when the line below it
// *stops* erroring, which is precisely the regression being guarded.

// @ts-expect-error — `register` is registry plumbing; it takes an unexported `EmitterEntry`.
export type _NoRegister = BulletFieldHandle['register'];

// @ts-expect-error — `unregister` is registry plumbing; it takes an unexported `EmitterEntry`.
export type _NoUnregister = BulletFieldHandle['unregister'];

// @ts-expect-error — `fire(entry)` is unusable from outside: `EmitterEntry` is not exported.
export type _NoFire = BulletFieldHandle['fire'];

// ---------------------------------------------------------------------------
// …and where they went instead
// ---------------------------------------------------------------------------

/**
 * The internal handle still carries all three, and still carries the public
 * surface, because it is the type of the single object both the ref and the
 * registry context are handed. If this stops resolving, the split has been
 * made at runtime rather than in the types — which is the other way this can
 * regress, and the more damaging one.
 */
export type _InternalHandleKeepsThePlumbing = {
  register: EmitterRegistryHandle['register'];
  unregister: EmitterRegistryHandle['unregister'];
  fire: EmitterRegistryHandle['fire'];
  fireAt: EmitterRegistryHandle['fireAt'];
};
