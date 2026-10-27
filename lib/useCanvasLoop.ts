"use client";

import { useEffect, useRef } from "react";

export type DrawFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/**
 * Runs `draw` on every animation frame with a canvas sized to its CSS box at
 * the device pixel ratio. Drawing code works in CSS pixels.
 */
export function useCanvasLoop(draw: DrawFn) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);

  useEffect(() => {
    drawRef.current = draw;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const loop = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (width > 0 && height > 0) drawRef.current(ctx, width, height);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return canvasRef;
}
