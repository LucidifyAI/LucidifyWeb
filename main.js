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
console.log("Lucidify EEG Viewer starting…");

window.addEventListener("DOMContentLoaded", () => {
  const viewerSections = document.getElementById("views");
  viewerSections.classList.add("hidden");
  const fileInput = document.getElementById("file-input");
  const fileInfo = document.getElementById("file-info");

  const waveformCanvas = document.getElementById("waveform-canvas");
  const waveformCtx = waveformCanvas.getContext("2d");
  
  const spectrogramCanvas = document.getElementById("spectrogram-canvas");
  const spectrogramCtx = spectrogramCanvas.getContext("2d");
  
  const hypnogramCanvas = document.getElementById("hypnogram-canvas");
  
  const waveformControls = document.getElementById("waveform-controls");
  const spectrogramControls = document.getElementById("spectrogram-controls");
  const hypnogramControls = document.getElementById("hypnogram-controls");
  
  const zoomSlider = document.getElementById("zoom-slider");
  const panTrack = document.getElementById("pan-track");
  const panThumb = document.getElementById("pan-thumb");
  const timeLabel = document.getElementById("time-label");
  const freqRangeLabel = document.getElementById("freq-range-label");
  
  const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB, tweak as needed
  
  const saveViewButton = document.getElementById("save-view-button");
  const spectrogramRefreshBtn = document.getElementById("spectrogram-refresh-button");
  const hypnogramRefreshBtn   = document.getElementById("hypnogram-refresh-button");
  
  const spectrogramChannelControls = document.getElementById("spectrogram-channel-controls");
  const hypnogramChannelControls   = document.getElementById("hypnogram-channel-controls");
  
  spectrogramRefreshBtn?.addEventListener("click", async () => {
    if (!lastRecording) return;
    setSectionLoading(spectrogramSection, true);
    await nextPaint();
    try {
      drawSpectrogram(
        spectrogramCtx,
        spectrogramCanvas,
        lastRecording,
        spectrogramVisible
      );
    } finally {
      setSectionLoading(spectrogramSection, false);
    }
  });
  
  hypnogramRefreshBtn?.addEventListener("click", async () => {
    if (!lastRecording) return;
    setSectionLoading(hypnogramSection, true);
    await nextPaint();
    try {
      await renderHypnogramFromSelection();
    } finally {
      setSectionLoading(hypnogramSection, false);
    }
  });
  // Optional large-file segment loader (from large_edf_segment_loader.js)
  const segmentLoader = window.LargeEdfSegmentLoader
    ? new window.LargeEdfSegmentLoader({
        thresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
        onSegmentReady: (recording) => {
          setLoading(false);
          fileInfo.textContent = "Loaded EDF segment.";
          useRecording(recording);
        },
        onCancelled: (reason) => {
          setLoading(false);
          console.log("Large EDF segment load cancelled/failed:", reason);
          fileInfo.textContent = "Large EDF load cancelled.";
        }
      })
    : null;

  
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
  let lastFileName = null; 
  let waveformVisible = [];
  let spectrogramVisible = [];
  let hypnogramVisible = [];
  let referenceHypno = null;
  
  // shared view window (seconds)
  let viewStartSec = 0;
  let viewDurationSec = 10;
  let maxViewSpanSec = 60;
  
  let isPanning = false;
  
  

  // Bind EDF parser and renderers from separate modules
  const parseEdf = window.LucidifyParseEdf;
  const createFakeRecording = window.LucidifyCreateFakeRecording;
  const drawWaveform = window.LucidifyDrawWaveform;
  const drawSpectrogram = window.LucidifyDrawSpectrogram;
  const resizeCanvasToDisplaySize = window.LucidifyResizeCanvasToDisplaySize;
  
  const waveformSection = document.getElementById("waveform-section");
  const spectrogramSection = document.getElementById("spectrogram-section");
  const hypnogramSection = document.getElementById("hypnogram-section");
  let flipSecondChannelVert = false;
  const flipSecondChannelVertRef = {
    get value() { return flipSecondChannelVert; },
    set value(v) { flipSecondChannelVert = !!v; }
  };
flipSecondChannelVertRef.value = true; 
  if (window.LucidifyBindRenderViewState) {
    window.LucidifyBindRenderViewState({
      maxViewSpanSecRef:   { get value() { return maxViewSpanSec; },   set value(v) { maxViewSpanSec = v; } },
      viewStartSecRef:     { get value() { return viewStartSec; },     set value(v) { viewStartSec = v; } },
      viewDurationSecRef:  { get value() { return viewDurationSec; },  set value(v) { viewDurationSec = v; } },
      spectrogramMaxHzRef: { get value() { return spectrogramMaxHz; }, set value(v) { spectrogramMaxHz = v; } },
      editingFreqRef:      { get value() { return editingFreq; },      set value(v) { editingFreq = v; } },
      freqRangeLabelRef:   { get value() { return freqRangeLabel; } },
	  flipSecondChannelVertRef,
    });
  }

  if (!fileInput || !fileInfo || !waveformCanvas || !waveformCtx || !spectrogramCanvas || !spectrogramCtx) {
    console.error("DOM not wired correctly");
    return;
  }
  
  // --- UI / state helpers ------------------------------------------------
  function setSectionLoading(sectionEl, isLoading) {
    if (!sectionEl) return;
    const overlay = sectionEl.querySelector(".section-overlay");
    if (overlay) overlay.classList.toggle("hidden", !isLoading);
    sectionEl.classList.toggle("loading", isLoading);
  }

function redrawWaveform() {
  if (!lastRecording) return;

  // IMPORTANT: update backing-store size to match CSS size
  resizeCanvasToDisplaySize(waveformCanvas);

  // Draw using current viewStartSec/viewDurationSec (your renderer reads bound state)
  drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
}
let resizeRAF = 0;
window.addEventListener("resize", () => {
  if (resizeRAF) cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = 0;

    updatePanThumb();

    if (!lastRecording) return;

    resizeCanvasToDisplaySize(waveformCanvas);
    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);

    // Optional (heavier): only if you want them to stay crisp on resize
    // resizeCanvasToDisplaySize(spectrogramCanvas);
    // drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
    // resizeCanvasToDisplaySize(hypnogramCanvas);
    // renderHypnogramFromSelection();
  });
});
  // --- Hypnogram model selector (Physio vs BOAS vs YASA) ----------------------
function ensureHypnogramModelSelector() {
  if (!hypnogramControls) return;
  if (document.getElementById("hypnogram-model-physio")) return;

  const wrap = document.createElement("div");
  wrap.className = "hypnogram-model-controls";
  wrap.innerHTML = `
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <span style="opacity:0.8;">Model:</span>
      <label><input type="radio" id="hypnogram-model-physio" name="hypnogram-model" value="physio" checked> Physio</label>
      <label><input type="radio" name="hypnogram-model" value="boas"> BOAS</label>
      <label><input type="radio" name="hypnogram-model" value="yasa"> YASA</label>
  
      <span style="width:16px;"></span>
  
      <button id="hypnogram-load-ref" type="button" title="Load a reference hypnogram (EDF/TSV)">Load Ref</button>
      <button id="hypnogram-clear-ref" type="button" title="Clear reference overlay">Clear Ref</button>
      <input id="hypnogram-ref-input" type="file" accept=".edf,.tsv" style="display:none" />
    </div>
  `;
  hypnogramControls.prepend(wrap);
  const refBtn   = wrap.querySelector("#hypnogram-load-ref");
  const clrBtn   = wrap.querySelector("#hypnogram-clear-ref");
  const refInput = wrap.querySelector("#hypnogram-ref-input");
  refBtn?.addEventListener("click", () => refInput?.click());

  clrBtn?.addEventListener("click", async () => {
    referenceHypno = null;
    if (!lastRecording) return;
    setSectionLoading(hypnogramSection, true);
    await nextPaint();
    try { await renderHypnogramFromSelection(); }
    finally { setSectionLoading(hypnogramSection, false); }
  });
  
  refInput?.addEventListener("change", async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
  
    const nameLower = (f.name || "").toLowerCase();
  
    const buf = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(f);
    });
  
    if (nameLower.endsWith(".edf")) {
		referenceHypno = window.HYPNO_REF.parseSleepEdfHypnogramFromArrayBuffer(buf, {
		  epochSec: 30,
		  mapToAasm: true,
		  totalDurationSec: Number(lastRecording?.durationSec) || null,
		});
      referenceHypno.sourceName = f.name;
    } else if (nameLower.endsWith(".tsv")) {
		const tsvText = new TextDecoder("utf-8").decode(new Uint8Array(buf));
	referenceHypno = window.HYPNO_REF.parseBidsEventsTsvToHypnogram(tsvText, {
	epochSec: 30,
	totalDurationSec: lastRecording?.durationSec,
	fs: lastRecording?.channels?.[0]?.fs, // if you want begsample alignment
	preferSamples: true,
	// stageColumn: "stage_hum", // optional override
	sourceName: f.name,
	});
    } else {
      throw new Error("Unsupported ref hypnogram format (use .edf or .tsv).");
    }
    if (!lastRecording) return;
    setSectionLoading(hypnogramSection, true);
    await nextPaint();
    try { await renderHypnogramFromSelection(); }
    finally { setSectionLoading(hypnogramSection, false); refInput.value = "";  }
  });
  wrap.addEventListener("change", async () => {
    if (!lastRecording) return;
    setSectionLoading(hypnogramSection, true);
    await nextPaint();
    try {
      await renderHypnogramFromSelection();
    } finally {
      setSectionLoading(hypnogramSection, false);
    }
  });
}

function getSelectedHypnogramModelUrl() {
  const v =
    document.querySelector('input[name="hypnogram-model"]:checked')?.value ||
    "physio";

  if (v === "boas") return "model_boas.json";
  if (v === "yasa") return "model_yasa.json";
  return "model_physio.json";
}

  const loadingOverlay = document.getElementById("loading-overlay");
  
  function setLoading(isLoading) {
    if (!loadingOverlay) return;
    loadingOverlay.classList.toggle("hidden", !isLoading);
  }
  function updateTimeLabel() {
    if (!lastRecording) {
      timeLabel.textContent = "";
      return;
    }
    const end = viewStartSec + viewDurationSec;
    timeLabel.textContent =
      `Time: ${viewStartSec.toFixed(2)}–${end.toFixed(2)} s / ` +
      `${lastRecording.durationSec.toFixed(2)} s`;
  }
  function mergeChannels(recording, indices) {
    const chans = recording.channels;
    const fs = chans[indices[0]].fs;
  
    let minLen = Infinity;
    for (const i of indices) {
      if (chans[i].fs !== fs) {
        throw new Error("Hypnogram channels must share the same sampling rate.");
      }
      minLen = Math.min(minLen, chans[i].samples.length);
    }
  
    const out = new Float32Array(minLen);
    for (const i of indices) {
      const s = chans[i].samples;
      for (let j = 0; j < minLen; j++) out[j] += s[j];
    }
  
    const inv = 1 / indices.length;
    for (let j = 0; j < minLen; j++) out[j] *= inv;
  
    return { samples: out, fs, physDim: chans[indices[0]].physDim };
  }
  
  function normalizeToVolts(samples, physDim) {
    const d = (physDim || "").trim();
    let mul = 1.0;
    if (d === "uV" || d === "µV") mul = 1e-6;
    else if (d === "mV") mul = 1e-3;
  
    if (mul === 1.0) return samples;
  
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * mul;
    return out;
  }
  function nextPaint() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }
  function sliceView(samples, fs) {
    const startSamp = Math.max(0, Math.floor(viewStartSec * fs));
    const endSamp = Math.min(samples.length, Math.floor((viewStartSec + viewDurationSec) * fs));
    if (endSamp <= startSamp) return samples.subarray(0, 0);
    return samples.subarray(startSamp, endSamp);
  }
  function viterbiSmoothSleepStages(probs, labels) {
  // probs: Array[T] of Array[K] (K must match labels.length)
    const T = probs?.length || 0;
    const K = labels?.length || 0;
    if (!T || !K) return [];
  
    const eps = 1e-12;
  
    // ---- Transition model (hand-tuned, simple but effective) ----
    // High self-transition; discourage impossible jumps.
    // Order matches labels: ["W","N1","N2","N3","REM"]
    // You can tweak these later.
    const A = [
      //  W     N1    N2    N3    REM
      [0.94, 0.05, 0.009, 0.0005, 0.0005], // W
      [0.08, 0.84, 0.07,  0.005,  0.005 ], // N1
      [0.02, 0.08, 0.86,  0.03,   0.01  ], // N2
      [0.005,0.01, 0.08,  0.90,   0.005 ], // N3
      [0.06, 0.03, 0.08,  0.005,  0.825 ], // REM
    ];
  
    // Initial state prior (typical: start awake)
    const pi = [0.90, 0.08, 0.02, 0.0, 0.0];
  
    // Precompute logs
    const logA = A.map(row => row.map(p => Math.log(Math.max(p, eps))));
    const logPi = pi.map(p => Math.log(Math.max(p, eps)));
  
    // dp[t][k] = best log prob ending in state k at time t
    const dp = Array.from({ length: T }, () => new Float64Array(K));
    const back = Array.from({ length: T }, () => new Int16Array(K));
  
    // t = 0
    for (let k = 0; k < K; k++) {
      const e = Math.log(Math.max(probs[0][k] ?? 0, eps));
      dp[0][k] = logPi[k] + e;
      back[0][k] = 0;
    }
  
    // t > 0
    for (let t = 1; t < T; t++) {
      for (let k = 0; k < K; k++) {
        const e = Math.log(Math.max(probs[t][k] ?? 0, eps));
        let bestVal = -Infinity;
        let bestJ = 0;
        for (let j = 0; j < K; j++) {
          const v = dp[t - 1][j] + logA[j][k];
          if (v > bestVal) { bestVal = v; bestJ = j; }
        }
        dp[t][k] = bestVal + e;
        back[t][k] = bestJ;
      }
    }
  
    // Termination
    let lastK = 0;
    let bestLast = dp[T - 1][0];
    for (let k = 1; k < K; k++) {
      if (dp[T - 1][k] > bestLast) { bestLast = dp[T - 1][k]; lastK = k; }
    }
  
    // Backtrack
    const path = new Array(T);
    for (let t = T - 1; t >= 0; t--) {
      path[t] = labels[lastK];
      lastK = back[t][lastK];
    }
    return path;
  }
 
//---------------------------------------------------------------------------
//---------------------RenderHypnogramFromSelection
async function renderHypnogramFromSelection() {
    if (!lastRecording) return;
    console.log("rendering hypnogram from selection");
    ensureHypnogramModelSelector();
  
    resizeCanvasToDisplaySize(hypnogramCanvas);
    hypnogramCanvas.height = 160;
    const ctx = hypnogramCanvas.getContext("2d");
    ctx.clearRect(0, 0, hypnogramCanvas.width, hypnogramCanvas.height);
  
    const indices = [];
    for (let i = 0; i < hypnogramVisible.length; i++) {
      if (hypnogramVisible[i]) indices.push(i);
    }
    if (indices.length === 0) return;
  
    const merged = mergeChannels(lastRecording, indices);
    const fs = merged.fs;
    
    // Keep original units for YASA
    const samplesNative_full = merged.samples;      // in merged.physDim (often µV)
    // Keep volts for Lucidify LR models
    const samplesV_full = normalizeToVolts(samplesNative_full, merged.physDim);
    
    // Slice both using the same indices
    let windowSamplesNative = sliceView(samplesNative_full, fs);
    let windowSamplesV      = sliceView(samplesV_full, fs);
    let windowStartSecUsed = viewStartSec;
    let windowSamples = sliceView(samplesV_full, fs);
    // Ensure at least 1 epoch (apply same a/b to both)
    const epochSamp = Math.floor(30 * fs);
    if (windowSamplesV.length < epochSamp) {
      const centerSec = viewStartSec + viewDurationSec / 2;
      const center = Math.floor(centerSec * fs);
      let a = Math.max(0, center - Math.floor(epochSamp / 2));
      let b = Math.min(samplesV_full.length, a + epochSamp);
      a = Math.max(0, b - epochSamp);
    
      windowSamplesV      = samplesV_full.slice(a, b);
      windowSamplesNative = samplesNative_full.slice(a, b);
  	windowStartSecUsed = a / fs;
    }
  
    const selected =
      document.querySelector('input[name="hypnogram-model"]:checked')?.value || "physio";
  
    let stages, probs;
  
    if (selected === "yasa") {
      if (!window.LucidifyYasaSleepStage?.runFromSamples) {
        throw new Error("YASA selected, but LucidifyYasaSleepStage is not loaded.");
      }
      ({ stages, probs } = await window.LucidifyYasaSleepStage.runFromSamples(
        windowSamplesNative, fs, { epochSec: 30, physDim: merged.physDim }
      ));
    } else if (window.LucidifySleepStage?.run) {
      const modelUrl = getSelectedHypnogramModelUrl();
      ({ stages, probs } = await window.LucidifySleepStage.run(
        {
          channels: [{ name: "merged", fs, physDim: merged.physDim, samples: windowSamplesV }],
          durationSec: windowSamplesV.length / fs,
        },
        { epochSec: 30, channelIndex: 0, modelUrl }
      ));
    } else if (window.LucidifySleepStage?.runFromSamples) {
      const modelUrl = getSelectedHypnogramModelUrl();
      ({ stages, probs } = await window.LucidifySleepStage.runFromSamples(
        windowSamplesV,
        fs,
        { epochSec: 30, modelUrl }
      ));
    } else {
      throw new Error("No sleep staging API found (LucidifySleepStage.run or runFromSamples).");
    }
  
    const hmmCb = document.getElementById("hypnogram-hmm-checkbox");
    let stagesToDraw = stages;
  
    if (hmmCb?.checked && Array.isArray(probs) && probs.length === stages.length) {
      const labels = ["W", "N1", "N2", "N3", "REM"];
      stagesToDraw = viterbiSmoothSleepStages(probs, labels);
    }
  
    window.renderHypnogramStep(hypnogramCanvas, stagesToDraw, { leftMargin: 80 });
    
    if (referenceHypno?.stages?.length) {
      const epochSec = referenceHypno.epochSec || 30;
      const startEpoch = Math.floor(windowStartSecUsed / epochSec);
      const refSlice = referenceHypno.stages.slice(startEpoch, startEpoch + stagesToDraw.length);
    
      // Overlay using same coordinate mapping + step style as the base renderer
		window.renderHypnogramStepOverlay(hypnogramCanvas, refSlice, {
		  leftMargin: 80,
		  lineWidth: 2,
		  dash: [], // solid
		  strokeStyle: "rgba(255, 255, 0, .5)", 
		});
    
      const m = window.HYPNO_REF.compareStages(stagesToDraw, refSlice);
      console.log(
        `Ref compare (${referenceHypno.sourceName || "ref"}): ` +
        `N=${m.N} acc=${(m.acc * 100).toFixed(1)}% kappa=${m.kappa.toFixed(3)}`
      );
    }
  }
//------------------------------------------------------------------------------------------
  function stageToY(stage) {
    // Matches label order W, REM, N1, N2, N3 (top -> bottom)
    if (stage === "W") return 0;
    if (stage === "REM") return 1;
    if (stage === "N1") return 2;
    if (stage === "N2") return 3;
    if (stage === "N3") return 4;
    return null;
  }
  


  // Pan thumb reflects which portion of the recording we’re viewing.
  function updatePanThumb() {
    if (!lastRecording || !panTrack) return;
    const trackRect = panTrack.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    const duration = lastRecording.durationSec || 1;
    const span = Math.min(duration, maxViewSpanSec);
    const windowSpan = Math.min(viewDurationSec, span);

    if (span <= 0 || windowSpan <= 0) {
      panThumb.style.width = "0px";
      panThumb.style.transform = "translateX(0px)";
      return;
    }

    const ratio = windowSpan / span;
    const thumbWidth = Math.max(10, trackWidth * ratio);

	const clampedStart = Math.max(0, Math.min(viewStartSec, span - windowSpan));
	const maxStart = Math.max(0, span - windowSpan);

	// position should be 0..1 over the travel range
	const posRatio = (maxStart > 0) ? (clampedStart / maxStart) : 0;

	const x = (trackWidth - thumbWidth) * posRatio;

	panThumb.style.width = `${thumbWidth}px`;
	panThumb.style.transform = `translateX(${x}px)`;
  }

  // If the user drags the pan thumb, we reposition the view window.
  function panToFraction(frac) {
    if (!lastRecording) return;
    frac = Math.min(Math.max(frac, 0), 1);

    const duration = lastRecording.durationSec || 1;
    const span = Math.min(duration, maxViewSpanSec);
    const windowSpan = Math.min(viewDurationSec, span);
    if (span <= 0 || windowSpan <= 0) return;

    const maxStart = span - windowSpan;
    viewStartSec = frac * maxStart;

    updateTimeLabel();
    updatePanThumb();

    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
  }

  // --- Channel visibility controls --------------------------------------

  /**
   * Rebuild the checkboxes for wave/spectrogram visibility.
   * @param {Recording} recording
     */
  function buildChannelControls(recording) {
    waveformControls.innerHTML = "";
    spectrogramChannelControls.innerHTML = "";
    hypnogramChannelControls.innerHTML = "";
  
  
    // Bind HMM toggle once (do not bind inside channel loop)
    const hmmCbGlobal = document.getElementById("hypnogram-hmm-checkbox");
    if (hmmCbGlobal && !hmmCbGlobal.dataset.bound) {
      hmmCbGlobal.dataset.bound = "1";
      hmmCbGlobal.addEventListener("change", async () => {
        if (!lastRecording) return;
        setSectionLoading(hypnogramSection, true);
        await nextPaint();
        try {
          await renderHypnogramFromSelection();
        } finally {
          setSectionLoading(hypnogramSection, false);
        }
      });
    }
  
    const channels = recording.channels || [];
    const n = channels.length;
  
    // Start with all channels OFF…
    waveformVisible = new Array(n).fill(false);
    spectrogramVisible = new Array(n).fill(false);
    hypnogramVisible = new Array(n).fill(false);
  
    channels.forEach((ch, idx) => {
      const name = ch.name || `Ch ${idx + 1}`;
  
      // Only the first two channels visible initially
      const defaultVisible = idx < 2;
      waveformVisible[idx] = defaultVisible;
      spectrogramVisible[idx] = defaultVisible;
  
      // --- Waveform checkbox ---
      const wLabel = document.createElement("label");
      const wCb = document.createElement("input");
      wCb.type = "checkbox";
      wCb.checked = defaultVisible;
      wCb.addEventListener("change", async () => {  
	  waveformVisible[idx] = wCb.checked;
  
	  setSectionLoading(waveformSection, true);  
	  await nextPaint();  
	  try {  
		drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);  
	  } finally {  
		setSectionLoading(waveformSection, false);  
	  }  
	});
      wLabel.appendChild(wCb);
      wLabel.appendChild(document.createTextNode(" " + name));
      waveformControls.appendChild(wLabel);
      waveformControls.appendChild(document.createElement("br"));
  
      // --- Spectrogram checkbox ---
      const sLabel = document.createElement("label");
      const sCb = document.createElement("input");
      sCb.type = "checkbox";
      sCb.checked = defaultVisible;
      sCb.addEventListener("change", async () => {
        spectrogramVisible[idx] = sCb.checked;
  
	  setSectionLoading(spectrogramSection, true);  
	  await nextPaint();  
	  try {  
		drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);  
	  } finally {  
		setSectionLoading(spectrogramSection, false);  
	  }
      });
      sLabel.appendChild(sCb);
      sLabel.appendChild(document.createTextNode(" " + name));
      spectrogramChannelControls.appendChild(sLabel);
      spectrogramChannelControls.appendChild(document.createElement("br"));  
	  
	// --- Hypnogram checkbox ---  
	// sensible default: first EEG-like channel ON  
	const hLabel = document.createElement("label");  
	const hCb = document.createElement("input");  
	hCb.type = "checkbox";  
	const defaultHypno = idx === 0;  
	hCb.checked = defaultHypno;  
	hypnogramVisible[idx] = defaultHypno;
  
	hCb.addEventListener("change", async () => {  
	  hypnogramVisible[idx] = hCb.checked;
  
	  setSectionLoading(hypnogramSection, true);  
	  await nextPaint();  
	  try {  
		await renderHypnogramFromSelection();
      } finally {  
		setSectionLoading(hypnogramSection, false);  
	  }  
	});

	hLabel.appendChild(hCb);  
	hLabel.appendChild(  
	  document.createTextNode(` ${ch.name}${ch.physDim ? " (" + ch.physDim + ")" : ""}`)  
	);  
	hypnogramChannelControls.appendChild(hLabel);  
	hypnogramChannelControls.appendChild(document.createElement("br"));
    });
  }
  
  
  // --- Zoom slider -------------------------------------------------------

  zoomSlider.addEventListener("input", () => {
    if (!lastRecording) return;
    const sliderVal = Number(zoomSlider.value);
  
    const duration = lastRecording.durationSec || 1;
    maxViewSpanSec = duration;
  
    const minWindow = Math.min(0.25, duration);
    const maxWindow = duration;
  
    const minV = Number(zoomSlider.min || 1);
    const maxV = Number(zoomSlider.max || 100);
    const v = Math.min(Math.max(sliderVal, minV), maxV);
    const t = (maxV === minV) ? 1 : ((v - minV) / (maxV - minV)); // 0..1
  
    const lnMin = Math.log(minWindow);
    const lnMax = Math.log(maxWindow);
    const lnVal = lnMin + (lnMax - lnMin) * (1 - t);
    viewDurationSec = Math.exp(lnVal);
  
    const span = Math.min(duration, maxViewSpanSec);
    const maxStart = Math.max(0, span - viewDurationSec);
    viewStartSec = Math.min(Math.max(viewStartSec, 0), maxStart);
  
    updateTimeLabel();
    updatePanThumb();
  
    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
  });
  
  // --- Pan thumb dragging ------------------------------------------------

  panThumb.addEventListener("mousedown", (event) => {
    if (!lastRecording) return;
    isPanning = true;
    event.preventDefault();
  });

  document.addEventListener("mouseup", () => {
    isPanning = false;
  });

  document.addEventListener("mousemove", (event) => {
    if (!isPanning || !lastRecording) return;

    const rect = panTrack.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const frac = x / Math.max(rect.width, 1);

    panToFraction(frac);
  });

  // --- Click pan track to reposition ------------------------------------

  panTrack.addEventListener("mousedown", (event) => {
    if (!lastRecording) return;
  
    const rect = panTrack.getBoundingClientRect();
    const trackWidth = rect.width;
    if (trackWidth <= 0) return;
  
    const duration = lastRecording.durationSec || 1;
    const span = Math.min(duration, maxViewSpanSec);
    const windowSpan = Math.min(viewDurationSec, span);
    const maxStart = Math.max(0, span - windowSpan);
  
    const ratio = (span > 0) ? (windowSpan / span) : 1;
    const thumbWidth = Math.max(10, trackWidth * ratio);
    const travel = Math.max(1, trackWidth - thumbWidth);
  
    // click position, then convert to "thumb-left" so the thumb centers on the click
    const clickX = event.clientX - rect.left;
    const thumbLeft = Math.min(Math.max(clickX - thumbWidth / 2, 0), travel);
    const frac = thumbLeft / travel; // 0..1 over travel
  
    viewStartSec = frac * maxStart;
  
    updateTimeLabel();
    updatePanThumb();
  
    // keep pan/zoom fast: waveform only
    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
  });

  // --- Frequency range editing ------------------------------------------

  freqRangeLabel.addEventListener("click", () => {
    if (!lastRecording) return;
    if (editingFreq) return;

    editingFreq = true;

    const oldText = freqRangeLabel.textContent || "";
    const currentMax = spectrogramMaxHz || 0;

    while (freqRangeLabel.firstChild) {
      freqRangeLabel.removeChild(freqRangeLabel.firstChild);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentMax > 0 ? String(currentMax) : "";
    input.style.width = "80px";

    const spanHz = document.createElement("span");
    spanHz.textContent = " Hz";

    freqRangeLabel.appendChild(document.createTextNode("Freq: 0–"));
    freqRangeLabel.appendChild(input);
    freqRangeLabel.appendChild(spanHz);

    input.focus();
    input.select();

    function finishEditing(cancel) {
      if (!editingFreq) return;
      editingFreq = false;

      while (freqRangeLabel.firstChild) {
        freqRangeLabel.removeChild(freqRangeLabel.firstChild);
      }

      if (cancel) {
        freqRangeLabel.textContent = oldText;
        return;
      }

      const val = Number(input.value);
      const fs = lastRecording.channels?.[0]?.fs || 256;
      const nyquist = fs / 2;

      if (!Number.isFinite(val) || val <= 0) {
        spectrogramMaxHz = null;
      } else {
        spectrogramMaxHz = Math.min(Math.max(val, 1), nyquist);
      }

		const shownMax = (spectrogramMaxHz == null) ? nyquist : spectrogramMaxHz;
		freqRangeLabel.textContent = `Freq: 0–${shownMax.toFixed(1)} Hz`;

	  if (lastRecording) {
	    (async () => {
		  setSectionLoading(spectrogramSection, true);
		  await nextPaint(); // lets overlay render before heavy work
		  try {
		    drawSpectrogram(
		  	spectrogramCtx,
		  	spectrogramCanvas,
		  	lastRecording,
		  	spectrogramVisible
		    );
		  } finally {
		    setSectionLoading(spectrogramSection, false);
		  }
	    })();
	  }  
    }

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        finishEditing(false);
      } else if (ev.key === "Escape") {
        finishEditing(true);
      }
    });

    input.addEventListener("blur", () => {
      finishEditing(false);
    });
  });

  // --- Use a new Recording ----------------------------------------------

  /**
   * Called when we’ve loaded a (possibly partial) EDF Recording.
   * @param {Recording} recording
   */
  function useRecording(recording) {
	viewerSections.classList.remove("hidden");
    lastRecording = recording;

    if (!recording || !recording.channels || recording.channels.length === 0) {
      fileInfo.textContent = "No data in recording.";
      waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
      spectrogramCtx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
      waveformControls.innerHTML = "";
      spectrogramControls.innerHTML = "";
      timeLabel.textContent = "";
      updatePanThumb();
	  if (saveViewButton) saveViewButton.disabled = true;
      return;
    }
	if (saveViewButton) saveViewButton.disabled = false;
    buildChannelControls(lastRecording);
    maxViewSpanSec = lastRecording.durationSec || 10;
    if (maxViewSpanSec <= 0) maxViewSpanSec = 10;

    viewStartSec = 0;
    viewDurationSec = maxViewSpanSec;

    zoomSlider.value = "0";

	resizeCanvasToDisplaySize(waveformCanvas);
	resizeCanvasToDisplaySize(spectrogramCanvas);
	resizeCanvasToDisplaySize(hypnogramCanvas);   

    updateTimeLabel();
    updatePanThumb();

    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);

	// one extra pass after layout settles
	requestAnimationFrame(() => {
	  resizeCanvasToDisplaySize(waveformCanvas);
	  drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
	});
    drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
	setSectionLoading(hypnogramSection, true);
	nextPaint().then(async () => {
      try {
        await renderHypnogramFromSelection();
      } finally {
        setSectionLoading(hypnogramSection, false);
      }
    });
  }
	if (saveViewButton) {
	  saveViewButton.addEventListener("click", () => {
		if (!lastRecording) return;

		// Use waveform visibility as “selected channels”
		const channelIndices = [];
		for (let i = 0; i < waveformVisible.length; i++) {
		  if (waveformVisible[i]) channelIndices.push(i);
		}
		if (channelIndices.length === 0) {
		  alert("No channels selected to save.");
		  return;
		}

		const baseName =
		  (lastFileName ? lastFileName.replace(/\.[^.]+$/, "") : "recording") +
		  "_view";
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${baseName}_${timestamp}.edf`;

		window.LucidifyDownloadEdfFromView({
		  recording: lastRecording,
		  channelIndices,
		  viewStartSec,
		  viewDurationSec,
		  patientId: "X",
		  recordingId: `Trimmed from ${lastFileName || "EDF"}`,
		  filename
		});
	  });
	}

  // --- File handling ---------------------------------------------------

  fileInput.addEventListener("change", async (event) => {
	try{

		const input = event.target;
		if (!input.files || !input.files.length) {
		fileInfo.textContent = "No file selected.";
		return;
		}
	
		const file = input.files[0];
		setLoading(true);
		await new Promise(requestAnimationFrame);
		const { name, size } = file;
	
		fileInfo.textContent = `Selected file: ${name} (${(size / (1024 * 1024)).toFixed(2)} MB)`;
	
		lastFileName = name;
		if (saveViewButton) {
		saveViewButton.disabled = true; // will re-enable once recording is valid
		}
	
		if (segmentLoader && size >= LARGE_FILE_THRESHOLD_BYTES) {
		  try {
			const taken = segmentLoader.handleFile(file);
			if (taken) {
			  // IMPORTANT: global overlay must be off here, because FileReader won't run.
			  setLoading(false);

			  fileInfo.textContent = "Large EDF: choose channels/segment…";
			  return; // Segment loader will call onSegmentReady later
			}
		  } catch (err) {
			console.warn("Segment loader failed, falling back:", err);
		  }
		}
	
	
		const reader = new FileReader();
	
		reader.onload = (ev) => {
		try {
			const arrayBuffer = ev.target.result;
			const nameLower = (name || "").toLowerCase();
	
			if (nameLower.endsWith(".edf")) {
			const recording = parseEdf(arrayBuffer);
			useRecording(recording);
			} else {
			console.warn("Unknown format, using fake data for now");
			const recording = createFakeRecording();
			useRecording(recording);
			}
		} catch (err) {
			console.error("Error parsing EDF:", err);
			fileInfo.textContent = "Error parsing EDF file.";
		}
		};
	
		reader.onerror = (err) => {
		console.error("Error reading file", err);
		fileInfo.textContent = "Error reading file.";
		};
		reader.onloadend = () => {
		  setLoading(false);
		};
		reader.readAsArrayBuffer(file);
	}catch(err){
		 console.error("Error parsing EDF:", err);
		 setLoading(false);
	}
	  
  });

});
