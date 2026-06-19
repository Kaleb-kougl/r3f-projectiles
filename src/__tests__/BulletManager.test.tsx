import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';

import ReactThreeTestRenderer from '@react-three/test-renderer';
import { BulletManager } from '../BulletManager';
import { BulletManagerHandle } from '../types';

describe('BulletManager', () => {
  it('mounts, initializes the instancedMesh, and allocates the exact maxBullets pool', async () => {
    const renderer = await ReactThreeTestRenderer.create(<BulletManager maxBullets={777} paused />);
    
    const mesh = renderer.scene.children[0];
    expect(mesh).toBeDefined();
    
    // third arg of instancedMesh args is maxBullets: args={[undefined, undefined, maxBullets]}
    expect(mesh.props.args[2]).toBe(777);
  });

  it('provides imperative fire(), clear() and activeCount APIs', async () => {
    let bulletRef: React.RefObject<BulletManagerHandle> | null = null;
    
    const TestComponent = () => {
      const ref = useRef<BulletManagerHandle>(null);
      bulletRef = ref;
      return <BulletManager ref={ref} maxBullets={500} paused={true} pattern="ring" />;
    };

    await ReactThreeTestRenderer.create(<TestComponent />);
    
    expect(bulletRef?.current).toBeDefined();
    expect(bulletRef!.current!.activeCount).toBe(0);

    // Imperatively fire
    await ReactThreeTestRenderer.act(async () => {
      bulletRef!.current!.fire();
    });

    // Ring pattern normally produces 100 bullets
    expect(bulletRef!.current!.activeCount).toBe(100);

    // Imperatively clear
    await ReactThreeTestRenderer.act(async () => {
      bulletRef!.current!.clear();
    });

    expect(bulletRef!.current!.activeCount).toBe(0);
  });

  it('respects paused=true and reducedMotion=true props', async () => {
    let bulletRef: React.RefObject<BulletManagerHandle> | null = null;
    
    const TestComponent = ({ paused = false, reducedMotion = false }) => {
      const ref = useRef<BulletManagerHandle>(null);
      bulletRef = ref;
      return (
        <BulletManager 
          ref={ref} 
          paused={paused} 
          reducedMotion={reducedMotion} 
          maxBullets={500} 
          pattern="ring" 
          fireRate={10} 
        />
      );
    };

    const renderer = await ReactThreeTestRenderer.create(<TestComponent paused={true} />);
    
    // When paused, auto-fire should not occur even if we advance frames
    await renderer.advanceFrames(10, 0.1); 
    expect(bulletRef!.current!.activeCount).toBe(0);

    // Now test reduced motion
    await renderer.update(<TestComponent reducedMotion={true} />);
    
    // Reduced motion spawns a static burst immediately during the frame
    await renderer.advanceFrames(1, 0.1);
    expect(bulletRef!.current!.activeCount).toBeGreaterThan(0);
    const countAfterSpawn = bulletRef!.current!.activeCount;

    // Advance more frames, activeCount should NOT change because animation/life countdown is skipped
    await renderer.advanceFrames(10, 0.1);
    expect(bulletRef!.current!.activeCount).toBe(countAfterSpawn);
  });

  it('handles negative/edge case props: fireRate=0, fireRate<0, boundsLimit<=0', async () => {
    let bulletRef: React.RefObject<BulletManagerHandle> | null = null;
    
    const TestComponent = ({ boundsLimit = 25, fireRate = 1.5, paused = false }) => {
      const ref = useRef<BulletManagerHandle>(null);
      bulletRef = ref;
      return (
        <BulletManager 
          ref={ref} 
          maxBullets={500} 
          fireRate={fireRate} 
          boundsLimit={boundsLimit} 
          paused={paused}
          pattern="ring" 
        />
      );
    };

    // fireRate=0 might result in Infinity interval, so it should not fire automatically
    const renderer = await ReactThreeTestRenderer.create(<TestComponent fireRate={0} />);
    await renderer.advanceFrames(10, 0.1);
    expect(bulletRef!.current!.activeCount).toBe(0);

    // fireRate < 0
    await renderer.update(<TestComponent fireRate={-1} />);
    // With negative fireRate, fireInterval is negative, so timeAccum >= fireInterval is true every frame
    await renderer.advanceFrames(2, 0.1);
    expect(bulletRef!.current!.activeCount).toBeGreaterThan(0);
    
    await renderer.update(<TestComponent paused={true} />); // pause to stop updates
    await ReactThreeTestRenderer.act(async () => {
      bulletRef!.current!.clear();
    });

    // boundsLimit <= 0 should immediately kill any bullets that move
    await renderer.update(<TestComponent boundsLimit={0} paused={false} fireRate={10} />);
    
    // Fire it, but they should die instantly
    await ReactThreeTestRenderer.act(async () => {
      bulletRef!.current!.fire();
    });
    
    // Advance 1 frame with positive delta so it calculates bounds limit
    // Since boundsLimit=0, spawnCenterY=3 means |y| > boundsLimit immediately -> dies.
    await renderer.advanceFrames(1, 0.1);
    expect(bulletRef!.current!.activeCount).toBe(0);
  });

  it('handles dynamic maxBullets re-allocation gracefully', async () => {
    let bulletRef: React.RefObject<BulletManagerHandle> | null = null;
    
    const TestComponent = ({ maxBullets }: { maxBullets: number }) => {
      const ref = useRef<BulletManagerHandle>(null);
      bulletRef = ref;
      return <BulletManager ref={ref} maxBullets={maxBullets} paused={true} pattern="ring" />;
    };

    const renderer = await ReactThreeTestRenderer.create(<TestComponent maxBullets={100} />);
    
    let mesh = renderer.scene.children[0];
    expect(mesh.props.args[2]).toBe(100);

    await ReactThreeTestRenderer.act(async () => {
      bulletRef!.current!.fire();
    });
    expect(bulletRef!.current!.activeCount).toBeGreaterThan(0);

    // Reallocate maxBullets
    await renderer.update(<TestComponent maxBullets={200} />);
    
    mesh = renderer.scene.children[0];
    expect(mesh.props.args[2]).toBe(200);
    
    // Active count should be 0 because the pool array is recreated fresh by the useEffect hook
    expect(bulletRef!.current!.activeCount).toBe(0);
  });

  it('calls onBulletCount callback with active count each frame', async () => {
    const onBulletCount = vi.fn();
    const renderer = await ReactThreeTestRenderer.create(
      <BulletManager maxBullets={500} onBulletCount={onBulletCount} pattern="ring" fireRate={10} />
    );
    
    await renderer.advanceFrames(2, 0.1);
    
    expect(onBulletCount).toHaveBeenCalled();
    expect(typeof onBulletCount.mock.calls[0][0]).toBe('number');
  });

  it('supports custom child material overrides', async () => {
    const renderer = await ReactThreeTestRenderer.create(
      <BulletManager maxBullets={100} paused>
        <meshStandardMaterial emissive="hotpink" emissiveIntensity={2} />
      </BulletManager>
    );


    const material = renderer.scene.findAll((c: { type?: string | ((...args: unknown[]) => unknown) }) => typeof c.type === 'string' && c.type.toLowerCase().includes('material'))[0];
    expect(material).toBeDefined();
    expect(material?.props.emissive).toBe('hotpink');
    expect(material?.props.emissiveIntensity).toBe(2);
  });
});
