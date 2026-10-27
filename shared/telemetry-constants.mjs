// Link constants shared by the dashboard (lib/useTelemetry.ts), the simulator
// (server/telemetry-server.mjs) and the acceptance test (scripts/verify.mjs).
// Plain JavaScript so Node can import it without a build step; types are in
// telemetry-constants.d.mts.

/** No frame for longer than this means LINK LOST */
export const WATCHDOG_MS = 500;

/** Rate the simulator sends at and the dashboard expects */
export const TARGET_FPS = 30;

/** How long the simulator holds frames after a "pause" message */
export const PAUSE_MS = 2000;

/** Text message that asks the simulator to hold frames */
export const PAUSE_COMMAND = "pause";
