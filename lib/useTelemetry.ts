"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  PAUSE_COMMAND,
  PAUSE_MS,
  TARGET_FPS,
  WATCHDOG_MS,
} from "@/shared/telemetry-constants.mjs";
import {
  DEFAULT_TELEMETRY_URL,
  HISTORY_MS,
  fmtDuration,
  fmtUtcMs,
  parseFrame,
  type TelemetryFrame,
} from "./telemetry";

// Data flow
// ---------
// Frames arrive at ~30 Hz. They are written into a mutable store (a ref) that
// the canvases read in their requestAnimationFrame loops, so frames never
// cause a React render by themselves. React state is a throttled snapshot
// (10 Hz) for the text readouts, plus the event log, which only changes when
// the link state changes.

export type SocketState = "connecting" | "open" | "closed";
export type LinkState = "awaiting" | "nominal" | "lost";

export interface Sample {
  t: number; // wall-clock arrival time, ms since the epoch
  x: number;
  y: number;
  speed: number;
  batteryV: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TelemetryStore {
  latest: TelemetryFrame | null;
  link: LinkState;
  /** performance.now() of the last frame, 0 before the first one */
  lastFrameMono: number;
  /** Last HISTORY_MS of frames, oldest first */
  samples: Sample[];
  /** Every position seen so far. Only grows, so the map scale stays stable. */
  bounds: Bounds | null;
}

export type LinkEventKind =
  | "acquired"
  | "lost"
  | "restored"
  | "socket-open"
  | "socket-closed"
  | "unreachable"
  | "operator";

export interface LinkEvent {
  id: number;
  at: number; // ms since the epoch
  kind: LinkEventKind;
  message: string;
}

export interface TelemetrySnapshot {
  frame: TelemetryFrame | null;
  link: LinkState;
  socket: SocketState;
  retryInMs: number | null;
  fps: number;
  latencyMs: number | null;
  framesReceived: number;
  /** Time since the last frame, null before the first frame */
  silenceMs: number | null;
  /** Wall clock at snapshot time, null until mounted (keeps SSR output stable) */
  nowMs: number | null;
  /** True from sending "pause" until frames resume */
  dropActive: boolean;
  /** Time left on the server's hold, counts down to 0 */
  dropRemainingMs: number;
}

export interface Telemetry {
  url: string;
  store: RefObject<TelemetryStore>;
  snapshot: TelemetrySnapshot;
  events: LinkEvent[];
  targetFps: number;
  /** Sends "pause" to the server. Returns false when the socket is not open or a drop is active. */
  sendPause: () => boolean;
}

const WATCHDOG_TICK_MS = 50;
const SNAPSHOT_EVERY_TICKS = 2; // 10 Hz text updates
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;
const MAX_EVENTS = 200;
/** Stop showing a drop as active if the link never went down (server ignored it) */
const DROP_GIVE_UP_MS = PAUSE_MS + 1000;

const INITIAL_SNAPSHOT: TelemetrySnapshot = {
  frame: null,
  link: "awaiting",
  socket: "connecting",
  retryInMs: null,
  fps: 0,
  latencyMs: null,
  framesReceived: 0,
  silenceMs: null,
  nowMs: null,
  dropActive: false,
  dropRemainingMs: 0,
};

function createStore(): TelemetryStore {
  return { latest: null, link: "awaiting", lastFrameMono: 0, samples: [], bounds: null };
}

function growBounds(bounds: Bounds | null, x: number, y: number): Bounds {
  if (!bounds) return { minX: x, maxX: x, minY: y, maxY: y };
  return {
    minX: Math.min(bounds.minX, x),
    maxX: Math.max(bounds.maxX, x),
    minY: Math.min(bounds.minY, y),
    maxY: Math.max(bounds.maxY, y),
  };
}

export function useTelemetry(url: string = DEFAULT_TELEMETRY_URL): Telemetry {
  const store = useRef<TelemetryStore>(createStore());
  const socketRef = useRef<WebSocket | null>(null);
  const eventIdRef = useRef(0);
  /** performance.now() when "pause" was sent, null when no drop is active */
  const dropRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(INITIAL_SNAPSHOT);
  const [events, setEvents] = useState<LinkEvent[]>([]);

  const log = useCallback((kind: LinkEventKind, message: string) => {
    eventIdRef.current += 1;
    const event: LinkEvent = { id: eventIdRef.current, at: Date.now(), kind, message };
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  useEffect(() => {
    const s = store.current;
    let disposed = false;
    let socketState: SocketState = "connecting";
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAt: number | null = null;
    let backoffMs = BACKOFF_MIN_MS;
    let reportedUnreachable = false;

    const arrivals: number[] = []; // performance.now() of frames in the last second
    let latencyMs: number | null = null;
    let framesReceived = 0;
    let lastFrameWall = 0;
    let tick = 0;

    const pruneArrivals = (now: number) => {
      while (arrivals.length > 0 && arrivals[0] < now - 1000) arrivals.shift();
    };

    const publish = () => {
      const now = performance.now();
      pruneArrivals(now);
      const dropAt = dropRef.current;
      if (dropAt !== null && s.link !== "lost" && now - dropAt > DROP_GIVE_UP_MS) {
        dropRef.current = null;
      }
      setSnapshot({
        frame: s.latest,
        link: s.link,
        socket: socketState,
        retryInMs: retryAt === null ? null : Math.max(0, retryAt - now),
        fps: arrivals.length,
        latencyMs: s.link === "nominal" ? latencyMs : null,
        framesReceived,
        silenceMs: s.latest ? now - s.lastFrameMono : null,
        nowMs: Date.now(),
        dropActive: dropRef.current !== null,
        dropRemainingMs:
          dropRef.current === null ? 0 : Math.max(0, dropRef.current + PAUSE_MS - now),
      });
    };

    const onFrame = (frame: TelemetryFrame) => {
      const now = performance.now();
      const wall = Date.now();
      const previous = s.latest;

      if (s.link === "awaiting") {
        s.link = "nominal";
        log("acquired", `first frame received, seq ${frame.seq}`);
      } else if (s.link === "lost" && previous) {
        s.link = "nominal";
        const outageMs = now - s.lastFrameMono;
        const missed = frame.seq - previous.seq - 1;
        const seqText =
          missed >= 0
            ? `seq ${previous.seq} -> ${frame.seq}, ${missed} frames missed`
            : `seq restarted at ${frame.seq}`;
        log("restored", `frames resumed after ${fmtDuration(outageMs)} outage, ${seqText}`);
        dropRef.current = null;
      }

      s.latest = frame;
      s.lastFrameMono = now;
      s.bounds = growBounds(s.bounds, frame.x, frame.y);
      s.samples.push({ t: wall, x: frame.x, y: frame.y, speed: frame.speed, batteryV: frame.batteryV });
      while (s.samples.length > 0 && s.samples[0].t < wall - HISTORY_MS) s.samples.shift();

      arrivals.push(now);
      pruneArrivals(now);
      latencyMs = wall - frame.ts;
      lastFrameWall = wall;
      framesReceived += 1;
    };

    const scheduleRetry = () => {
      if (disposed) return;
      retryAt = performance.now() + backoffMs;
      retryTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    };

    const connect = () => {
      if (disposed) return;
      retryTimer = null;
      retryAt = null;
      socketState = "connecting";

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        socketState = "closed";
        scheduleRetry();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        socketState = "open";
        backoffMs = BACKOFF_MIN_MS;
        reportedUnreachable = false;
        log("socket-open", `connected to ${url}`);
        publish();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (disposed || typeof event.data !== "string") return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(event.data);
        } catch {
          return;
        }
        const frame = parseFrame(decoded);
        if (frame) onFrame(frame);
      };

      ws.onclose = () => {
        if (disposed) return;
        const wasOpen = socketState === "open";
        socketRef.current = null;
        socketState = "closed";
        dropRef.current = null;
        scheduleRetry();
        if (wasOpen) {
          log("socket-closed", `connection to ${url} closed, reconnecting with backoff`);
        } else if (!reportedUnreachable) {
          reportedUnreachable = true;
          log("unreachable", `cannot reach ${url}, retrying with backoff up to ${BACKOFF_MAX_MS / 1000} s`);
        }
        publish();
      };
    };

    const watchdog = setInterval(() => {
      if (s.link === "nominal" && performance.now() - s.lastFrameMono > WATCHDOG_MS) {
        s.link = "lost";
        const lastSeq = s.latest ? s.latest.seq : 0;
        log(
          "lost",
          `no frame for more than ${WATCHDOG_MS} ms, last seq ${lastSeq} at ${fmtUtcMs(lastFrameWall)} UTC`,
        );
        tick = 0;
        publish();
        return;
      }
      tick += 1;
      if (tick % SNAPSHOT_EVERY_TICKS === 0) publish();
    }, WATCHDOG_TICK_MS);

    // Deferred so React strict mode (mount, unmount, mount) does not open and
    // immediately abort a socket.
    const startTimer = setTimeout(connect, 0);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      clearInterval(watchdog);
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [url, log]);

  const sendPause = useCallback((): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || dropRef.current !== null) return false;
    dropRef.current = performance.now();
    ws.send(PAUSE_COMMAND);
    log("operator", `sent "${PAUSE_COMMAND}" to ${url}, server holds frames for ${PAUSE_MS / 1000} s`);
    return true;
  }, [url, log]);

  return { url, store, snapshot, events, targetFps: TARGET_FPS, sendPause };
}
