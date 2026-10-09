import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { Vector3 } from 'three';
import { BulletField, type BulletFieldHandle } from '../BulletField';
import { createBulletSimulation, type BulletSimulation } from '../core';
import { gen, mod, compose, createSeededRandom } from '../patterns';
import { definePayload } from '../payload';

/**
 * Determinism of the headless core, and "exactly one implementation":
 *
 *  1. two simulations fed the same call sequence hold bit-identical state;
 *  2. rendering a simulation through `<BulletField simulation>` — under any
 *     frame grouping, with or without interpolation — never feeds back into
 *     it: its hash matches a simulation no renderer ever touched;
 *  3. a field that OWNS its bullets, in manual mode, ends a script in exactly
 *     the state a headless simulation fed the same script ends in — same
 *     slots, same doubles — because it is the same code.
 */

const DT = 1 / 60;
const Shot = definePayload({ hp: 3, tag: 4 });

/** A deterministic, sequenced, accelerated pattern with a payload. */
const fan = () =>
  compose(
    gen.arc(7, Math.PI / 3, 4),
    mod.accelerate(0.5, 0.2),
    mod.sequence(0.01),
    mod.payload(Shot.pack({ hp: 2, tag: 1 })),
  );

/**
 * The surface the script needs. A field handle has it, and a simulation is
 * assignable to it (its `fireAt` / `clear` return counts the handle's do not).
 */
type Driver = Pick<
  BulletFieldHandle,
  'fireAt' | 'forEachActive' | 'setPayload' | 'clear' | 'acquireEmitter' | 'releaseEmitter'
>;

/**
 * The "input log": per tick, maybe fire from a moving origin (seeded galaxy
 * included), step, then a collision pass that consumes and rewrites payloads,
 * with an emitter dying mid-way. `step` and `frame` are injected so each
 * consumer can be driven its own way.
 */
async function script(
  d: Driver,
  step: (dt: number) => void,
  frame: (tick: number) => Promise<void> | void,
): Promise<void> {
  const rng = createSeededRandom(2024);
  const galaxy = () => compose(gen.galaxy(30, 2, 3, 2, rng), mod.payload(Shot.pack({ hp: 1, tag: 3 })));
  const boss = d.acquireEmitter();
  const turret = d.acquireEmitter();
  const origin = new Vector3();
  for (let tick = 0; tick < 150; tick++) {
    origin.set(Math.sin(tick * 0.07) * 2, 0, tick * 0.004);
    if (tick % 6 === 0) d.fireAt(origin, fan, boss);
    if (tick % 25 === 0) d.fireAt(origin, galaxy, turret);
    if (tick === 90) {
      d.clear(turret);
      d.releaseEmitter(turret);
    }
    step(DT);
    d.forEachActive((i, pos, payload) => {
      if (pos.z <= 1.2) return;
      const hp = Shot.get(payload, 'hp');
      if (hp <= 1) return true;
      d.setPayload(i, Shot.with(payload, 'hp', hp - 1));
    });
    await frame(tick);
  }
}

function headless(): BulletSimulation {
  return createBulletSimulation({ maxBullets: 600, boundsLimit: 6, fadeTime: 0.3, interpolation: true });
}

async function playHeadless(): Promise<{ sim: BulletSimulation; state: number[] }> {
  const sim = headless();
  await script(sim, (dt) => sim.step(dt), () => {});
  const state: number[] = [];
  sim.writeStateHash(state);
  return { sim, state };
}

type Renderer = Awaited<ReturnType<typeof ReactThreeTestRenderer.create>>;

// ===========================================================================
// 1. Same calls, same state
// ===========================================================================

describe('BulletSimulation — determinism', () => {
  it('two simulations fed the same call sequence agree bit-for-bit', async () => {
    const a = await playHeadless();
    const b = await playHeadless();

    expect(a.sim.activeCount).toBeGreaterThan(10);
    expect(a.state.length).toBe(10 * a.sim.activeCount);
    // `toEqual` would treat -0 and 0 alike; the claim is bits, so Object.is.
    expect(a.state.length).toBe(b.state.length);
    for (let k = 0; k < a.state.length; k++) expect(Object.is(a.state[k], b.state[k])).toBe(true);
    expect(a.sim.hashState()).toBe(b.sim.hashState());
    // The collision pass really did rewrite payloads, so that path is covered.
    let wounded = 0;
    a.sim.forEachActive((_i, _p, payload) => {
      if (Shot.get(payload, 'hp') === 1 && Shot.get(payload, 'tag') === 1) wounded++;
    });
    expect(wounded).toBeGreaterThan(0);
  });

  it('a single differing input changes the hash', async () => {
    const a = await playHeadless();
    const b = headless();
    await script(b, (dt) => b.step(dt), (tick) => {
      if (tick !== 140) return;
      let nudged = false; // one bullet's payload, once, near the end
      b.forEachActive((i, _p, payload) => {
        if (nudged) return;
        nudged = true;
        b.setPayload(i, Shot.with(payload, 'tag', 15));
      });
      expect(nudged).toBe(true);
    });
    expect(b.hashState()).not.toBe(a.sim.hashState());
  });
});

// ===========================================================================
// 2. Rendering never feeds back, however frames group the steps
// ===========================================================================

describe('<BulletField simulation> — rendering does not perturb the simulation', () => {
  it('matches a never-rendered simulation under several frame groupings, with interpolation', async () => {
    const reference = await playHeadless();

    const groupings: Array<(tick: number) => boolean> = [
      () => true, // a frame per tick
      (t) => t % 3 === 2, // three ticks per frame
      (t) => t % 7 === 0 || t % 11 === 0, // ragged
      () => false, // never rendered mid-script
    ];
    for (const [g, frameAfter] of groupings.entries()) {
      const sim = headless();
      let alpha = 0;
      const renderer: Renderer = await ReactThreeTestRenderer.create(
        <BulletField
          simulation={sim}
          orient={g % 2 === 0 ? 'velocity' : 'none'}
          interpolate={() => alpha}
        />,
      );
      await script(sim, (dt) => sim.step(dt), async (tick) => {
        if (!frameAfter(tick)) return;
        alpha = (tick % 5) / 5;
        await renderer.advanceFrames(1, 0.016);
      });
      await renderer.advanceFrames(2, 0.016);

      const state: number[] = [];
      sim.writeStateHash(state);
      expect(state.length).toBe(reference.state.length);
      for (let k = 0; k < state.length; k++) expect(Object.is(state[k], reference.state[k])).toBe(true);
      expect(sim.hashState()).toBe(reference.sim.hashState());
      await renderer.unmount();
    }
  });
});

// ===========================================================================
// 3. One implementation: an owned field IS the core
// ===========================================================================

describe('an owned <BulletField> runs the same simulation as the headless core', () => {
  it('ends the same script in the same slots with the same doubles', async () => {
    const reference = await playHeadless();

    let ref: React.RefObject<BulletFieldHandle | null> | null = null;
    const Wrapper = () => {
      const r = useRef<BulletFieldHandle | null>(null);
      ref = r;
      return <BulletField ref={r} stepMode="manual" maxBullets={600} boundsLimit={6} fadeTime={0.3} />;
    };
    const renderer = await ReactThreeTestRenderer.create(<Wrapper />);
    const field = ref!.current!;
    await script(field, (dt) => field.step(dt), async (tick) => {
      if (tick % 4 === 0) await renderer.advanceFrames(1, 0.016);
    });

    type Row = [number, number, number, number, number, number];
    const rows = (walk: Driver['forEachActive']): Row[] => {
      const out: Row[] = [];
      walk((i, p, payload, id) => {
        out.push([i, p.x, p.y, p.z, payload, id]);
      });
      return out.sort((a, b) => a[0] - b[0]);
    };
    const mine = rows((cb) => field.forEachActive(cb));
    const theirs = rows((cb) => reference.sim.forEachActive(cb));

    expect(field.activeCount).toBe(reference.sim.activeCount);
    expect(mine.length).toBeGreaterThan(10);
    expect(mine.length).toBe(theirs.length);
    for (let r = 0; r < mine.length; r++) {
      for (let k = 0; k < 6; k++) expect(Object.is(mine[r][k], theirs[r][k])).toBe(true);
    }
  });
});
