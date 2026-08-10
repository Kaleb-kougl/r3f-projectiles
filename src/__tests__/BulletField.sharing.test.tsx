import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Vector3, type InstancedMesh, type Object3D } from 'three';
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
 * `<BulletField>` — the four claims that only become visible once **several**
 * emitters share one field, and that phases 3c and 4 left observed only
 * indirectly.
 *
 *  - **Sharing** — two emitters at different cadences draw from one pool, so
 *    `activeCount` is their sum, and the whole subtree contributes exactly one
 *    `instancedMesh`. The suite has leaned on both (every helper reaches the
 *    mesh through `scene.children[0]`) without ever asserting either.
 *  - **Service order** (Wiring / decision 6) — registration order, asserted
 *    *directly*: two otherwise-identical emitters against a pool with too few
 *    slots left for both, where the only thing that can decide the winner is
 *    the order they registered in.
 *  - **A remounted emitter lands at the registry tail** (Lifecycle). 3c pinned
 *    the *id* an unmount/remount produces; this pins the **service position**,
 *    which is the half of the claim a consumer can actually feel.
 *  - **Release site 5** — the `maxBullets` reallocation effect, exercised on a
 *    field with several registered emitters and bullets in flight, asserting
 *    the sparse set comes back whole rather than merely that the bullet array
 *    did. `BulletManager.test.tsx:134` covers this at N=1 and can only see
 *    `activeCount === 0`.
 *
 * ---------------------------------------------------------------------------
 * SLOT ASSIGNMENT ORDER IS EXPLICITLY NOT PART OF THE CONTRACT, exactly as in
 * `BulletManager.characterization.test.tsx`, `BulletField.test.tsx` and
 * `BulletField.imperative.test.tsx`. Nothing here asserts which slot index came
 * back. Bullets are identified by `payload` and attributed by `emitterId`; the
 * realloc tests do bound slot indices by the pool's *capacity*, which is a
 * claim about the arrays being resized rather than about assignment order.
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
 * spawns or frees a slot.
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
  rotationSpeed: 0, // no orbit drift: the auto-fire origin is a fixed point
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

/** How many live bullets carry each payload — emitter identity, id-independent. */
function countsByPayload(handle: BulletFieldHandle): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of census(handle)) out[r.payload] = (out[r.payload] ?? 0) + 1;
  return out;
}

/** The real three.js `InstancedMesh` behind the test-renderer's first node. */
function meshOf(renderer: Renderer): InstancedMesh {
  return renderer.scene.children[0].instance as unknown as InstancedMesh;
}

/**
 * Every `InstancedMesh` in the **whole** three.js graph, not just the first
 * scene node — the point of the sharing claim is that there is only one, and
 * a second one hiding deeper in the tree would still be a second draw call.
 */
function instancedMeshesIn(renderer: Renderer): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  const scene = (renderer.scene as unknown as { instance: Object3D }).instance;
  scene.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh) found.push(o as InstancedMesh);
  });
  return found;
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

// ===========================================================================
// 1. Sharing — one pool, one mesh, two cadences
// ===========================================================================

describe('BulletField — sharing one pool and one mesh', () => {
  it('adds two emitters\' bullets into one activeCount that is their sum', async () => {
    // Two cadences that stay exactly in phase with a 0.1s frame: 10/s fires
    // every frame, 5/s every second frame. (1/10 and 1/5 are both exact
    // doubles, and 0.1 + 0.1 === 0.2 exactly, so the schedule is not a
    // floating-point coin toss.)
    const Comp = ({
      fieldRef,
    }: {
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD}>
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(2, { payload: 10 })} />
        <Emitter {...EMITTER} fireRate={5} pattern={burstOf(3, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});
    await renderer.advanceFrames(10, DT);

    // 10 shots × 2 bullets, and 5 shots × 3 bullets, out of ONE 1000-slot pool.
    expect(field().activeCountFor(1)).toBe(20);
    expect(field().activeCountFor(2)).toBe(15);
    expect(countsByPayload(field())).toEqual({ 10: 20, 20: 15 });

    // The claim itself: the field's count is the sum, not the larger, not one
    // emitter's, and not two independent pools reported separately.
    expect(field().activeCount).toBe(35);
    expect(field().activeCount).toBe(
      field().activeCountFor(1) + field().activeCountFor(2),
    );
    expect(census(field())).toHaveLength(35);

    // …and it keeps being the sum as the cadences drift apart.
    await renderer.advanceFrames(10, DT);
    expect(field().activeCountFor(1)).toBe(40);
    expect(field().activeCountFor(2)).toBe(30);
    expect(field().activeCount).toBe(70);
  });

  it('contributes exactly one instancedMesh to the scene graph, whatever the emitter count', async () => {
    // Relied on by every helper in this suite (`scene.children[0]`) and by the
    // design's "one field, one material" rule, but never asserted as such: N
    // emitters must cost N registry entries, not N draw calls.
    const Comp = ({
      n,
      fieldRef,
    }: {
      n: number;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField ref={fieldRef} {...FIELD}>
        {Array.from({ length: n }, (_, i) => (
          <Emitter key={i} {...EMITTER} fireRate={10} pattern={burstOf(2, { payload: i })} />
        ))}
      </BulletField>
    );

    const { renderer, field, render } = await mountField(Comp, { n: 1 });
    expect(instancedMeshesIn(renderer)).toHaveLength(1);

    await render({ n: 5 });
    expect(instancedMeshesIn(renderer)).toHaveLength(1);
    // The mesh is also the only scene node the subtree contributes: an
    // `<Emitter>` renders `null` and the registry provider is not a scene
    // object, so five emitters add five registry entries and nothing else.
    expect(renderer.scene.children).toHaveLength(1);
    expect(instancedMeshesIn(renderer)[0]).toBe(meshOf(renderer));

    // And all five emitters' bullets live in that one mesh's one pool.
    await renderer.advanceFrames(1, DT);
    expect(field().activeCount).toBe(10);
    expect(countsByPayload(field())).toEqual({ 0: 2, 1: 2, 2: 2, 3: 2, 4: 2 });
    expect(meshOf(renderer).instanceMatrix.count).toBe(FIELD.maxBullets);
  });
});

// ===========================================================================
// 2. Service order — registration order, asserted directly
// ===========================================================================

describe('BulletField — service order is registration order', () => {
  it('gives the FIRST-registered emitter the last slots and drops the later one', async () => {
    // The doc is explicit that service order buys exactly one thing: it decides
    // who loses bullets when the shared pool cannot serve everyone. So assert
    // that, directly. The two emitters are identical in every respect that
    // could otherwise break the tie — same cadence, same burst size, same
    // origin — leaving registration order as the only difference between them.
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
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 10 })} />
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 20 })} />
      </BulletField>
    );

    const { renderer, field } = await mountField(Comp, {});

    // Fill 7 of the 10 slots from outside, so exactly 3 remain — fewer than one
    // emitter's burst. A pool with room for neither burst in full is the only
    // situation in which service order is observable at all.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(7, { payload: 99 }), 0);
    });
    expect(field().activeCount).toBe(7);

    await renderer.advanceFrames(1, DT);

    // First-registered takes what is left — all three of it — and the later
    // emitter gets nothing. Not one each, not a split, not last-wins.
    expect(field().activeCountFor(1)).toBe(3);
    expect(field().activeCountFor(2)).toBe(0);
    expect(field().activeCount).toBe(10);
    expect(countsByEmitter(field())).toEqual({ 0: 7, 1: 3 });

    // …and `onPoolExhausted` reports the same order from the other side: the
    // first emitter is short-changed 3-of-4, the second is refused outright.
    expect(onPoolExhausted.mock.calls).toEqual([
      [1, 4, 3, 'pool-full'],
      [2, 4, 0, 'pool-full'],
    ]);

    // Starvation is stable, not alternating: the incumbent keeps winning on
    // every subsequent frame because the pool never gives anything back.
    await renderer.advanceFrames(5, DT);
    expect(field().activeCountFor(2)).toBe(0);
    expect(field().activeCount).toBe(10);
  });
});

// ===========================================================================
// 3. Lifecycle — a remounted emitter lands at the registry TAIL
// ===========================================================================

describe('BulletField — a remounted <Emitter> lands at the registry tail', () => {
  it('serves it last under a full pool, and leaves the survivors in their order', async () => {
    // Four emitters so that "B moved to the tail" and "the survivors kept their
    // relative order" are distinguishable claims: with three, removing the
    // middle one looks identical whether the registry splices or swap-removes.
    //
    // Mount order A B C D; B unmounts and remounts; expected service order is
    // therefore A C D B.
    const onPoolExhausted = vi.fn();
    const Comp = ({
      showB,
      paused,
      fieldRef,
    }: {
      showB: boolean;
      paused: boolean;
      fieldRef: React.RefObject<BulletFieldHandle | null>;
    }) => (
      <BulletField
        ref={fieldRef}
        {...FIELD}
        maxBullets={20}
        paused={paused}
        onPoolExhausted={onPoolExhausted}
      >
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 10 })} />
        {showB ? (
          <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 20 })} />
        ) : null}
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 30 })} />
        <Emitter {...EMITTER} fireRate={10} pattern={burstOf(4, { payload: 40 })} />
      </BulletField>
    );

    // Paused throughout the setup: the frame loop returns above the auto-fire
    // pass, so no cadence accumulates and nothing fires until the pool is
    // primed and the registry is in its final shape.
    const { renderer, field, render } = await mountField(Comp, {
      showB: true,
      paused: true,
    });

    await render({ showB: false, paused: true }); // B unregisters
    await render({ showB: true, paused: true }); // …and re-registers, at the tail

    // Prime: 10 of 20 slots gone, so the four bursts of 4 (16 requested) cannot
    // all be served and the cut lands inside the third emitter served.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(10, { payload: 99 }), 0);
    });

    await render({ showB: true, paused: false });
    await renderer.advanceFrames(1, DT);

    // A whole, C whole, D truncated to 2, B refused. If the remount had put B
    // back where it was, the truncation would have landed on C and D instead.
    expect(countsByPayload(field())).toEqual({ 99: 10, 10: 4, 30: 4, 40: 2 });
    expect(field().activeCount).toBe(20);

    // The same statement in ids, which also shows the remount took a fresh one:
    // A=1, B=2 (retired), C=3, D=4, B'=5.
    expect(countsByEmitter(field())).toEqual({ 0: 10, 1: 4, 3: 4, 4: 2 });
    expect(field().activeCountFor(2)).toBe(0); // B's retired id never fires again
    expect(field().activeCountFor(5)).toBe(0); // B' is last, and gets nothing

    // …and from the reporting side, in service order: D short, then B'.
    expect(onPoolExhausted.mock.calls).toEqual([
      [4, 4, 2, 'pool-full'],
      [5, 4, 0, 'pool-full'],
    ]);
  });
});

// ===========================================================================
// 4. Release site 5 — the maxBullets realloc, on a multi-emitter field
// ===========================================================================

describe('BulletField — maxBullets realloc resets the sparse set (release site 5)', () => {
  /** Three declarative emitters plus room for imperative bullets. */
  const ReallocComp = ({
    maxBullets,
    onPoolExhausted,
    aRef,
    bRef,
    cRef,
    fieldRef,
  }: {
    maxBullets: number;
    onPoolExhausted?: (id: number, requested: number, spawned: number) => void;
    aRef: React.RefObject<EmitterHandle | null>;
    bRef: React.RefObject<EmitterHandle | null>;
    cRef: React.RefObject<EmitterHandle | null>;
    fieldRef: React.RefObject<BulletFieldHandle | null>;
  }) => (
    <BulletField
      ref={fieldRef}
      {...FIELD}
      maxBullets={maxBullets}
      onPoolExhausted={onPoolExhausted}
    >
      <Emitter ref={aRef} {...EMITTER} pattern={burstOf(10, { payload: 10 })} />
      <Emitter ref={bRef} {...EMITTER} pattern={burstOf(10, { payload: 20 })} />
      <Emitter ref={cRef} {...EMITTER} pattern={burstOf(5, { payload: 30, delay: 5 })} />
    </BulletField>
  );

  it('growing: every slot of the NEW capacity is handed out, and none of the old state survives', async () => {
    const onPoolExhausted = vi.fn();
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();
    const cRef = React.createRef<EmitterHandle>();

    const { renderer, field, render } = await mountField(ReallocComp, {
      maxBullets: 100,
      onPoolExhausted,
      aRef,
      bRef,
      cRef,
    });

    // ---- in flight at the moment of the realloc --------------------------
    // Three emitters' worth, one of them delayed (invisible to forEachActive
    // but still holding a slot), plus anonymous imperative bullets: every
    // provenance the field knows about, so nothing can survive by accident.
    await ReactThreeTestRenderer.act(async () => {
      aRef.current!.fire(); // 10
      bRef.current!.fire(); // 10
      cRef.current!.fire(); // 5, delayed
      field().fireAt(ORIGIN, burstOf(35, { payload: 99 }), 0);
    });
    expect(field().activeCount).toBe(60);
    expect(field().activeCountFor(1)).toBe(10);
    expect(field().activeCountFor(3)).toBe(5); // the delayed burst holds slots
    expect(census(field())).toHaveLength(55); // …and is not visible

    const countBefore = meshOf(renderer).count;
    expect(countBefore).toBeGreaterThanOrEqual(60);

    // ---- realloc ---------------------------------------------------------
    await render({ maxBullets: 400, onPoolExhausted, aRef, bRef, cRef });
    expect(renderer.scene.children[0].props.args[2]).toBe(400);

    // Nothing survived — including the delayed bullets, which live in the
    // sparse set rather than in anything `forEachActive` can see.
    expect(field().activeCount).toBe(0);
    expect(census(field())).toEqual([]);
    for (const id of [0, 1, 2, 3]) expect(field().activeCountFor(id)).toBe(0);

    // ---- the whole new capacity is available -----------------------------
    // This is the assertion the N=1 test cannot make. `activeCount === 0` is
    // satisfied by resetting `denseCount` alone; being able to hand out 400
    // slots afterwards requires `free` to have been reallocated at the new size
    // AND `freeTop` reset to it. Miss either and the field silently keeps the
    // old pool's leftover capacity.
    onPoolExhausted.mockClear();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(400, { payload: 1 }), 7);
    });
    expect(field().activeCount).toBe(400);
    expect(onPoolExhausted).not.toHaveBeenCalled();

    // Exactly 400, not more: the 401st bullet is refused.
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(1, { payload: 2 }), 8);
    });
    expect(field().activeCount).toBe(400);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(8, 1, 0, 'pool-full');

    // Every slot handed out indexes the NEW bullet array. (A bound, not an
    // order: a stale `free` stack would hand back indices from the old
    // allocation, which is how this fails in practice.)
    const indices = census(field()).map((r) => r.index);
    expect(Math.min(...indices)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...indices)).toBeLessThan(400);
    expect(new Set(indices).size).toBe(400); // …and no slot twice

    // ---- a full release/reacquire cycle on the fresh arrays --------------
    await ReactThreeTestRenderer.act(async () => {
      field().clear();
    });
    expect(field().activeCount).toBe(0);
    onPoolExhausted.mockClear();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(400, { payload: 3 }), 9);
    });
    expect(field().activeCount).toBe(400);
    expect(onPoolExhausted).not.toHaveBeenCalled();

    // ---- the registry is untouched by the realloc ------------------------
    // Emitters are not pool state: they keep their ids and their handles.
    await ReactThreeTestRenderer.act(async () => {
      field().clear();
      aRef.current!.fire();
      bRef.current!.fire();
    });
    expect(countsByEmitter(field())).toEqual({ 1: 10, 2: 10 });
  });

  it('does not inherit the old allocation\'s high-water mark', async () => {
    // `mesh.count` is driven by the high-water mark, which lives in a sibling
    // ref the array swap does not touch. Left unreset, a field that peaked at
    // 60 keeps running the vertex shader over 60 instances after a realloc
    // leaves it with a handful — the exact cost the mark exists to remove.
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();
    const cRef = React.createRef<EmitterHandle>();

    const { renderer, field, render } = await mountField(ReallocComp, {
      maxBullets: 100,
      aRef,
      bRef,
      cRef,
    });

    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(60, { payload: 99 }), 0);
    });
    const peak = meshOf(renderer).count;
    expect(peak).toBeGreaterThanOrEqual(60);

    await render({ maxBullets: 400, aRef, bRef, cRef });
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(5, { payload: 1 }), 1);
    });

    // Five live bullets cannot need a draw range inherited from a pool that no
    // longer exists. (How far below `peak` it lands depends on slot assignment,
    // which is not contractual — that it is below at all is.)
    expect(field().activeCount).toBe(5);
    expect(meshOf(renderer).count).toBeLessThan(peak);
    expect(meshOf(renderer).count).toBeGreaterThanOrEqual(5);
  });

  it('shrinking: the free stack never hands out a slot past the new capacity', async () => {
    // The direction that fails loudest if the sparse-set arrays are not
    // reallocated: a `free` stack still sized for the old pool pops slot
    // indices the new bullet array does not have.
    const onPoolExhausted = vi.fn();
    const aRef = React.createRef<EmitterHandle>();
    const bRef = React.createRef<EmitterHandle>();
    const cRef = React.createRef<EmitterHandle>();

    const { renderer, field, render } = await mountField(ReallocComp, {
      maxBullets: 100,
      onPoolExhausted,
      aRef,
      bRef,
      cRef,
    });

    await ReactThreeTestRenderer.act(async () => {
      aRef.current!.fire();
      bRef.current!.fire();
      field().fireAt(ORIGIN, burstOf(40, { payload: 99 }), 0);
    });
    expect(field().activeCount).toBe(60);

    await render({ maxBullets: 20, onPoolExhausted, aRef, bRef, cRef });
    expect(renderer.scene.children[0].props.args[2]).toBe(20);
    expect(field().activeCount).toBe(0);

    onPoolExhausted.mockClear();
    await ReactThreeTestRenderer.act(async () => {
      field().fireAt(ORIGIN, burstOf(100, { payload: 1 }), 5);
    });

    // Exactly the new capacity, reported as one truncated burst, with every
    // slot inside the new array's bounds.
    expect(field().activeCount).toBe(20);
    expect(onPoolExhausted).toHaveBeenCalledTimes(1);
    expect(onPoolExhausted).toHaveBeenCalledWith(5, 100, 20, 'pool-full');
    const indices = census(field()).map((r) => r.index);
    expect(indices).toHaveLength(20);
    expect(Math.max(...indices)).toBeLessThan(20);
    expect(new Set(indices).size).toBe(20);

    // The emitters still fire into the smaller pool, and are still refused
    // politely rather than corrupting it.
    await ReactThreeTestRenderer.act(async () => {
      field().clear();
      aRef.current!.fire(); // 10 of 20
      bRef.current!.fire(); // 10 of 20 — exactly full
    });
    expect(countsByEmitter(field())).toEqual({ 1: 10, 2: 10 });
    expect(field().activeCount).toBe(20);
  });
});
