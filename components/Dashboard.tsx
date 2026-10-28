"use client";

import { useEffect, useState } from "react";
import { resolveSource, type TelemetrySource } from "@/lib/sources";
import { fmtAngle360, fmtBearing, fmtSigned, headingToBearing } from "@/lib/telemetry";
import { useTelemetry } from "@/lib/useTelemetry";
import { EventLog } from "./EventLog";
import { LinkDropButton } from "./LinkDropButton";
import { MapCanvas } from "./MapCanvas";
import { ReadoutPanel } from "./ReadoutPanel";
import { StatusBar } from "./StatusBar";

export function Dashboard() {
  // ?source= is only readable in the browser. Until it is read the source is
  // null: the page renders its empty state and no socket is opened, so the
  // simulator is never contacted when rosbridge was asked for.
  const [source, setSource] = useState<TelemetrySource | null>(null);
  useEffect(() => {
    setSource(resolveSource(window.location.search));
  }, []);

  const { store, snapshot, events, targetFps, sendPause } = useTelemetry(source);
  const f = snapshot.frame;
  const odomFrame = source?.odomFrame ?? false;

  return (
    <div className="screen">
      <StatusBar snapshot={snapshot} targetFps={targetFps} rosbridge={source?.kind === "rosbridge"} />

      <main className="main">
        <section className={`panel map link-${snapshot.link}`} aria-label="Position map">
          <div className="panel-head">
            <h2 className="panel-title">Position</h2>
            <span className="panel-meta">
              {odomFrame
                ? "odom frame, x = rover start direction, metres"
                : "local frame, metres, x east, y north"}
            </span>
            <dl className="map-readout num">
              <dt>X</dt>
              <dd>{fmtSigned(f?.x, 2)}</dd>
              <dt>Y</dt>
              <dd>{fmtSigned(f?.y, 2)}</dd>
              <dt>{odomFrame ? "YAW" : "BRG"}</dt>
              <dd>
                {odomFrame
                  ? fmtAngle360(f?.headingDeg)
                  : fmtBearing(f ? headingToBearing(f.headingDeg) : null)}
              </dd>
            </dl>
            <LinkDropButton
              socketOpen={snapshot.socket === "open"}
              dropActive={snapshot.dropActive}
              dropRemainingMs={snapshot.dropRemainingMs}
              onDrop={sendPause}
            />
          </div>
          <div className="map-body">
            <MapCanvas store={store} odomFrame={odomFrame} />
          </div>
        </section>

        <ReadoutPanel snapshot={snapshot} store={store} odomFrame={odomFrame} />
      </main>

      <EventLog events={events} sourceText={source ? source.description : null} />
    </div>
  );
}
