// Telemetry sources. The dashboard can read either:
//   sim        the local simulator (server/telemetry-server.mjs), default
//   rosbridge  nav_msgs/Odometry through the rosbridge v2 WebSocket protocol
// Chosen with ?source=sim or ?source=rosbridge.

import {
  DEFAULT_ODOM_TOPIC,
  DEFAULT_ROSBRIDGE_URL,
  PAUSE_COMMAND,
  TARGET_FPS,
} from "@/shared/telemetry-constants.mjs";
import { isRecord, odometryToFrame } from "./odometry";
import { DEFAULT_TELEMETRY_URL, parseFrame, type TelemetryFrame } from "./telemetry";

export type SourceKind = "sim" | "rosbridge";

export type SourceMessage =
  | { kind: "frame"; frame: TelemetryFrame; frameId?: string; childFrameId?: string }
  | { kind: "status"; level: string; text: string };

export interface TelemetrySource {
  kind: SourceKind;
  url: string;
  /** One line for the UI and the event log */
  description: string;
  /** Sent every time the socket opens */
  openMessages: string[];
  /** Logged after the open messages are sent, null if there are none */
  openNote: string | null;
  /** Asks the server to hold frames (link drop demo) */
  pauseMessage: string;
  /** One WebSocket text message to a frame or status, null to ignore it */
  decode: (data: string) => SourceMessage | null;
  /** Frames carry a sender sequence number */
  hasSequence: boolean;
  /** Sender timestamps share the browser's clock, so latency is meaningful */
  latencyComparable: boolean;
  /** Minimum spacing of stored trail and trace samples; 0 stores every frame */
  sampleIntervalMs: number;
  /** Positions are in the odom frame (no north) instead of east/north */
  odomFrame: boolean;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function simulatorSource(): TelemetrySource {
  const url = process.env.NEXT_PUBLIC_TELEMETRY_URL ?? DEFAULT_TELEMETRY_URL;
  return {
    kind: "sim",
    url,
    description: `simulator ${url}`,
    openMessages: [],
    openNote: null,
    pauseMessage: PAUSE_COMMAND,
    decode: (data) => {
      const frame = parseFrame(parseJson(data));
      return frame ? { kind: "frame", frame } : null;
    },
    hasSequence: true,
    latencyComparable: true,
    sampleIntervalMs: 0,
    odomFrame: false,
  };
}

function rosbridgeSource(): TelemetrySource {
  const url = process.env.NEXT_PUBLIC_ROSBRIDGE_URL ?? DEFAULT_ROSBRIDGE_URL;
  const topic = process.env.NEXT_PUBLIC_ODOM_TOPIC ?? DEFAULT_ODOM_TOPIC;
  const type = "nav_msgs/msg/Odometry";
  // throttle_rate 0: rosbridge forwards every message. A server-side throttle
  // drops any message younger than the throttle, which turns a 50 Hz topic
  // into 25 Hz at throttle_rate 33. We decimate on our side instead.
  const subscribe = {
    op: "subscribe",
    id: `ground-station:${topic}`,
    topic,
    type,
    throttle_rate: 0,
  };

  return {
    kind: "rosbridge",
    url,
    description: `rosbridge ${url}, ${topic} (${type})`,
    openMessages: [JSON.stringify(subscribe)],
    openNote: `subscribed to ${topic} (${type}, throttle_rate 0)`,
    // Understood by server/fake-rosbridge.mjs only; a real rosbridge rejects it
    pauseMessage: JSON.stringify({ op: PAUSE_COMMAND }),
    decode: (data) => {
      const msg = parseJson(data);
      if (!isRecord(msg)) return null;
      if (msg.op === "status") {
        const level = typeof msg.level === "string" ? msg.level : "info";
        const text = typeof msg.msg === "string" ? msg.msg : JSON.stringify(msg);
        return { kind: "status", level, text };
      }
      if (msg.op !== "publish" || msg.topic !== topic) return null;
      const odom = odometryToFrame(msg.msg);
      return odom
        ? { kind: "frame", frame: odom.frame, frameId: odom.frameId, childFrameId: odom.childFrameId }
        : null;
    },
    hasSequence: false,
    latencyComparable: false,
    sampleIntervalMs: 1000 / TARGET_FPS,
    odomFrame: true,
  };
}

/** Reads ?source= from a query string. Anything other than "rosbridge" is the simulator. */
export function resolveSource(search: string): TelemetrySource {
  const kind = new URLSearchParams(search).get("source");
  return kind === "rosbridge" ? rosbridgeSource() : simulatorSource();
}
