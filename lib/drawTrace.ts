import { HISTORY_MS, SAMPLE_GAP_MS } from "./telemetry";
import { MONO_FONT, PALETTE as P } from "./palette";
import type { Sample } from "./useTelemetry";

export interface TraceSpec {
  /** null where the source has no value; the line breaks there */
  value: (sample: Sample) => number | null;
  /** Fixed axis range; values outside it extend the axis */
  min: number;
  max: number;
  /** Round the auto-extended top of the axis up to a multiple of this */
  maxStep?: number;
  digits: number;
  threshold?: { value: number; label: string };
}

const GUTTER_PX = 48; // right-hand axis labels
const PAD_Y_PX = 7;

export function drawTrace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  samples: readonly Sample[],
  spec: TraceSpec,
  nowWall: number,
  dim: boolean,
): void {
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, 0, w, h);

  let min = spec.min;
  let max = spec.max;
  for (const s of samples) {
    const v = spec.value(s);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (spec.maxStep && max > spec.max) max = Math.ceil(max / spec.maxStep) * spec.maxStep;
  if (max - min < 1e-6) max = min + 1;

  const plotW = w - GUTTER_PX;
  const top = PAD_Y_PX;
  const bottom = h - PAD_Y_PX;
  const toX = (t: number) => plotW - ((nowWall - t) / HISTORY_MS) * plotW;
  const toY = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);

  // Frame: top and bottom rules, right edge of the plot
  ctx.strokeStyle = P.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(top) + 0.5);
  ctx.lineTo(plotW, Math.round(top) + 0.5);
  ctx.moveTo(0, Math.round(bottom) + 0.5);
  ctx.lineTo(plotW, Math.round(bottom) + 0.5);
  ctx.moveTo(Math.round(plotW) + 0.5, top);
  ctx.lineTo(Math.round(plotW) + 0.5, bottom);
  ctx.stroke();

  ctx.font = `11px ${MONO_FONT}`;
  ctx.fillStyle = P.label;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(max.toFixed(spec.digits), plotW + 6, top + 4);
  ctx.fillText(min.toFixed(spec.digits), plotW + 6, bottom - 4);
  ctx.textBaseline = "alphabetic";
  ctx.fillText("-60 s", 3, top + 13);

  if (spec.threshold) {
    const ty = Math.round(toY(spec.threshold.value)) + 0.5;
    ctx.strokeStyle = P.caution;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(plotW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    // Flat backing so the label stays legible when the trace runs through it
    ctx.textAlign = "right";
    const labelW = ctx.measureText(spec.threshold.label).width;
    ctx.fillStyle = P.panel;
    ctx.fillRect(plotW - labelW - 7, ty - 14, labelW + 6, 13);
    ctx.fillStyle = P.caution;
    ctx.fillText(spec.threshold.label, plotW - 4, ty - 3);
    ctx.textAlign = "left";
  }

  // Trace line, broken wherever frames were missing
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, plotW, h);
  ctx.clip();
  ctx.strokeStyle = P.text;
  ctx.globalAlpha = dim ? 0.45 : 1;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let penDown = false;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const v = spec.value(s);
    if (v === null) {
      penDown = false;
      continue;
    }
    const px = toX(s.t);
    const py = toY(v);
    if (!penDown || s.t - samples[i - 1].t > SAMPLE_GAP_MS) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    penDown = true;
  }
  ctx.stroke();
  ctx.restore();
}
