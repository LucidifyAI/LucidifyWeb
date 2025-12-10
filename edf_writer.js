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

  // Small helpers ---------------------------------------------------------

  const encoder = new TextEncoder();

  function writeAscii(bytes, offset, length, text) {
    const s = (text == null ? "" : String(text));
    const encoded = encoder.encode(s);
    const n = Math.min(length, encoded.length);
    for (let i = 0; i < n; i++) {
      bytes[offset + i] = encoded[i];
    }
    for (let i = n; i < length; i++) {
      bytes[offset + i] = 0x20; // space padding
    }
  }

  function writeNumberField(bytes, offset, length, value) {
    let s;
    if (typeof value === "string") {
      s = value;
    } else if (Number.isInteger(value)) {
      s = value.toString();
    } else {
      s = value.toFixed(3);
    }
    if (s.length > length) s = s.slice(0, length);
    s = s.padEnd(length, " ");
    writeAscii(bytes, offset, length, s);
  }

  function pad2(n) {
    return n.toString().padStart(2, "0");
  }

  // Core: build an EDF buffer for the given view --------------------------

  /**
   * Build an EDF ArrayBuffer from a recording and a time window.
   *
   * @param {Object} options
   *   - recording: { durationSec, channels: [{ name, fs, samples }, ...] }
   *   - channelIndices: array of indices into recording.channels
   *   - viewStartSec: start time (seconds)
   *   - viewDurationSec: duration (seconds)
   *   - patientId (optional): string
   *   - recordingId (optional): string
   *
   * @returns {ArrayBuffer}
   */
  function makeEdfFromView(options) {
    const {
      recording,
      channelIndices,
      viewStartSec,
      viewDurationSec,
      patientId = "X",
      recordingId = "Trimmed EDF"
    } = options;

    if (!recording || !Array.isArray(recording.channels)) {
      throw new Error("Invalid recording");
    }
    if (!channelIndices || channelIndices.length === 0) {
      throw new Error("No channels selected");
    }

    const allChannels = recording.channels;
    const chans = channelIndices
      .map((idx) => allChannels[idx])
      .filter((ch) => !!ch);

    const nSignals = chans.length;
    if (!nSignals) throw new Error("No valid channels for EDF");

    // Determine a duration that all channels can support given viewStartSec.
    let effectiveDurationSec = viewDurationSec;
    const perChannelInfo = [];

    for (let s = 0; s < nSignals; s++) {
      const ch = chans[s];
      const fs = ch.fs || 256;
      const samples = ch.samples || new Float32Array(0);

      const startSample = Math.floor(viewStartSec * fs);
      const maxDurForCh =
        startSample < samples.length
          ? (samples.length - startSample) / fs
          : 0;

      if (maxDurForCh < effectiveDurationSec) {
        effectiveDurationSec = maxDurForCh;
      }
    }

    if (!Number.isFinite(effectiveDurationSec) || effectiveDurationSec <= 0) {
      throw new Error("View window is outside available data");
    }

    // For EDF, all channels share the same data-record duration;
    // each channel defines its own samples-per-record.
    const DIG_MIN = -32768;
    const DIG_MAX = 32767;

    let fsFirst = null;
    const samplesPerRecord = new Array(nSignals);
    const physMins = new Array(nSignals);
    const physMaxs = new Array(nSignals);
    const digMins = new Array(nSignals).fill(DIG_MIN);
    const digMaxs = new Array(nSignals).fill(DIG_MAX);
    const labels = new Array(nSignals);
    const digitArrays = new Array(nSignals);

    for (let s = 0; s < nSignals; s++) {
      const ch = chans[s];
      const fs = ch.fs || 256;
      if (fsFirst == null && fs > 0) fsFirst = fs;

      const samples = ch.samples || new Float32Array(0);
      const startSample = Math.floor(viewStartSec * fs);
      const maxLen = Math.max(0, samples.length - startSample);
      const idealLen = Math.floor(effectiveDurationSec * fs);
      const len = Math.max(1, Math.min(maxLen, idealLen));

      const seg = samples.subarray(startSample, startSample + len);

      // Compute physMin/Max from the segment
      let minV = Infinity;
      let maxV = -Infinity;
      for (let i = 0; i < seg.length; i++) {
        const v = seg[i];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      if (!Number.isFinite(minV) || !Number.isFinite(maxV) || minV === maxV) {
        minV = -1;
        maxV = 1;
      }

      const denom = maxV - minV || 1;
      const scale = (DIG_MAX - DIG_MIN) / denom;

      const digits = new Int16Array(seg.length);
      for (let i = 0; i < seg.length; i++) {
        let d = Math.round((seg[i] - minV) * scale + DIG_MIN);
        if (d < DIG_MIN) d = DIG_MIN;
        if (d > DIG_MAX) d = DIG_MAX;
        digits[i] = d;
      }

      labels[s] = ch.name || `Ch ${s + 1}`;
      samplesPerRecord[s] = digits.length;
      physMins[s] = minV;
      physMaxs[s] = maxV;
      digitArrays[s] = digits;
    }

    if (!fsFirst) fsFirst = 256;
    // Use first channel’s fs and its sample count to define the record duration
    const durFromFirst =
      samplesPerRecord[0] / (chans[0].fs || fsFirst) || effectiveDurationSec;
    const recordDurationSec = durFromFirst;

    // EDF header sizes
    const headerBytes = 256 + 256 * nSignals;
    const totalSamplesAllSignals = samplesPerRecord.reduce(
      (acc, n) => acc + n,
      0
    );
    const bytesPerDataRecord = totalSamplesAllSignals * 2; // int16
    const nDataRecords = 1;
    const totalBytes = headerBytes + bytesPerDataRecord * nDataRecords;

    const buffer = new ArrayBuffer(totalBytes);
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    // ----------------- Main fixed header (first 256 bytes) ----------------

    const now = new Date();
    const dd = pad2(now.getDate());
    const mm = pad2(now.getMonth() + 1);
    const yy = pad2(now.getFullYear() % 100);
    const HH = pad2(now.getHours());
    const MM = pad2(now.getMinutes());
    const SS = pad2(now.getSeconds());

    // version
    writeAscii(bytes, 0, 8, "0");
    // patient id
    writeAscii(bytes, 8, 80, patientId);
    // recording id
    writeAscii(bytes, 88, 80, recordingId);
    // start date dd.mm.yy
    writeAscii(bytes, 168, 8, `${dd}.${mm}.${yy}`);
    // start time hh.mm.ss
    writeAscii(bytes, 176, 8, `${HH}.${MM}.${SS}`);
    // number of bytes in header
    writeNumberField(bytes, 184, 8, headerBytes);
    // reserved
    writeAscii(bytes, 192, 44, "");
    // number of data records
    writeNumberField(bytes, 236, 8, nDataRecords);
    // duration of a data record in seconds
    writeNumberField(bytes, 244, 8, recordDurationSec);
    // number of signals
    writeNumberField(bytes, 252, 4, nSignals);

    // ----------------- Per-signal header blocks ---------------------------

    const base = 256;
    const labelsOffset = base;
    const transducerOffset = labelsOffset + 16 * nSignals;
    const physDimOffset = transducerOffset + 80 * nSignals;
    const physMinOffset = physDimOffset + 8 * nSignals;
    const physMaxOffset = physMinOffset + 8 * nSignals;
    const digMinOffset = physMaxOffset + 8 * nSignals;
    const digMaxOffset = digMinOffset + 8 * nSignals;
    const prefilterOffset = digMaxOffset + 8 * nSignals;
    const samplesPerRecordOffset = prefilterOffset + 80 * nSignals;
    const reservedOffset = samplesPerRecordOffset + 8 * nSignals;

    for (let s = 0; s < nSignals; s++) {
      const label = labels[s];
      const physMin = physMins[s];
      const physMax = physMaxs[s];
      const dMin = digMins[s];
      const dMax = digMaxs[s];
      const nSamp = samplesPerRecord[s];

      writeAscii(bytes, labelsOffset + 16 * s, 16, label);
      writeAscii(bytes, transducerOffset + 80 * s, 80, "");
      writeAscii(bytes, physDimOffset + 8 * s, 8, "uV");
      writeNumberField(bytes, physMinOffset + 8 * s, 8, physMin);
      writeNumberField(bytes, physMaxOffset + 8 * s, 8, physMax);
      writeNumberField(bytes, digMinOffset + 8 * s, 8, dMin);
      writeNumberField(bytes, digMaxOffset + 8 * s, 8, dMax);
      writeAscii(bytes, prefilterOffset + 80 * s, 80, "");
      writeNumberField(
        bytes,
        samplesPerRecordOffset + 8 * s,
        8,
        nSamp
      );
      writeAscii(bytes, reservedOffset + 32 * s, 32, "");
    }

    // ----------------- Data records (just 1 record) -----------------------

    let dataOffset = headerBytes;
    for (let s = 0; s < nSignals; s++) {
      const digits = digitArrays[s];
      for (let i = 0; i < digits.length; i++) {
        dv.setInt16(dataOffset, digits[i], true); // little-endian
        dataOffset += 2;
      }
    }

    return buffer;
  }

  /**
   * Convenience: create and download a trimmed EDF file for the given view.
   *
   * @param {Object} options - same as makeEdfFromView plus:
   *   - filename (optional)
   */
  function downloadEdfFromView(options) {
    const buffer = makeEdfFromView(options);
    const blob = new Blob([buffer], {
      type: "application/octet-stream"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = options.filename || "trimmed.edf";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  // Export on window
  window.LucidifyMakeEdfFromView = makeEdfFromView;
  window.LucidifyDownloadEdfFromView = downloadEdfFromView;
})();
