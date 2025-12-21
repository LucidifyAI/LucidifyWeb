// hypnogram_render.js
const STAGE_TO_Y = { W: 0, N1: 1, N2: 2, N3: 3, REM: 4 };

export function renderHypnogram(canvas, stages, options = {}) {
  const ctx = canvas.getContext("2d");

  const {
    padding = 10,
    rowHeight = 18,
    epochWidth = 2,          // adjust based on duration/zoom
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
  const width = padding * 2 + labelSpace + stages.length * (epochWidth + gap);
  const height = padding * 2 + rows * rowHeight;

  canvas.width = width;
  canvas.height = height;

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
