import { WATCHDOG_MS, SAMPLE_GAP_MS, TRAIL_MS, fmtDuration } from "./telemetry";
import { LABEL_FONT, MONO_FONT, PALETTE as P } from "./palette";
import type { Bounds, TelemetryStore } from "./useTelemetry";

const PAD_PX = 40;
const MIN_HALF_SPAN_M = 10;
const MARGIN_M = 2;
const TRAIL_CHUNK = 6; // segments per stroke; each chunk gets one alpha value

/** 1, 2 or 5 times a power of ten, at least `raw` */
export function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function viewBounds(bounds: Bounds | null): Bounds {
  // The view always includes the origin (start point) and at least 20 m x 20 m
  const b = bounds ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const minX = Math.min(b.minX, 0) - MARGIN_M;
  const maxX = Math.max(b.maxX, 0) + MARGIN_M;
  const minY = Math.min(b.minY, 0) - MARGIN_M;
  const maxY = Math.max(b.maxY, 0) + MARGIN_M;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = Math.max((maxX - minX) / 2, MIN_HALF_SPAN_M);
  const hy = Math.max((maxY - minY) / 2, MIN_HALF_SPAN_M);
  return { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy };
}

function fmtGridLabel(value: number, step: number): string {
  return step < 1 ? value.toFixed(1) : String(Math.round(value));
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  store: TelemetryStore,
  nowWall: number,
  nowMono: number,
): void {
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, 0, w, h);

  const view = viewBounds(store.bounds);
  const scale = Math.min(
    (w - 2 * PAD_PX) / (view.maxX - view.minX),
    (h - 2 * PAD_PX) / (view.maxY - view.minY),
  ); // px per metre
  if (!(scale > 0)) return;

  const cx = (view.minX + view.maxX) / 2;
  const cy = (view.minY + view.maxY) / 2;
  const toX = (x: number) => w / 2 + (x - cx) * scale;
  const toY = (y: number) => h / 2 - (y - cy) * scale;

  const lost = store.link === "lost";

  // ---- grid -------------------------------------------------------------
  const step = niceStep(56 / scale);
  const xMin = cx - w / 2 / scale;
  const xMax = cx + w / 2 / scale;
  const yMin = cy - h / 2 / scale;
  const yMax = cy + h / 2 / scale;

  ctx.lineWidth = 1;
  ctx.font = `11px ${MONO_FONT}`;
  ctx.textBaseline = "alphabetic";

  for (let i = Math.ceil(xMin / step); i * step <= xMax; i += 1) {
    const gx = i * step;
    const px = Math.round(toX(gx)) + 0.5;
    ctx.strokeStyle = i === 0 ? P.gridAxis : P.gridMinor;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = P.label;
    ctx.textAlign = "left";
    ctx.fillText(fmtGridLabel(gx, step), px + 3, h - 6);
  }
  for (let i = Math.ceil(yMin / step); i * step <= yMax; i += 1) {
    const gy = i * step;
    const py = Math.round(toY(gy)) + 0.5;
    ctx.strokeStyle = i === 0 ? P.gridAxis : P.gridMinor;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    ctx.fillStyle = P.label;
    ctx.textAlign = "left";
    ctx.fillText(fmtGridLabel(gy, step), 4, py - 4);
  }

  // ---- trail, fading with age ----------------------------------------------
  const samples = store.samples;
  let start = 0;
  while (start < samples.length && samples[start].t < nowWall - TRAIL_MS) start += 1;

  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = start; i < samples.length - 1; i += TRAIL_CHUNK) {
    const end = Math.min(i + TRAIL_CHUNK, samples.length - 1);
    const age = nowWall - samples[end].t;
    const freshness = Math.max(0, 1 - age / TRAIL_MS);
    ctx.globalAlpha = (0.06 + 0.84 * freshness) * (lost ? 0.5 : 1);
    ctx.beginPath();
    ctx.moveTo(toX(samples[i].x), toY(samples[i].y));
    for (let j = i + 1; j <= end; j += 1) {
      const px = toX(samples[j].x);
      const py = toY(samples[j].y);
      if (samples[j].t - samples[j - 1].t > SAMPLE_GAP_MS) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ---- rover marker with heading arrow ------------------------------------------
  const frame = store.latest;
  if (frame) {
    const theta = (frame.headingDeg * Math.PI) / 180;
    ctx.save();
    ctx.globalAlpha = lost ? 0.55 : 1;
    ctx.translate(toX(frame.x), toY(frame.y));
    // Canvas y points down, so a CCW maths angle is a negative canvas rotation
    ctx.rotate(-theta);

    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(42, 0);
    ctx.moveTo(36, -4);
    ctx.lineTo(42, 0);
    ctx.lineTo(36, 4);
    ctx.stroke();

    ctx.fillStyle = P.accent;
    ctx.strokeStyle = P.panel;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-8, 8);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, -8);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  // ---- north indicator (top right) ----------------------------------------
  const nx = w - 28;
  const ny = 22;
  ctx.strokeStyle = P.text;
  ctx.fillStyle = P.text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nx, ny + 30);
  ctx.lineTo(nx, ny + 8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(nx, ny + 2);
  ctx.lineTo(nx - 5, ny + 11);
  ctx.lineTo(nx + 5, ny + 11);
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 13px ${LABEL_FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("N", nx, ny - 4);

  // ---- scale bar (bottom right) -------------------------------------------
  const barM = niceStep(110 / scale);
  const barPx = barM * scale;
  const bx1 = w - 20;
  const bx0 = bx1 - barPx;
  const by = h - 26;
  ctx.strokeStyle = P.text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx0, by - 5);
  ctx.lineTo(bx0, by);
  ctx.lineTo(bx1, by);
  ctx.lineTo(bx1, by - 5);
  ctx.stroke();
  ctx.font = `12px ${MONO_FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(`${barM < 1 ? barM.toFixed(1) : barM} m`, (bx0 + bx1) / 2, by - 8);

  // ---- state overlays ----------------------------------------------------
  if (store.link === "awaiting") {
    drawNotice(ctx, w, "AWAITING TELEMETRY", "no frames received yet", false);
  } else if (lost) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    const silence = Math.max(WATCHDOG_MS, nowMono - store.lastFrameMono);
    drawNotice(ctx, w, "LINK LOST", `no frames for ${fmtDuration(silence)}, position held`, true);
  }
}

function drawNotice(
  ctx: CanvasRenderingContext2D,
  w: number,
  title: string,
  detail: string,
  alarm: boolean,
): void {
  const boxW = Math.min(w - 32, 360);
  const boxH = 64;
  const x = Math.round((w - boxW) / 2) + 0.5;
  const y = 20.5;

  ctx.fillStyle = alarm ? P.alarmFill : P.bg;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = alarm ? P.alarm : P.ruleStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.textAlign = "center";
  ctx.fillStyle = P.text;
  ctx.font = `600 22px ${LABEL_FONT}`;
  ctx.fillText(title, w / 2, y + 28);
  ctx.font = `13px ${MONO_FONT}`;
  ctx.fillText(detail, w / 2, y + 50);
}
