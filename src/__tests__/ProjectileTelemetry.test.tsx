
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { ProjectileTelemetry } from '../ProjectileTelemetry';

describe('ProjectileTelemetry', () => {
  // `ReturnType<typeof vi.spyOn>` collapses spyOn's generics to their
  // constraints — `MockInstance<(...args: unknown[]) => unknown>` — which loses
  // the spied method's real signature and makes `mockImplementation`'s callback
  // parameters `unknown`. Naming the spied signature keeps `cb` a
  // `FrameRequestCallback` and keeps `mockReturnValue` checked.
  let rAFSpy: MockInstance<typeof window.requestAnimationFrame>;
  let cAFSpy: MockInstance<typeof window.cancelAnimationFrame>;
  let getContextSpy: MockInstance<typeof HTMLCanvasElement.prototype.getContext>;

  beforeEach(() => {
    // Spy on animation frame methods
    rAFSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      return 123;
    });
    cAFSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    // Spy on canvas getContext
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D);
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
    // Capture the render loop callback to trigger it manually.
    //
    // `= null` alone would give the declaration a control-flow type of `null`:
    // the only assignment is inside the mock's closure, which TS's flow
    // analysis cannot see, so `if (loopCb)` would narrow to `never` and
    // `loopCb(0)` would not be callable. Widening the initializer to the
    // variable's real domain restores the guard without weakening it — the
    // runtime `not.toBeNull()` check and the `if` are both untouched.
    let loopCb = null as FrameRequestCallback | null;
    rAFSpy.mockImplementation((cb) => {
      loopCb = cb;
      return 456;
    });
    
    const mockFillRect = vi.fn();
    getContextSpy.mockReturnValue({
      fillRect: mockFillRect,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D);

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
    // See the note in test 3 for why the initializer is widened rather than a
    // bare `= null`.
    let loopCb = null as FrameRequestCallback | null;
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
