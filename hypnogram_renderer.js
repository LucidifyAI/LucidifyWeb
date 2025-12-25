// hypnogram_renderer.js (classic script)
(function () {
  "use strict";
	window.renderHypnogram = renderHypnogram;
})();

const STAGE_TO_Y = { W: 0, N1: 1, N2: 2, N3: 3, REM: 4 };

function renderHypnogram(canvas, stages, options = {}) {
  const ctx = canvas.getContext("2d");

  const {
    padding = 10,
    rowHeight = 18,
    gap = 0,
    colors = {
      W:   "#f2c14e",
      N1:  "#a7c7e7",
      N2:  "#5fa8d3",
      N3:  "#1b4965",
      REM: "#f25c54",
      UNK: "#999999",
    },
    drawGrid = true,
    labelLeft = true,
  } = options;

  const rows = 5;
  const labelSpace = labelLeft ? 32 : 0;
  // Replace width computation with "fit to CSS width"
  const cssWidth = canvas.clientWidth || 900;
  const width = cssWidth;
  
  // keep height as before
  const height = padding * 2 + rows * rowHeight;
  
  // set backing resolution (optionally * devicePixelRatio)
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
  // compute epochWidth to fit
  const drawable = width - (padding * 2 + labelSpace);
  const epochWidth = Math.max(1, Math.floor(drawable / stages.length));
  
  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "middle";

  // grid + labels
  if (drawGrid) {
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    for (let r = 0; r <= rows; r++) {
      const y = padding + r * rowHeight;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(width - padding, y);
      ctx.stroke();
    }
  }

  if (labelLeft) {
    const labels = ["W", "N1", "N2", "N3", "REM"];
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    for (let r = 0; r < labels.length; r++) {
      const y = padding + r * rowHeight + rowHeight / 2;
      ctx.fillText(labels[r], padding, y);
    }
  }

  // epochs
  const x0 = padding + labelSpace;
  for (let e = 0; e < stages.length; e++) {
    const s = stages[e] ?? "UNK";
    const yRow = STAGE_TO_Y[s];
    if (yRow == null) continue;

    const x = x0 + e * (epochWidth + gap);
    const y = padding + yRow * rowHeight;

    ctx.fillStyle = colors[s] || colors.UNK;
    ctx.fillRect(x, y, epochWidth, rowHeight);
  }
}
function renderHypnogramStep(canvas, stages, options = {}) {
  const ctx = canvas.getContext("2d");

  const padding = options.padding ?? 10;
  const leftMargin = options.leftMargin ?? 80;
  const lineWidth = options.lineWidth ?? 2;

  // Stage order (top to bottom)
  const order = ["W", "REM", "N1", "N2", "N3"];
  const stageToLevel = new Map(order.map((s, i) => [s, i]));

  // Ensure canvas buffer matches display size
  // (assumes main.js already called resizeCanvasToDisplaySize(canvas))
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Draw labels
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#bbb";

  const plotTop = padding;
  const plotBottom = H - padding;
  const plotLeft = leftMargin;
  const plotRight = W - padding;

  const nLevels = order.length;
  const dy = (plotBottom - plotTop) / (nLevels - 1);

  for (let i = 0; i < nLevels; i++) {
    const y = plotTop + i * dy;
    ctx.fillText(order[i], 10, y);

    // light grid line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }

  if (!stages || stages.length === 0) return;

  // X scaling: fit all epochs into available width
  const n = stages.length;
  const dx = (plotRight - plotLeft) / Math.max(1, n - 1);

  // Build step path
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  function yForStage(stage) {
    const level = stageToLevel.has(stage) ? stageToLevel.get(stage) : stageToLevel.get("W");
    return plotTop + level * dy;
  }

  let x = plotLeft;
  let y = yForStage(stages[0]);
  ctx.moveTo(x, y);

  for (let i = 1; i < n; i++) {
    const x2 = plotLeft + i * dx;
    const y2 = yForStage(stages[i]);

    // step: horizontal to x2 at current y, then vertical to y2
    ctx.lineTo(x2, y);
    ctx.lineTo(x2, y2);

    x = x2;
    y = y2;
  }

  ctx.stroke();
}
function renderHypnogramStepOverlay(canvas, stages, options = {}) {
  const ctx = canvas.getContext("2d");

  const padding = options.padding ?? 10;
  const leftMargin = options.leftMargin ?? 80;
  const lineWidth = options.lineWidth ?? 2;

  // Style controls for overlay
  const strokeStyle = options.strokeStyle ?? "rgba(255,255,255,0.70)";
  const dash = options.dash ?? [6, 4];           // dashed overlay
  const drawLabels = options.drawLabels ?? false; // usually false for overlay
  const drawGrid = options.drawGrid ?? false;     // usually false for overlay

  // Stage order (top to bottom) must match renderHypnogramStep
  const order = ["W", "REM", "N1", "N2", "N3"];
  const stageToLevel = new Map(order.map((s, i) => [s, i]));

  const W = canvas.width;
  const H = canvas.height;

  // Plot bounds must match renderHypnogramStep
  const plotTop = padding;
  const plotBottom = H - padding;
  const plotLeft = leftMargin;
  const plotRight = W - padding;

  const nLevels = order.length;
  const dy = (plotBottom - plotTop) / (nLevels - 1);

  function yForStage(stage) {
    const level = stageToLevel.has(stage) ? stageToLevel.get(stage) : stageToLevel.get("W");
    return plotTop + level * dy;
  }

  // Optional labels/grid (off by default for overlay)
  if (drawGrid || drawLabels) {
    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    if (drawLabels) ctx.fillStyle = "#bbb";

    for (let i = 0; i < nLevels; i++) {
      const y = plotTop + i * dy;
      if (drawLabels) ctx.fillText(order[i], 10, y);

      if (drawGrid) {
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (!stages || stages.length === 0) return;

  // X scaling: fit all epochs into available width
  const n = stages.length;
  const dx = (plotRight - plotLeft) / Math.max(1, n - 1);

  // Draw step path on top (no clearRect)
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);

  ctx.beginPath();
  let x = plotLeft;
  let y = yForStage(stages[0]);
  ctx.moveTo(x, y);

  for (let i = 1; i < n; i++) {
    const x2 = plotLeft + i * dx;
    const y2 = yForStage(stages[i]);
    ctx.lineTo(x2, y);
    ctx.lineTo(x2, y2);
    x = x2;
    y = y2;
  }

  ctx.stroke();
  ctx.restore();
}

window.renderHypnogramStepOverlay = renderHypnogramStepOverlay;

window.renderHypnogramStep = renderHypnogramStep;

