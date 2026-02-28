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
  const xf = dsp.bandpassFIR_04_30_zeroPhase(xr, 100);
  return xf;
}

  async function loadJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
    return await r.json();
  }
  function packToModelFeatureOrder(featureNames, X, modelFeatureNames) {
    if (!Array.isArray(modelFeatureNames) || modelFeatureNames.length === 0) {
      return { featureNames, X }; // nothing to do
    }

    const idxByName = new Map(featureNames.map((n, i) => [n, i]));

    const orderIdx = new Array(modelFeatureNames.length);
    const missing = [];
    for (let i = 0; i < modelFeatureNames.length; i++) {
      const nm = modelFeatureNames[i];
      const j = idxByName.get(nm);
      if (j === undefined) {
        missing.push(nm);
        orderIdx[i] = -1;
      } else {
        orderIdx[i] = j;
      }
    }

    if (missing.length) {
      // Throw hard: if we silently continue, LightGBM will read the wrong columns.
      const msg =
        `Missing ${missing.length} model features in extracted table. ` +
        `First few: ${missing.slice(0, 10).join(", ")}`;
      throw new Error(msg);
    }

    // Re-pack each row into modelFeatureNames order
    const Xpacked = new Array(X.length);
    for (let r = 0; r < X.length; r++) {
      const src = X[r];
      const dst = new Float64Array(orderIdx.length);
      for (let c = 0; c < orderIdx.length; c++) {
        dst[c] = src[orderIdx[c]];
      }
      Xpacked[r] = dst;
    }

    return { featureNames: modelFeatureNames.slice(), X: Xpacked };
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

  // --- preprocess (same as before) ---
const eegP = await preprocessSignal(eeg, fs, dsp);
console.log("stageYASA preprocess:", {
  fsIn: fs,
  eeg_in_len: eeg?.length ?? null,
  eegP_len: eegP?.length ?? null,
  eegP_type: eegP?.constructor?.name ?? typeof eegP,
});
const eogP = eog ? await preprocessSignal(eog, fs, dsp) : null;
const emgP = emg ? await preprocessSignal(emg, fs, dsp) : null;

  // --- feature extraction (same as before) ---
  let { featureNames, X } = feats.buildFeatureTable(
    { eeg: eegP, eog: eogP, emg: emgP },
    100,
    epochSec,
    metadata,
    dsp
  );
function statsAndHash(tag, x, fs, nSec = 30) {
  const n = Math.min(x.length, Math.floor(fs * nSec));
  let s = 0, s2 = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    s += v; s2 += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = s / (n || 1);
  const varr = s2 / (n || 1) - mean * mean;
  const std = Math.sqrt(Math.max(0, varr));

  let chk = 0;
  const m = Math.min(n, 1024);
  for (let i = 0; i < m; i++) chk += x[i] * (i + 1);

  console.log(`${tag} fs=${fs} n=${n} mean=${mean} std=${std} min=${mn} max=${mx} chk=${chk}`);
}

function isThenable(v) {
  return v != null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}
async function maybeAwait(v) {
  return isThenable(v) ? await v : v;
}

// REPLACE the old preprocessSignal with this async version:
async function preprocessSignal(x, fsIn, dsp) {
  if (!x || x.length === 0) return new Float64Array(0);

  x = toFloat64Array(x);

  // resample -> 100 Hz (sync or async)
  let x100 = await maybeAwait(dsp.resampleTo100Hz(x, fsIn));
  if (!x100) return new Float64Array(0);
  if (!(x100 instanceof Float64Array)) x100 = Float64Array.from(x100);

  // bandpass 0.4–30 (sync or async)
  let xbp = await maybeAwait(dsp.bandpass_04_30(x100, 100.0));
  if (!xbp) return new Float64Array(0);
  if (!(xbp instanceof Float64Array)) xbp = Float64Array.from(xbp);

  return xbp;
}

	statsAndHash("JS RAW EEG epoch0", eeg, fs, 30);
  // --- load model dump (same as before) ---
  let dump = modelDump;
  if (!dump && modelDumpUrl) dump = await loadJSON(modelDumpUrl);
  if (!dump) {
    throw new Error("No YASA LightGBM dump_model JSON provided (modelDump or modelDumpUrl).");
  }

  // --- pack features into the model's expected order right before inference ---
  const modelFeatureNames = dump.feature_names || dump.featureNames;
  ({ featureNames, X } = packToModelFeatureOrder(featureNames, X, modelFeatureNames));
// === Epoch-alignment debug: compare time_hour / time_norm across JS vs Python ===
(function logTimeFeatures() {
  const idxHour = featureNames.indexOf("time_hour");
  const idxNorm = featureNames.indexOf("time_norm");
  if (idxHour < 0 || idxNorm < 0) {
    console.warn("Missing time features in featureNames:", { idxHour, idxNorm });
    return;
  }

  function logRow(r) {
    console.log(
      `JS row${r} time_hour/time_norm:`,
      X[r][idxHour],
      X[r][idxNorm]
    );
  }

  logRow(0);
  if (X.length > 10) logRow(10);
  if (X.length > 100) logRow(100);
})();
console.log("JS packed featureNames[0..10]:", JSON.stringify(featureNames.slice(0, 10)));
console.log("JS packed X0 first5:", X[0][0], X[0][1], X[0][2], X[0][3], X[0][4]);

if (X.length > 10) {
  console.log("JS packed X10 first5:", X[10][0], X[10][1], X[10][2], X[10][3], X[10][4]);
}
if (X.length > 100) {
  console.log("JS packed X100 first5:", X[100][0], X[100][1], X[100][2], X[100][3], X[100][4]);
}
  // --- inference ---
  const model = new lgbm.LGBMDumpModel(dump, {
    numClass: classNames.length,
    classNames,
    featureNames
  });

  const prob = model.predictProba(X);
  const pred = model.predict(X);
	console.log("featureNames aligned?",
	  featureNames.length,
	  dump.feature_names.length,
	  featureNames[0] === dump.feature_names[0],
	  featureNames[featureNames.length - 1] === dump.feature_names[dump.feature_names.length - 1]
	);

	console.log("first row checksum:",
	  X[0][0], X[0][1], X[0][2], X[0][3], X[0][4]
	);
  return { stages: pred, probs: prob, featureNames };
}

  window.YASA_STAGE = { stageYASA };
})();
