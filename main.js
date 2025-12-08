console.log("Lucidify EEG Viewer starting…");

window.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("file-input");
  const fileInfo = document.getElementById("file-info");

  const waveformCanvas = document.getElementById("waveform-canvas");
  const waveformCtx = waveformCanvas.getContext("2d");
  
  const spectrogramCanvas = document.getElementById("spectrogram-canvas");
  const spectrogramCtx = spectrogramCanvas.getContext("2d");
  
  const waveformControls = document.getElementById("waveform-controls");
  const spectrogramControls = document.getElementById("spectrogram-controls");
  
  const zoomSlider = document.getElementById("zoom-slider");
  const panTrack = document.getElementById("pan-track");
  const panThumb = document.getElementById("pan-thumb");
  const timeLabel = document.getElementById("time-label");
  const freqRangeLabel = document.getElementById("freq-range-label");
  
  
  if (!fileInput || !fileInfo ||
      !waveformCanvas || !waveformCtx ||
      !spectrogramCanvas || !spectrogramCtx ||
      !waveformControls || !spectrogramControls ||
      !zoomSlider || !panTrack || !panThumb ||
      !timeLabel || !freqRangeLabel) {
    console.error("DOM not wired correctly");
    return;
  }
  
  let spectrogramMaxHz = null;   // null = auto (Nyquist)
  let editingFreq = false;
  
  let lastRecording = null;
  let waveformVisible = [];
  let spectrogramVisible = [];
  
  // shared view window (seconds)
  let viewStartSec = 0;
  let viewDurationSec = 10;
  let maxViewSpanSec = 60;
  
  let isPanning = false;
  
  if (!fileInput || !fileInfo || !waveformCanvas || !waveformCtx || !spectrogramCanvas || !spectrogramCtx) {
    console.error("DOM not wired correctly");
    return;
  }
 
  function resizeCanvasToDisplaySize(canvas) {
    const rect = canvas.getBoundingClientRect();
    const displayWidth = Math.floor(rect.width);
    if (canvas.width !== displayWidth) {
      canvas.width = displayWidth;
    }
  }
  freqRangeLabel.addEventListener("click", () => {
  if (editingFreq) return;
  if (!lastRecording) return;

  editingFreq = true;

  // current value to show in the input
  const current = Number.isFinite(spectrogramMaxHz)
    ? spectrogramMaxHz.toFixed(1)
    : "";

  // build inline input
  const input = document.createElement("input");
  input.type = "text";
  input.value = current;
  input.size = 6;
  input.style.background = "#222";
  input.style.color = "#eee";
  input.style.border = "1px solid #555";
  input.style.fontSize = "0.85rem";
  input.style.marginLeft = "0.25rem";
  input.style.marginRight = "0.25rem";

  // replace label content with "Freq: 0– [input] Hz"
  freqRangeLabel.textContent = "Freq: 0–";
  freqRangeLabel.appendChild(input);
  const hzSpan = document.createElement("span");
  hzSpan.textContent = " Hz";
  freqRangeLabel.appendChild(hzSpan);

  input.focus();
  input.select();

  function commit() {
    if (!editingFreq) return;
    editingFreq = false;

    const val = parseFloat(input.value);
    const fsForLabel =
      (lastRecording.channels.find(ch => ch.fs && ch.fs > 0)?.fs) || 256;
    const nyquist = fsForLabel / 2;

    if (!Number.isFinite(val) || val <= 0) {
      spectrogramMaxHz = nyquist;     // reset to auto if invalid
    } else {
      spectrogramMaxHz = Math.max(1, Math.min(val, nyquist));
    }

    // redraw; drawSpectrogram will rebuild the label text
    if (lastRecording) {
      drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
    }
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      editingFreq = false;
      // cancel: reset override to Nyquist
      spectrogramMaxHz = null;
      if (lastRecording) {
        drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
      }
    }
  });
});

window.addEventListener("resize", () => {
  resizeCanvasToDisplaySize(waveformCanvas);
  resizeCanvasToDisplaySize(spectrogramCanvas);
  updatePanThumb();
  if (lastRecording) {
    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
    drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
  }
});


  // --- Recording model -------------------------------------------------
  /**
   * @typedef {Object} Channel
   * @property {string} name
   * @property {number} fs         // sampling rate (Hz)
   * @property {Float32Array} samples
   */

  /**
   * @typedef {Object} Recording
   * @property {Channel[]} channels
   * @property {number} durationSec
   */

  /** @type {Recording | null} */
  // Fake test data so we can exercise the renderer
  function createFakeRecording() {
    const durationSec = 10;
    const fs = 256;
    const nSamples = durationSec * fs;

    /** @type {Channel[]} */
    const channels = [];

    const freqs = [8, 12, 4]; // pretend alpha, beta, theta, etc.
    const names = ["Cz", "Pz", "F3"];

    for (let ch = 0; ch < names.length; ch++) {
      const samples = new Float32Array(nSamples);
      const f = freqs[ch % freqs.length];
      for (let i = 0; i < nSamples; i++) {
        const t = i / fs;
        const sine = Math.sin(2 * Math.PI * f * t);
        const noise = (Math.random() - 0.5) * 0.3;
        samples[i] = sine + noise;
      }
      channels.push({
        name: names[ch],
        fs,
        samples,
      });
    }

	const recording = { durationSec, channels };
	computeDisplayRanges(recording);
	return recording;
  }
function buildChannelControls(recording) {
  const n = recording.channels.length;
  waveformVisible = new Array(n).fill(false);
  spectrogramVisible = new Array(n).fill(false);

  waveformControls.innerHTML = "";
  spectrogramControls.innerHTML = "";

  for (let i = 0; i < n; i++) {
    const name = recording.channels[i].name || `Ch ${i + 1}`;

    const defaultVisible = i < 2; // only first two on by default
    waveformVisible[i] = defaultVisible;
    spectrogramVisible[i] = defaultVisible;

    // Waveform checkbox
    const wLabel = document.createElement("label");
    wLabel.style.marginRight = "0.75rem";
    const wCb = document.createElement("input");
    wCb.type = "checkbox";
    wCb.checked = defaultVisible;
    wCb.dataset.index = String(i);
    wCb.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.index);
      waveformVisible[idx] = e.target.checked;
      if (lastRecording) {
        drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
      }
    });
    wLabel.appendChild(wCb);
    wLabel.appendChild(document.createTextNode(" " + name));
    waveformControls.appendChild(wLabel);

    // Spectrogram checkbox
    const sLabel = document.createElement("label");
    sLabel.style.marginRight = "0.75rem";
    const sCb = document.createElement("input");
    sCb.type = "checkbox";
    sCb.checked = defaultVisible;
    sCb.dataset.index = String(i);
    sCb.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.index);
      spectrogramVisible[idx] = e.target.checked;
      if (lastRecording) {
        drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
      }
    });
    sLabel.appendChild(sCb);
    sLabel.appendChild(document.createTextNode(" " + name));
    spectrogramControls.appendChild(sLabel);
  }
}

function updateTimeLabel() {
  if (!lastRecording) {
    timeLabel.textContent = "";
    return;
  }
  const start = viewStartSec;
  const end = viewStartSec + viewDurationSec;
  timeLabel.textContent =
    `Time: ${start.toFixed(1)}–${end.toFixed(1)} s (window ${viewDurationSec.toFixed(1)} s)`;
}

function updatePanThumb() {
  if (!lastRecording) {
    panThumb.style.width = "100%";
    panThumb.style.left = "0%";
    return;
  }

  const spanSec = Math.min(lastRecording.durationSec || 0, maxViewSpanSec);
  if (spanSec <= 0) {
    panThumb.style.width = "100%";
    panThumb.style.left = "0%";
    return;
  }

  const windowSec = Math.min(viewDurationSec, spanSec);
  const fracWidth = windowSec / spanSec;

  if (spanSec <= windowSec || fracWidth >= 0.999) {
    // fully zoomed out: thumb spans entire track
    panThumb.style.width = "100%";
    panThumb.style.left = "0%";
    return;
  }

  const maxStart = spanSec - windowSec;
  const clampedStart = Math.min(Math.max(viewStartSec, 0), maxStart);

  const widthPct = fracWidth * 100;
  const fracStart = clampedStart / maxStart;
  const leftPct = fracStart * (100 - widthPct);

  panThumb.style.width = `${widthPct}%`;
  panThumb.style.left = `${leftPct}%`;
}
function updateViewFromZoom() {
  if (!lastRecording) return;

  const spanSec = Math.min(lastRecording.durationSec || 0, maxViewSpanSec);
  const minWindowSec = 1;
  const span = Math.max(minWindowSec, spanSec);

  const zoomVal = Number(zoomSlider.value) || 0; // 0..100
  const tZoom = zoomVal / 100;
  viewDurationSec = span - tZoom * (span - minWindowSec);

  const maxStart = Math.max(0, span - viewDurationSec);
  viewStartSec = Math.min(Math.max(viewStartSec, 0), maxStart);

  updateTimeLabel();
  updatePanThumb();

  drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
  drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
}

zoomSlider.addEventListener("input", updateViewFromZoom);

function setViewStartFromPan(clientX) {
  if (!lastRecording) return;

  const spanSec = Math.min(lastRecording.durationSec || 0, maxViewSpanSec);
  const minWindowSec = 1;
  const span = Math.max(minWindowSec, spanSec);

  if (span <= viewDurationSec) {
    viewStartSec = 0;
    return;
  }

  const rect = panTrack.getBoundingClientRect();
  const x = clientX - rect.left;
  const fx = Math.min(Math.max(x / rect.width, 0), 1);

  const maxStart = span - viewDurationSec;
  viewStartSec = fx * maxStart;

  updateTimeLabel();
  updatePanThumb();

  drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
  drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
}

panTrack.addEventListener("mousedown", (e) => {
  isPanning = true;
  setViewStartFromPan(e.clientX);
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  setViewStartFromPan(e.clientX);
});

window.addEventListener("mouseup", () => {
  isPanning = false;
});
function computeDisplayRanges(recording) {
  if (!recording || !recording.channels) return;

  for (const ch of recording.channels) {
    const s = ch.samples;
    if (!s || s.length === 0) {
      ch.displayMin = -1;
      ch.displayMax = 1;
      continue;
    }

    let minV = Infinity;
    let maxV = -Infinity;

    // downsample for speed if very long
    const step = Math.max(1, Math.floor(s.length / 20000));
    for (let i = 0; i < s.length; i += step) {
      const v = s[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    if (!Number.isFinite(minV) || !Number.isFinite(maxV) || minV === maxV) {
      minV = -1;
      maxV = 1;
    }

    ch.displayMin = minV;
    ch.displayMax = maxV;
  }
}

//zoomSlider.addEventListener("input", updateViewFromSliders);
  // --- Waveform drawing ------------------------------------------------

  /**
   * Draws all channels of the recording stacked vertically.
   * Simple min/max-over-window renderer for speed.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Recording} recording
   */
  /**
 * Draws all channels of the recording stacked vertically.
 * Auto-scales each channel to fit its strip.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Recording} recording
 */
function drawWaveform(ctx, canvas, recording, visible) {
  resizeCanvasToDisplaySize(canvas);

  const { channels, durationSec } = recording;
  if (!channels || channels.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // effective span we’re using (clamped)
  const spanSec = Math.min(durationSec, maxViewSpanSec);
  const startSec = Math.min(viewStartSec, Math.max(0, spanSec - viewDurationSec));
  const windowSec = Math.min(viewDurationSec, spanSec);

  const indices = [];
  for (let i = 0; i < channels.length; i++) {
    if (!visible || visible[i]) indices.push(i);
  }
  if (indices.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const nChannels = indices.length;
  const channelHeight = height / nChannels;
  const padding = 4;

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 1;

  for (let ci = 0; ci < nChannels; ci++) {
    const chIndex = indices[ci];
    const ch = channels[chIndex];
    const samples = ch.samples;
    const fs = ch.fs || 256;

    const totalSpanSamples = Math.min(samples.length, Math.floor(spanSec * fs));
    const windowSamples = Math.min(Math.floor(windowSec * fs), totalSpanSamples);
    const startSample = Math.min(Math.floor(startSec * fs), totalSpanSamples - windowSamples);

    if (windowSamples <= 0) continue;

    const seg = samples.subarray(startSample, startSample + windowSamples);
    const nSamples = seg.length;

    const yTop = ci * channelHeight;
    const yMid = yTop + channelHeight / 2;

    ctx.fillStyle = "#aaa";
    ctx.font = "10px system-ui";
    ctx.fillText(ch.name || `Ch ${chIndex + 1}`, 5, yTop + 12);

    ctx.strokeStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(0, yMid);
    ctx.lineTo(width, yMid);
    ctx.stroke();

	// use global per-channel range so scale is stable across pan/zoom
	let minV = ch.displayMin;
	let maxV = ch.displayMax;

	if (!Number.isFinite(minV) || !Number.isFinite(maxV) || minV === maxV) {
	  // fallback to a simple +/-1 range if something went wrong
	  minV = -1;
	  maxV = 1;
	}

	const center = 0.5 * (maxV + minV);
	const halfRange = Math.max((maxV - minV) / 2, 1e-6);
	const scale = (channelHeight / 2 - padding) / halfRange;

    const samplesPerPixel = nSamples / width;

    ctx.strokeStyle = "#0f0";
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      const sampleStart = Math.floor(x * samplesPerPixel);
      const sampleEnd = Math.floor((x + 1) * samplesPerPixel);

      let localMin = Infinity;
      let localMax = -Infinity;

      for (let i = sampleStart; i < sampleEnd && i < nSamples; i++) {
        const v = seg[i];
        if (v < localMin) localMin = v;
        if (v > localMax) localMax = v;
      }
      if (!Number.isFinite(localMin) || !Number.isFinite(localMax)) continue;

      const yMin = yMid - (localMax - center) * scale;
      const yMax = yMid - (localMin - center) * scale;

      ctx.moveTo(x + 0.5, yMin);
      ctx.lineTo(x + 0.5, yMax);
    }

    ctx.stroke();
  }
}

// ---- Spectrogram helpers ----------------------------------------------

function hannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return w;
}

// in-place radix-2 Cooley–Tukey FFT on real/imag arrays
function fftRadix2(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error("re/im length mismatch");
  const levels = Math.log2(n) | 0;
  if (1 << levels !== n) throw new Error("FFT length must be power of 2");

  // bit-reverse
  for (let i = 0; i < n; i++) {
    let j = 0;
    for (let k = 0; k < levels; k++) {
      j = (j << 1) | ((i >> k) & 1);
    }
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = i + j;
        const l = k + half;
        const angle = step * j;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const tre = cos * re[l] - sin * im[l];
        const tim = sin * re[l] + cos * im[l];

        re[l] = re[k] - tre;
        im[l] = im[k] - tim;
        re[k] += tre;
        im[k] += tim;
      }
    }
  }
}
// Map 0..1 -> black→blue→green→yellow→red, >1 -> white
function hotColdColor(norm) {
  let t = norm;
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  let r = 0, g = 0, b = 0;

  if (t <= 0.25) {
    // black -> blue
    const u = t / 0.25;
    r = 0;
    g = 0;
    b = Math.round(255 * u);
  } else if (t <= 0.5) {
    // blue -> green
    const u = (t - 0.25) / 0.25;
    r = 0;
    g = Math.round(255 * u);
    b = Math.round(255 * (1 - u));
  } else if (t <= 0.75) {
    // green -> yellow
    const u = (t - 0.5) / 0.25;
    r = Math.round(255 * u);
    g = 255;
    b = 0;
  } else {
    // yellow -> red
    const u = (t - 0.75) / 0.25;
    r = 255;
    g = Math.round(255 * (1 - u));
    b = 0;
  }

  return [r, g, b];
}

/**
 * Draw a spectrogram for one channel.
 * Uses at most the first 60 seconds of data for speed.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Recording} recording
 * @param {number} channelIndex
 */
/**
 * Draw spectrograms for multiple channels stacked vertically.
 * Uses at most the first 60 seconds of each channel.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Recording} recording
 */
function drawSpectrogram(ctx, canvas, recording, visible) {
  resizeCanvasToDisplaySize(canvas);

  const { channels, durationSec } = recording;
  if (!channels || channels.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const indices = [];
  for (let i = 0; i < channels.length; i++) {
    if (!visible || visible[i]) indices.push(i);
  }
  if (indices.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const spanSec = Math.min(durationSec, maxViewSpanSec);
  const startSec = Math.min(viewStartSec, Math.max(0, spanSec - viewDurationSec));
  const windowSec = Math.min(viewDurationSec, spanSec);

  const width = canvas.width;
  const height = canvas.height;
  const maxChannelsToDraw = 8;
  const nChannels = Math.min(indices.length, maxChannelsToDraw);
  const channelHeight = height / nChannels;

  const winSize = 512;
  const hop = winSize >> 2;
  const nFreq = winSize >> 1;
  const window = hannWindow(winSize);


  // First pass: compute spectrograms and global min/max
  /** @type {Float32Array[][]} */
   const specs = new Array(nChannels);
  const framesPerChannel = new Array(nChannels);
  let globalMin = Infinity;
  let globalMax = -Infinity;

  let fsForLabel = null;

  for (let ci = 0; ci < nChannels; ci++) {
    const chIndex = indices[ci];
    const ch = channels[chIndex];
    const fs = ch.fs || 256;
    const samples = ch.samples;

    if (fsForLabel == null && fs > 0) {
      fsForLabel = fs;
    }

    const totalSpanSamples = Math.min(samples.length, Math.floor(spanSec * fs));
    const windowSamples = Math.min(Math.floor(windowSec * fs), totalSpanSamples);
    const startSample = Math.min(Math.floor(startSec * fs), totalSpanSamples - windowSamples);

    if (windowSamples < winSize + 1) {
      specs[ci] = null;
      framesPerChannel[ci] = 0;
      continue;
    }

    const segment = samples.subarray(startSample, startSample + windowSamples);
    const nFrames = Math.floor((segment.length - winSize) / hop) + 1;
    framesPerChannel[ci] = nFrames;

    const re = new Float32Array(winSize);
    const im = new Float32Array(winSize);
    const specRows = new Array(nFrames);

    for (let f = 0; f < nFrames; f++) {
      const offset = f * hop;
      for (let i = 0; i < winSize; i++) {
        const v = segment[offset + i] || 0;
        re[i] = v * window[i];
        im[i] = 0;
      }

      fftRadix2(re, im);

      const row = new Float32Array(nFreq);
      for (let k = 0; k < nFreq; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const val = Math.log10(mag + 1e-6);
        row[k] = val;
        if (val < globalMin) globalMin = val;
        if (val > globalMax) globalMax = val;
      }
      specRows[f] = row;
    }

    specs[ci] = specRows;
  }

	if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax) || globalMin === globalMax) {
	  ctx.clearRect(0, 0, width, height);
	  return;
	}

	// Nyquist and effective max display freq
	if (!fsForLabel) fsForLabel = 256;
	const nyquist = fsForLabel / 2;

	// If override is null or above Nyquist, clamp to Nyquist
	if (spectrogramMaxHz === null || !Number.isFinite(spectrogramMaxHz) || spectrogramMaxHz <= 0) {
	  spectrogramMaxHz = nyquist;
	} else if (spectrogramMaxHz > nyquist) {
	  spectrogramMaxHz = nyquist;
	}

	const effectiveMaxHz = spectrogramMaxHz;
	freqRangeLabel.textContent = `Freq: 0–${effectiveMaxHz.toFixed(1)} Hz`;

	// Precompute the highest bin we will show
	const maxBin = Math.max(
	  1,
	  Math.min(
		nFreq - 1,
		Math.floor((effectiveMaxHz / nyquist) * (nFreq - 1))
	  )
	);


  // Second pass: render into a single imageData
    // Second pass: render into a single imageData
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let ci = 0; ci < nChannels; ci++) {
    const chIndex = indices[ci]; // original channel index (for labels if needed)
    const specRows = specs[ci];  // use ci here, not chIndex
    const nFrames = framesPerChannel[ci];
    if (!specRows || nFrames === 0) continue;

    const yStart = Math.floor(ci * channelHeight);
    const chHeight = Math.floor(channelHeight);

    for (let yLocal = 0; yLocal < chHeight; yLocal++) {
      const y = yStart + yLocal;
      if (y >= height) break;

	const freqFrac = 1 - yLocal / Math.max(1, chHeight - 1);
	const freqIndex = Math.min(
	  maxBin,
	  Math.floor(freqFrac * maxBin)
	);

      for (let x = 0; x < width; x++) {
        const tFrac = x / Math.max(1, width - 1);
        const frameIndex = Math.min(nFrames - 1, Math.floor(tFrac * nFrames));
        const val = specRows[frameIndex][freqIndex];

        let norm = (val - globalMin) / (globalMax - globalMin);
        if (!Number.isFinite(norm)) norm = 0;

        let r, g, b;
        if (norm > 1.0) {
          r = g = b = 255; // clipping => white
        } else {
          [r, g, b] = hotColdColor(norm);
        }

        const idx = (y * width + x) * 4;
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}


// ---- EDF parsing ------------------------------------------------------

function readAscii(bytes, start, length) {
  const slice = bytes.slice(start, start + length);
  return new TextDecoder("ascii").decode(slice).trim();
}

function readNumber(bytes, start, length) {
  const txt = readAscii(bytes, start, length);
  const n = Number(txt);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse an EDF file into a Recording.
 * @param {ArrayBuffer} buffer
 * @returns {Recording}
 */
function parseEdf(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  // ---- main header (first 256 bytes) ----
  // EDF spec:
  // 184–191: header bytes
  // 236–243: number of data records
  // 244–251: duration of one data record (sec)
  // 252–255: number of signals
  const headerBytes          = readNumber(bytes, 184, 8);
  const nDataRecords         = readNumber(bytes, 236, 8);
  const durationSecPerRecord = readNumber(bytes, 244, 8);
  const nSignals             = readNumber(bytes, 252, 4);

  console.log("EDF headerBytes:", headerBytes,
              "nDataRecords:", nDataRecords,
              "dur/rec:", durationSecPerRecord,
              "nSignals:", nSignals);

  if (!Number.isFinite(headerBytes) ||
      !Number.isFinite(nSignals) ||
      nSignals <= 0 ||
      !Number.isFinite(durationSecPerRecord) ||
      durationSecPerRecord <= 0) {
    throw new Error("Invalid EDF header");
  }

  // ---- per-signal fields are stored column-wise, not 256 bytes per signal ----
  const base = 256; // start of signal header area

  const labelsOffset           = base;
  const transducerOffset       = labelsOffset           + 16 * nSignals;
  const physDimOffset          = transducerOffset       + 80 * nSignals;
  const physMinOffset          = physDimOffset          +  8 * nSignals;
  const physMaxOffset          = physMinOffset          +  8 * nSignals;
  const digMinOffset           = physMaxOffset          +  8 * nSignals;
  const digMaxOffset           = digMinOffset           +  8 * nSignals;
  const prefilterOffset        = digMaxOffset           +  8 * nSignals;
  const samplesPerRecordOffset = prefilterOffset        + 80 * nSignals;
  const reservedOffset         = samplesPerRecordOffset +  8 * nSignals;
  // headerBytes should be >= reservedOffset + 32 * nSignals

  const labels = [];
  const physMins = [];
  const physMaxs = [];
  const digMins = [];
  const digMaxs = [];
  const samplesPerRecord = [];

  for (let s = 0; s < nSignals; s++) {
    const label   = readAscii(bytes, labelsOffset           + 16 * s, 16);
    const physMin = readNumber(bytes, physMinOffset         +  8 * s, 8);
    const physMax = readNumber(bytes, physMaxOffset         +  8 * s, 8);
    const digMin  = readNumber(bytes, digMinOffset          +  8 * s, 8);
    const digMax  = readNumber(bytes, digMaxOffset          +  8 * s, 8);
    const nSamp   = readNumber(bytes, samplesPerRecordOffset+  8 * s, 8);

    labels.push(label || `Ch ${s + 1}`);
    physMins.push(physMin);
    physMaxs.push(physMax);
    digMins.push(digMin);
    digMaxs.push(digMax);
    samplesPerRecord.push(nSamp);
  }

  // ---- data records ----
  const bytesPerRecord =
    samplesPerRecord.reduce((acc, n) => acc + n * 2, 0);

  let records = nDataRecords;
  if (records <= 0) {
    records = Math.floor((bytes.length - headerBytes) / bytesPerRecord);
  }

  const durationSec = records * durationSecPerRecord;

  /** @type {Channel[]} */
  const channels = [];

  // precompute signal offsets inside one data record
  const signalOffsets = [];
  let off = 0;
  for (let s = 0; s < nSignals; s++) {
    signalOffsets.push(off);
    off += samplesPerRecord[s] * 2;
  }

  for (let s = 0; s < nSignals; s++) {
    const totalSamples = samplesPerRecord[s] * records;
    const samples = new Float32Array(totalSamples);

    const digMin = digMins[s];
    const digMax = digMaxs[s];
    const physMin = physMins[s];
    const physMax = physMaxs[s];

    const denom = (digMax - digMin) || 1;
    const scale = (physMax - physMin) / denom;
    const baseVal = physMin - scale * digMin;

    let writeIndex = 0;

    for (let r = 0; r < records; r++) {
      const recordBase = headerBytes + r * bytesPerRecord;
      const signalBase = recordBase + signalOffsets[s];
      const nSamp = samplesPerRecord[s];

      for (let i = 0; i < nSamp; i++) {
        const byteOffset = signalBase + i * 2;
        if (byteOffset + 1 >= bytes.length) break;
        const digit = dv.getInt16(byteOffset, true); // little-endian
        samples[writeIndex++] = baseVal + scale * digit;
      }
    }

    const fs = samplesPerRecord[s] / durationSecPerRecord;

    channels.push({
      name: labels[s],
      fs,
      samples,
    });
  }

  console.log("EDF parsed: channels =", channels.length,
              "durationSec =", durationSec);

	const recording = {
	  durationSec,
	  channels
	};

	computeDisplayRanges(recording);
	return recording;
}


  // --- File handling ---------------------------------------------------

  fileInput.addEventListener("change", (event) => {
    const input = event.target;
    if (!input.files || input.files.length === 0) {
      fileInfo.textContent = "No file selected.";
	lastRecording = null;
	waveformVisible = [];
	spectrogramVisible = [];
	waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
	spectrogramCtx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
	waveformControls.innerHTML = "";
	spectrogramControls.innerHTML = "";
      return;
    }

    const file = input.files[0];
    fileInfo.textContent = `Selected: ${file.name} (${file.size} bytes)`;

    console.log("Selected file:", file);

    const reader = new FileReader();
	reader.onload = () => {
	  const arrayBuffer = reader.result;
	  const bytes = new Uint8Array(arrayBuffer);
	  console.log("File loaded, first 64 bytes:", bytes.slice(0, 64));

	  try {
		// Simple extension check for now
		const name = (file.name || "").toLowerCase();
		if (name.endsWith(".edf")) {
		  lastRecording = parseEdf(arrayBuffer);
		  buildChannelControls(lastRecording);
		  maxViewSpanSec = Math.min(lastRecording.durationSec || 0, 60);
		if (maxViewSpanSec <= 0) maxViewSpanSec = 10;
   		  viewStartSec = 0;
   		  viewDurationSec = maxViewSpanSec;
   
     		  // reset sliders
   		  zoomSlider.value = "0";
   		  updateTimeLabel();
		  drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
		  drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
		} else {
		  console.warn("Unknown format, using fake data for now");
          lastRecording = createFakeRecording();
		  maxViewSpanSec = Math.min(lastRecording.durationSec || 0, 60);
		  viewStartSec = 0;
		  viewDurationSec = maxViewSpanSec;
		  zoomSlider.value = "0";
		  updateTimeLabel();
		  buildChannelControls(lastRecording);
          maxViewSpanSec = Math.min(lastRecording.durationSec || 0, 60);
          if (maxViewSpanSec <= 0) maxViewSpanSec = 10;
          
          viewStartSec = 0;
          viewDurationSec = maxViewSpanSec;
          
          // reset zoom to “full”
          zoomSlider.value = "0";
          updateTimeLabel();
          updatePanThumb();
          
          drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
          drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
		}

		console.log("Parsed recording:", lastRecording);
		drawWaveform(waveformCtx, waveformCanvas, lastRecording,waveformVisible);
		drawSpectrogram(spectrogramCtx,spectrogramCanvas,lastRecording,spectrogramVisible);
	  } catch (err) {
		console.error("Error parsing EDF:", err);
		fileInfo.textContent = "Error parsing EDF file.";
	  }
	};

    reader.onerror = (err) => {
      console.error("Error reading file", err);
      fileInfo.textContent = "Error reading file.";
    };

    reader.readAsArrayBuffer(file);
  });

  // Initial dummy drawing so we see something
  lastRecording = createFakeRecording();
  drawWaveform(waveformCtx, waveformCanvas, lastRecording);
  drawSpectrogram(spectrogramCtx,spectrogramCanvas,lastRecording);
});
