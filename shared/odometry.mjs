// nav_msgs/Odometry (rosbridge JSON) conversion shared by the dashboard
// (lib/odometry.ts) and the acceptance test (scripts/verify.mjs, check 8).
// Plain JavaScript so Node can import it without a build step; types are in
// odometry.d.mts.
//
// Matches the wheel_odometry node (topic /wheel/odometry, frame_id odom,
// child_frame_id base_footprint):
//   x, y      pose.pose.position, metres in the odom frame
//   yaw       atan2(2*w*z, 1 - 2*z*z) from pose.pose.orientation (planar
//             rotation, only z and w set), degrees normalised to [0, 360)
//   speed     twist.twist.linear.x, m/s, signed (negative when reversing)

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value, path) {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function num(value, ...path) {
  const v = at(value, path);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(value, ...path) {
  const v = at(value, path);
  return typeof v === "string" ? v : "";
}

/** Yaw in degrees, [0, 360), counter-clockwise from +x */
export function yawDegFromQuaternion(z, w) {
  const deg = (Math.atan2(2 * w * z, 1 - 2 * z * z) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Converts the `msg` field of a rosbridge publish op. Returns null if malformed. */
export function convertOdometry(msg) {
  const x = num(msg, "pose", "pose", "position", "x");
  const y = num(msg, "pose", "pose", "position", "y");
  const qz = num(msg, "pose", "pose", "orientation", "z");
  const qw = num(msg, "pose", "pose", "orientation", "w");
  const speed = num(msg, "twist", "twist", "linear", "x");
  if (x === null || y === null || qz === null || qw === null || speed === null) return null;

  // ROS 2 header stamp: the sender's clock, not comparable with the browser's
  const sec = num(msg, "header", "stamp", "sec") ?? 0;
  const nanosec = num(msg, "header", "stamp", "nanosec") ?? 0;

  return {
    x,
    y,
    yawDeg: yawDegFromQuaternion(qz, qw),
    speed,
    stampMs: sec * 1000 + nanosec / 1e6,
    frameId: str(msg, "header", "frame_id"),
    childFrameId: str(msg, "child_frame_id"),
  };
}

export { isRecord };
