import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectileTelemetry } from '../ProjectileTelemetry';

describe('ProjectileTelemetry', () => {
  let rAFSpy: ReturnType<typeof vi.spyOn>;
  let cAFSpy: ReturnType<typeof vi.spyOn>;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on animation frame methods
    rAFSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return 123;
    });
    cAFSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    // Spy on canvas getContext
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      fillStyle: '',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Memory leak prevention: verifies cancelAnimationFrame is called on unmount', () => {
    const { unmount } = render(<ProjectileTelemetry getCount={() => 10} />);
    
    // Verify requestAnimationFrame was called
    expect(rAFSpy).toHaveBeenCalled();
    const rafId = rAFSpy.mock.results[0].value;
    
    // Unmount the component
    unmount();
    
    // Verify cancelAnimationFrame was called with the correct ID
    expect(cAFSpy).toHaveBeenCalledWith(rafId);
  });

  it('2. Headless environments: degrades gracefully if getContext returns null', () => {
    // Mock getContext to return null (headless / unsupported environment)
    getContextSpy.mockReturnValue(null);
    
    const { container } = render(<ProjectileTelemetry getCount={() => 10} />);
    
    // requestAnimationFrame shouldn't be called if getContext is null
    expect(rAFSpy).not.toHaveBeenCalled();
    
    // It should still render the container and canvas elements without crashing
    expect(container.querySelector('canvas')).toBeDefined();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('3. MaxCount edge cases: prevents division by zero if maxCount=0', () => {
    // Capture the render loop callback to trigger it manually
    let loopCb: FrameRequestCallback | null = null;
    rAFSpy.mockImplementation((cb) => {
      loopCb = cb;
      return 456;
    });
    
    const mockFillRect = vi.fn();
    getContextSpy.mockReturnValue({
      fillRect: mockFillRect,
      fillStyle: '',
    } as any);

    render(<ProjectileTelemetry getCount={() => 100} maxCount={0} />);
    
    // Trigger the animation frame loop
    expect(loopCb).not.toBeNull();
    if (loopCb) loopCb(0);
    
    // Check what was passed to fillRect.
    const fillRectCalls = mockFillRect.mock.calls;
    
    // First call is the background clear (0, 0, WIDTH, HEIGHT)
    expect(fillRectCalls[0]).toEqual([0, 0, 80, 48]); 
    
    // Check that we don't have any calls with NaN
    fillRectCalls.forEach(call => {
      call.forEach(arg => {
        expect(Number.isNaN(arg)).toBe(false);
        expect(arg).not.toBe(Infinity);
      });
    });
  });

  it('4. Negative / NaN entity counts: handles negative values or NaN returned by getCount', () => {
    let loopCb: FrameRequestCallback | null = null;
    rAFSpy.mockImplementation((cb) => {
      loopCb = cb;
      return 789;
    });

    const getCountMock = vi.fn()
      .mockReturnValueOnce(-5) // First frame: negative
      .mockReturnValueOnce(NaN) // Second frame: NaN
      .mockReturnValueOnce(undefined as unknown as number); // Third frame: undefined (invalid)

    render(<ProjectileTelemetry getCount={getCountMock} />);

    const textElement = document.querySelector('span:nth-of-type(2)') as HTMLSpanElement;

    // Execute first frame (count = -5)
    if (loopCb) loopCb(0);
    expect(textElement?.textContent).toBe('0');

    // Execute second frame (count = NaN)
    if (loopCb) loopCb(1);
    expect(textElement?.textContent).toBe('0');

    // Execute third frame (count = undefined)
    if (loopCb) loopCb(2);
    expect(textElement?.textContent).toBe('0');
  });
});
