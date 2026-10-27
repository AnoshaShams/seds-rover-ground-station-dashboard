// Acceptance check: "TypeScript build passing; WebSocket updates at 30 fps
// with <500 ms watchdog".
//
// Usage: npm run verify
//
// Uses the telemetry server on ws://localhost:8080 if one is already running
// (for example a preview server). Otherwise it starts server/telemetry-server.mjs
// as a child process and stops it at the end. The thresholds come from
// shared/telemetry-constants.mjs, the same module the dashboard imports.
// Prints a PASS/FAIL table, writes everything it printed to
// proof/verify-output.txt, and exits non-zero if any check fails.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PAUSE_COMMAND, PAUSE_MS, TARGET_FPS, WATCHDOG_MS } from "../shared/telemetry-constants.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "proof", "verify-output.txt");
const PORT = Number(process.env.PORT ?? 8080);
const WS_URL = `ws://localhost:${PORT}`;

const FPS_MIN = TARGET_FPS - 2;
const FPS_MAX = TARGET_FPS + 2;
const MAX_GAP_MS = 100;
const WARMUP_MS = 500;
const MEASURE_MS = 5000;
/** How long to watch after sending "pause" */
const PAUSE_OBSERVE_MS = PAUSE_MS + 2000;

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

// ---- telemetry source ---------------------------------------------------

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

async function startSimulator() {
  const child = spawn(process.execPath, ["server/telemetry-server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));

  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) break;
    if (await isListening(PORT)) return child;
    await sleep(100);
  }
  child.kill();
  throw new Error(`simulator did not start on port ${PORT}:\n${log.join("")}`);
}

// ---- frame capture ------------------------------------------------------

/** Connects and records the arrival time of every frame */
function openRecorder() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
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

function between(frames, from, to) {
  return frames.filter((f) => f.t >= from && f.t < to);
}

function gapsOf(frames) {
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].t - frames[i - 1].t);
  return gaps;
}

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
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

// ---- main ---------------------------------------------------------------

const results = []; // { id, name, criterion, measured, pass }

function record(id, name, criterion, measured, pass) {
  results.push({ id, name, criterion, measured, pass });
}

async function main() {
  const startedAt = new Date();
  out("Rover ground station: acceptance verification");
  out(`Run at:    ${stamp(startedAt)}, ${startedAt.toISOString()}`);
  out(`Criteria:  TypeScript build passing; WebSocket updates at ${TARGET_FPS} fps with <${WATCHDOG_MS} ms watchdog`);
  out(
    `Constants: WATCHDOG_MS=${WATCHDOG_MS}, TARGET_FPS=${TARGET_FPS}, PAUSE_MS=${PAUSE_MS} ` +
      `(shared/telemetry-constants.mjs, also imported by the dashboard)`,
  );
  out(`Platform:  Node ${process.version}, ${process.platform} ${process.arch}`);

  let simulator = null;
  if (await isListening(PORT)) {
    out(`Source:    ${WS_URL}, already running, used as is`);
  } else {
    simulator = await startSimulator();
    out(`Source:    ${WS_URL}, started by this script (pid ${simulator.pid})`);
  }
  out("");

  try {
    // Checks 1 to 3 use one connection
    let recorder = null;
    try {
      recorder = await openRecorder();
    } catch (err) {
      const msg = `cannot connect: ${err.message}`;
      record("1", "Frame rate, 5 s window", `${FPS_MIN} to ${FPS_MAX} fps`, msg, false);
      record("2", "Largest gap, normal operation", `< ${MAX_GAP_MS} ms`, msg, false);
      record("3", "Pause gap and recovery", `gap > ${WATCHDOG_MS} ms, then frames resume`, msg, false);
    }

    if (recorder) {
      const { ws, frames } = recorder;
      out(`[1,2] Measuring ${MEASURE_MS / 1000} s of frames after a ${WARMUP_MS} ms warm-up ...`);
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
        "1",
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
        "2",
        "Largest gap, normal operation",
        `< ${MAX_GAP_MS} ms`,
        `max ${maxGap.toFixed(1)} ms (mean ${meanGap.toFixed(1)}, p99 ${percentile(gaps, 99).toFixed(1)}, ` +
          `${over50} of ${gaps.length} gaps > 50 ms)`,
        maxGap < MAX_GAP_MS,
      );

      // Check 3: pause produces a gap longer than the watchdog, then recovers
      out(`[3]   Sending "${PAUSE_COMMAND}", watching for ${PAUSE_OBSERVE_MS / 1000} s ...`);
      const tPause = performance.now();
      ws.send(PAUSE_COMMAND);
      await sleep(PAUSE_OBSERVE_MS);
      ws.close();

      // Include the last frame before the request so the gap is measured from it
      const lastBefore = frames.filter((f) => f.t < tPause).at(-1);
      const after = frames.filter((f) => f.t >= tPause);
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
      const resumedFrames = gapIndex > 0 ? span.length - gapIndex : 0;
      const resumed = resumedFrames >= TARGET_FPS / 2;
      const seqMissed = gapIndex > 0 ? span[gapIndex].seq - span[gapIndex - 1].seq - 1 : 0;
      const tripped = outage > WATCHDOG_MS;
      record(
        "3",
        "Pause gap and recovery",
        `gap > ${WATCHDOG_MS} ms, then frames resume`,
        `outage ${outage.toFixed(0)} ms (server hold ${PAUSE_MS} ms), ` +
          `${resumed ? "resumed" : "NOT resumed"}: ${resumedFrames} frames after, ${seqMissed} seq missed`,
        tripped && resumed,
      );
    }
  } finally {
    if (simulator) simulator.kill();
  }

  // Check 4: TypeScript and production build
  const steps = [
    ["4a", "TypeScript", "npx tsc --noEmit"],
    ["4b", "Production build", "npm run build"],
  ];
  for (const [id, name, command] of steps) {
    out(`[${id}]  Running ${command} ...`);
    const r = await run(command);
    for (const line of r.output.replace(ANSI, "").split(/\r?\n/)) {
      if (line.trim()) out(`      | ${line}`);
    }
    record(id, name, `${command} exits 0`, `exit ${r.code} (${r.seconds.toFixed(1)} s)`, r.code === 0);
  }

  // Report
  const header = ["#", "Check", "Criterion", "Measured", "Result"];
  const rows = results.map((r) => [r.id, r.name, r.criterion, r.measured, r.pass ? "PASS" : "FAIL"]);
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
