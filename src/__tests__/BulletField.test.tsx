import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Vector3, type InstancedMesh } from 'three';
import {
  BulletField,
  type BulletFieldHandle,
  type BulletFieldProps,
  type EmitterProps,
} from '../BulletField';
import { Emitter, type EmitterHandle } from '../Emitter';
import { acquire } from '../pool';
import type { BulletSpawnData, PatternFactory } from '../types';

/**
 * `<BulletField>` — phase 3c of docs/bulletfield-emitter-split.md.
 *
 * 3a and 3b were byte-identical refactors. 3c is the first step that changes
 * behaviour on purpose, so this file exists to pin the three new behaviours:
 *
 *  - **`emitterId` provenance** (decision 7) — field-issued, starting at 1,
 *    never recycled, surviving its emitter's unregistration.
 *  - **Per-bullet `scale` at BOTH write sites** (decision 2) — the fade line in
 *    the simulate loop, and the spawn-time matrix write that is the *only*
 *    write a reduced-motion or paused bullet ever gets.
 *  - **Decision 5's reduced-motion divergence** — each emitter snapshots from
 *    its own origin, against a field-wide budget that is stateful across
 *    frames.
 *
 * ---------------------------------------------------------------------------
 * SLOT ASSIGNMENT ORDER IS EXPLICITLY NOT PART OF THE CONTRACT, exactly as in
 * `BulletManager.characterization.test.tsx`. Nothing here asserts which slot
 * index came back. Bullets are identified by `payload` and attributed by
 * `emitterId`; a slot index is only ever used as a key into the instance
 * matrix, never compared or ordered.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface BulletSpec {
  payload?: number;
  scale?: number;
  life?: number;
  delay?: number;
}

/**
 * Motionless, effectively immortal bullets spawned exactly at the source
 * position (zero offset). Zero velocity means the simulate loop can never move
 * one out of bounds and a huge default `life` means none expires, so
 * `activeCount` moves only when the code under test spawns or frees a slot.
 *
 * Zero offset also makes the spawn position *equal* to the resolved origin,
 * which is what lets the reduced-motion tests below read an emitter's origin
 * straight back out of `forEachActive`.
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
      d.scale = s.scale ?? 1;
      return d;
    });
}

/** `n` identical motionless bullets, all tagged with the same payload. */
function burstOf(n: number, spec: BulletSpec = {}): PatternFactory {
  return staticBurst(Array.from({ length: n }, () => spec));
}

// `<BulletField>` takes its props required (defaults live in `<BulletManager>`
// until phase 4 decides otherwise), so every test needs a full set.
const FIELD: Omit<BulletFieldProps, 'children'> = {
  maxBullets: 1000,
  boundsLimit: 25,
  bulletRadius: 0.12,
  fadeTime: 0, // no fade unless a test asks for one: scale is then unmultiplied
  fadeCurve: 'linear',
  paused: false,
  reducedMotion: false,
};

// Likewise for `<Emitter>`. A `fireRate` this low cannot auto-fire inside the
// second or two of simulated time any test here advances.
const EMITTER: Omit<EmitterProps, 'pattern'> = {
  fireRate: 0.01,
  spawnCenterY: 3,
  rotationSpeed: 0,
};

const DT = 0.1; // must stay ≤ 0.1: the frame loop clamps to Math.min(delta, 0.1)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

/** The real three.js `InstancedMesh` behind the test-renderer scene node. */
function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

/**
 * The uniform scale three wrote into slot `slot`'s instance matrix.
 *
 * The field only ever writes translation + uniform scale (`_dummy` is never
 * rotated), so element 0 of the column-major 4×4 is the scale factor outright.
 */
function matrixScaleAt(mesh: InstancedMesh, slot: number): number {
  return mesh.instanceMatrix.array[slot * 16];
}

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

/**
 * Mount `Comp`, capturing a `<BulletField>` handle. `render` re-renders the
 * same component with new props, which is how emitters are mounted and
 * unmounted mid-test.
 */
async function mountField<P extends object>(
  Comp: (p: P & { fieldRef: React.RefObject<BulletFieldHandle | null> }) => React.ReactElement,
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

// ===========================================================================
// 1. Provenance — decision 7
// ===========================================================================

describe('BulletField — emitterId provenance (decision 7)', () => {
  const PATTERN_A = burstOf(4, { payload: 10 });
  const PATTERN_B = burstOf(4, { payload: 20 });
  const PATTERN_C = burstOf(4, { payload: 30 });

  it('attributes each bullet to the emitter that fired it, with ids starting at 1', async () => {
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();

    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={aRef} {...EMITTER} pattern={PATTERN_A} />
        <Emitter ref={bRef} {...EMITTER} pattern={PATTERN_B} />
      </BulletField>
    );

    const { field } = await mountField(Comp, {});

    await ReactThreeTestRenderer.act(async () => {
      aRef.current!.fire();
      bRef.current!.fire();
    });

    const rows = census(field());
    expect(rows).toHaveLength(8);

    // Ids are field-issued in registration order, and registration order is
    // JSX order. `0` is reserved for anonymous and must never be issued.
    const idOf = (payload: number) => {
      const ids = new Set(rows.filter((r) => r.payload === payload).map((r) => r.emitterId));
      expect(ids.size).toBe(1); // one emitter's burst is never split across ids
      return [...ids][0];
    };
    expect(idOf(10)).toBe(1);
    expect(idOf(20)).toBe(2);

    expect(countsByEmitter(field())).toEqual({ 1: 4, 2: 4 });
  });

  it('keeps a released emitter\'s in-flight bullets alive and correctly attributed', async () => {
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();

    const Comp = ({
      showB,
      fieldRef,
    }: {
      showB: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={aRef} {...EMITTER} pattern={PATTERN_A} />
        {showB ? <Emitter ref={bRef} {...EMITTER} pattern={PATTERN_B} /> : null}
      </BulletField>
    );

    const { field, render } = await mountField(Comp, { showB: true });

    await ReactThreeTestRenderer.act(async () => {
      aRef.current!.fire();
      bRef.current!.fire();
    });
    expect(countsByEmitter(field())).toEqual({ 1: 4, 2: 4 });

    // Unmounting an <Emitter> IS releaseEmitter. It retires the id and takes
    // the emitter's cadence with it — but deliberately does NOT clear bullets.
    await render({ showB: false });

    expect(field().activeCount).toBe(8);
    expect(countsByEmitter(field())).toEqual({ 1: 4, 2: 4 });
    // Still attributed to 2, not reassigned to the survivor and not zeroed to
    // the anonymous id.
    expect(census(field()).filter((r) => r.payload === 20).every((r) => r.emitterId === 2)).toBe(
      true,
    );
  });

  it('never recycles a retired id — a later emitter is a different emitter', async () => {
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();
    const cRef = React.createRef<EmitterHandle>();

    const Comp = ({
      showB,
      showC,
      fieldRef,
    }: {
      showB: boolean;
      showC: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={aRef} {...EMITTER} pattern={PATTERN_A} />
        {showB ? <Emitter ref={bRef} {...EMITTER} pattern={PATTERN_B} /> : null}
        {showC ? <Emitter ref={cRef} {...EMITTER} pattern={PATTERN_C} /> : null}
      </BulletField>
    );

    const { field, render } = await mountField(Comp, { showB: true, showC: false });

    await ReactThreeTestRenderer.act(async () => {
      bRef.current!.fire();
    });
    expect(countsByEmitter(field())).toEqual({ 2: 4 });

    // B retires; C acquires. If ids recycled, C would be issued 2 and would
    // inherit B's four bullets in flight — the exact break decision 7 exists
    // to prevent.
    await render({ showB: false, showC: true });

    await ReactThreeTestRenderer.act(async () => {
      cRef.current!.fire();
    });

    const counts = countsByEmitter(field());
    expect(counts[2]).toBe(4); // B's orphans, untouched
    expect(counts[3]).toBe(4); // C's own, under a fresh id
    expect(Object.keys(counts).sort()).toEqual(['2', '3']);

    const cId = census(field()).find((r) => r.payload === 30)!.emitterId;
    expect(cId).toBe(3);
    expect(cId).not.toBe(2);
  });

  it('leaves a three-parameter forEachActive callback working untouched', async () => {
    // The fourth argument is additive: JS drops arguments a callback does not
    // declare, so pre-provenance consumer code must be bit-for-bit unaffected.
    const aRef = React.createRef<EmitterHandle>();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={aRef} {...EMITTER} pattern={PATTERN_A} />
      </BulletField>
    );

    const { field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      aRef.current!.fire();
    });

    const payloads: number[] = [];
    field().forEachActive((_i, _pos, payload) => {
      payloads.push(payload);
    });
    expect(payloads).toEqual([10, 10, 10, 10]);

    // …including consumption.
    field().forEachActive(() => true);
    expect(field().activeCount).toBe(0);
  });
});

// ===========================================================================
// 2. Per-bullet scale — decision 2, BOTH write sites
// ===========================================================================

describe('BulletField — per-bullet scale (decision 2)', () => {
  const BIG = 3;
  const SCALED = burstOf(4, { payload: 1, scale: BIG });

  it('multiplies scale into the fade line in the normal simulate path (site 1)', async () => {
    // fadeTime > life so the bullets are mid-fade on the very first frame: the
    // observed matrix scale is then fade × scale and cannot be confused with
    // either factor alone.
    const LIFE = 2;
    const FADE = 4;
    const pattern = burstOf(4, { payload: 1, scale: BIG, life: LIFE });

    const emRef = React.createRef<EmitterHandle>();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} fadeTime={FADE}>
        <Emitter ref={emRef} {...EMITTER} pattern={pattern} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      emRef.current!.fire();
    });
    await renderer.advanceFrames(1, DT);

    // One frame consumed DT of life; linear fade means fade === life / fadeTime.
    const fade = (LIFE - DT) / FADE;
    const expected = fade * BIG;
    expect(fade).toBeLessThan(1); // the fade is genuinely active
    expect(expected).not.toBeCloseTo(BIG, 3); // …so this cannot be site 2's write
    expect(expected).not.toBeCloseTo(fade, 3); // …nor an unscaled fade

    const mesh = meshOf(renderer);
    const rows = census(field());
    expect(rows).toHaveLength(4);
    for (const { index } of rows) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(expected, 4);
    }
  });

  it('writes scale at spawn under reducedMotion — the only path that can see site 2', async () => {
    // Reduced motion spawns above the simulate loop and returns, so the
    // spawn-time matrix write is the ONLY one these bullets ever receive. A
    // hardcoded scale(1,1,1) here makes mod.scale a permanent no-op in exactly
    // the snapshot that has no motion to convey size any other way.
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter {...EMITTER} pattern={SCALED} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    const mesh = meshOf(renderer);
    const rows = census(field());
    expect(rows).toHaveLength(4);
    for (const { index } of rows) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(BIG, 5);
    }

    // And it stays: the field is frozen, so nothing rewrites the matrix.
    await renderer.advanceFrames(10, DT);
    for (const { index } of census(field())) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(BIG, 5);
    }
  });

  it('writes scale at spawn for a fire() while paused — site 2 again', async () => {
    // `paused` returns above the simulate loop too, so for as long as it stays
    // true the spawn write is the whole story.
    const emRef = React.createRef<EmitterHandle>();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={emRef} {...EMITTER} pattern={SCALED} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      emRef.current!.fire();
    });

    const mesh = meshOf(renderer);
    const rows = census(field());
    expect(rows).toHaveLength(4);
    for (const { index } of rows) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(BIG, 5);
    }

    await renderer.advanceFrames(5, DT);
    for (const { index } of census(field())) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(BIG, 5);
    }
  });

  it('leaves the default scale of 1 exactly as it was', async () => {
    const emRef = React.createRef<EmitterHandle>();
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} paused>
        <Emitter ref={emRef} {...EMITTER} pattern={burstOf(3, { payload: 1 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await ReactThreeTestRenderer.act(async () => {
      emRef.current!.fire();
    });

    const mesh = meshOf(renderer);
    for (const { index } of census(field())) {
      expect(matrixScaleAt(mesh, index)).toBeCloseTo(1, 6);
    }
  });
});

// ===========================================================================
// 3. Reduced motion — decision 5
// ===========================================================================

describe('BulletField — reduced motion (decision 5)', () => {
  it('snapshots three emitters once each, from three distinct origins', async () => {
    const originA = { current: new Vector3(5, 0, 0) };
    const originB = { current: new Vector3(0, 5, 0) };
    const originC = { current: new Vector3(0, 0, 5) };

    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter {...EMITTER} origin={originA} pattern={burstOf(4, { payload: 10 })} />
        <Emitter {...EMITTER} origin={originB} pattern={burstOf(4, { payload: 20 })} />
        <Emitter {...EMITTER} origin={originC} pattern={burstOf(4, { payload: 30 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    // Three turrets' worth of bullets, not one.
    expect(field().activeCount).toBe(12);
    expect(countsByEmitter(field())).toEqual({ 1: 4, 2: 4, 3: 4 });

    const at = (id: number, o: Vector3) => {
      for (const r of census(field()).filter((x) => x.emitterId === id)) {
        expect(r.pos[0]).toBeCloseTo(o.x, 6);
        expect(r.pos[1]).toBeCloseTo(o.y, 6);
        expect(r.pos[2]).toBeCloseTo(o.z, 6);
      }
    };
    at(1, originA.current);
    at(2, originB.current);
    at(3, originC.current);

    // Serviced exactly once, then frozen: no growth, no motion.
    await renderer.advanceFrames(20, DT);
    expect(field().activeCount).toBe(12);
    at(1, originA.current);
    at(2, originB.current);
    at(3, originC.current);
  });

  it('truncates the last emitter against the field-wide budget rather than thinning all three', async () => {
    // 3 × 80 = 240 requested against a 200 budget. Registration order decides:
    // the first two are served whole and the third takes the 40 that are left.
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 10 })} />
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 20 })} />
        <Emitter {...EMITTER} pattern={burstOf(80, { payload: 30 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    expect(field().activeCount).toBe(200);
    expect(countsByEmitter(field())).toEqual({ 1: 80, 2: 80, 3: 40 });

    // The budget is spent, not merely capped per call: further frames add none.
    await renderer.advanceFrames(5, DT);
    expect(field().activeCount).toBe(200);
  });

  it('still snapshots an <Emitter> mounted after reduced motion engaged', async () => {
    // The guard is per emitter, and the budget survives across frames, so a
    // late arrival is serviced on a later frame instead of being invisible
    // forever — which is exactly why the cap cannot be a per-call argument.
    const Comp = ({
      showLate,
      fieldRef,
    }: {
      showLate: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter {...EMITTER} pattern={burstOf(10, { payload: 10 })} />
        {showLate ? (
          <Emitter {...EMITTER} spawnCenterY={9} pattern={burstOf(10, { payload: 20 })} />
        ) : null}
      </BulletField>
    );

    const { renderer, field, render } = await mountField(Comp, { showLate: false });
    await renderer.advanceFrames(1, DT);
    expect(countsByEmitter(field())).toEqual({ 1: 10 });

    await render({ showLate: true });
    await renderer.advanceFrames(1, DT);

    // The newcomer got its snapshot; the incumbent did not get a second one.
    expect(field().activeCount).toBe(20);
    expect(countsByEmitter(field())).toEqual({ 1: 10, 2: 10 });
    // …and from its own centre, not the first emitter's.
    for (const r of census(field()).filter((x) => x.emitterId === 2)) {
      expect(r.pos[1]).toBeCloseTo(9, 6);
    }

    await renderer.advanceFrames(10, DT);
    expect(field().activeCount).toBe(20);
  });

  it('re-arms guards and budget when reduced motion toggles off and on again', async () => {
    const Comp = ({
      reducedMotion,
      fieldRef,
    }: {
      reducedMotion: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion={reducedMotion}>
        <Emitter {...EMITTER} pattern={burstOf(150, { payload: 10, life: 0.05 })} />
      </BulletField>
    );

    const { renderer, field, render } = await mountField(Comp, { reducedMotion: true });
    await renderer.advanceFrames(1, DT);
    expect(field().activeCount).toBe(150);

    // A normal frame resets the per-emitter guard and re-arms the budget, and
    // retires the (short-lived) snapshot bullets.
    await render({ reducedMotion: false });
    await renderer.advanceFrames(1, DT);
    expect(field().activeCount).toBe(0);

    await render({ reducedMotion: true });
    await renderer.advanceFrames(1, DT);
    // A full 150 again. A budget that had not been re-armed would sit at 50.
    expect(field().activeCount).toBe(150);
  });

  it('DIVERGENCE: an origin ref wins over the static spawn centre in the snapshot', async () => {
    // Pre-3c, this path was unconditionally `(0, spawnCenterY, 0)` and never
    // read `origin` — so `<BulletManager origin={ref} reducedMotion>`
    // snapshotted at the world origin instead of at the emitter. It now
    // resolves origin exactly as fire() and auto-fire do. This is the one
    // deliberate behavioural divergence in the split.
    const origin = { current: new Vector3(7, 1, -2) };

    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion>
        <Emitter
          {...EMITTER}
          spawnCenterY={3}
          origin={origin}
          pattern={burstOf(4, { payload: 10 })}
        />
        {/* No origin: the static fallback is unchanged, and stays per-emitter. */}
        <Emitter {...EMITTER} spawnCenterY={3} pattern={burstOf(4, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(1, DT);

    const rows = census(field());
    expect(rows).toHaveLength(8);

    for (const r of rows.filter((x) => x.emitterId === 1)) {
      expect(r.pos).toEqual([7, 1, -2]); // at the emitter…
      expect(r.pos).not.toEqual([0, 3, 0]); // …not at the world origin
    }
    for (const r of rows.filter((x) => x.emitterId === 2)) {
      expect(r.pos).toEqual([0, 3, 0]);
    }
  });
});

// ===========================================================================
// 4. Field-wide clear()
// ===========================================================================

describe('BulletField — field-wide clear()', () => {
  // Deliberately not a multiple of DT, so every assertion sits clear of the
  // firing threshold rather than on top of it.
  const FIRE_INTERVAL = 0.85;
  const CADENCE = 1 / FIRE_INTERVAL;

  it('resets cadence, reduced-motion guards, and the shared budget together', async () => {
    const Comp = ({
      reducedMotion,
      fieldRef,
    }: {
      reducedMotion: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD} reducedMotion={reducedMotion}>
        <Emitter {...EMITTER} fireRate={CADENCE} pattern={burstOf(150, { payload: 10 })} />
        <Emitter {...EMITTER} fireRate={CADENCE} pattern={burstOf(150, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field, render } = await mountField(Comp, { reducedMotion: false });

    // ---- (a) cadence ------------------------------------------------------
    await renderer.advanceFrames(8, DT); // 0.80s — just short of the first shot
    expect(field().activeCount).toBe(0);

    await ReactThreeTestRenderer.act(async () => {
      field().clear();
    });

    // Another 0.80s. Un-reset, both timers would stand at 1.60s and would have
    // fired five frames ago.
    await renderer.advanceFrames(8, DT);
    expect(field().activeCount).toBe(0);

    // …and the timers are running, not dead: one more frame crosses 0.85s and
    // BOTH emitters fire, so clear() reset every registered entry, not just the
    // first.
    await renderer.advanceFrames(1, DT);
    expect(countsByEmitter(field())).toEqual({ 1: 150, 2: 150 });

    await ReactThreeTestRenderer.act(async () => {
      field().clear();
    });
    expect(field().activeCount).toBe(0);

    // ---- (b) reduced-motion guards AND (c) the shared budget --------------
    await render({ reducedMotion: true });
    await renderer.advanceFrames(1, DT);
    // 300 requested against the 200 budget: 150 + 50, the second truncated.
    expect(countsByEmitter(field())).toEqual({ 1: 150, 2: 50 });

    await ReactThreeTestRenderer.act(async () => {
      field().clear();
    });
    expect(field().activeCount).toBe(0);

    await renderer.advanceFrames(1, DT);
    // Identical to the first snapshot. A clear() that reset the guards but not
    // the budget would spawn 0 (budget already spent); one that reset the
    // budget but not the guards would also spawn 0 (both emitters skipped). The
    // exact 150/50 split is what shows the budget came back at a full 200
    // rather than at some leftover.
    expect(countsByEmitter(field())).toEqual({ 1: 150, 2: 50 });

    // ---- ids are NOT reset by clear() -------------------------------------
    // clear() destroys bullets, not identities.
    expect(Object.keys(countsByEmitter(field())).sort()).toEqual(['1', '2']);
  });
});
