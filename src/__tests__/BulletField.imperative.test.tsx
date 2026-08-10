import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Vector3 } from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
  type EmitterProps,
} from '../BulletField';
import { Emitter, type EmitterHandle } from '../Emitter';
import { BulletManager } from '../BulletManager';
import { acquire, releaseSpawnData } from '../pool';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * `<BulletField>` — phase 4 of docs/bulletfield-emitter-split.md: the
 * imperative surface, `onPoolExhausted`, and the invariants they are built on.
 *
 *  - **`fireAt`** (two-consumption-paths) — spawning with no React at all, for
 *    consumers whose emitters are pool rows rather than components.
 *  - **Id lifecycle** (decision 7) — `acquireEmitter` / `releaseEmitter` over a
 *    monotonic counter that never recycles, shared with `<Emitter>`
 *    registration.
 *  - **Exhaustion** (decision 1) — drop-newest, and `onPoolExhausted` raised
 *    once per burst rather than once per dropped bullet.
 *  - **The cross-emitter invariant** (decision 1's headline claim) — no
 *    emitter can ever destroy another emitter's bullets, by any route.
 *  - **Reentrancy** — `fireAt` from inside a `forEachActive` callback, the
 *    hazard decision 1 exists to make unreachable.
 *  - **Swap-remove** — the backwards walk from phase 2, verified in-tree at
 *    last.
 *  - **`releaseSpawnData`'s double-release guard**, now that the `includes()`
 *    scan behind it has been replaced.
 *
 * ---------------------------------------------------------------------------
 * SLOT ASSIGNMENT ORDER IS EXPLICITLY NOT PART OF THE CONTRACT, exactly as in
 * `BulletManager.characterization.test.tsx` and `BulletField.test.tsx`.
 * Nothing here asserts which slot index came back; bullets are identified by
 * `payload` and attributed by `emitterId`.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface BulletSpec {
  payload?: number;
  life?: number;
  delay?: number;
}

/**
 * Motionless, effectively immortal bullets spawned exactly at the source
 * position (zero offset), so `activeCount` moves only when the code under test
 * spawns or frees a slot, and a bullet's reported position *is* the origin it
 * was fired from.
 */
function staticBurst(specs: BulletSpec[]): PatternFactory {
  return () =>
    specs.map((s): BulletSpawnData => {
      const d = acquire();
      d.offset.set(0, 0, 0);
      d.velocity.set(0, 0, 0);
      d.acceleration.set(0, 0, 0);
      d.delay = s.delay ?? 0;
      d.life = s.life ?? 1000;
      d.color = null;
      d.payload = s.payload ?? 0;
      d.scale = 1;
      return d;
    });
}

/** `n` identical motionless bullets, all tagged with the same payload. */
function burstOf(n: number, spec: BulletSpec = {}): PatternFactory {
  return staticBurst(Array.from({ length: n }, () => spec));
}

/** `n` motionless bullets with payloads `0 … n-1`, so each is distinguishable. */
function numberedBurst(n: number): PatternFactory {
  return staticBurst(Array.from({ length: n }, (_, i) => ({ payload: i })));
}

const FIELD: Omit<BulletFieldProps, 'children'> = {
  maxBullets: 1000,
  boundsLimit: 25,
  bulletRadius: 0.12,
  fadeTime: 0,
  fadeCurve: 'linear',
  paused: false,
  reducedMotion: false,
};

const EMITTER: Omit<EmitterProps, 'pattern'> = {
  fireRate: 0.01, // cannot auto-fire inside the second or two any test advances
  spawnCenterY: 3,
  rotationSpeed: 0,
};

const DT = 0.1; // must stay ≤ 0.1: the frame loop clamps to Math.min(delta, 0.1)

const ORIGIN = new Vector3(1, 2, 3);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

interface Row {
  index: number;
  payload: number;
  emitterId: number;
  pos: [number, number, number];
}

/** Non-destructive walk of every visible bullet. */
function census(handle: BulletFieldHandle): Row[] {
  const rows: Row[] = [];
  handle.forEachActive((index, pos, payload, emitterId) => {
    rows.push({ index, payload, emitterId, pos: [pos.x, pos.y, pos.z] });
  });
  return rows;
}

/** How many live bullets each emitter id owns, as a plain object. */
function countsByEmitter(handle: BulletFieldHandle): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of census(handle)) out[r.emitterId] = (out[r.emitterId] ?? 0) + 1;
  return out;
}

async function mountField<P extends object>(
  Comp: (
    p: P & { fieldRef: React.RefObject<BulletFieldHandle | null> },
  ) => React.ReactElement,
  props: P,
): Promise<{
  renderer: Renderer;
  field: () => BulletFieldHandle;
  render: (next: P) => Promise<void>;
}> {
  let ref: React.RefObject<BulletFieldHandle | null> | null = null;
  const Wrapper = (p: P) => {
    const r = useRef<BulletFieldHandle | null>(null);
    ref = r;
    return <Comp {...p} fieldRef={r} />;
  };
  const renderer = await ReactThreeTestRenderer.create(<Wrapper {...props} />);
  return {
    renderer,
    field: () => ref!.current!,
    render: async (next) => {
      await renderer.update(<Wrapper {...next} />);
    },
  };
}

/** A bare field with no emitters at all — the pure imperative consumer. */
async function mountBareField(extra: Partial<BulletFieldProps> = {}) {
  const Comp = ({
    fieldRef,
  }: {
    fieldRef: React.RefObject<BulletFieldHandle | null>;
  }) => <BulletField ref={fieldRef} {...FIELD} {...extra} />;
  return mountField(Comp, {});
}

// ===========================================================================
// 1. The imperative path — fireAt
// ===========================================================================

describe('BulletField — fireAt (the no-React consumption path)', () => {
  it('spawns with no <Emitter> mounted at all, at the origin it is given', async () => {
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(5, { payload: 42 }));
    });

    const rows = census(field());
    expect(rows).toHaveLength(5);
    expect(field().activeCount).toBe(5);
    for (const r of rows) {
      expect(r.payload).toBe(42);
      expect(r.pos).toEqual([1, 2, 3]);
    }
  });

  it('defaults to the reserved anonymous id 0', async () => {
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(3));
    });

    expect(countsByEmitter(field())).toEqual({ 0: 3 });
    expect(field().activeCountFor(0)).toBe(3);

    // …and `clear(0)` reaches exactly the anonymous bullets, which is what
    // closes decision 7's "no reservable range" problem by construction.
    await ReactThreeTestRenderer.act(async () => {
      field().clear(0);
    });
    expect(field().activeCount).toBe(0);
  });

  it('accepts an explicit emitterId and stamps every bullet in the burst with it', async () => {
    const { field } = await mountBareField();

    let id = 0;
    await ReactThreeTestRenderer.act(async () => {
      id = field().acquireEmitter();
      field().fireAt(ORIGIN, burstOf(4, { payload: 7 }), id);
    });

    expect(id).toBe(1);
    expect(countsByEmitter(field())).toEqual({ 1: 4 });
    expect(field().activeCountFor(1)).toBe(4);
    expect(field().activeCountFor(0)).toBe(0);
  });

  it('accepts both a PatternKey and a PatternFactory', async () => {
    const { field } = await mountBareField();

    // A built-in key, resolved through BUILTIN_PATTERNS. 'ring' is 100 bullets.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, 'ring', 1);
    });
    expect(field().activeCountFor(1)).toBe(100);

    // A custom factory, called directly.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(6, { payload: 9 }), 2);
    });
    expect(field().activeCountFor(2)).toBe(6);
    expect(field().activeCount).toBe(106);
    expect(
      census(field())
        .filter((r) => r.emitterId === 2)
        .every((r) => r.payload === 9),
    ).toBe(true);
  });

  it('works while the field is paused, exactly as <Emitter>.fire() does', async () => {
    const { renderer, field } = await mountBareField({ paused: true });

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(4, { payload: 1 }));
    });
    expect(field().activeCount).toBe(4);

    // Paused means frozen, not dropped: the bullets neither move nor expire.
    await renderer.advanceFrames(10, DT);
    expect(field().activeCount).toBe(4);
    for (const r of census(field())) expect(r.pos).toEqual([1, 2, 3]);
  });

  it('does not retain the origin vector the caller handed it', async () => {
    const { field } = await mountBareField();
    const moving = new Vector3(1, 1, 1);

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(moving, burstOf(2, { payload: 1 }), 1);
      moving.set(50, 50, 50); // the caller reuses their vector immediately
      field().fireAt(moving, burstOf(2, { payload: 2 }), 2);
    });

    for (const r of census(field()).filter((x) => x.emitterId === 1)) {
      expect(r.pos).toEqual([1, 1, 1]);
    }
    for (const r of census(field()).filter((x) => x.emitterId === 2)) {
      expect(r.pos).toEqual([50, 50, 50]);
    }
  });
});

// ===========================================================================
// 2. Id lifecycle — decision 7
// ===========================================================================

describe('BulletField — id lifecycle (decision 7)', () => {
  it('issues ids from one monotonic counter shared with <Emitter> registration', async () => {
    const Comp = ({
      showSecond,
      fieldRef,
    }: {
      showSecond: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter {...EMITTER} pattern={burstOf(1)} />
        {showSecond ? <Emitter {...EMITTER} pattern={burstOf(1)} /> : null}
      </BulletField>
    );

    const { field, render } = await mountField(Comp, { showSecond: false });

    // The mounted <Emitter> took 1 at registration. `acquireEmitter` is a
    // second entry point onto that same counter, not a second counter — so it
    // continues the sequence rather than colliding with the live id 1.
    const a = field().acquireEmitter();
    const b = field().acquireEmitter();
    expect(a).toBe(2);
    expect(b).toBe(3);

    // …and a later <Emitter> continues it too, from the other direction.
    await render({ showSecond: true });
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(1, { payload: 99 }), 0);
    });
    // The new emitter's id is whatever comes next; the only claim that matters
    // is that it is not one of the ids already handed out.
    const c = field().acquireEmitter();
    expect(c).toBeGreaterThan(b);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('never issues 0, and never returns an id that is already live', async () => {
    const { field } = await mountBareField();

    const issued: number[] = [];
    for (let i = 0; i < 50; i++) issued.push(field().acquireEmitter());

    expect(issued).not.toContain(0); // 0 is reserved for anonymous
    expect(new Set(issued).size).toBe(50); // every one distinct
    expect(issued[0]).toBe(1); // and the sequence starts at 1
  });

  it('release-then-acquire returns a DIFFERENT id, never the released one', async () => {
    const { field } = await mountBareField();

    const first = field().acquireEmitter();
    field().releaseEmitter(first);
    const second = field().acquireEmitter();

    expect(second).not.toBe(first);
    expect(second).toBeGreaterThan(first);

    // Repeatedly, and after a release out of order too.
    const seen = new Set<number>([first, second]);
    for (let i = 0; i < 20; i++) {
      const id = field().acquireEmitter();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      if (i % 3 === 0) field().releaseEmitter(id);
    }
  });

  it('keeps a released emitter\'s bullets alive, attributed, and out of clear(newId)\'s reach', async () => {
    const { field } = await mountBareField();

    let dying = 0;
    let heir = 0;
    await ReactThreeTestRenderer.act(async () => {
      dying = field().acquireEmitter();
      field().fireAt(ORIGIN, burstOf(5, { payload: 111 }), dying);
    });

    // The archer dies. It wants its arrows to finish their flight, so it
    // releases without clearing — the separation decision 7 is built around.
    field().releaseEmitter(dying);

    expect(field().activeCount).toBe(5);
    expect(field().activeCountFor(dying)).toBe(5);
    expect(countsByEmitter(field())).toEqual({ [dying]: 5 });

    // A new archer spawns into the same conceptual slot in the consumer's own
    // pool. If ids recycled, it would be issued `dying` and would inherit — and
    // then destroy — five arrows that are not its.
    await ReactThreeTestRenderer.act(async () => {
      heir = field().acquireEmitter();
      field().fireAt(new Vector3(0, 0, 0), burstOf(2, { payload: 222 }), heir);
    });
    expect(heir).not.toBe(dying);

    await ReactThreeTestRenderer.act(async () => {
      field().clear(heir);
    });

    // The orphans are untouched: same count, same payload, same id, and still
    // NOT reattributed to the anonymous 0.
    expect(field().activeCount).toBe(5);
    const rows = census(field());
    expect(rows.every((r) => r.emitterId === dying)).toBe(true);
    expect(rows.every((r) => r.payload === 111)).toBe(true);
    expect(field().activeCountFor(0)).toBe(0);

    // And they remain reachable by their own retired id — provenance survives
    // the emitter, which is the entire reason the id is field-issued.
    await ReactThreeTestRenderer.act(async () => {
      field().clear(dying);
    });
    expect(field().activeCount).toBe(0);
  });

  it('never issues an id that a consumer has already used for bullets in flight', async () => {
    // `fireAt`'s `emitterId` is an open parameter, so a consumer managing its
    // own ids can name one the field never issued. The counter absorbs it, or
    // a later `acquireEmitter()` would hand a second emitter an id that live
    // bullets already carry — decision 1's cross-emitter invariant, broken by
    // the one route decision 7 left open.
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(3, { payload: 1 }), 500);
    });
    expect(field().activeCountFor(500)).toBe(3);

    const next = field().acquireEmitter();
    expect(next).toBeGreaterThan(500);
    expect(field().activeCountFor(next)).toBe(0);

    // Same rule from the release side: an id the consumer names is an id the
    // field will not issue, whether or not it issued it in the first place.
    field().releaseEmitter(9000);
    expect(field().acquireEmitter()).toBeGreaterThan(9000);
  });

  it('releaseEmitter clears nothing by itself', async () => {
    const { field } = await mountBareField();

    let id = 0;
    await ReactThreeTestRenderer.act(async () => {
      id = field().acquireEmitter();
      field().fireAt(ORIGIN, burstOf(6, { payload: 1 }), id);
    });

    const before = census(field());
    field().releaseEmitter(id);
    const after = census(field());

    expect(after).toHaveLength(6);
    expect(after).toEqual(before); // byte for byte: slots, ids, payloads, positions
  });
});

// ===========================================================================
// 3. Exhaustion — decision 1
// ===========================================================================

describe('BulletField — pool exhaustion (decision 1)', () => {
  it('drops the NEWEST burst and leaves every existing bullet untouched', async () => {
    const onPoolExhausted = vi.fn();
    const { field } = await mountBareField({ maxBullets: 10, onPoolExhausted });

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(10, { payload: 1 }), 1);
    });
    const before = census(field());
    expect(before).toHaveLength(10);
    expect(onPoolExhausted).not.toHaveBeenCalled(); // an exact fit is not exhaustion

    // A second emitter fires into a completely full pool.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(new Vector3(9, 9, 9), burstOf(4, { payload: 2 }), 2);
    });

    // Nothing of emitter 2's landed, and emitter 1 kept all ten — same slots,
    // same payloads, same ids, same positions.
    expect(field().activeCount).toBe(10);
    expect(field().activeCountFor(2)).toBe(0);
    expect(census(field())).toEqual(before);
  });

  it('fires onPoolExhausted EXACTLY ONCE per burst, not once per dropped bullet', async () => {
    const onPoolExhausted = vi.fn();
    const { field } = await mountBareField({ maxBullets: 10, onPoolExhausted });

    // Fill the pool completely, then throw a 100-bullet burst at it. The
    // design's stated failure mode is 100 callbacks in one frame.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(10, { payload: 1 }), 1);
      field().fireAt(ORIGIN, burstOf(100, { payload: 2 }), 2);
    });

    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(2, 100, 0, 'pool-full');
  });

  it('reports the partial count when a burst is only half-served', async () => {
    const onPoolExhausted = vi.fn();
    const { field } = await mountBareField({ maxBullets: 10, onPoolExhausted });

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(6, { payload: 1 }), 1);
    });
    expect(onPoolExhausted).not.toHaveBeenCalled();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(6, { payload: 2 }), 2);
    });

    // Four slots were left, so four landed and the callback says so.
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(2, 6, 4, 'pool-full');
    expect(field().activeCountFor(1)).toBe(6);
    expect(field().activeCountFor(2)).toBe(4);
  });

  it('reports from the auto-fire path too, once per burst per emitter', async () => {
    const onPoolExhausted = vi.fn();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        maxBullets={10}
        onPoolExhausted={onPoolExhausted}
      >
        {/* One shot per frame at DT = 0.1s, asking for 50 into a 10-slot pool. */}
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(50, { payload: 1 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    expect(field().activeCount).toBe(10);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(1, 50, 10, 'pool-full');
  });

  it('reports a reduced-motion snapshot truncated by the field-wide budget', async () => {
    // Decision 5 makes the 200 cap behave as drop-newest in registration order
    // precisely so exhaustion has one semantics rather than two — so the third
    // emitter, truncated at 40 of 80, reports through the same callback.
    const onPoolExhausted = vi.fn();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        reducedMotion
        onPoolExhausted={onPoolExhausted}
      >
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 10 })} />
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 20 })} />
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 30 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    expect(field().activeCount).toBe(200);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(
      3,
      80,
      40,
      'reduced-motion-budget',
    );
  });

  it('stays silent when every burst fits', async () => {
    const onPoolExhausted = vi.fn();
    const { field } = await mountBareField({ maxBullets: 100, onPoolExhausted });

    await ReactThreeTestRenderer.act(async () => {
      for (let i = 0; i < 10; i++) field().fireAt(ORIGIN, burstOf(10), i + 1);
    });

    expect(field().activeCount).toBe(100); // exactly full, never over
    expect(onPoolExhausted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3b. The exhaustion REASON — which constraint bound, not just that one did
// ===========================================================================
//
// One semantics for exhaustion (decision 5) but two remedies: a `'pool-full'`
// burst says raise `maxBullets` or slow an emitter down, and a
// `'reduced-motion-budget'` one says nothing can be done, because the 200 cap
// is not configurable. The reduced-motion path is the only one where either
// constraint can bind, so it is the only place the discriminator can be wrong
// — both directions are asserted there.

describe('BulletField — onPoolExhausted reports WHY the burst was cut short', () => {
  it('reports pool-full when the snapshot is truncated by the pool, not the budget', async () => {
    // Reduced motion, but a 30-slot pool against a 200-bullet budget: the
    // budget cannot possibly be what binds. A reason hardcoded per spawn path
    // rather than computed from the outcome reddens exactly here.
    const onPoolExhausted = vi.fn();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        maxBullets={30}
        reducedMotion
        onPoolExhausted={onPoolExhausted}
      >
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 10 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    expect(field().activeCount).toBe(30); // the pool, exactly — nowhere near 200
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(1, 80, 30, 'pool-full');
  });

  it('reports pool-full from <Emitter>.fire(), the one spawn path with no other test on it', async () => {
    // The manual-fire path had no exhaustion assertion of any kind before the
    // reason existed, so a wrong constant here would have gone unnoticed.
    const onPoolExhausted = vi.fn();
    const emitter = React.createRef<EmitterHandle>();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        maxBullets={10}
        onPoolExhausted={onPoolExhausted}
      >
        <Emitter ref={emitter} {...EMITTER} pattern={burstOf(6, { payload: 1 })} />
      </BulletField>
    );

    const { field } = await mountField(Comp, {});

    await ReactThreeTestRenderer.act(async () => {
      emitter.current!.fire(); // 6 of 10 — fits
    });
    expect(onPoolExhausted).not.toHaveBeenCalled();

    await ReactThreeTestRenderer.act(async () => {
      emitter.current!.fire(); // 4 of 6 land, 2 are dropped
    });

    expect(field().activeCount).toBe(10);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(1, 6, 4, 'pool-full');
  });

  it('reports reduced-motion-budget when the budget is spent and the pool is not', async () => {
    // The mirror image: 1000 slots, so 300 of the 1000 are still free when the
    // second emitter is refused. The only thing that ran out is the field-wide
    // 200-bullet snapshot allowance.
    const onPoolExhausted = vi.fn();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        reducedMotion
        onPoolExhausted={onPoolExhausted}
      >
        <Emitter {...EMITTER} pattern={burstOf(150, { payload: 10 })} />
        <Emitter {...EMITTER} pattern={burstOf(150, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    // 150 + 50 = the cap. The first emitter fit; the second was truncated.
    expect(field().activeCount).toBe(200);
    expect(field().activeCountFor(2)).toBe(50);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(
      2,
      150,
      50,
      'reduced-motion-budget',
    );

    // …and the proof that the pool was never the constraint: it still serves a
    // 100-bullet burst without complaint. `maxBullets` was never the remedy,
    // which is the entire reason the two reasons are told apart.
    onPoolExhausted.mockClear();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(100, { payload: 30 }), 9);
    });
    expect(field().activeCount).toBe(300);
    expect(onPoolExhausted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. The cross-emitter invariant — decision 1's headline claim
// ===========================================================================

describe('BulletField — an emitter can never destroy another emitter\'s bullets', () => {
  it('holds across clear(id), exhaustion, release, and id reuse attempts', async () => {
    const { field } = await mountBareField({ maxBullets: 20 });

    let a = 0;
    let b = 0;
    await ReactThreeTestRenderer.act(async () => {
      a = field().acquireEmitter();
      b = field().acquireEmitter();
      field().fireAt(new Vector3(1, 0, 0), burstOf(5, { payload: 100 }), a);
      field().fireAt(new Vector3(2, 0, 0), burstOf(5, { payload: 200 }), b);
    });

    /** Emitter A's bullets, as a stable fingerprint. */
    const fingerprintA = () =>
      census(field())
        .filter((r) => r.emitterId === a)
        .map((r) => `${r.index}:${r.payload}:${r.pos.join(',')}`)
        .sort();
    const baseline = fingerprintA();
    expect(baseline).toHaveLength(5);

    // ---- (1) B clears itself ---------------------------------------------
    await ReactThreeTestRenderer.act(async () => {
      field().clear(b);
    });
    expect(field().activeCountFor(b)).toBe(0);
    expect(fingerprintA()).toEqual(baseline);

    // ---- (2) B exhausts the pool -----------------------------------------
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(new Vector3(2, 0, 0), burstOf(500, { payload: 200 }), b);
    });
    expect(field().activeCount).toBe(20); // full, and it stopped there
    expect(field().activeCountFor(b)).toBe(15);
    expect(fingerprintA()).toEqual(baseline); // not one of A's was recycled

    // ---- (3) B is released, and its successor cannot inherit --------------
    field().releaseEmitter(b);
    let c = 0;
    await ReactThreeTestRenderer.act(async () => {
      c = field().acquireEmitter();
      field().clear(c); // the successor clears "its own" bullets: it has none
    });
    expect(field().activeCountFor(b)).toBe(15); // B's orphans survive
    expect(fingerprintA()).toEqual(baseline);

    // ---- (4) the anonymous id is not a back door -------------------------
    await ReactThreeTestRenderer.act(async () => {
      field().clear(0);
    });
    expect(fingerprintA()).toEqual(baseline);
    expect(field().activeCountFor(b)).toBe(15);

    // ---- (5) only A's own clear touches A --------------------------------
    await ReactThreeTestRenderer.act(async () => {
      field().clear(a);
    });
    expect(field().activeCountFor(a)).toBe(0);
    expect(field().activeCountFor(b)).toBe(15);
  });

  it('holds for <Emitter> bullets against an imperative clear', async () => {
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 10 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(0, DT);

    // Give the declarative emitter some bullets, then fire imperatively under a
    // *different* id and clear that id.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(4, { payload: 10 }), 1); // emitter 1 is the <Emitter>
      field().fireAt(ORIGIN, burstOf(3, { payload: 20 }), 2);
    });
    expect(countsByEmitter(field())).toEqual({ 1: 4, 2: 3 });

    await ReactThreeTestRenderer.act(async () => {
      field().clear(2);
    });
    expect(countsByEmitter(field())).toEqual({ 1: 4 });
  });
});

// ===========================================================================
// 4b. clear(emitterId) — the narrowed form of the three field-wide resets
// ===========================================================================

describe('BulletField — clear(emitterId)', () => {
  // Deliberately not a multiple of DT, so every assertion sits clear of the
  // firing threshold rather than on top of it.
  const FIRE_INTERVAL = 0.85;
  const CADENCE = 1 / FIRE_INTERVAL;

  it('resets only the named emitter\'s cadence, and leaves it running', async () => {
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD}>
        <Emitter {...EMITTER} fireRate={CADENCE} pattern={burstOf(3, { payload: 10 })} />
        <Emitter {...EMITTER} fireRate={CADENCE} pattern={burstOf(3, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});

    await renderer.advanceFrames(8, DT); // 0.80s — both just short of a shot
    expect(field().activeCount).toBe(0);

    await ReactThreeTestRenderer.act(async () => {
      field().clear(1);
    });

    // One more frame: emitter 2 crosses 0.85s and fires; emitter 1, reset to
    // zero, stands at 0.10s and does not. A clear() that reset every entry
    // would leave both silent here.
    await renderer.advanceFrames(1, DT);
    expect(field().activeCountFor(1)).toBe(0);
    expect(field().activeCountFor(2)).toBe(3);

    // …and emitter 1's timer is running, not dead: eight more frames put it
    // 0.90s past the reset and it fires — exactly once, and no earlier.
    // (Emitter 2's own second shot lands on a frame decided by 0.85 not
    // dividing 0.1 evenly, which is not what this test is about; all that
    // matters here is that clear(1) left its bullets and its timer alone.)
    await renderer.advanceFrames(8, DT);
    expect(field().activeCountFor(1)).toBe(3);
    expect(field().activeCountFor(2)).toBeGreaterThanOrEqual(3);
  });

  it('re-arms only the named emitter\'s reduced-motion snapshot', async () => {
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      // 100 each spends the whole 200 field-wide budget, so the refund is
      // load-bearing: without it the re-armed emitter would find the budget at
      // zero and snapshot nothing at all.
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter {...EMITTER} pattern={burstOf(100, { payload: 10 })} />
        <Emitter {...EMITTER} pattern={burstOf(100, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);
    expect(countsByEmitter(field())).toEqual({ 1: 100, 2: 100 });

    await ReactThreeTestRenderer.act(async () => {
      field().clear(1);
    });
    expect(countsByEmitter(field())).toEqual({ 2: 100 });

    // Emitter 1's guard was re-armed, so it snapshots again — and the budget
    // was refunded exactly what the clear released, so it gets all 100 back
    // rather than finding the allowance already spent. Emitter 2's guard was
    // not touched, so it does not snapshot twice, and the refund was bounded
    // by what was released rather than re-arming the whole field.
    await renderer.advanceFrames(1, DT);
    expect(countsByEmitter(field())).toEqual({ 1: 100, 2: 100 });

    await renderer.advanceFrames(10, DT);
    expect(field().activeCount).toBe(200);
  });
});

// ===========================================================================
// 5. Reentrancy — firing from inside forEachActive
// ===========================================================================

describe('BulletField — reentrancy', () => {
  it('fireAt from inside a forEachActive callback corrupts neither the walk nor attribution', async () => {
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(6), 1);
    });

    // The canonical shape: a hit test that fires a retaliation shot. Decision 1
    // names this as the reason recycle-oldest is disqualified, and the doc says
    // to assert the guarantee rather than assume it.
    const visited: Array<{ payload: number; emitterId: number }> = [];
    field().forEachActive((_i, _pos, payload, emitterId) => {
      visited.push({ payload, emitterId });
      if (payload === 3) {
        field().fireAt(new Vector3(9, 9, 9), burstOf(4, { payload: 500 }), 2);
      }
    });

    // The walk saw the six bullets that were live when it started — each once,
    // none of the four fired mid-walk, and every one under its own id.
    expect(visited).toHaveLength(6);
    expect(visited.map((v) => v.payload).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(visited.every((v) => v.emitterId === 1)).toBe(true);

    // The retaliation shot landed, whole and correctly attributed.
    expect(field().activeCount).toBe(10);
    expect(countsByEmitter(field())).toEqual({ 1: 6, 2: 4 });
    for (const r of census(field()).filter((x) => x.emitterId === 2)) {
      expect(r.payload).toBe(500);
      expect(r.pos).toEqual([9, 9, 9]);
    }
  });

  it('survives consuming and firing in the same callback', async () => {
    // The nastiest ordering: the slot is swap-removed and pushed onto the free
    // stack, then immediately popped again by the reentrant spawn — so the
    // walk's cursor, the dense list, and the new bullet all touch one slot.
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(6), 1);
    });

    const visited: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      visited.push(payload);
      if (payload % 2 === 0) {
        field().fireAt(new Vector3(9, 9, 9), burstOf(1, { payload: 500 }), 2);
        return true; // consume
      }
    });

    expect(visited.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);

    // Three consumed, three fired, three survivors — and the survivors are the
    // odd ones, still emitter 1's, with the newcomers whole and separate.
    expect(field().activeCount).toBe(6);
    expect(countsByEmitter(field())).toEqual({ 1: 3, 2: 3 });
    expect(
      census(field())
        .filter((r) => r.emitterId === 1)
        .map((r) => r.payload)
        .sort((x, y) => x - y),
    ).toEqual([1, 3, 5]);
  });

  it('reports exhaustion from a reentrant fireAt without disturbing the walk', async () => {
    const onPoolExhausted = vi.fn();
    const { field } = await mountBareField({ maxBullets: 6, onPoolExhausted });

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(6), 1);
    });

    const visited: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      visited.push(payload);
      field().fireAt(new Vector3(9, 9, 9), burstOf(2, { payload: 500 }), 2);
    });

    expect(visited.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    // Six reentrant bursts, six callbacks — one each, never one per bullet.
    expect(onPoolExhausted).toHaveBeenCalledTimes(6);
    expect(onPoolExhausted).toHaveBeenCalledWith(2, 2, 0, 'pool-full');
    expect(field().activeCount).toBe(6);
    expect(field().activeCountFor(1)).toBe(6);
  });
});

// ===========================================================================
// 6. Swap-remove — the backwards walk from phase 2, verified in-tree
// ===========================================================================

describe('BulletField — forEachActive visits every live bullet exactly once', () => {
  it('when consuming every bullet', async () => {
    const { field } = await mountBareField();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(8), 1);
    });

    const visited: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      visited.push(payload);
      return true;
    });

    expect(visited).toHaveLength(8);
    expect(new Set(visited).size).toBe(8);
    expect(visited.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(field().activeCount).toBe(0);
  });

  it('when consuming a scattered subset — the forward-walk skip is the failure guarded', async () => {
    // Swap-remove moves the LAST live entry into the vacated position, so a
    // forward walk skips one live bullet per consumption: a silent,
    // load-dependent miss in the consumer's collision pass. The odd/even
    // pattern makes a single miss visible.
    const { field } = await mountBareField();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(8), 1);
    });

    const visited: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      visited.push(payload);
      return payload % 2 === 0;
    });

    expect(visited).toHaveLength(8);
    expect(visited.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(field().activeCount).toBe(4);

    // …and the second pass sees exactly the four survivors, once each.
    const second: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      second.push(payload);
    });
    expect(second.sort((x, y) => x - y)).toEqual([1, 3, 5, 7]);
  });

  it('when the live set is fragmented across two emitters', async () => {
    const { field } = await mountBareField();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, numberedBurst(5), 1);
      field().fireAt(ORIGIN, numberedBurst(5), 2);
    });

    // Consume only emitter 1's. Every one of the ten must still be visited.
    const visited: Array<[number, number]> = [];
    field().forEachActive((_i, _pos, payload, emitterId) => {
      visited.push([emitterId, payload]);
      return emitterId === 1;
    });

    expect(visited).toHaveLength(10);
    expect(visited.filter(([e]) => e === 1)).toHaveLength(5);
    expect(visited.filter(([e]) => e === 2)).toHaveLength(5);
    expect(field().activeCountFor(1)).toBe(0);
    expect(field().activeCountFor(2)).toBe(5);
  });
});

// ===========================================================================
// 7. activeCountFor
// ===========================================================================

describe('BulletField — activeCountFor', () => {
  it('partitions the live set across several emitters and sums to activeCount', async () => {
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(3, { payload: 1 })); // anonymous, id 0
      field().fireAt(ORIGIN, burstOf(5, { payload: 2 }), 1);
      field().fireAt(ORIGIN, burstOf(7, { payload: 3 }), 2);
      field().fireAt(ORIGIN, burstOf(11, { payload: 4 }), 3);
    });

    expect(field().activeCountFor(0)).toBe(3);
    expect(field().activeCountFor(1)).toBe(5);
    expect(field().activeCountFor(2)).toBe(7);
    expect(field().activeCountFor(3)).toBe(11);
    expect(field().activeCount).toBe(26);

    // An id that never fired, and one that was never issued.
    expect(field().activeCountFor(4)).toBe(0);
    expect(field().activeCountFor(-1)).toBe(0);

    // It tracks clears, per emitter.
    await ReactThreeTestRenderer.act(async () => {
      field().clear(2);
    });
    expect(field().activeCountFor(2)).toBe(0);
    expect(field().activeCountFor(3)).toBe(11);
    expect(field().activeCount).toBe(26 - 7);
  });

  it('counts delayed bullets, which forEachActive deliberately skips', async () => {
    // A delayed bullet is invisible to a hit test but still holds a slot, so it
    // must count toward the number a consumer reasons about the pool with.
    const { field } = await mountBareField();

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(4, { payload: 1, delay: 5 }), 1);
      field().fireAt(ORIGIN, burstOf(2, { payload: 2 }), 1);
    });

    expect(field().activeCountFor(1)).toBe(6);
    expect(field().activeCount).toBe(6);
    expect(census(field())).toHaveLength(2); // only the two undelayed are visible
  });
});

// ===========================================================================
// 8. Defaults — one definition, shared by the field and the wrapper
// ===========================================================================

/**
 * Phase 4 moved the fourteen defaults out of `<BulletManager>` and down into
 * `<BulletField>` and `<Emitter>`, so that a public field has usable defaults
 * without the wrapper restating them. The failure mode that replaces is two
 * copies drifting apart — so these tests read the same defaults through **both**
 * doors and require them to agree.
 */
describe('BulletField / Emitter — defaults', () => {
  /** The three.js `InstancedMesh` behind the test-renderer's first scene node. */
  const meshOf = (renderer: Renderer) =>
    renderer.scene.children[0].instance as unknown as {
      geometry: { parameters: { radius: number } };
    };

  it('applies the documented field defaults with no props at all', async () => {
    const renderer = await ReactThreeTestRenderer.create(<BulletField />);

    // maxBullets: the instancedMesh's third `args` entry.
    expect(renderer.scene.children[0].props.args[2]).toBe(2000);
    // bulletRadius: the sphere geometry's radius.
    expect(meshOf(renderer).geometry.parameters.radius).toBeCloseTo(0.12, 6);
  });

  it('reaches the SAME field defaults through <BulletManager>, which restates none of them', async () => {
    const field = await ReactThreeTestRenderer.create(<BulletField />);
    const wrapped = await ReactThreeTestRenderer.create(<BulletManager />);

    expect(wrapped.scene.children[0].props.args[2]).toBe(
      field.scene.children[0].props.args[2],
    );
    expect(meshOf(wrapped).geometry.parameters.radius).toBe(
      meshOf(field).geometry.parameters.radius,
    );
  });

  it('applies the documented emitter defaults: fireRate 1.5 and spawnCenterY 3', async () => {
    // A zero-offset pattern, so a bullet's reported position IS the resolved
    // spawn centre, and only `pattern` is supplied — everything else defaults.
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef}>
        <Emitter pattern={burstOf(2, { payload: 1 })} rotationSpeed={0} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});

    // fireRate 1.5 ⇒ one shot every 0.6667s. Six frames of 0.1s is short of it…
    await renderer.advanceFrames(6, DT);
    expect(field().activeCount).toBe(0);
    // …seven crosses it.
    await renderer.advanceFrames(1, DT);
    expect(field().activeCount).toBe(2);

    // spawnCenterY 3, via the orbit's Y component (rotationSpeed pinned to 0 so
    // X and Z are the orbit's fixed radius rather than a phase).
    for (const r of census(field())) expect(r.pos[1]).toBeCloseTo(3, 6);
  });

  it('applies the default fadeTime of 1 with a linear curve', async () => {
    // A bullet with 0.5s of life left is exactly half-faded under fadeTime 1.
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => <BulletField ref={fieldRef} />;

    const { renderer, field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(new Vector3(0, 0, 0), burstOf(1, { payload: 1, life: 0.6 }));
    });
    await renderer.advanceFrames(1, DT); // 0.5s of life remains

    const mesh = renderer.scene.children[0].instance as unknown as {
      instanceMatrix: { array: ArrayLike<number> };
    };
    const rows = census(field());
    expect(rows).toHaveLength(1);
    // Uniform scale lives in element 0 of the column-major 4×4.
    expect(mesh.instanceMatrix.array[rows[0].index * 16]).toBeCloseTo(0.5, 5);
  });

  it('applies the default boundsLimit of 25', async () => {
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => <BulletField ref={fieldRef} />;

    const { renderer, field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(new Vector3(0, 20, 0), burstOf(1, { payload: 1 }), 1); // inside
      field().fireAt(new Vector3(0, 30, 0), burstOf(1, { payload: 2 }), 2); // outside
    });
    await renderer.advanceFrames(1, DT);

    expect(field().activeCountFor(1)).toBe(1);
    expect(field().activeCountFor(2)).toBe(0);
  });

  it('defaults paused and reducedMotion to false', async () => {
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef}>
        <Emitter fireRate={10} pattern={burstOf(3, { payload: 1 })} rotationSpeed={0} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    // Not paused: auto-fire ran at all.
    expect(field().activeCount).toBe(3);
    // Not reduced motion: the simulation keeps running rather than freezing
    // after one snapshot, so a second shot lands on the next frame.
    await renderer.advanceFrames(1, DT);
    expect(field().activeCount).toBe(6);
  });
});

// ===========================================================================
// 9. releaseSpawnData — the double-release guarantee, without includes()
// ===========================================================================

describe('releaseSpawnData — double-release guard (the includes() replacement)', () => {
  it('never hands two callers the same object after a double release', async () => {
    const p = acquire();
    releaseSpawnData([p]);
    releaseSpawnData([p]); // the double free

    const a = acquire();
    const b = acquire();
    expect(a).not.toBe(b); // aliased pool would return p twice

    releaseSpawnData([a, b]);
  });

  it('holds when a whole burst array is released twice', async () => {
    const burst = [acquire(), acquire(), acquire()];
    releaseSpawnData(burst);
    releaseSpawnData(burst);
    releaseSpawnData(burst); // and a third time for good measure

    const back = [acquire(), acquire(), acquire()];
    expect(new Set(back).size).toBe(3);

    releaseSpawnData(back);
  });

  it('holds across an interleaved release / acquire / release cycle', async () => {
    // The membership index must be cleared when an object LEAVES the pool, or
    // an object recycled once could never be recycled again — the pool would
    // quietly stop recycling and start allocating instead.
    const p = acquire();
    releaseSpawnData([p]);

    const q = acquire();
    expect(q).toBe(p); // came back out

    releaseSpawnData([q]);
    const r = acquire();
    expect(r).toBe(p); // and back out a second time

    releaseSpawnData([r]);
  });

  it('still resets a double-released object on re-acquire', async () => {
    const p = acquire();
    p.scale = 4;
    p.payload = 9;
    p.life = 99;
    releaseSpawnData([p]);
    releaseSpawnData([p]);

    const back = acquire();
    expect(back).toBe(p);
    expect(back.scale).toBe(1);
    expect(back.payload).toBe(0);
    expect(back.life).toBe(5.0);

    releaseSpawnData([back]);
  });

  it('handles a large double-released burst — the case includes() made quadratic', async () => {
    // 2,000 items double-released used to be up to 2,000 × 20,000 identity
    // comparisons. The guarantee under test is unchanged: every object comes
    // back out exactly once.
    const N = 2000;
    const burst: BulletSpawnData[] = [];
    for (let i = 0; i < N; i++) burst.push(acquire());

    releaseSpawnData(burst);
    releaseSpawnData(burst);

    const back = new Set<BulletSpawnData>();
    for (let i = 0; i < N; i++) back.add(acquire());
    expect(back.size).toBe(N); // no object handed out twice

    releaseSpawnData([...back]);
  });
});

// ===========================================================================
// 10. The public handle surface — the runtime half only
// ===========================================================================
//
// The *narrowing* of `BulletFieldHandle` cannot be tested from here, and this
// is deliberately not an attempt to. There is one handle object at runtime —
// it is also the registry context value, and its identity has to stay stable —
// so `register`, `unregister` and `fire` are all still sitting on the object a
// `ref` receives. Only the type hides them, and the type is asserted in
// `src/__tests__/BulletFieldHandle.types.ts`, whose runner is `tsc --noEmit`.
//
// What is worth pinning here is the other half: every member the public type
// promises is actually implemented on the object handed out.

describe('BulletField — the ref carries every member the public type promises', () => {
  it('implements all seven consumer members', async () => {
    const { field } = await mountBareField();
    const handle = field();

    for (const member of [
      'fireAt',
      'clear',
      'acquireEmitter',
      'releaseEmitter',
      'activeCountFor',
      'forEachActive',
    ] as const) {
      expect(typeof handle[member]).toBe('function');
    }
    // `activeCount` is a getter, not a method — the one member that would slip
    // past the loop above.
    expect(typeof handle.activeCount).toBe('number');
  });
});
