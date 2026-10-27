"use client";

import { memo, type RefObject } from "react";
import { drawTrace, type TraceSpec } from "@/lib/drawTrace";
import { useCanvasLoop } from "@/lib/useCanvasLoop";
import type { TelemetryStore } from "@/lib/useTelemetry";

interface TraceCanvasProps {
  store: RefObject<TelemetryStore>;
  /** Must be a stable object (module constant) */
  spec: TraceSpec;
  label: string;
}

function TraceCanvasImpl({ store, spec, label }: TraceCanvasProps) {
  const canvasRef = useCanvasLoop((ctx, w, h) => {
    const s = store.current;
    drawTrace(ctx, w, h, s.samples, spec, Date.now(), s.link === "lost");
  });

  return (
    <div className="trace">
      <canvas ref={canvasRef} role="img" aria-label={label} />
    </div>
  );
}

export const TraceCanvas = memo(TraceCanvasImpl);
