"use client";

import { DEFAULT_TELEMETRY_URL, fmtBearing, fmtSigned, headingToBearing } from "@/lib/telemetry";
import { useTelemetry } from "@/lib/useTelemetry";
import { EventLog } from "./EventLog";
import { LinkDropButton } from "./LinkDropButton";
import { MapCanvas } from "./MapCanvas";
import { ReadoutPanel } from "./ReadoutPanel";
import { StatusBar } from "./StatusBar";

const TELEMETRY_URL = process.env.NEXT_PUBLIC_TELEMETRY_URL ?? DEFAULT_TELEMETRY_URL;

export function Dashboard() {
  const { store, snapshot, events, targetFps, sendPause } = useTelemetry(TELEMETRY_URL);
  const f = snapshot.frame;

  return (
    <div className="screen">
      <StatusBar snapshot={snapshot} targetFps={targetFps} />

      <main className="main">
        <section className={`panel map link-${snapshot.link}`} aria-label="Position map">
          <div className="panel-head">
            <h2 className="panel-title">Position</h2>
            <span className="panel-meta">local frame, metres, x east, y north</span>
            <dl className="map-readout num">
              <dt>X</dt>
              <dd>{fmtSigned(f?.x, 2)}</dd>
              <dt>Y</dt>
              <dd>{fmtSigned(f?.y, 2)}</dd>
              <dt>BRG</dt>
              <dd>{fmtBearing(f ? headingToBearing(f.headingDeg) : null)}</dd>
            </dl>
            <LinkDropButton
              socketOpen={snapshot.socket === "open"}
              dropActive={snapshot.dropActive}
              dropRemainingMs={snapshot.dropRemainingMs}
              onDrop={sendPause}
            />
          </div>
          <div className="map-body">
            <MapCanvas store={store} />
          </div>
        </section>

        <ReadoutPanel snapshot={snapshot} store={store} />
      </main>

      <EventLog events={events} />
    </div>
  );
}
