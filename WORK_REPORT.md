Work Report

To: Bushra Rahman, Ahmed Ali Kamran

Task: SEDS-TASK-ROV-SRILANKA-005, Web Browser Ground Station Telemetry Dashboard

What I built

I built a browser ground station dashboard for the SEDS Pakistan rover using
Next.js, React and strict TypeScript, without UI, chart or map libraries. It
has two data sources. The first is a built-in simulator that sends speed,
battery voltage, position and heading 30 times per second. The second is
rosbridge mode, which reads nav_msgs/Odometry from /wheel/odometry, as my
teammate Giyan's node publishes it, through the rosbridge protocol. The
dashboard shows a canvas map, readouts with history traces, a status bar and a
link event log. A watchdog shows LINK LOST after 500 ms without data and
recovers automatically.

How I verified it

npm run verify runs 9 checks using the dashboard's own constants, sample gate
and odometry conversion code. All 9 passed in the saved run,
proof/verify-output.txt. The simulator delivered 30.00 fps, and a pause caused
a 2031 ms outage before frames resumed. The largest gap between simulator
frames was 66.0 ms. It varies between runs but stayed under its 100 ms limit.
The TypeScript check and production build exited with code 0. In rosbridge mode
the source delivered 50.00 messages per second and the sample gate kept 29.87
per second. The conversion check measured +0.300 m/s with constant yaw when
driving straight and a yaw rate of +28.64 deg/s when turning. After a pause the
outage lasted 2008 ms before messages resumed. I also checked link loss and
reconnection in the browser by using the link drop button.

Limitations

Rosbridge mode was tested only against a fake rosbridge that replays Giyan's
demo pattern, not against real ROS 2 or her actual node. Battery is unavailable
in rosbridge mode. The link drop button only works with the simulators.

I used Claude as an AI coding assistant for this task. I reviewed, ran and
tested the result myself.

Repository: https://github.com/AnoshaShams/seds-rover-ground-station-dashboard
