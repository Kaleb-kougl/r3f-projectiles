import React, { useRef, useMemo, useEffect } from 'react';

export interface ProjectileTelemetryProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A function that returns the current number of active projectiles */
  getCount: () => number;
  /** The maximum expected bullet count for scaling the graph (default: 2000) */
  maxCount?: number;
}

export function ProjectileTelemetry({
  getCount,
  maxCount = 2000,
  style,
  ...rest
}: ProjectileTelemetryProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  // Zero-allocation buffer
  const historySize = 80;
  const history = useMemo(() => new Float32Array(historySize), []);
  const headRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const PR = Math.round(window.devicePixelRatio || 1);
    const WIDTH = 80 * PR;
    const HEIGHT = 48 * PR;
    
    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let rafId: number;
    let lastCount = -1;

    const loop = () => {
      rafId = requestAnimationFrame(loop);

      // Update history
      const count = getCount();
      const head = headRef.current;
      history[head] = count;
      headRef.current = (head + 1) % historySize;

      // Update text directly in DOM to avoid React re-renders while keeping perfectly crisp text
      if (textRef.current && count !== lastCount) {
        textRef.current.textContent = count.toString();
        lastCount = count;
      }

      // Colors mimicking mrdoob stats (Cyan theme)
      const bg = '#002';
      const fg = '#0ff';

      // Clear canvas
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Draw graph
      ctx.fillStyle = fg;
      for (let i = 0; i < historySize; i++) {
        const index = (head + i) % historySize;
        const val = history[index];
        
        // Scale to the full canvas height now that there's no text header
        let barHeight = (val / maxCount) * HEIGHT;
        if (barHeight > HEIGHT) barHeight = HEIGHT; // Clamp
        
        if (barHeight > 0) {
          ctx.fillRect(i * PR, HEIGHT - barHeight, PR, barHeight);
        }
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [getCount, history, maxCount]);

  return (
    <div
      style={{
        zIndex: 20,
        opacity: 0.8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        ...style,
      }}
      {...rest}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '80px', marginBottom: '4px', alignItems: 'flex-end', paddingLeft: '1px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '9px',
            fontWeight: 600,
            letterSpacing: '0.05em',
            color: 'var(--color-text-muted, #8b949e)',
            lineHeight: '1',
          }}
        >
          ENTITIES
        </span>
        <span
          ref={textRef}
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '11px',
            fontWeight: 'bold',
            color: '#0ff',
            lineHeight: '1',
          }}
        >
          0
        </span>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '80px',
          height: '48px',
          backgroundColor: '#002', // match mrdoob stats cyan theme
          borderRadius: '2px',
        }}
      />
    </div>
  );
}
