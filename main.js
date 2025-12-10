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
  
  const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB, tweak as needed
  
  const saveViewButton = document.getElementById("save-view-button");
  // Optional large-file segment loader (from large_edf_segment_loader.js)
  const segmentLoader = window.LargeEdfSegmentLoader
    ? new window.LargeEdfSegmentLoader({
        thresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
        onSegmentReady: (recording) => {
          fileInfo.textContent = "Loaded EDF segment.";
          useRecording(recording);
        },
        onCancelled: (reason) => {
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

  if (window.LucidifyBindRenderViewState) {
    window.LucidifyBindRenderViewState({
      maxViewSpanSecRef:   { get value() { return maxViewSpanSec; },   set value(v) { maxViewSpanSec = v; } },
      viewStartSecRef:     { get value() { return viewStartSec; },     set value(v) { viewStartSec = v; } },
      viewDurationSecRef:  { get value() { return viewDurationSec; },  set value(v) { viewDurationSec = v; } },
      spectrogramMaxHzRef: { get value() { return spectrogramMaxHz; }, set value(v) { spectrogramMaxHz = v; } },
      editingFreqRef:      { get value() { return editingFreq; },      set value(v) { editingFreq = v; } },
      freqRangeLabelRef:   { get value() { return freqRangeLabel; } },
    });
  }

  if (!fileInput || !fileInfo || !waveformCanvas || !waveformCtx || !spectrogramCanvas || !spectrogramCtx) {
    console.error("DOM not wired correctly");
    return;
  }
  
  // --- UI / state helpers ------------------------------------------------

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
    const posRatio = clampedStart / span;
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
    drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
  }

  // --- Channel visibility controls --------------------------------------

  /**
   * Rebuild the checkboxes for wave/spectrogram visibility.
   * @param {Recording} recording
   */
function buildChannelControls(recording) {
  waveformControls.innerHTML = "";
  spectrogramControls.innerHTML = "";

  const channels = recording.channels || [];
  const n = channels.length;

  // Start with all channels OFF…
  waveformVisible = new Array(n).fill(false);
  spectrogramVisible = new Array(n).fill(false);

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
    wCb.addEventListener("change", (e) => {
      waveformVisible[idx] = e.target.checked;
      if (lastRecording) {
        drawWaveform(
          waveformCtx,
          waveformCanvas,
          lastRecording,
          waveformVisible
        );
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
    sCb.addEventListener("change", (e) => {
      spectrogramVisible[idx] = e.target.checked;
      if (lastRecording) {
        drawSpectrogram(
          spectrogramCtx,
          spectrogramCanvas,
          lastRecording,
          spectrogramVisible
        );
      }
    });
    sLabel.appendChild(sCb);
    sLabel.appendChild(document.createTextNode(" " + name));
    spectrogramControls.appendChild(sLabel);
    spectrogramControls.appendChild(document.createElement("br"));
  });
}


  // --- Zoom slider -------------------------------------------------------

  zoomSlider.addEventListener("input", () => {
    if (!lastRecording) return;
    const sliderVal = Number(zoomSlider.value) || 1;

    const duration = lastRecording.durationSec || 1;
    maxViewSpanSec = duration;

    const minWindow = 0.25;
    const maxWindow = Math.min(duration, maxViewSpanSec);
    const t = sliderVal / 100;
    const lnMin = Math.log(minWindow);
    const lnMax = Math.log(maxWindow);
    const lnVal = lnMin + (lnMax - lnMin) * (1 - t);
    viewDurationSec = Math.exp(lnVal);

    const maxStart = Math.max(0, duration - viewDurationSec);
    viewStartSec = Math.min(Math.max(viewStartSec, 0), maxStart);

    updateTimeLabel();
    updatePanThumb();

    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
    drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
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
    const x = event.clientX - rect.left;
    const frac = x / Math.max(rect.width, 1);

    panToFraction(frac);
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

      freqRangeLabel.textContent =
        `Freq: 0–${spectrogramMaxHz.toFixed(1)} Hz`;

      if (lastRecording) {
        drawSpectrogram(
          spectrogramCtx,
          spectrogramCanvas,
          lastRecording,
          spectrogramVisible
        );
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

  // --- Window resize handling -------------------------------------------

  window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize(waveformCanvas);
    resizeCanvasToDisplaySize(spectrogramCanvas);
    updatePanThumb();
    if (lastRecording) {
      drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
      drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
    }
  });

  // --- Use a new Recording ----------------------------------------------

  /**
   * Called when we’ve loaded a (possibly partial) EDF Recording.
   * @param {Recording} recording
   */
  function useRecording(recording) {
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

    updateTimeLabel();
    updatePanThumb();

    drawWaveform(waveformCtx, waveformCanvas, lastRecording, waveformVisible);
    drawSpectrogram(spectrogramCtx, spectrogramCanvas, lastRecording, spectrogramVisible);
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

  fileInput.addEventListener("change", (event) => {
    const input = event.target;
    if (!input.files || !input.files.length) {
      fileInfo.textContent = "No file selected.";
      return;
    }

    const file = input.files[0];
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
          fileInfo.textContent = "Loading large EDF segment…";
          return; // Large loader will call onSegmentReady/useRecording later
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

    reader.readAsArrayBuffer(file);
  });



  // Initial dummy drawing so we see something
  lastRecording = createFakeRecording();
  drawWaveform(waveformCtx, waveformCanvas, lastRecording);
  drawSpectrogram(spectrogramCtx,spectrogramCanvas,lastRecording);
});
