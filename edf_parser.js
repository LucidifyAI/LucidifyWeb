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

  // ---- EDF parsing helpers ----

  function readAscii(bytes, start, length) {
    const slice = bytes.slice(start, start + length);
    return new TextDecoder("ascii").decode(slice).trim();
  }

  function readNumber(bytes, start, length) {
    const txt = readAscii(bytes, start, length);
    const n = Number(txt);
    return Number.isNaN(n) ? 0 : n;
  }

  // --- Recording model utilities ----------------------------------------

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

  // Fake recording for testing
  function createFakeRecording() {
    const durationSec = 10;
    const fs = 256;
    const nSamples = durationSec * fs;

    const channels = [];
    const freqs = [8, 12, 4];
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

  // ---- Full EDF parser --------------------------------------------------

  function parseEdf(buffer) {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);

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

    const base = 256;

    const labelsOffset           = base;
    const transducerOffset       = labelsOffset           + 16 * nSignals;
    const physDimOffset          = transducerOffset       + 80 * nSignals;
    const physMinOffset          = physDimOffset          +  8 * nSignals;
    const physMaxOffset          = physMinOffset          +  8 * nSignals;
    const digMinOffset           = physMaxOffset          +  8 * nSignals;
    const digMaxOffset           = digMinOffset           +  8 * nSignals;
    const prefilterOffset        = digMaxOffset           +  8 * nSignals;
    const samplesPerRecordOffset = prefilterOffset        + 80 * nSignals;

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

    const bytesPerRecord =
      samplesPerRecord.reduce((acc, n) => acc + n * 2, 0);

    let records = nDataRecords;
    if (records <= 0) {
      records = Math.floor((bytes.length - headerBytes) / bytesPerRecord);
    }

    const durationSec = records * durationSecPerRecord;
    const channels = [];

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
          const digit = dv.getInt16(byteOffset, true);
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

  // Expose API on window
  window.LucidifyParseEdf = parseEdf;
  window.LucidifyCreateFakeRecording = createFakeRecording;
  window.LucidifyComputeDisplayRanges = computeDisplayRanges;
})();
