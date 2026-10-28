# SEDS Pakistan Rover Ground Station

A browser-based ground station telemetry dashboard for the SEDS Pakistan rover,
built for task **SEDS-TASK-ROV-SRILANKA-005** (Web Browser Ground Station
Telemetry Dashboard).

The dashboard receives telemetry frames over a WebSocket and shows:

- a top status bar with link state, socket state, frames per second, latency,
  frame counter and UTC clock
- a position map drawn on a canvas: grid in metres, scale bar, north indicator,
  rover marker with heading arrow and a trail that fades with age
- a readout table for speed, battery voltage (with a NOMINAL / LOW status and a
  bar), position X and Y, and heading as a compass bearing
- 60 second history traces for speed and battery voltage
- a link event log with UTC timestamps
- a link watchdog that shows LINK LOST when frames stop for more than 500 ms
  and recovers on its own when they resume
- a "Simulate link drop" button for demonstrating the watchdog

It uses Next.js (App Router), React and TypeScript in strict mode, plus the `ws`
package for the simulator. There are no UI libraries, chart libraries, map tile
services, external fonts, CDNs or API keys.

![Dashboard](proof/dashboard-screenshot.png)

## Running it

Requirements: Node.js 20.9 or newer (required by Next.js 16; developed on Node 24) and npm.

```bash
npm install
```

Then, in one terminal, start the telemetry simulator (WebSocket on port 8080):

```bash
npm run sim
```

In a second terminal, start the dashboard:

```bash
npm run dev
```

Open http://localhost:3000.

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Production build (includes the TypeScript check) |
| `npm run start` | Serves the production build |
| `npm run verify` | Runs the acceptance checks described below |

The dashboard connects to `ws://localhost:8080` by default. To use a different
address, set `NEXT_PUBLIC_TELEMETRY_URL` before `npm run dev` or `npm run build`.
The simulator port can be changed with the `PORT` environment variable.

## Architecture

```
On the rover                                  In the browser
------------                                  --------------
updater.py (ROS 2 node)                       Next.js dashboard
  publishes std_msgs/String (JSON)              useTelemetry() hook
  on topic mission_control_updater   ---->      -> canvas map and traces
  at 100 Hz                         bridge      -> readout table, event log
                                  (WebSocket)

In this repository
------------------
server/telemetry-server.mjs  --WebSocket, 30 Hz-->  dashboard
(stands in for the rover and the bridge)
```

The reference rover software is `updater.py`, a ROS 2 node from the TrickFire
Robotics URC 2023 open-source code. It publishes a JSON string as a
`std_msgs/String` on the `mission_control_updater` topic every 10 ms (100 Hz).
On a real rover, a bridge (for example rosbridge, or a small rclpy node)
would subscribe to that topic and forward each message to the browser over
WebSocket. `updater.py` is part of the task materials and is not included in
this repository.

In this repository, `server/telemetry-server.mjs` plays the role of the rover
and the bridge together. It simulates the rover driving a figure-eight course
(40 m across, one lap per 60 s), with a battery that drains from 25.2 V to 21.0 V
over 10 minutes and then starts over. It sends one frame to every connected
client 30 times per second.

### Source layout

| Path | Contents |
|---|---|
| `server/telemetry-server.mjs` | Telemetry simulator (WebSocket server) |
| `shared/telemetry-constants.mjs` | `WATCHDOG_MS`, `TARGET_FPS`, `PAUSE_MS`, `PAUSE_COMMAND`, shared by the dashboard, simulator and verify script |
| `lib/useTelemetry.ts` | WebSocket connection, reconnect with backoff, frame store, FPS, latency, watchdog, event log |
| `lib/telemetry.ts` | Frame type and validation, heading to bearing conversion, number formatting |
| `lib/useCanvasLoop.ts` | requestAnimationFrame loop for a canvas sized to the device pixel ratio |
| `lib/drawMap.ts`, `lib/drawTrace.ts` | Canvas drawing for the map and the history traces |
| `components/` | Dashboard layout, status bar, readouts, event log, link drop button |
| `app/` | Next.js page, layout and stylesheet |
| `scripts/verify.mjs` | Acceptance checks |
| `proof/` | Saved output of `npm run verify` and a dashboard screenshot |

## Data frame

Each WebSocket message is one JSON object:

```json
{ "seq": 1072, "ts": 1793124864189, "speed": 1.54, "batteryV": 24.95,
  "x": 13.589, "y": 9.971, "headingDeg": 5.97 }
```

| Field | Unit | Meaning |
|---|---|---|
| `seq` | count | Frame counter. It keeps counting while frames are held, so a gap in `seq` shows how many frames were missed. |
| `ts` | ms since the Unix epoch | Time the frame was created by the sender |
| `speed` | m/s | Ground speed |
| `batteryV` | V | Battery pack voltage. LOW below 22.0 V. |
| `x` | m | Position east of the start point |
| `y` | m | Position north of the start point |
| `headingDeg` | degrees | 0 = east (+x), increasing counter-clockwise, range 0 to 360 |

Frames that are not valid JSON or are missing a numeric field are ignored.

**Heading convention.** The frame uses the maths convention (0 = east,
counter-clockwise). The dashboard converts it to a compass bearing for
display: `bearing = (90 - headingDeg) mod 360`, so 0 = north and bearings
increase clockwise. The readout also shows the nearest 8-point cardinal
direction (N, NE, E and so on).

## How the requirements are met

### 30 fps updates

- **Sending at 30 Hz.** `server/telemetry-server.mjs` sends at `TARGET_FPS`
  (30) from `shared/telemetry-constants.mjs`. It schedules each tick against
  the clock with `setTimeout` instead of using `setInterval`. On Windows,
  timers only fire about every 15.6 ms, so `setInterval(33.3)` gave about
  21 Hz; correcting each delay keeps the average at 30 Hz.
- **No React render per frame.** `lib/useTelemetry.ts` writes each frame into a
  mutable store (a React ref) instead of React state, so 30 frames per second
  do not cause 30 React renders per second.
- **Canvases redraw every animation frame.** The map and traces read that store
  through `lib/useCanvasLoop.ts`, drawn by `lib/drawMap.ts` and
  `lib/drawTrace.ts`.
- **Text readouts update at 10 Hz.** The readouts come from a throttled snapshot
  published 10 times per second.
- **Measured rate.** The status bar shows the measured frame rate, counted over a
  sliding 1 second window, next to the 30 fps target. Latency is
  `Date.now() - frame.ts` for the latest frame.

### 500 ms watchdog

- **Detection.** `lib/useTelemetry.ts` checks every 50 ms. If more than
  `WATCHDOG_MS` (500) has passed since the last frame, the link state becomes
  LINK LOST, so a loss is shown between 500 and 550 ms after the last frame.
- **While the link is lost.** The status bar, map and readout panel all say
  LINK LOST in text, and the values are held and dimmed. The event log records
  the time and the last sequence number received.
- **Recovery.** When frames resume, the state returns to NOMINAL on its own. The
  log records the outage length and how many frames were missed (from the
  `seq` gap).
- **Connection handling.** If the WebSocket closes, the hook reconnects with
  exponential backoff: 0.5, 1, 2, 4, then 8 seconds between attempts.
- **Link drop button.** "Simulate link drop" sends `pause` to the simulator,
  which holds frames for `PAUSE_MS` (2 s). The button shows a countdown while
  the hold is active.

## Verification

```bash
npm run verify
```

`scripts/verify.mjs` checks the acceptance criteria "TypeScript build passing;
WebSocket updates at 30 fps with <500 ms watchdog" for the simulator, and the
odometry mode against the fake rosbridge. It uses a simulator on port 8080 and
a rosbridge on port 9090 if they are already running, otherwise it starts
`server/telemetry-server.mjs` and `server/fake-rosbridge.mjs` and stops them at
the end. Thresholds come from `shared/telemetry-constants.mjs`; checks 7 and 8
run the dashboard's own `shared/sample-gate.mjs` and `shared/odometry.mjs`.

| Check | Pass condition |
|---|---|
| 1. Simulator frame rate | 28 to 32 frames per second over 5 seconds |
| 2. Largest gap between simulator frames | under 100 ms |
| 3. Send `pause` to the simulator | a gap longer than `WATCHDOG_MS` (500 ms) is seen, then frames resume |
| 4. `npx tsc --noEmit` | exit code 0 |
| 5. `npm run build` | exit code 0 |
| 6. Odometry message rate | 45 to 55 messages per second over 12 seconds (50 Hz expected) |
| 7. Sample gate on the real arrival times | 28 to 32 samples per second |
| 8. Odometry conversion | straight phase: speed 0.30 +/- 0.01 m/s (each sample +/- 0.02), yaw spread at most 0.5 deg, direction of travel within 1 deg of yaw; turn phase: speed at most 0.01 m/s, yaw rate +28.65 deg/s +/- 5 % |
| 9. Send `{"op":"pause"}` to the rosbridge | a gap longer than `WATCHDOG_MS` is seen, then messages resume |

It prints one PASS/FAIL table with the measured values and the date and time,
saves the output to `proof/verify-output.txt`, and exits with a non-zero code
if any check fails.

Last saved run (`proof/verify-output.txt`, Windows 11, Node 24.18):

| Check | Measured | Result |
|---|---|---|
| 1. Simulator frame rate | 30.00 fps (150 frames in 5 s) | PASS |
| 2. Largest gap | 66.0 ms (mean 33.4 ms, p99 49.0 ms) | PASS |
| 3. Simulator pause | 2031 ms outage, frames resumed, 60 frames missed | PASS |
| 4. TypeScript check | exit 0 | PASS |
| 5. Production build | exit 0 | PASS |
| 6. Odometry message rate | 50.00 msg/s (600 in 12 s) | PASS |
| 7. Sample gate | 29.87 samples/s (359 of 600 kept) | PASS |
| 8. Odometry conversion | straight +0.300 m/s, yaw spread 0.00 deg; turn yaw rate +28.64 deg/s | PASS |
| 9. Rosbridge pause | 2008 ms outage, messages resumed | PASS |

The simulator's largest gap varies between runs (48.7 ms and 66.0 ms in two
consecutive runs) because of the Windows timer resolution (about 15.6 ms) and
other load on the machine. It is the check with the smallest margin. Check 8
measures exact values because the fake rosbridge computes ideal odometry; the
real node's speeds jitter slightly around 0.3 m/s.

## Limitations

- **Simulated telemetry.** All telemetry is simulated. The dashboard has not
  been connected to the rover or to a real ROS 2 system.
- **No ROS 2 bridge yet.** No ROS 2 to WebSocket bridge is included. Forwarding
  the `mission_control_updater` topic to the browser still has to be built and
  tested.
- **Different message content.** The JSON that `updater.py` publishes holds motor
  state entries (built by `InfoToJSONHelper` from the motor configuration), not
  the position, speed, battery and heading fields used here. A bridge, or a
  change on the rover side, would need to produce this frame format, or the
  dashboard would need to be adapted to the real message.
- **Different rates.** `updater.py` publishes at 100 Hz, while the dashboard is
  designed and tested for 30 Hz. A bridge would need to downsample, or the
  dashboard would need checking at the higher rate.
- **Local position frame.** Position is in a local frame in metres starting at
  the origin. There is no GPS or map projection.
- **No security.** There is no authentication or encryption on the WebSocket
  (`ws://`, not `wss://`). It is meant for a trusted local network.
- **Pause affects everyone.** The `pause` command is a simulator feature for
  demonstrations. It affects every connected client.
- **Limited test coverage.** `npm run verify` checks the data sources' rates and
  timing, the sample gate, the odometry conversion and the build. It does not
  drive the dashboard in a browser. The dashboard's LINK LOST display and
  recovery were checked by hand. The odometry checks run against
  `server/fake-rosbridge.mjs`, not a real rosbridge_server and ROS 2 node.
