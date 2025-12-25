/*  yasa_staging.js
    End-to-end YASA-like staging in the browser.

    Requires:
      - yasa_dsp.js (window.YASA_DSP)
      - yasa_features.js (window.YASA_FEATURES)
      - yasa_lgbm.js (window.YASA_LGBM)

    Notes:
      - Input signals should be in microvolts (µV), consistent with YASA guidance.
      - Downsamples to 100 Hz, then bandpasses 0.4–30 Hz before features.
*/

(function () {
  "use strict";

  function toFloat64Array(x) {
    if (x instanceof Float64Array) return x;
    if (x instanceof Float32Array) return Float64Array.from(x);
    return Float64Array.from(x);
  }

  function preprocessSignal(x, fsIn, dsp) {
    const xr = dsp.resampleTo100Hz(toFloat64Array(x), fsIn);
    const xf = dsp.bandpass_04_30(xr, 100);
    return xf;
  }

  async function loadJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
    return await r.json();
  }

  async function stageYASA(opts) {
    const {
      eeg, eog = null, emg = null,
      fs, epochSec = 30,
      metadata = null,
      modelDump = null,              // object OR null
      modelDumpUrl = null,           // optional URL
      classNames = ["W", "N1", "N2", "N3", "R"],
    } = opts;

    if (!eeg) throw new Error("YASA staging requires an EEG channel");
    if (!fs || fs <= 0) throw new Error("Invalid sampling rate");

    const dsp = window.YASA_DSP;
    const feats = window.YASA_FEATURES;
    const lgbm = window.YASA_LGBM;

    if (!dsp || !feats || !lgbm) throw new Error("Missing YASA modules (DSP, FEATURES, LGBM)");

    const eegP = preprocessSignal(eeg, fs, dsp);
    const eogP = eog ? preprocessSignal(eog, fs, dsp) : null;
    const emgP = emg ? preprocessSignal(emg, fs, dsp) : null;

    const { featureNames, X } = feats.buildFeatureTable(
      { eeg: eegP, eog: eogP, emg: emgP },
      100,
      epochSec,
      metadata,
      dsp
    );

    let dump = modelDump;
    if (!dump && modelDumpUrl) dump = await loadJSON(modelDumpUrl);
    if (!dump) {
      throw new Error("No YASA LightGBM dump_model JSON provided (modelDump or modelDumpUrl).");
    }

    const model = new lgbm.LGBMDumpModel(dump, {
      numClass: classNames.length,
      classNames,
      featureNames
    });

    const prob = model.predictProba(X);
    const pred = model.predict(X);

    return { stages: pred, probs: prob, featureNames };
  }

  window.YASA_STAGE = { stageYASA };
})();
