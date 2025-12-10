/*
 Lucidify EDF Tools - Copyright (c) 2025 Lucidify
 All rights reserved.

 This source code is provided for use only within the Lucidify platform
 and associated research tools. Redistribution, reproduction, or use of
 any portion of this file outside Lucidify projects is not permitted
 without written permission.

 The algorithms and methods implemented here represent proprietary work
 under active development. Unauthorized reuse may violate copyright or
 research licensing agreements.

 If you need access, licensing, or integration support, contact:
 support@lucidify.ai
*/
(function () {
  "use strict";

  // These will be set by main.js so renderers can use the current view
  let maxViewSpanSecRef = { value: 60 };
  let viewStartSecRef   = { value: 0 };
  let viewDurationSecRef = { value: 10 };
  let spectrogramMaxHzRef = { value: null };
  let editingFreqRef = { value: false };
  let freqRangeLabelRef = { value: null };

  function bindViewState(opts) {
    maxViewSpanSecRef   = opts.maxViewSpanSecRef;
    viewStartSecRef     = opts.viewStartSecRef;
    viewDurationSecRef  = opts.viewDurationSecRef;
    spectrogramMaxHzRef = opts.spectrogramMaxHzRef;
    editingFreqRef      = opts.editingFreqRef;
    freqRangeLabelRef   = opts.freqRangeLabelRef;
  }

  function resizeCanvasToDisplaySize(canvas) {
    const rect = canvas.getBoundingClientRect();
    const displayWidth = Math.floor(rect.width);
    if (canvas.width !== displayWidth) {
      canvas.width = displayWidth;
    }
  }

  // ----------------- Waveform --------------------------------------------

  function drawWaveform(ctx, canvas, recording, visible) {
    resizeCanvasToDisplaySize(canvas);

    const { channels, durationSec } = recording;
    if (!channels || channels.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const maxViewSpanSec = maxViewSpanSecRef.value;
    const viewStartSec   = viewStartSecRef.value;
    const viewDurationSec = viewDurationSecRef.value;

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

      let minV = ch.displayMin;
      let maxV = ch.displayMax;
      if (!Number.isFinite(minV) || !Number.isFinite(maxV) || minV === maxV) {
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

  // ----------------- Spectrogram helpers ---------------------------------

  function hannWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    return w;
  }

  function fftRadix2(re, im) {
    const n = re.length;
    if (n !== im.length) throw new Error("re/im length mismatch");
    const levels = Math.log2(n) | 0;
    if (1 << levels !== n) throw new Error("FFT length must be power of 2");

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

  function hotColdColor(norm) {
    let t = norm;
    if (t < 0) t = 0;
    if (t > 1) t = 1;

    let r = 0, g = 0, b = 0;

    if (t <= 0.25) {
      const u = t / 0.25;
      b = Math.round(255 * u);
    } else if (t <= 0.5) {
      const u = (t - 0.25) / 0.25;
      g = Math.round(255 * u);
      b = Math.round(255 * (1 - u));
    } else if (t <= 0.75) {
      const u = (t - 0.5) / 0.25;
      r = Math.round(255 * u);
      g = 255;
    } else {
      const u = (t - 0.75) / 0.25;
      r = 255;
      g = Math.round(255 * (1 - u));
    }

    return [r, g, b];
  }

  function drawSpectrogram(ctx, canvas, recording, visible) {
    resizeCanvasToDisplaySize(canvas);

    const { channels, durationSec } = recording;
    if (!channels || channels.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const maxViewSpanSec = maxViewSpanSecRef.value;
    const viewStartSec   = viewStartSecRef.value;
    const viewDurationSec = viewDurationSecRef.value;
    let spectrogramMaxHz = spectrogramMaxHzRef.value;
    const editingFreq    = editingFreqRef.value;
    const freqRangeLabel = freqRangeLabelRef.value;

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

      if (fsForLabel == null && fs > 0) fsForLabel = fs;

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

    if (!fsForLabel) fsForLabel = 256;
    const nyquist = fsForLabel / 2;

    if (spectrogramMaxHz === null || !Number.isFinite(spectrogramMaxHz) || spectrogramMaxHz <= 0) {
      spectrogramMaxHz = nyquist;
    } else if (spectrogramMaxHz > nyquist) {
      spectrogramMaxHz = nyquist;
    }
    spectrogramMaxHzRef.value = spectrogramMaxHz;

    if (!editingFreq && freqRangeLabel) {
      freqRangeLabel.textContent = `Freq: 0–${spectrogramMaxHz.toFixed(1)} Hz`;
    }

    const effectiveMaxHz = spectrogramMaxHz;
    const maxBin = Math.max(
      1,
      Math.min(
        nFreq - 1,
        Math.floor((effectiveMaxHz / nyquist) * (nFreq - 1))
      )
    );

    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    for (let ci = 0; ci < nChannels; ci++) {
      const specRows = specs[ci];
      const nFrames = framesPerChannel[ci];
      if (!specRows || nFrames === 0) continue;

      const yStart = Math.floor(ci * channelHeight);
      const chHeight = Math.floor(channelHeight);

      for (let yLocal = 0; yLocal < chHeight; yLocal++) {
        const y = yStart + yLocal;
        if (y >= height) break;

        const freqFrac = 1 - yLocal / Math.max(1, chHeight - 1);
        const freqIndex = Math.min(maxBin, Math.floor(freqFrac * maxBin));

        for (let x = 0; x < width; x++) {
          const tFrac = x / Math.max(1, width - 1);
          const frameIndex = Math.min(nFrames - 1, Math.floor(tFrac * nFrames));
          const val = specRows[frameIndex][freqIndex];

          let norm = (val - globalMin) / (globalMax - globalMin);
          if (!Number.isFinite(norm)) norm = 0;

          let r, g, b;
          if (norm > 1.0) {
            r = g = b = 255;
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

  // Export
  window.LucidifyBindRenderViewState = bindViewState;
  window.LucidifyResizeCanvasToDisplaySize = resizeCanvasToDisplaySize;
  window.LucidifyDrawWaveform = drawWaveform;
  window.LucidifyDrawSpectrogram = drawSpectrogram;
})();
