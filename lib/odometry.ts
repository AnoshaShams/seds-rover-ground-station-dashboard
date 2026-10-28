// nav_msgs/Odometry (as JSON from rosbridge) to a dashboard TelemetryFrame.
// The conversion itself lives in shared/odometry.mjs so scripts/verify.mjs
// tests the same code.

import { convertOdometry } from "@/shared/odometry.mjs";
import type { TelemetryFrame } from "./telemetry";

export { isRecord } from "@/shared/odometry.mjs";

export interface OdometryFrame {
  frame: TelemetryFrame;
  frameId: string;
  childFrameId: string;
}

/** Converts the `msg` field of a rosbridge publish op. Returns null if malformed. */
export function odometryToFrame(msg: unknown): OdometryFrame | null {
  const odom = convertOdometry(msg);
  if (!odom) return null;
  return {
    frame: {
      seq: null,
      ts: odom.stampMs,
      speed: odom.speed,
      batteryV: null,
      x: odom.x,
      y: odom.y,
      headingDeg: odom.yawDeg,
    },
    frameId: odom.frameId,
    childFrameId: odom.childFrameId,
  };
}
