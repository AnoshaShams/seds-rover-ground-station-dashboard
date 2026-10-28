// nav_msgs/Odometry (as JSON from rosbridge) to a dashboard TelemetryFrame.
//
// Matches the wheel_odometry node (topic /wheel/odometry, frame_id odom,
// child_frame_id base_footprint):
//   x, y      pose.pose.position, metres in the odom frame
//   yaw       atan2(2*w*z, 1 - 2*z*z) from pose.pose.orientation (planar
//             rotation, only z and w set), degrees normalised to [0, 360)
//   speed     twist.twist.linear.x, m/s, signed (negative when reversing)

import { normalizeDeg, type TelemetryFrame } from "./telemetry";

export interface OdometryFrame {
  frame: TelemetryFrame;
  frameId: string;
  childFrameId: string;
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a nested field, for example at(msg, "pose", "pose", "position") */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function num(value: unknown, ...path: string[]): number | null {
  const v = at(value, ...path);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(value: unknown, ...path: string[]): string {
  const v = at(value, ...path);
  return typeof v === "string" ? v : "";
}

export function yawDegFromQuaternion(z: number, w: number): number {
  return normalizeDeg((Math.atan2(2 * w * z, 1 - 2 * z * z) * 180) / Math.PI);
}

/** Converts the `msg` field of a rosbridge publish op. Returns null if malformed. */
export function odometryToFrame(msg: unknown): OdometryFrame | null {
  const x = num(msg, "pose", "pose", "position", "x");
  const y = num(msg, "pose", "pose", "position", "y");
  const qz = num(msg, "pose", "pose", "orientation", "z");
  const qw = num(msg, "pose", "pose", "orientation", "w");
  const speed = num(msg, "twist", "twist", "linear", "x");
  if (x === null || y === null || qz === null || qw === null || speed === null) return null;

  // ROS 2 header stamp; only used for display of the sender clock, never for latency
  const sec = num(msg, "header", "stamp", "sec") ?? 0;
  const nanosec = num(msg, "header", "stamp", "nanosec") ?? 0;

  return {
    frame: {
      seq: null,
      ts: sec * 1000 + nanosec / 1e6,
      speed,
      batteryV: null,
      x,
      y,
      headingDeg: yawDegFromQuaternion(qz, qw),
    },
    frameId: str(msg, "header", "frame_id"),
    childFrameId: str(msg, "child_frame_id"),
  };
}
