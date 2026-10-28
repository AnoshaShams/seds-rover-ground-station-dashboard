/**
 * Decides which incoming frames become stored trail and trace samples.
 *
 * With intervalMs <= 0 every frame is kept (simulator mode). Otherwise it keeps
 * one frame per interval on average using a deadline schedule: a 50 Hz input
 * with a 33.3 ms interval keeps 30 frames per second, not 25 as a plain
 * "at least 33.3 ms since the last sample" rule would. After a gap longer than
 * one interval the schedule restarts from the next frame.
 */
export function createSampleGate(intervalMs: number): (wallMs: number) => boolean {
  let nextAt = -Infinity;
  return (wallMs) => {
    if (intervalMs <= 0) return true;
    if (wallMs < nextAt) return false;
    nextAt = wallMs - nextAt > intervalMs ? wallMs + intervalMs : nextAt + intervalMs;
    return true;
  };
}
