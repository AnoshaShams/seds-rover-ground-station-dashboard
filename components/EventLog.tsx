import { fmtUtcMs } from "@/lib/telemetry";
import type { LinkEvent, LinkEventKind } from "@/lib/useTelemetry";

const KIND_LABEL: Record<LinkEventKind, string> = {
  acquired: "ACQUIRED",
  lost: "LINK LOST",
  restored: "RESTORED",
  "socket-open": "SOCKET OPEN",
  "socket-closed": "SOCKET CLOSED",
  unreachable: "UNREACHABLE",
  operator: "OPERATOR",
};

export function EventLog({ events }: { events: LinkEvent[] }) {
  return (
    <section className="panel log" aria-label="Link event log">
      <div className="panel-head">
        <h2 className="panel-title">Link event log</h2>
        <span className="panel-meta">{events.length} entries, newest first</span>
      </div>
      <ol className="log-list">
        {events.length === 0 ? (
          <li className="log-row log-empty">
            <span>--</span>
            <span />
            <span>No events</span>
          </li>
        ) : (
          events.map((e) => (
            <li key={e.id} className={`log-row kind-${e.kind}`}>
              <time dateTime={new Date(e.at).toISOString()}>{fmtUtcMs(e.at)} UTC</time>
              <span className="log-kind">{KIND_LABEL[e.kind]}</span>
              <span className="log-msg">{e.message}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
