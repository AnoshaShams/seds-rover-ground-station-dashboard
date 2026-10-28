// Acceptance checks.
//
// Simulator mode: "TypeScript build passing; WebSocket updates at 30 fps with
// <500 ms watchdog" (checks 1 to 5).
// Odometry mode: nav_msgs/Odometry over the rosbridge protocol, 50 Hz source,
// sampled at 30 Hz, conversion and watchdog (checks 6 to 9).
//
// Usage: npm run verify
//
// Uses the simulator on ws://localhost:8080 and the (fake) rosbridge on
// ws://localhost:9090 if they are already running (for example as preview
// servers). Otherwise it starts server/telemetry-server.mjs and
// server/fake-rosbridge.mjs as child processes and stops them at the end.
// Thresholds, the sample gate and the odometry conversion are imported from
// shared/, the same modules the dashboard uses. Prints one PASS/FAIL table,
// writes everything it printed to proof/verify-output.txt, and exits non-zero
// if any check fails.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { convertOdometry } from "../shared/odometry.mjs";
import { createSampleGate } from "../shared/sample-gate.mjs";
import {
  DEFAULT_ODOM_TOPIC,
  PAUSE_COMMAND,
  PAUSE_MS,
  TARGET_FPS,
  WATCHDOG_MS,
} from "../shared/telemetry-constants.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "proof", "verify-output.txt");
const SIM_PORT = Number(process.env.PORT ?? 8080);
const SIM_URL = `ws://localhost:${SIM_PORT}`;
const ROS_PORT = Number(process.env.ROSBRIDGE_PORT ?? 9090);
const ROS_URL = `ws://localhost:${ROS_PORT}`;

// Simulator mode (checks 1 to 3)
const FPS_MIN = TARGET_FPS - 2;
const FPS_MAX = TARGET_FPS + 2;
const MAX_GAP_MS = 100;
const WARMUP_MS = 500;
const MEASURE_MS = 5000;
/** How long to watch after sending "pause" */
const PAUSE_OBSERVE_MS = PAUSE_MS + 2000;

// Odometry mode (checks 6 to 9). Expected values come from the wheel_odometry
// demo (fake_joint_states.py defaults) that server/fake-rosbridge.mjs replays.
const ODOM_RATE_HZ = 50;
const ODOM_RATE_MIN = 45;
const ODOM_RATE_MAX = 55;
/** Long enough to contain at least one full straight and one full turn phase */
const ODOM_MEASURE_MS = 12000;
const DEMO_SPEED = 0.3; // m/s
const DEMO_TURN_DEG_S = (0.5 * 180) / Math.PI; // 28.65 deg/s
const TOL_SPEED_MEAN = 0.01; // m/s, mean speed in the straight phase
const TOL_SPEED_EACH = 0.02; // m/s, every straight-phase sample
const TOL_YAW_SPREAD_DEG = 0.5; // yaw range within one straight segment
const TOL_TRACK_DEG = 1.0; // direction of travel vs yaw in a straight segment
const TOL_TURN_SPEED = 0.01; // m/s, |speed| in the turn phase
const TOL_TURN_RATE = 0.05; // 5 % of the expected turn rate
/** Messages dropped at each end of a phase segment (phase changes) */
const SEGMENT_TRIM = 2;
/** Shortest segment that is evaluated, messages (1 s at 50 Hz) */
const SEGMENT_MIN = ODOM_RATE_HZ;

// ---- output -------------------------------------------------------------

const printed = [];
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function out(line = "") {
  console.log(line);
  printed.push(line.replace(ANSI, ""));
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = `${sign}${p(Math.floor(Math.abs(offsetMin) / 60))}:${p(Math.abs(offsetMin) % 60)}`;
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} (UTC${off})`
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- servers --------------------------------------------------------------

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "localhost" });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function startServer(script, port) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));

  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) break;
    if (await isListening(port)) return child;
    await sleep(100);
  }
  child.kill();
  throw new Error(`${script} did not start on port ${port}:\n${log.join("")}`);
}

/** Uses a running server or starts one. Returns the child to stop, or null. */
async function ensureServer(label, script, port, url) {
  if (await isListening(port)) {
    out(`Source:    ${label} ${url}, already running, used as is`);
    return null;
  }
  const child = await startServer(script, port);
  out(`Source:    ${label} ${url}, started by this script (pid ${child.pid})`);
  return child;
}

// ---- capture --------------------------------------------------------------

/** Simulator: records the arrival time and seq of every frame */
function openSimRecorder() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SIM_URL);
    const frames = []; // { t: performance.now(), seq }
    ws.on("message", (data) => {
      const t = performance.now();
      try {
        const frame = JSON.parse(String(data));
        if (typeof frame.seq === "number") frames.push({ t, seq: frame.seq });
      } catch {
        // not a telemetry frame
      }
    });
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("error", reject);
  });
}

/** Rosbridge: subscribes like the dashboard does and records every publish */
function openOdomRecorder() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ROS_URL);
    const msgs = []; // { t: performance.now(), wall: Date.now(), odom }
    const statuses = [];
    ws.on("message", (data) => {
      const t = performance.now();
      const wall = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.op === "status") statuses.push(`${msg.level}: ${msg.msg}`);
      if (msg.op !== "publish" || msg.topic !== DEFAULT_ODOM_TOPIC) return;
      msgs.push({ t, wall, odom: convertOdometry(msg.msg) });
    });
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          op: "subscribe",
          id: "verify",
          topic: DEFAULT_ODOM_TOPIC,
          type: "nav_msgs/msg/Odometry",
          throttle_rate: 0,
        }),
      );
      resolve({ ws, msgs, statuses });
    });
    ws.once("error", reject);
  });
}

function between(items, from, to) {
  return items.filter((f) => f.t >= from && f.t < to);
}

function gapsOf(items) {
  const gaps = [];
  for (let i = 1; i < items.length; i += 1) gaps.push(items[i].t - items[i - 1].t);
  return gaps;
}

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Largest gap after a pause request, measured from the last item before it */
function pauseGap(items, tPause) {
  const lastBefore = items.filter((f) => f.t < tPause).at(-1);
  const after = items.filter((f) => f.t >= tPause);
  const span = lastBefore ? [lastBefore, ...after] : after;
  let gapIndex = -1;
  let outage = 0;
  for (let i = 1; i < span.length; i += 1) {
    const g = span[i].t - span[i - 1].t;
    if (g > outage) {
      outage = g;
      gapIndex = i;
    }
  }
  return { span, gapIndex, outage, resumedCount: gapIndex > 0 ? span.length - gapIndex : 0 };
}

// ---- odometry analysis ----------------------------------------------------

/** Signed smallest difference b - a in degrees, (-180, 180] */
function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Splits into runs of straight (speed well above 0) and turn (speed near 0) messages */
function phaseSegments(msgs) {
  const kind = (o) => (o.speed > DEMO_SPEED / 2 ? "straight" : Math.abs(o.speed) < DEMO_SPEED / 6 ? "turn" : null);
  const segments = [];
  let current = null;
  for (const m of msgs) {
    const k = kind(m.odom);
    if (!current || current.kind !== k) {
      current = { kind: k, items: [] };
      segments.push(current);
    }
    current.items.push(m);
  }
  return segments
    .filter((s) => s.kind !== null)
    .map((s) => ({ kind: s.kind, items: s.items.slice(SEGMENT_TRIM, s.items.length - SEGMENT_TRIM) }))
    .filter((s) => s.items.length >= SEGMENT_MIN);
}

/** Least-squares slope of unwrapped yaw (deg) against header stamp (s) */
function yawRate(items) {
  let unwrapped = items[0].odom.yawDeg;
  const pts = items.map((m, i) => {
    if (i > 0) unwrapped += angleDiff(items[i - 1].odom.yawDeg, m.odom.yawDeg);
    return { x: m.odom.stampMs / 1000, y: unwrapped };
  });
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  return sxy / sxx;
}

function checkConversion(msgs) {
  const valid = msgs.filter((m) => m.odom !== null);
  const malformed = msgs.length - valid.length;
  const segments = phaseSegments(valid);
  const straight = segments.filter((s) => s.kind === "straight");
  const turn = segments.filter((s) => s.kind === "turn");
  if (straight.length === 0 || turn.length === 0 || malformed > 0) {
    return {
      pass: false,
      measured:
        `${straight.length} straight and ${turn.length} turn segments of >= 1 s captured` +
        (malformed > 0 ? `, ${malformed} messages failed to convert` : ""),
    };
  }

  // Straight: speed, constant yaw, direction of travel matches yaw
  const sSpeeds = straight.flatMap((s) => s.items.map((m) => m.odom.speed));
  const sMean = sSpeeds.reduce((a, b) => a + b, 0) / sSpeeds.length;
  const sWorst = Math.max(...sSpeeds.map((v) => Math.abs(v - DEMO_SPEED)));
  let yawSpread = 0;
  let trackErr = 0;
  for (const s of straight) {
    const first = s.items[0].odom;
    const last = s.items.at(-1).odom;
    const spread = Math.max(...s.items.map((m) => Math.abs(angleDiff(first.yawDeg, m.odom.yawDeg))));
    yawSpread = Math.max(yawSpread, spread);
    const track = (Math.atan2(last.y - first.y, last.x - first.x) * 180) / Math.PI;
    trackErr = Math.max(trackErr, Math.abs(angleDiff(first.yawDeg, track)));
  }

  // Turn: speed about zero, yaw increasing at about 0.5 rad/s
  const tSpeedMax = Math.max(...turn.flatMap((s) => s.items.map((m) => Math.abs(m.odom.speed))));
  const rates = turn.map((s) => yawRate(s.items));
  const rate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const rateErr = Math.abs(rate - DEMO_TURN_DEG_S) / DEMO_TURN_DEG_S;

  const pass =
    Math.abs(sMean - DEMO_SPEED) <= TOL_SPEED_MEAN &&
    sWorst <= TOL_SPEED_EACH &&
    yawSpread <= TOL_YAW_SPREAD_DEG &&
    trackErr <= TOL_TRACK_DEG &&
    tSpeedMax <= TOL_TURN_SPEED &&
    rate > 0 &&
    rateErr <= TOL_TURN_RATE;

  return {
    pass,
    measured:
      `straight: v ${sMean >= 0 ? "+" : ""}${sMean.toFixed(3)} m/s (worst dev ${sWorst.toFixed(3)}), ` +
      `yaw spread ${yawSpread.toFixed(2)} deg, track vs yaw ${trackErr.toFixed(2)} deg; ` +
      `turn: |v| max ${tSpeedMax.toFixed(3)} m/s, yaw rate ${rate >= 0 ? "+" : ""}${rate.toFixed(2)} deg/s ` +
      `(${(rateErr * 100).toFixed(1)} % off); ${straight.length}+${turn.length} segments`,
  };
}

// ---- shell commands -----------------------------------------------------

function run(command) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => {
      resolve({ code: code ?? 1, seconds: (performance.now() - started) / 1000, output });
    });
  });
}

// ---- checks ---------------------------------------------------------------

const results = []; // { id, name, criterion, measured, pass }

function record(id, name, criterion, measured, pass) {
  results.push({ id, name, criterion, measured, pass });
}

async function simulatorChecks() {
  let recorder;
  try {
    recorder = await openSimRecorder();
  } catch (err) {
    const msg = `cannot connect: ${err.message}`;
    record(1, "Frame rate, 5 s window", `${FPS_MIN} to ${FPS_MAX} fps`, msg, false);
    record(2, "Largest gap, normal operation", `< ${MAX_GAP_MS} ms`, msg, false);
    record(3, "Pause gap and recovery", `gap > ${WATCHDOG_MS} ms, then frames resume`, msg, false);
    return;
  }

  const { ws, frames } = recorder;
  out(`[1,2] Simulator: measuring ${MEASURE_MS / 1000} s of frames after a ${WARMUP_MS} ms warm-up ...`);
  const t0 = performance.now() + WARMUP_MS;
  await sleep(WARMUP_MS + MEASURE_MS);
  const window = between(frames, t0, t0 + MEASURE_MS);

  // Check 1: frame rate
  const fps = window.length / (MEASURE_MS / 1000);
  const seqRate =
    window.length > 1
      ? (window.at(-1).seq - window[0].seq) / ((window.at(-1).t - window[0].t) / 1000)
      : 0;
  record(
    1,
    "Frame rate, 5 s window",
    `${FPS_MIN} to ${FPS_MAX} fps`,
    `${fps.toFixed(2)} fps (${window.length} frames; seq rate ${seqRate.toFixed(2)}/s)`,
    fps >= FPS_MIN && fps <= FPS_MAX,
  );

  // Check 2: largest gap in normal operation
  const gaps = gapsOf(window);
  const maxGap = gaps.length ? Math.max(...gaps) : Infinity;
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;
  const over50 = gaps.filter((g) => g > 50).length;
  record(
    2,
    "Largest gap, normal operation",
    `< ${MAX_GAP_MS} ms`,
    `max ${maxGap.toFixed(1)} ms (mean ${meanGap.toFixed(1)}, p99 ${percentile(gaps, 99).toFixed(1)}, ` +
      `${over50} of ${gaps.length} gaps > 50 ms)`,
    maxGap < MAX_GAP_MS,
  );

  // Check 3: pause produces a gap longer than the watchdog, then recovers
  out(`[3]   Simulator: sending "${PAUSE_COMMAND}", watching for ${PAUSE_OBSERVE_MS / 1000} s ...`);
  const tPause = performance.now();
  ws.send(PAUSE_COMMAND);
  await sleep(PAUSE_OBSERVE_MS);
  ws.close();

  const { span, gapIndex, outage, resumedCount } = pauseGap(frames, tPause);
  const resumed = resumedCount >= TARGET_FPS / 2;
  const seqMissed = gapIndex > 0 ? span[gapIndex].seq - span[gapIndex - 1].seq - 1 : 0;
  record(
    3,
    "Pause gap and recovery",
    `gap > ${WATCHDOG_MS} ms, then frames resume`,
    `outage ${outage.toFixed(0)} ms (server hold ${PAUSE_MS} ms), ` +
      `${resumed ? "resumed" : "NOT resumed"}: ${resumedCount} frames after, ${seqMissed} seq missed`,
    outage > WATCHDOG_MS && resumed,
  );
}

async function odometryChecks() {
  const crit6 = `${ODOM_RATE_MIN} to ${ODOM_RATE_MAX} msg/s`;
  const crit7 = `${FPS_MIN} to ${FPS_MAX} samples/s`;
  const crit8 =
    `straight: v ${DEMO_SPEED.toFixed(2)} +/- ${TOL_SPEED_MEAN} (each +/- ${TOL_SPEED_EACH}), ` +
    `yaw spread <= ${TOL_YAW_SPREAD_DEG} deg, track <= ${TOL_TRACK_DEG} deg; ` +
    `turn: |v| <= ${TOL_TURN_SPEED}, yaw +${DEMO_TURN_DEG_S.toFixed(2)} deg/s +/- ${TOL_TURN_RATE * 100} %`;
  const crit9 = `gap > ${WATCHDOG_MS} ms, then messages resume`;

  let recorder;
  try {
    recorder = await openOdomRecorder();
  } catch (err) {
    const msg = `cannot connect: ${err.message}`;
    record(6, "Odometry message rate", crit6, msg, false);
    record(7, "Sample gate rate (dashboard code)", crit7, msg, false);
    record(8, "Odometry conversion", crit8, msg, false);
    record(9, "Odometry pause gap and recovery", crit9, msg, false);
    return;
  }

  const { ws, msgs, statuses } = recorder;
  out(`[6-8] Odometry: measuring ${ODOM_MEASURE_MS / 1000} s of ${DEFAULT_ODOM_TOPIC} after a ${WARMUP_MS} ms warm-up ...`);
  const t0 = performance.now() + WARMUP_MS;
  await sleep(WARMUP_MS + ODOM_MEASURE_MS);
  const window = between(msgs, t0, t0 + ODOM_MEASURE_MS);
  if (statuses.length > 0) out(`      | server status: ${statuses.join("; ")}`);

  // Check 6: message rate
  const rate = window.length / (ODOM_MEASURE_MS / 1000);
  const gaps = gapsOf(window);
  record(
    6,
    "Odometry message rate",
    crit6,
    `${rate.toFixed(2)} msg/s (${window.length} msgs in ${ODOM_MEASURE_MS / 1000} s; ` +
      `max gap ${gaps.length ? Math.max(...gaps).toFixed(1) : "n/a"} ms)`,
    rate >= ODOM_RATE_MIN && rate <= ODOM_RATE_MAX,
  );

  // Check 7: the dashboard's sample gate on the real arrival times
  const gate = createSampleGate(1000 / TARGET_FPS);
  const kept = window.filter((m) => gate(m.wall));
  const keptSpan = kept.length > 1 ? (kept.at(-1).wall - kept[0].wall) / 1000 : 0;
  const keptRate = keptSpan > 0 ? (kept.length - 1) / keptSpan : 0;
  record(
    7,
    "Sample gate rate (dashboard code)",
    crit7,
    `${keptRate.toFixed(2)} samples/s (${kept.length} of ${window.length} msgs kept, arrival times)`,
    keptRate >= FPS_MIN && keptRate <= FPS_MAX,
  );

  // Check 8: conversion through shared/odometry.mjs
  const conv = checkConversion(window);
  record(8, "Odometry conversion", crit8, conv.measured, conv.pass);

  // Check 9: pause op produces a gap longer than the watchdog, then recovers
  out(`[9]   Odometry: sending {"op":"${PAUSE_COMMAND}"}, watching for ${PAUSE_OBSERVE_MS / 1000} s ...`);
  const tPause = performance.now();
  ws.send(JSON.stringify({ op: PAUSE_COMMAND }));
  await sleep(PAUSE_OBSERVE_MS);
  ws.close();

  const { outage, resumedCount } = pauseGap(msgs, tPause);
  const resumed = resumedCount >= ODOM_RATE_HZ / 2;
  record(
    9,
    "Odometry pause gap and recovery",
    crit9,
    `outage ${outage.toFixed(0)} ms (server hold ${PAUSE_MS} ms), ` +
      `${resumed ? "resumed" : "NOT resumed"}: ${resumedCount} msgs after`,
    outage > WATCHDOG_MS && resumed,
  );
}

async function buildChecks() {
  const steps = [
    [4, "TypeScript", "npx tsc --noEmit"],
    [5, "Production build", "npm run build"],
  ];
  for (const [id, name, command] of steps) {
    out(`[${id}]   Running ${command} ...`);
    const r = await run(command);
    for (const line of r.output.replace(ANSI, "").split(/\r?\n/)) {
      if (line.trim()) out(`      | ${line}`);
    }
    record(id, name, `${command} exits 0`, `exit ${r.code} (${r.seconds.toFixed(1)} s)`, r.code === 0);
  }
}

// ---- main ---------------------------------------------------------------

async function main() {
  const startedAt = new Date();
  out("Rover ground station: acceptance verification");
  out(`Run at:    ${stamp(startedAt)}, ${startedAt.toISOString()}`);
  out(`Criteria:  TypeScript build passing; WebSocket updates at ${TARGET_FPS} fps with <${WATCHDOG_MS} ms watchdog;`);
  out(`           odometry mode: ${ODOM_RATE_HZ} Hz nav_msgs/Odometry via rosbridge, sampled at ${TARGET_FPS} Hz`);
  out(
    `Constants: WATCHDOG_MS=${WATCHDOG_MS}, TARGET_FPS=${TARGET_FPS}, PAUSE_MS=${PAUSE_MS} ` +
      `(shared/telemetry-constants.mjs, also imported by the dashboard)`,
  );
  out("Shared:    shared/sample-gate.mjs and shared/odometry.mjs, the dashboard's own code");
  out(`Platform:  Node ${process.version}, ${process.platform} ${process.arch}`);

  const children = [];
  try {
    const sim = await ensureServer("simulator", "server/telemetry-server.mjs", SIM_PORT, SIM_URL);
    if (sim) children.push(sim);
    const ros = await ensureServer("rosbridge", "server/fake-rosbridge.mjs", ROS_PORT, ROS_URL);
    if (ros) children.push(ros);
    out("");

    await simulatorChecks();
    await odometryChecks();
  } finally {
    for (const child of children) child.kill();
  }

  await buildChecks();

  // Report
  results.sort((a, b) => a.id - b.id);
  const header = ["#", "Check", "Criterion", "Measured", "Result"];
  const rows = results.map((r) => [String(r.id), r.name, r.criterion, r.measured, r.pass ? "PASS" : "FAIL"]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmtRow = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  const failed = results.filter((r) => !r.pass).length;

  out("");
  out(fmtRow(header));
  out(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) out(fmtRow(row));
  out("");
  out(`OVERALL: ${failed === 0 ? "PASS" : "FAIL"} (${results.length - failed} of ${results.length} checks passed)`);
  out(`Finished: ${stamp(new Date())}`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, printed.join("\n") + "\n");
  console.log(`Saved to ${path.relative(ROOT, OUT_FILE)}`);

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  out(`verify: ${err.stack ?? err}`);
  out("OVERALL: FAIL (verification did not complete)");
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, printed.join("\n") + "\n");
  process.exitCode = 1;
});
