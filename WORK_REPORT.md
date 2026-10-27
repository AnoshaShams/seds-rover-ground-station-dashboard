# Work Report

**To:** Bushra Rahman, Ahmed Ali Kamran
**Task:** SEDS-TASK-ROV-SRILANKA-005, Web Browser Ground Station Telemetry Dashboard

## What I built

I built a browser ground station for the SEDS Pakistan rover using Next.js,
React and strict TypeScript, with no UI, chart or map libraries. A Node
WebSocket simulator stands in for the rover's ROS 2 node (`updater.py`) and the
bridge that would forward its `mission_control_updater` topic. It sends a frame
30 times per second with speed, battery voltage, position and heading. The
dashboard shows a canvas map with a fading trail and heading arrow, a readout
table with 60 second speed and battery traces, a status bar with frame rate and
latency, and a timestamped link event log. A watchdog shows LINK LOST when no
frame arrives for more than 500 ms, holds and dims the values, and recovers
when frames resume. A button pauses the simulator to demonstrate this.

## How I verified it

`npm run verify` runs the acceptance checks with the dashboard's own constants.
In the saved run (proof/verify-output.txt) it measured 30.00 fps over 5 seconds, a largest gap of 47.3 ms between frames (limit 100 ms), and a
2034 ms outage after a pause, with frames resuming and 60 frames missed. The
TypeScript check and the production build both exited with code 0, so all 5
checks passed. By hand, I also checked link loss, reconnection and the layout
at 1366x768 and 1920x1080.

## Limitations

The telemetry is simulated, and there is no ROS 2 to WebSocket bridge yet. The
real `updater.py` message contains motor states at 100 Hz, so a bridge or the
dashboard would need to map that format before field use.

I used Claude Code as an AI coding assistant for this task. I reviewed, ran and
tested the result myself.

Repository: https://github.com/AnoshaShams/seds-rover-ground-station-dashboard
