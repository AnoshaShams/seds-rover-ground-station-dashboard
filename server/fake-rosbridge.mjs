/**
 * Fake rosbridge server (WebSocket, port 9090) for testing the dashboard's
 * rosbridge mode without ROS 2.
 *
 * On the real system, the wheel_odometry node (giyan-odometry) publishes
 * nav_msgs/Odometry on /wheel/odometry, one message per /joint_states message,
 * and rosbridge_server forwards it to WebSocket clients using the rosbridge v2
 * protocol. This script stands in for both. It is not a general rosbridge:
 *
 *   {"op":"subscribe","topic":"/wheel/odometry","type":"nav_msgs/msg/Odometry",
 *    "throttle_rate":0}       starts publish messages for that topic
 *   {"op":"unsubscribe", ...}  stops them
 *   {"op":"pause"}             NOT part of rosbridge: holds all publishing for
 *                              PAUSE_MS (2 s) so the dashboard's link-drop
 *                              button works in this mode too
 *   anything else              answered with a {"op":"status","level":"error"}
 *
 * Messages replay the fake_joint_states demo through the odometry maths:
 *   50 Hz; straight at 0.3 m/s for 5 s, then turn on the spot at 0.5 rad/s for
 *   5 s, repeating. frame_id "odom", child_frame_id "base_footprint". The first
 *   message the node publishes has zero pose and velocity (baseline), as in
 *   odometry_core.py. Pose is integrated with the midpoint heading and the yaw
 *   is normalised to [-pi, pi]; orientation is (0, 0, sin(yaw/2), cos(yaw/2)).
 *   Header stamps are ROS 2 style { sec, nanosec } from this machine's clock.
 *   Covariance matches odometry_node.py (1e-3 x/y, 1e-2 yaw).
 *
 * Velocities here are exact. The real node computes them from timestamp gaps,
 * so its speeds jitter slightly around 0.3 m/s; that is not reproduced.
 *
 * Usage: npm run sim:rosbridge   (set the PORT env var to use a different port)
 */

import { WebSocketServer, WebSocket } from "ws";
import { DEFAULT_ODOM_TOPIC, PAUSE_COMMAND, PAUSE_MS } from "../shared/telemetry-constants.mjs";

const PORT = Number(process.env.PORT ?? 9090);
const TOPIC = DEFAULT_ODOM_TOPIC;
const ACCEPTED_TYPES = new Set(["nav_msgs/msg/Odometry", "nav_msgs/Odometry"]);
const RATE_HZ = 50;
const TICK_MS = 1000 / RATE_HZ;

// fake_joint_states.py defaults
const SPEED = 0.3; // m/s, straight phase
const TURN_RATE = 0.5; // rad/s, turn phase
const PHASE_SECONDS = 5.0;

// ---- odometry state (as odometry_core.py would produce it) ---------------

const odom = { x: 0, y: 0, theta: 0, v: 0, omega: 0 };
let demoTime = 0; // seconds since start, advanced by a fixed 1/RATE_HZ per tick
let hasBaseline = false;

function normalizeAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function advance() {
  const dt = 1 / RATE_HZ;
  const straight = Math.floor(demoTime / PHASE_SECONDS) % 2 === 0;
  const v = straight ? SPEED : 0;
  const omega = straight ? 0 : TURN_RATE;
  demoTime += dt;

  // First message: baseline only, pose and velocity stay zero
  if (!hasBaseline) {
    hasBaseline = true;
    return;
  }

  const dCenter = v * dt;
  const dTheta = omega * dt;
  const mid = odom.theta + dTheta / 2; // midpoint heading
  odom.x += dCenter * Math.cos(mid);
  odom.y += dCenter * Math.sin(mid);
  odom.theta = normalizeAngle(odom.theta + dTheta);
  odom.v = v;
  odom.omega = omega;
}

function covariance() {
  const c = new Array(36).fill(0);
  c[0] = 1e-3;
  c[7] = 1e-3;
  c[35] = 1e-2;
  return c;
}

function odometryMessage() {
  const ms = Date.now();
  return {
    header: {
      stamp: { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 },
      frame_id: "odom",
    },
    child_frame_id: "base_footprint",
    pose: {
      pose: {
        position: { x: odom.x, y: odom.y, z: 0 },
        orientation: { x: 0, y: 0, z: Math.sin(odom.theta / 2), w: Math.cos(odom.theta / 2) },
      },
      covariance: covariance(),
    },
    twist: {
      twist: {
        linear: { x: odom.v, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: odom.omega },
      },
      covariance: covariance(),
    },
  };
}

// ---- rosbridge protocol ---------------------------------------------------

/** Per client: subscription id -> { topic, throttleMs, lastSent } */
const subscriptions = new Map();
let pausedUntil = 0;

function sendStatus(ws, level, msg, id) {
  const status = { op: "status", level, msg };
  if (id !== undefined) status.id = id;
  ws.send(JSON.stringify(status));
}

function handle(ws, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    sendStatus(ws, "error", "Unable to load the JSON message");
    return;
  }
  if (typeof msg !== "object" || msg === null || typeof msg.op !== "string") {
    sendStatus(ws, "error", "Received a message without an op");
    return;
  }

  const subs = subscriptions.get(ws);
  const id = typeof msg.id === "string" ? msg.id : `sub:${msg.topic}`;

  switch (msg.op) {
    case "subscribe": {
      if (msg.type !== undefined && !ACCEPTED_TYPES.has(msg.type)) {
        sendStatus(ws, "error", `subscribe: type ${msg.type} does not match ${TOPIC} (nav_msgs/msg/Odometry)`, msg.id);
        return;
      }
      if (msg.topic !== TOPIC) {
        sendStatus(ws, "warning", `fake rosbridge only publishes ${TOPIC}; ${msg.topic} will receive nothing`, msg.id);
        return;
      }
      const throttleMs = Number.isFinite(msg.throttle_rate) ? Math.max(0, msg.throttle_rate) : 0;
      subs.set(id, { topic: msg.topic, throttleMs, lastSent: 0 });
      console.log(`[rosbridge] subscribe ${msg.topic} (throttle_rate ${throttleMs})`);
      return;
    }
    case "unsubscribe":
      subs.delete(id);
      console.log(`[rosbridge] unsubscribe ${msg.topic ?? id}`);
      return;
    case PAUSE_COMMAND:
      pausedUntil = Date.now() + PAUSE_MS;
      console.log(`[rosbridge] "${PAUSE_COMMAND}" received, holding publishing for ${PAUSE_MS} ms`);
      return;
    default:
      sendStatus(ws, "error", `fake rosbridge does not support op "${msg.op}"`, msg.id);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  subscriptions.set(ws, new Map());
  console.log(`[rosbridge] client connected (${req.socket.remoteAddress}), ${wss.clients.size} total`);
  ws.on("message", (data, isBinary) => {
    if (!isBinary) handle(ws, data.toString());
  });
  ws.on("close", () => {
    subscriptions.delete(ws);
    console.log(`[rosbridge] client disconnected, ${wss.clients.size} remaining`);
  });
  ws.on("error", (err) => console.warn(`[rosbridge] client error: ${err.message}`));
});

wss.on("listening", () => {
  console.log(`[rosbridge] fake rosbridge on ws://localhost:${PORT}, ${TOPIC} at ${RATE_HZ} Hz`);
});

wss.on("error", (err) => {
  console.error(`[rosbridge] server error: ${err.message}`);
  process.exit(1);
});

function tick() {
  advance();
  const now = Date.now();
  if (now < pausedUntil) return;

  const payload = JSON.stringify({ op: "publish", topic: TOPIC, msg: odometryMessage() });
  for (const [ws, subs] of subscriptions) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // One copy per client, respecting the smallest throttle among its subscriptions
    let due = false;
    for (const sub of subs.values()) {
      if (sub.topic === TOPIC && now - sub.lastSent >= sub.throttleMs) {
        sub.lastSent = now;
        due = true;
      }
    }
    if (due) ws.send(payload);
  }
}

// Same wall-clock scheduling as the simulator: setInterval on Windows runs
// slow because of its ~15.6 ms timer resolution.
let nextTickAt = performance.now();
let timer;

function schedule() {
  nextTickAt += TICK_MS;
  const now = performance.now();
  if (now - nextTickAt > 1000) nextTickAt = now;
  timer = setTimeout(() => {
    tick();
    schedule();
  }, Math.max(0, nextTickAt - now));
}

schedule();

function shutdown() {
  clearTimeout(timer);
  for (const client of wss.clients) client.terminate();
  wss.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
