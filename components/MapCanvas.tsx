"use client";

import { memo, type RefObject } from "react";
import { drawMap } from "@/lib/drawMap";
import { useCanvasLoop } from "@/lib/useCanvasLoop";
import type { TelemetryStore } from "@/lib/useTelemetry";

function MapCanvasImpl({ store }: { store: RefObject<TelemetryStore> }) {
  const canvasRef = useCanvasLoop((ctx, w, h) => {
    drawMap(ctx, w, h, store.current, Date.now(), performance.now());
  });

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Rover position map, grid in metres, north up"
    />
  );
}

export const MapCanvas = memo(MapCanvasImpl);
