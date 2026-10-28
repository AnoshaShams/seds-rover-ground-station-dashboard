import type { RefObject } from "react";
import type { TraceSpec } from "@/lib/drawTrace";
import {
  BATTERY_LOW_V,
  BATTERY_MAX_V,
  BATTERY_MIN_V,
  EMPTY,
  bearingToCardinal,
  fmtAngle360,
  fmtBearing,
  fmtFixed,
  fmtSigned,
  headingToBearing,
  isBatteryLow,
} from "@/lib/telemetry";
import type { TelemetrySnapshot, TelemetryStore } from "@/lib/useTelemetry";
import { TraceCanvas } from "./TraceCanvas";

const SPEED_TRACE: TraceSpec = {
  value: (s) => s.speed,
  min: 0,
  max: 1,
  maxStep: 0.5,
  digits: 1,
};

const BATTERY_TRACE: TraceSpec = {
  value: (s) => s.batteryV,
  min: BATTERY_MIN_V,
  max: BATTERY_MAX_V,
  digits: 1,
  threshold: { value: BATTERY_LOW_V, label: `LOW ${BATTERY_LOW_V.toFixed(1)}` },
};

interface RowProps {
  label: string;
  value: string;
  unit: string;
  note?: string;
  caption?: string;
}

function Row({ label, value, unit, note, caption }: RowProps) {
  return (
    <div className="row">
      <span className="row-head">
        <span className="row-label">{label}</span>
        {note ? <span className="row-note">{note}</span> : null}
      </span>
      <span className="row-value num">{value}</span>
      <span className="row-unit">{unit}</span>
      {caption ? <span className="row-caption">{caption}</span> : null}
    </div>
  );
}

function stateText(snapshot: TelemetrySnapshot): string {
  if (snapshot.link === "awaiting") return "AWAITING TELEMETRY";
  if (snapshot.link === "lost") return "LINK LOST, VALUES HELD";
  return "LIVE";
}

interface ReadoutPanelProps {
  snapshot: TelemetrySnapshot;
  store: RefObject<TelemetryStore>;
  /** Odometry source: odom frame positions, yaw instead of bearing, no battery */
  odomFrame: boolean;
}

export function ReadoutPanel({ snapshot, store, odomFrame }: ReadoutPanelProps) {
  const f = snapshot.frame;
  const bearing = f ? headingToBearing(f.headingDeg) : null;
  const volts = f ? f.batteryV : null;
  const low = volts !== null && isBatteryLow(volts);
  const fillPct =
    volts !== null
      ? Math.min(100, Math.max(0, ((volts - BATTERY_MIN_V) / (BATTERY_MAX_V - BATTERY_MIN_V)) * 100))
      : 0;
  const thresholdPct = ((BATTERY_LOW_V - BATTERY_MIN_V) / (BATTERY_MAX_V - BATTERY_MIN_V)) * 100;

  return (
    <section className={`panel readouts link-${snapshot.link}`} aria-label="Telemetry readouts">
      <div className="panel-head">
        <h2 className="panel-title">Telemetry</h2>
        <span className={`panel-state state-${snapshot.link}`}>{stateText(snapshot)}</span>
      </div>

      <div className="readout-body">
        <div className="group">
          <Row
            label="Speed"
            value={odomFrame ? fmtSigned(f?.speed, 2) : fmtFixed(f?.speed, 2)}
            unit="m/s"
            note={odomFrame ? "negative when reversing" : undefined}
          />
          <TraceCanvas store={store} spec={SPEED_TRACE} label="Speed, last 60 seconds" />
        </div>

        {odomFrame ? (
          <div className="group">
            <Row label="Battery" value={EMPTY} unit="V" />
            <div className="battery-status">
              <span className="row-label">Status</span>
              <span className="status-word is-unavailable">UNAVAILABLE</span>
              <span className="battery-rule">no battery data on this source</span>
            </div>
          </div>
        ) : (
        <div className="group">
          <Row label="Battery" value={fmtFixed(f?.batteryV, 2)} unit="V" />
          <div className="battery">
            <div className="battery-bar num">
              <span>{BATTERY_MIN_V.toFixed(1)}</span>
              <div className="battery-track">
                <div
                  className={`battery-fill ${f ? (low ? "is-low" : "is-ok") : ""}`}
                  style={{ width: `${fillPct}%` }}
                />
                <div className="battery-mark" style={{ left: `${thresholdPct}%` }} />
              </div>
              <span>{BATTERY_MAX_V.toFixed(1)} V</span>
            </div>
            <div className="battery-status">
              <span className="row-label">Status</span>
              <span className={`status-word ${volts !== null ? (low ? "is-low" : "is-ok") : ""}`}>
                {volts !== null ? (low ? "LOW" : "NOMINAL") : EMPTY}
              </span>
              <span className="battery-rule">LOW below {BATTERY_LOW_V.toFixed(1)} V</span>
            </div>
          </div>
          <TraceCanvas store={store} spec={BATTERY_TRACE} label="Battery voltage, last 60 seconds" />
        </div>
        )}

        <div className="group">
          <Row
            label="Position X"
            value={fmtSigned(f?.x, 2)}
            unit="m"
            note={odomFrame ? "start direction" : "east"}
          />
          <Row
            label="Position Y"
            value={fmtSigned(f?.y, 2)}
            unit="m"
            note={odomFrame ? "left of start" : "north"}
          />
        </div>

        <div className="group">
          {odomFrame ? (
            <Row
              label="Heading"
              value={fmtAngle360(f?.headingDeg)}
              unit="deg"
              caption="yaw, counter-clockwise from start direction"
            />
          ) : (
            <Row
              label="Heading"
              value={fmtBearing(bearing)}
              unit="deg"
              note={bearing === null ? undefined : bearingToCardinal(bearing)}
              caption="bearing, clockwise from north"
            />
          )}
        </div>
      </div>
    </section>
  );
}
