import { fmtUtc, type TelemetryFrame } from "@/lib/telemetry";
import type { TelemetrySnapshot } from "@/lib/useTelemetry";

function linkText(snapshot: TelemetrySnapshot): string {
  switch (snapshot.link) {
    case "awaiting":
      return "AWAITING TELEMETRY";
    case "nominal":
      return "NOMINAL";
    case "lost":
      return "LINK LOST";
  }
}

function socketText(snapshot: TelemetrySnapshot): string {
  switch (snapshot.socket) {
    case "connecting":
      return "CONNECTING";
    case "open":
      return "OPEN";
    case "closed":
      return snapshot.retryInMs === null
        ? "CLOSED"
        : `RETRY ${(snapshot.retryInMs / 1000).toFixed(1)} S`;
  }
}

function seqText(frame: TelemetryFrame | null): string {
  return frame ? String(frame.seq) : "--";
}

export function StatusBar({ snapshot, targetFps }: { snapshot: TelemetrySnapshot; targetFps: number }) {
  const hasFrames = snapshot.frame !== null;
  const lost = snapshot.link === "lost";

  return (
    <header className="topbar">
      <div className="wordmark">SEDS PAKISTAN / ROVER GROUND STATION</div>

      <dl className={`stat stat-link link-${snapshot.link}`}>
        <dt>Link</dt>
        <dd>
          <span className="pip" aria-hidden="true" />
          {linkText(snapshot)}
          {lost && snapshot.silenceMs !== null ? (
            <span className="stat-sub"> {(snapshot.silenceMs / 1000).toFixed(1)} S</span>
          ) : null}
        </dd>
      </dl>

      <dl className={`stat socket-${snapshot.socket}`}>
        <dt>Socket</dt>
        <dd>{socketText(snapshot)}</dd>
      </dl>

      <dl className="stat">
        <dt>FPS</dt>
        <dd className="num">
          {hasFrames ? snapshot.fps : "--"}
          <span className="unit">/ {targetFps}</span>
        </dd>
      </dl>

      <dl className="stat">
        <dt>Latency</dt>
        <dd className="num">
          {snapshot.latencyMs === null ? "--" : Math.max(0, Math.round(snapshot.latencyMs))}
          <span className="unit">ms</span>
        </dd>
      </dl>

      <dl className="stat">
        <dt>Frame</dt>
        <dd className="num">{seqText(snapshot.frame)}</dd>
      </dl>

      <dl className="stat">
        <dt>UTC</dt>
        <dd className="num">{fmtUtc(snapshot.nowMs)}</dd>
      </dl>
    </header>
  );
}
