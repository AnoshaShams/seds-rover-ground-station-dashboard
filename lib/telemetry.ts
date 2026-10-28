// Telemetry frame format, conventions and formatting helpers.
//
// Frame conventions:
//   Simulator (server/telemetry-server.mjs): x = east, y = north, metres;
//   headingDeg 0 = east, counter-clockwise. The UI shows a compass bearing
//   instead: 0 = north, clockwise positive.
//   Rosbridge odometry (lib/odometry.ts): x, y in the odom frame, where +x is
//   the direction the rover faced at start; headingDeg is the yaw,
//   counter-clockwise from +x. There is no north in this frame.

export interface TelemetryFrame {
  /** Sender's frame counter, null when the source has none (ROS 2 headers) */
  seq: number | null;
  ts: number; // ms since the Unix epoch, set by the sender (may be another clock)
  speed: number; // m/s, negative when reversing (odometry)
  batteryV: number | null; // V, null when the source has no battery data
  x: number; // m
  y: number; // m
  headingDeg: number; // 0 = +x, CCW, [0, 360)
}

export { PAUSE_COMMAND, PAUSE_MS, TARGET_FPS, WATCHDOG_MS } from "@/shared/telemetry-constants.mjs";

export const DEFAULT_TELEMETRY_URL = "ws://localhost:8080";
export const HISTORY_MS = 60_000;
export const TRAIL_MS = 45_000;
/** A gap between samples longer than this is treated as missing data */
export const SAMPLE_GAP_MS = 250;

export const BATTERY_MIN_V = 21.0;
export const BATTERY_MAX_V = 25.2;
export const BATTERY_LOW_V = 22.0;

function finite(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validates one decoded JSON message. Returns null for anything malformed. */
export function parseFrame(raw: unknown): TelemetryFrame | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const seq = finite(record, "seq");
  const ts = finite(record, "ts");
  const speed = finite(record, "speed");
  const batteryV = finite(record, "batteryV");
  const x = finite(record, "x");
  const y = finite(record, "y");
  const headingDeg = finite(record, "headingDeg");

  if (
    seq === null ||
    ts === null ||
    speed === null ||
    batteryV === null ||
    x === null ||
    y === null ||
    headingDeg === null
  ) {
    return null;
  }
  return { seq, ts, speed, batteryV, x, y, headingDeg };
}

function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/** Maths heading (0 = east, CCW) to compass bearing (0 = north, CW) */
export function headingToBearing(headingDeg: number): number {
  return mod(90 - headingDeg, 360);
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function bearingToCardinal(bearingDeg: number): string {
  return CARDINALS[Math.round(mod(bearingDeg, 360) / 45) % 8];
}

export function isBatteryLow(volts: number): boolean {
  return volts < BATTERY_LOW_V;
}

// ---- formatting ----------------------------------------------------------

export const EMPTY = "--";

export function fmtFixed(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? EMPTY : value.toFixed(digits);
}

/** Always carries a sign so the column width does not change */
export function fmtSigned(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined) return EMPTY;
  const text = Math.abs(value).toFixed(digits);
  // Avoid showing "-0.00"
  const isZero = Number(text) === 0;
  return (value < 0 && !isZero ? "-" : "+") + text;
}

/** Any [0, 360) angle as 000.0 to 359.9 (bearing in simulator mode, yaw in odometry mode) */
export function fmtAngle360(deg: number | null | undefined): string {
  return fmtBearing(deg);
}

/** Bearing as 000.0 to 359.9 */
export function fmtBearing(bearingDeg: number | null | undefined): string {
  if (bearingDeg === null || bearingDeg === undefined) return EMPTY;
  let text = bearingDeg.toFixed(1);
  if (text === "360.0") text = "0.0";
  return text.padStart(5, "0");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** HH:MM:SS in UTC */
export function fmtUtc(epochMs: number | null): string {
  if (epochMs === null) return "--:--:--";
  const d = new Date(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** HH:MM:SS.mmm in UTC */
export function fmtUtcMs(epochMs: number): string {
  const d = new Date(epochMs);
  return `${fmtUtc(epochMs)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
}

/** Durations for the log: "640 ms" or "2.04 s" */
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
