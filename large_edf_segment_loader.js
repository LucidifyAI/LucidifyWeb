// LargeEdfSegmentLoader
// - Intercepts large EDF files
// - Lets the user choose a time window and subset of channels
// - Loads only that segment into memory and returns a Recording object:
//     { durationSec: number, channels: [ { name, fs, samples: Float32Array } ] }

(function () {
  "use strict";

  // ---------- Small EDF header helpers (local, no external dependencies) ----------

  function edfReadAscii(bytes, start, length) {
    const slice = bytes.subarray(start, start + length);
    return new TextDecoder("ascii").decode(slice).trim();
  }

  function edfReadNumber(bytes, start, length) {
    const txt = edfReadAscii(bytes, start, length);
    const n = Number(txt);
    return Number.isNaN(n) ? 0 : n;
  }

  // Parse only the EDF header: enough to know duration, channel layout, and scaling.
  function parseEdfHeaderForSegment(buffer) {
    const bytes = new Uint8Array(buffer);

    const headerBytes          = edfReadNumber(bytes, 184, 8);
    const nDataRecords         = edfReadNumber(bytes, 236, 8);
    const durationSecPerRecord = edfReadNumber(bytes, 244, 8);
    const nSignals             = edfReadNumber(bytes, 252, 4);

    if (!Number.isFinite(headerBytes) || headerBytes < 256 ||
        !Number.isFinite(nDataRecords) || nDataRecords <= 0 ||
        !Number.isFinite(durationSecPerRecord) || durationSecPerRecord <= 0 ||
        !Number.isFinite(nSignals) || nSignals <= 0) {
      throw new Error("Invalid EDF header");
    }

    const base = 256;

    const labelOffset            = base;
    const transducerOffset       = labelOffset            + 16 * nSignals;
    const physDimOffset          = transducerOffset       + 80 * nSignals;
    const physMinOffset          = physDimOffset          +  8 * nSignals;
    const physMaxOffset          = physMinOffset          +  8 * nSignals;
    const digMinOffset           = physMaxOffset          +  8 * nSignals;
    const digMaxOffset           = digMinOffset           +  8 * nSignals;
    const prefilterOffset        = digMaxOffset           +  8 * nSignals;
    const samplesPerRecordOffset = prefilterOffset        + 80 * nSignals;
    // const reserved2Offset     = samplesPerRecordOffset +  8 * nSignals;

    const labels            = new Array(nSignals);
    const physMin           = new Array(nSignals);
    const physMax           = new Array(nSignals);
    const digMin            = new Array(nSignals);
    const digMax            = new Array(nSignals);
    const samplesPerRecord  = new Array(nSignals);
    const samplingRatesHz   = new Array(nSignals);

    for (let s = 0; s < nSignals; s++) {
      labels[s]           = edfReadAscii(bytes, labelOffset            + 16 * s, 16);
      physMin[s]          = edfReadNumber(bytes, physMinOffset         +  8 * s,  8);
      physMax[s]          = edfReadNumber(bytes, physMaxOffset         +  8 * s,  8);
      digMin[s]           = edfReadNumber(bytes, digMinOffset          +  8 * s,  8);
      digMax[s]           = edfReadNumber(bytes, digMaxOffset          +  8 * s,  8);
      samplesPerRecord[s] = edfReadNumber(bytes, samplesPerRecordOffset + 8 * s, 8);

      const nPerRec = samplesPerRecord[s] || 0;
      samplingRatesHz[s] = nPerRec > 0 ? nPerRec / durationSecPerRecord : 0;
    }

    const totalSamplesPerRecord = samplesPerRecord.reduce((a, b) => a + b, 0);
    const durationSec = nDataRecords * durationSecPerRecord;

    return {
      headerBytes,
      nDataRecords,
      durationSecPerRecord,
      nSignals,
      labels,
      physMin,
      physMax,
      digMin,
      digMax,
      samplesPerRecord,
      samplingRatesHz,
      totalSamplesPerRecord,
      durationSec
    };
  }

  // ---------- Main class ----------

  class LargeEdfSegmentLoader {
    /**
     * @param {Object} options
     * @param {number} options.thresholdBytes - If file.size > threshold, show segment UI.
     * @param {function(recording:Object)} options.onSegmentReady - Called with Recording.
     * @param {function(reason?:any)} [options.onCancelled] - Called if user cancels or header fails.
     */
    constructor(options) {
      this.thresholdBytes = options.thresholdBytes || 100 * 1024 * 1024;
      this.onSegmentReady = options.onSegmentReady;
      this.onCancelled = options.onCancelled || function () {};
      this.root = options.root || document.body;

      this._currentFile = null;
      this._headerInfo = null;
	  this._headerBytesRaw = null;

      this._overlay = null;
      this._channelContainer = null;
      this._startInput = null;
      this._durationInput = null;
      this._infoText = null;
      this._submitBtn = null;
      this._cancelBtn = null;
    }

    /**
     * Try to handle the file as "large EDF". Returns true if it took over the flow.
     * If it returns false, caller should proceed with normal full-file load.
     * @param {File} file
     * @returns {boolean}
     */
    handleFile(file) {
      if (!file) return false;
      if (file.size <= this.thresholdBytes) {
        return false; // small enough: let caller handle normally
      }

      this._currentFile = file;

      // Read only the first chunk for the header
      const headerSlice = file.slice(0, 16384);
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
      	  const buf = e.target.result;
      	  const info = parseEdfHeaderForSegment(buf);
      	  this._headerInfo = info;
      	  // Store exact header bytes for later mini-EDF construction
      	  this._headerBytesRaw = buf.slice(0, info.headerBytes);
      	  this._showOverlay();
        } catch (err) {
          console.error("Failed to parse EDF header for large file flow:", err);
          this._currentFile = null;
          this._headerInfo = null;
		  this._headerBytesRaw = null;
          this.onCancelled({ reason: "header-parse-failed", error: err });
        }
      };
      reader.readAsArrayBuffer(headerSlice);
      return true;
    }

    // ---------- UI overlay ----------

    _ensureOverlayDom() {
      if (this._overlay) return;

      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.75)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "9999";

      const panel = document.createElement("div");
      panel.style.background = "#181818";
      panel.style.border = "1px solid #444";
      panel.style.borderRadius = "8px";
      panel.style.padding = "1rem";
      panel.style.maxWidth = "480px";
      panel.style.width = "90%";
      panel.style.color = "#eee";
      panel.style.fontFamily = "system-ui, sans-serif";
      panel.style.fontSize = "0.9rem";
      panel.style.boxShadow = "0 4px 16px rgba(0,0,0,0.5)";

      const title = document.createElement("h3");
      title.textContent = "Load EDF segment";
      title.style.marginTop = "0";
      title.style.marginBottom = "0.5rem";

      const info = document.createElement("div");
      info.style.marginBottom = "0.75rem";

      const timeRow = document.createElement("div");
      timeRow.style.display = "flex";
      timeRow.style.flexWrap = "wrap";
      timeRow.style.gap = "0.5rem";
      timeRow.style.marginBottom = "0.75rem";

      const startLabel = document.createElement("label");
      startLabel.textContent = "Start (s): ";
      const startInput = document.createElement("input");
      startInput.type = "number";
      startInput.step = "0.1";
      startInput.min = "0";
      startInput.value = "0";
      startInput.style.width = "6rem";
      startInput.style.background = "#222";
      startInput.style.color = "#eee";
      startInput.style.border = "1px solid #555";

      startLabel.appendChild(startInput);

      const durLabel = document.createElement("label");
      durLabel.textContent = "Duration (s): ";
      const durInput = document.createElement("input");
      durInput.type = "number";
      durInput.step = "0.1";
      durInput.min = "0.1";
      durInput.value = "300"; // default 5 minutes
      durInput.style.width = "6rem";
      durInput.style.background = "#222";
      durInput.style.color = "#eee";
      durInput.style.border = "1px solid #555";

      durLabel.appendChild(durInput);

      timeRow.appendChild(startLabel);
      timeRow.appendChild(durLabel);

      const chanTitle = document.createElement("div");
      chanTitle.textContent = "Channels to load:";
      chanTitle.style.marginBottom = "0.25rem";

      const channelContainer = document.createElement("div");
      channelContainer.style.maxHeight = "160px";
      channelContainer.style.overflowY = "auto";
      channelContainer.style.border = "1px solid #333";
      channelContainer.style.borderRadius = "4px";
      channelContainer.style.padding = "0.25rem 0.5rem";
      channelContainer.style.marginBottom = "0.75rem";

      const buttonsRow = document.createElement("div");
      buttonsRow.style.display = "flex";
      buttonsRow.style.justifyContent = "flex-end";
      buttonsRow.style.gap = "0.5rem";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.background = "#333";
      cancelBtn.style.color = "#eee";
      cancelBtn.style.border = "1px solid #555";
      cancelBtn.style.borderRadius = "4px";
      cancelBtn.style.padding = "0.25rem 0.75rem";
      cancelBtn.style.cursor = "pointer";

      const submitBtn = document.createElement("button");
      submitBtn.textContent = "Load segment";
      submitBtn.style.background = "#0a7";
      submitBtn.style.color = "#fff";
      submitBtn.style.border = "1px solid #0c8";
      submitBtn.style.borderRadius = "4px";
      submitBtn.style.padding = "0.25rem 0.75rem";
      submitBtn.style.cursor = "pointer";

      buttonsRow.appendChild(cancelBtn);
      buttonsRow.appendChild(submitBtn);

      panel.appendChild(title);
      panel.appendChild(info);
      panel.appendChild(timeRow);
      panel.appendChild(chanTitle);
      panel.appendChild(channelContainer);
      panel.appendChild(buttonsRow);

      overlay.appendChild(panel);
      this.root.appendChild(overlay);

      this._overlay = overlay;
      this._channelContainer = channelContainer;
      this._startInput = startInput;
      this._durationInput = durInput;
      this._infoText = info;
      this._cancelBtn = cancelBtn;
      this._submitBtn = submitBtn;

      cancelBtn.addEventListener("click", () => {
        this._hideOverlay();
        this._currentFile = null;
        this._headerInfo = null;
        this.onCancelled({ reason: "user-cancelled" });
      });
      submitBtn.addEventListener("click", () => this._onSubmit());
    }

    _showOverlay() {
      this._ensureOverlayDom();
      const file = this._currentFile;
      const info = this._headerInfo;
      if (!file || !info) return;

      const mb = (file.size / (1024 * 1024)).toFixed(1);
      this._infoText.textContent =
        `File: ${file.name} (${mb} MB), duration: ${info.durationSec.toFixed(1)} s, ` +
        `${info.nSignals} channels`;

      // Build channel checkbox list
      this._channelContainer.innerHTML = "";
      for (let i = 0; i < info.nSignals; i++) {
        const lbl = info.labels[i] || `Ch ${i + 1}`;
        const row = document.createElement("label");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "0.5rem";
        row.style.fontSize = "0.85rem";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = String(i);
        cb.checked = i < 2; // default: first two channels

        const span = document.createElement("span");
        span.textContent = lbl;

        row.appendChild(cb);
        row.appendChild(span);
        this._channelContainer.appendChild(row);
      }

      this._overlay.style.display = "flex";
    }

    _hideOverlay() {
      if (this._overlay) {
        this._overlay.style.display = "none";
      }
    }

    _onSubmit() {
      if (!this._currentFile || !this._headerInfo) return;

      const startSec = Math.max(0, Number(this._startInput.value) || 0);
      const durationSec = Math.max(0.1, Number(this._durationInput.value) || 0.1);

      const checkboxes = this._channelContainer.querySelectorAll("input[type=checkbox]");
      const selectedIndices = [];
      checkboxes.forEach((cb) => {
        if (cb.checked) {
          selectedIndices.push(Number(cb.value));
        }
      });

      if (selectedIndices.length === 0) {
        alert("Please select at least one channel.");
        return;
      }

      // UI feedback
      this._submitBtn.disabled = true;
      this._cancelBtn.disabled = true;
      this._submitBtn.textContent = "Loading…";

      this._loadSegment(startSec, durationSec, selectedIndices);
    }

    // ---------- Segment loading & decoding ----------

      _loadSegment(startSec, windowSec, selectedIndices) {
      const file = this._currentFile;
      const info = this._headerInfo;
      if (!file || !info || !this._headerBytesRaw) return;

      const {
        headerBytes,
        nDataRecords,
        durationSecPerRecord,
        samplesPerRecord,
        totalSamplesPerRecord,
        durationSec
      } = info;

      const bytesPerRecord = totalSamplesPerRecord * 2;

      const clampedStart = Math.min(Math.max(0, startSec), durationSec);
      const endReq = clampedStart + windowSec;
      const clampedEnd = Math.min(endReq, durationSec);

      const startRec = Math.floor(clampedStart / durationSecPerRecord);
      const endRec = Math.max(startRec + 1, Math.ceil(clampedEnd / durationSecPerRecord));
      const recCount = Math.min(nDataRecords - startRec, endRec - startRec);

      const byteStart = headerBytes + startRec * bytesPerRecord;
      const byteEnd = byteStart + recCount * bytesPerRecord;

      const slice = file.slice(byteStart, byteEnd);
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const dataBuf = e.target.result;

          // Build a mini-EDF: [original header (patched nDataRecords)] + [this slice of data]
          const miniBuf = this._buildMiniEdfBuffer(this._headerBytesRaw, info, dataBuf, recCount);

          // Reuse the existing full EDF parser so scaling is identical
		  const parseEdfFn = window.LucidifyParseEdf;
   		  if (!parseEdfFn) {
   		    throw new Error("parseEdf not available on window.LucidifyParseEdf");
   		  }
   		  let recording = parseEdfFn(miniBuf);
   
          // If channels were selected, drop the others
          if (selectedIndices && selectedIndices.length) {
            const channels = [];
            for (const idx of selectedIndices) {
              if (recording.channels[idx]) {
                channels.push(recording.channels[idx]);
              }
            }
            if (channels.length) {
              recording = {
                durationSec: recording.durationSec,
                channels
              };
            }
          }

          this._hideOverlay();
          this._submitBtn.disabled = false;
          this._cancelBtn.disabled = false;
          this._submitBtn.textContent = "Load segment";
          this._currentFile = null;
          this._headerInfo = null;
          this._headerBytesRaw = null;

          this.onSegmentReady(recording);
        } catch (err) {
          console.error("Failed to decode EDF segment:", err);
          this._submitBtn.disabled = false;
          this._cancelBtn.disabled = false;
          this._submitBtn.textContent = "Load segment";
          alert("Failed to load EDF segment.");
          this.onCancelled({ reason: "segment-decode-failed", error: err });
        }
      };
      reader.readAsArrayBuffer(slice);
    }
    _buildMiniEdfBuffer(headerBuf, info, dataBuf, recCount) {
      const headerBytes = info.headerBytes;

      // Copy original header bytes
      const headerView = new Uint8Array(headerBuf.slice(0, headerBytes));

      // Allocate new buffer: header + selected records
      const totalLen = headerBytes + dataBuf.byteLength;
      const out = new Uint8Array(totalLen);

      out.set(headerView, 0);
      out.set(new Uint8Array(dataBuf), headerBytes);

      // Patch "number of data records" field (ASCII, 8 chars) at bytes 236–243
      const enc = new TextEncoder();
      let recStr = String(recCount);
      if (recStr.length > 8) {
        recStr = recStr.slice(0, 8);
      } else {
        recStr = recStr.padEnd(8, " ");
      }
      out.set(enc.encode(recStr), 236);

      return out.buffer;
    }

    _decodeSegment(dataBuf, info, selectedIndices, recCount, clampedStart, clampedEnd) {
      const {
        durationSecPerRecord,
        labels,
        physMin,
        physMax,
        digMin,
        digMax,
        samplesPerRecord,
        totalSamplesPerRecord,
        samplingRatesHz
      } = info;

      const bytesPerRecord = totalSamplesPerRecord * 2;
      const view = new DataView(dataBuf);

      // Precompute channel offsets within a record (in bytes)
      const chanOffsetBytes = new Array(info.nSignals);
      let offsetSamples = 0;
      for (let i = 0; i < info.nSignals; i++) {
        chanOffsetBytes[i] = offsetSamples * 2;
        offsetSamples += samplesPerRecord[i] || 0;
      }

      const channels = [];

      for (const chIndex of selectedIndices) {
        const nPerRec = samplesPerRecord[chIndex] || 0;
        const fs = samplingRatesHz[chIndex] || 0;
        const label = labels[chIndex] || `Ch ${chIndex + 1}`;

        const nSamplesTotal = nPerRec * recCount;
        const out = new Float32Array(nSamplesTotal);

        const pMin = physMin[chIndex];
        const pMax = physMax[chIndex];
        const dMin = digMin[chIndex];
        const dMax = digMax[chIndex];

        const spanPhys = pMax - pMin || 1;
        const spanDig = dMax - dMin || 1;
        const scale = spanPhys / spanDig;

        const chanOffset = chanOffsetBytes[chIndex];

        let writePos = 0;
        for (let r = 0; r < recCount; r++) {
          const recBase = r * bytesPerRecord;
          const base = recBase + chanOffset;
          for (let s = 0; s < nPerRec; s++) {
            const raw = view.getInt16(base + 2 * s, true); // EDF uses little-endian
            const phys = pMin + (raw - dMin) * scale;
            out[writePos++] = phys;
          }
        }

        channels.push({
          name: label,
          fs,
          samples: out
        });
      }

      const durationSecSegment = clampedEnd - clampedStart;
      return {
        durationSec: durationSecSegment,
        channels
      };
    }
  }

  // Expose globally
  window.LargeEdfSegmentLoader = LargeEdfSegmentLoader;
})();
