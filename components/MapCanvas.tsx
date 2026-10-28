"use client";

import { memo, useRef, type RefObject } from "react";
import { drawMap, type MapView } from "@/lib/drawMap";
import { useCanvasLoop } from "@/lib/useCanvasLoop";
import type { TelemetryStore } from "@/lib/useTelemetry";

interface MapCanvasProps {
  store: RefObject<TelemetryStore>;
  /** Odom frame: +x is the rover start direction, view fits the trail */
  odomFrame: boolean;
}

function MapCanvasImpl({ store, odomFrame }: MapCanvasProps) {
  const view = useRef<MapView>({ bounds: null });
  const canvasRef = useCanvasLoop((ctx, w, h) => {
    drawMap(ctx, w, h, store.current, Date.now(), performance.now(), {
      odomFrame,
      view: view.current,
    });
  });

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={
        odomFrame
          ? "Rover position map in the odom frame, grid in metres, +x is the rover start direction"
          : "Rover position map, grid in metres, north up"
      }
    />
  );
}

export const MapCanvas = memo(MapCanvasImpl);
