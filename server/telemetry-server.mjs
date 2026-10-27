/**
 * Rover telemetry simulator (WebSocket, port 8080).
 *
 * On the real rover, telemetry comes from the ROS 2 node in updater.py
 * (`mission_control_updater_node`). It publishes a JSON string as a
 * std_msgs/String on the `mission_control_updater` topic at 100 Hz. A bridge
 * (for example rosbridge_server, or a small rclpy/rclnodejs node) subscribes to
 * that topic and forwards each message over WebSocket to the ground station.
 *
 * This script takes the place of that ROS 2 topic plus the bridge, so the
 * dashboard can be built and demoed without a rover. It simulates the rover
 * driving a looping figure-eight and broadcasts one JSON frame to every
 * connected client 30 times per second:
 *
 *   { seq, ts, speed, batteryV, x, y, headingDeg }
 *
 *   seq        frame counter, increases by 1 per simulation tick
 *   ts         ms since the Unix epoch, taken when the frame is created
 *   speed      ground speed, m/s
 *   batteryV   pack voltage, drains from 25.2 V to 21.0 V and then starts over
 *   x, y       position in metres, relative to the start of the course
 *   headingDeg 0 = +x (east), counter-clockwise positive, range [0, 360)
 *
 * Link-loss demo: if a client sends the text message "pause", the server stops
 * broadcasting for PAUSE_MS (2 seconds). The simulation and `seq` keep running, so the
 * dashboard sees a gap in `seq` once frames start arriving again.
 *
 * Usage: npm run sim   (set the PORT env var to use a different port)
 */

import { WebSocketServer, WebSocket } from "ws";
import { PAUSE_COMMAND, PAUSE_MS, TARGET_FPS } from "../shared/telemetry-constants.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const RATE_HZ = TARGET_FPS;
const TICK_MS = 1000 / RATE_HZ;

// Figure-eight course (lemniscate of Gerono): x = A sin(p), y = A sin(p) cos(p)
const COURSE_A = 20; // metres, half-width of the course
const LAP_SECONDS = 60; // time to drive one full figure-eight

// Battery: 25.2 V (6S full) down to 21.0 V over this many seconds, then starts over
const BATTERY_FULL_V = 25.2;
const BATTERY_EMPTY_V = 21.0;
const BATTERY_CYCLE_SECONDS = 600;

const omega = (2 * Math.PI) / LAP_SECONDS; // phase rate, rad/s

let seq = 0;
let phase = 0;
let simTime = 0; // seconds
let pausedUntil = 0; // ms since the epoch

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function makeFrame() {
  const s = Math.sin(phase);
  const c = Math.cos(phase);

  const x = COURSE_A * s;
  const y = COURSE_A * s * c;

  // Velocity is the derivative of position with respect to time
  const vx = COURSE_A * c * omega;
  const vy = COURSE_A * Math.cos(2 * phase) * omega;

  const speed = Math.hypot(vx, vy) + (Math.random() - 0.5) * 0.02; // small sensor noise
  let headingDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (headingDeg < 0) headingDeg += 360;

  const cycle = (simTime % BATTERY_CYCLE_SECONDS) / BATTERY_CYCLE_SECONDS;
  const batteryV =
    BATTERY_FULL_V - (BATTERY_FULL_V - BATTERY_EMPTY_V) * cycle + (Math.random() - 0.5) * 0.01;

  return {
    seq,
    ts: Date.now(),
    speed: round(Math.max(0, speed), 3),
    batteryV: round(batteryV, 3),
    x: round(x, 3),
    y: round(y, 3),
    headingDeg: round(headingDeg, 2),
  };
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  console.log(`[sim] client connected (${req.socket.remoteAddress}), ${wss.clients.size} total`);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString().trim().toLowerCase();
    if (text === PAUSE_COMMAND) {
      pausedUntil = Date.now() + PAUSE_MS;
      console.log(`[sim] "pause" received, holding broadcast for ${PAUSE_MS} ms`);
    }
  });

  ws.on("close", () => {
    console.log(`[sim] client disconnected, ${wss.clients.size} remaining`);
  });

  ws.on("error", (err) => {
    console.warn(`[sim] client error: ${err.message}`);
  });
});

wss.on("listening", () => {
  console.log(`[sim] rover telemetry simulator on ws://localhost:${PORT} at ${RATE_HZ} Hz`);
});

wss.on("error", (err) => {
  console.error(`[sim] server error: ${err.message}`);
  process.exit(1);
});

function tick() {
  const dt = TICK_MS / 1000;
  simTime += dt;
  phase = (phase + omega * dt) % (2 * Math.PI);
  seq += 1;

  if (Date.now() < pausedUntil) return;

  const payload = JSON.stringify(makeFrame());
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// Schedule each tick against the wall clock instead of using setInterval.
// Timers on Windows have ~15.6 ms resolution, so setInterval(33.3) really runs
// at ~21 Hz. Correcting every delay keeps the average at exactly RATE_HZ.
let nextTickAt = performance.now();
let timer;

function schedule() {
  nextTickAt += TICK_MS;
  const now = performance.now();
  // If we fall far behind (process suspended, etc.), reset instead of bursting
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
