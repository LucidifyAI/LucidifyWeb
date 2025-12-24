// sleep_local_bundle.js (no imports, no fetch; works under file://)
(function() {
  "use strict";

  // --- Embedded models ---
  // Provide models in a separate classic script BEFORE this one:
  //   window.LucidifySleepStageModels = { physio: <modelObj>, boas: <modelObj> };
  const MODELS = (window.LucidifySleepStageModels || {});

  function resolveEmbeddedModel(modelUrl) {
    if (!modelUrl) return null;
    const key = String(modelUrl).toLowerCase();
    if (key.includes("boas")) return MODELS.boas || null;
    if (key.includes("physio")) return MODELS.physio || null;
    if (key.endsWith("model.json")) return MODELS.physio || MODELS.boas || null;
    if (MODELS[key]) return MODELS[key];
    return null;
  }

// sleep_stage_features.js

const BANDS = {
  delta: [0.5, 4.0],
  theta: [4.0, 8.0],
  alpha: [8.0, 12.0],
  sigma: [12.0, 15.0],
  beta:  [15.0, 30.0],
};

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hannWindow(N) {
  const w = new Float32Array(N);
  const twoPi = 2 * Math.PI;
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((twoPi * n) / (N - 1));
  }
  return w;
}

// Radix-2 FFT (real input -> complex output). n must be power of 2.
function fftRadix2Real(x, nfft) {
  // Returns { re: Float32Array, im: Float32Array } length nfft
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);

  // copy + zero pad
  const n = Math.min(x.length, nfft);
  for (let i = 0; i < n; i++) re[i] = x[i];

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < nfft; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = nfft >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }

  // Cooley-Tukey
  for (let size = 2; size <= nfft; size <<= 1) {
    const half = size >> 1;
    const step = (2 * Math.PI) / size;
    for (let i = 0; i < nfft; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = -step * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);

        const evenRe = re[i + k];
        const evenIm = im[i + k];
        const oddRe  = re[i + k + half];
        const oddIm  = im[i + k + half];

        const tr = wr * oddRe - wi * oddIm;
        const ti = wr * oddIm + wi * oddRe;

        re[i + k] = evenRe + tr;
        im[i + k] = evenIm + ti;
        re[i + k + half] = evenRe - tr;
        im[i + k + half] = evenIm - ti;
      }
    }
  }

  return { re, im };
}

function trapezoidIntegral(y, x, i0, i1) {
  // integrates from i0..i1 inclusive over x (assumes x increasing)
  let area = 0;
  for (let i = i0; i < i1; i++) {
    const dx = x[i + 1] - x[i];
    area += 0.5 * (y[i] + y[i + 1]) * dx;
  }
  return area;
}

function bandpower(psd, freqs, fmin, fmax) {
  // integrate PSD over [fmin, fmax)
  let i0 = -1, i1 = -1;
  for (let i = 0; i < freqs.length; i++) {
    if (i0 < 0 && freqs[i] >= fmin) i0 = i;
    if (freqs[i] < fmax) i1 = i;
  }
  if (i0 < 0 || i1 <= i0) return 0.0;
  return trapezoidIntegral(psd, freqs, i0, i1);
}

function spectralEntropy(psd, freqs, fmin = 0.5, fmax = 30.0) {
  let i0 = -1, i1 = -1;
  for (let i = 0; i < freqs.length; i++) {
    if (i0 < 0 && freqs[i] >= fmin) i0 = i;
    if (freqs[i] <= fmax) i1 = i;
  }
  if (i0 < 0 || i1 <= i0) return 0.0;

  let sum = 0;
  for (let i = i0; i <= i1; i++) {
    const v = psd[i] > 0 ? psd[i] : 0;
    sum += v;
  }
  if (sum <= 0) return 0.0;

  let H = 0;
  for (let i = i0; i <= i1; i++) {
    const v = psd[i] > 0 ? psd[i] : 0;
    const p = v / sum;
    if (p > 0) H -= p * Math.log(p);
  }
  return H;
}

function spectralEdgeFreq(psd, freqs, edge = 0.95, fmin = 0.5, fmax = 30.0) {
  // Find f where cumulative integral reaches edge * total area
  let i0 = -1, i1 = -1;
  for (let i = 0; i < freqs.length; i++) {
    if (i0 < 0 && freqs[i] >= fmin) i0 = i;
    if (freqs[i] <= fmax) i1 = i;
  }
  if (i0 < 0 || i1 <= i0) return fmin;

  const total = trapezoidIntegral(psd, freqs, i0, i1);
  if (total <= 0) return fmin;
  const target = edge * total;

  let cum = 0;
  for (let i = i0; i < i1; i++) {
    const dx = freqs[i + 1] - freqs[i];
    cum += 0.5 * (psd[i] + psd[i + 1]) * dx;
    if (cum >= target) return freqs[i];
  }
  return freqs[i1];
}

// Welch PSD: returns { freqs: Float32Array, psd: Float32Array } for 0..fs/2
function welchPsd(epoch, fs) {
  const winSec = 4.0;
  let nperseg = Math.round(winSec * fs);
  nperseg = Math.max(32, nperseg);
  const noverlap = Math.floor(nperseg / 2);
  const step = Math.max(1, nperseg - noverlap);

  // Main pragmatic choice:
  // SciPy default is nfft=nperseg; here we use nextPow2 for a radix-2 FFT.
  const nfft = nextPow2(nperseg);

  const window = hannWindow(nperseg);

  // Window power normalization for density scaling
  // density ≈ (1/(fs * sum(w^2))) * |FFT|^2 for one-sided PSD (with doubling non-DC/Nyquist)
  let w2sum = 0;
  for (let i = 0; i < nperseg; i++) w2sum += window[i] * window[i];

  const nBins = Math.floor(nfft / 2) + 1;
  const psdAcc = new Float64Array(nBins);
  let nSeg = 0;

  for (let start = 0; start + nperseg <= epoch.length; start += step) {
    // copy segment, detrend constant (remove mean), apply window
    let mean = 0;
    for (let i = 0; i < nperseg; i++) mean += epoch[start + i];
    mean /= nperseg;

    const seg = new Float32Array(nperseg);
    for (let i = 0; i < nperseg; i++) seg[i] = (epoch[start + i] - mean) * window[i];

    const { re, im } = fftRadix2Real(seg, nfft);

    // one-sided power
    for (let k = 0; k < nBins; k++) {
      const rr = re[k], ii = im[k];
      let p = (rr * rr + ii * ii);

      // density scaling
      p = p / (fs * w2sum);

      // one-sided doubling (except DC and Nyquist if exists)
      if (k !== 0 && k !== nfft / 2) p *= 2;

      psdAcc[k] += p;
    }

    nSeg++;
  }

  if (nSeg <= 0) {
    // fallback: all zeros
    return {
      freqs: new Float32Array(nBins),
      psd: new Float32Array(nBins),
    };
  }

  const psd = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) psd[k] = psdAcc[k] / nSeg;

  const freqs = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) freqs[k] = (k * fs) / nfft;

  return { freqs, psd };
}
function computeFeatures(epoch, fs) {
  const { freqs, psd } = welchPsd(epoch, fs);

  const bp = {};
  for (const [name, [f0, f1]] of Object.entries(BANDS)) {
    bp[name] = bandpower(psd, freqs, f0, f1);
  }

  const eps = 1e-12;
  const feats = {
    log_delta: Math.log(bp.delta + eps),
    log_theta: Math.log(bp.theta + eps),
    log_alpha: Math.log(bp.alpha + eps),
    log_sigma: Math.log(bp.sigma + eps),
    log_beta:  Math.log(bp.beta  + eps),
  };

  feats.log_delta_over_beta = feats.log_delta - feats.log_beta;
  feats.log_sigma_over_theta = feats.log_sigma - feats.log_theta;
  feats.log_thetaalpha_over_beta =
    Math.log((bp.theta + bp.alpha) + eps) - Math.log(bp.beta + eps);

  feats.sef95 = spectralEdgeFreq(psd, freqs, 0.95, 0.5, 30.0);
  feats.spec_entropy = spectralEntropy(psd, freqs, 0.5, 30.0);

  // RMS
  let sumsq = 0;
  for (let i = 0; i < epoch.length; i++) sumsq += epoch[i] * epoch[i];
  feats.rms = Math.sqrt(sumsq / Math.max(1, epoch.length));

  // Zero-cross rate (matches np.mean(abs(diff(signbit))))
  let zc = 0;
  for (let i = 1; i < epoch.length; i++) {
    const a = epoch[i - 1] < 0;
    const b = epoch[i] < 0;
    if (a !== b) zc += 1;
  }
  feats.zero_cross_rate = zc / Math.max(1, epoch.length - 1);

  return feats;
}


// sleep_stage_model.js
async function loadSleepStageModel(modelUrlOrObj) {
  const model = (typeof modelUrlOrObj === "string")
    ? resolveEmbeddedModel(modelUrlOrObj)
    : modelUrlOrObj;
  if (!model) {
    throw new Error("Model not found. Provide embedded models (window.LucidifySleepStageModels) or pass a model object.");
  }
if (model.format !== "sleep_stage_lr_v1") {
    throw new Error(`Unexpected model format: ${model.format}`);
  }

  const labels = model.labels;                 // ["W","N1","N2","N3","REM"]
  const featureOrder = model.feature_order;    // 12 features
  const means = model.means;
  const stds = model.stds;
  const W = model.W;                           // [5][12]
  const b = model.b;                           // [5]

  if (labels.length !== 5) throw new Error("Expected 5 labels");
  if (featureOrder.length !== means.length || means.length !== stds.length) {
    throw new Error("Model arrays length mismatch");
  }

  function softmaxStable(logits) {
    let max = logits[0];
    for (let i = 1; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    const exps = new Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      const e = Math.exp(logits[i] - max);
      exps[i] = e;
      sum += e;
    }
    if (sum <= 0) sum = 1;
    for (let i = 0; i < exps.length; i++) exps[i] /= sum;
    return exps;
  }

  function predictFromFeatures(featuresByName) {
    // Pack features in model.feature_order
    const x = new Array(featureOrder.length);
    for (let i = 0; i < featureOrder.length; i++) {
      const k = featureOrder[i];
      const v = featuresByName[k];
      if (!Number.isFinite(v)) {
        throw new Error(`Missing or non-finite feature: ${k}=${v}`);
      }
      x[i] = (v - means[i]) / (stds[i] || 1);
    }

    // logits = W*x + b
    const logits = new Array(labels.length);
    for (let c = 0; c < labels.length; c++) {
      let s = b[c];
      const row = W[c];
      for (let j = 0; j < x.length; j++) s += row[j] * x[j];
      logits[c] = s;
    }

    const probs = softmaxStable(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;

    return {
      predId: best,
      predLabel: labels[best],
      probs,
      logits,
    };
  }

  return { model, predictFromFeatures };
}


// hypnogram_pipeline.js
function predictHypnogram(samples, fs, predictFromFeatures, epochLenSec = 30) {
  const samplesPerEpoch = Math.floor(fs * epochLenSec);
  const nEpochs = Math.floor(samples.length / samplesPerEpoch);
  const stages = new Array(nEpochs);
  const probs = new Array(nEpochs);

  for (let e = 0; e < nEpochs; e++) {
    const start = e * samplesPerEpoch;
    const stop = start + samplesPerEpoch;

    const epoch = samples.slice(start, stop);
    const feats = computeFeatures(epoch, fs);
    const out = predictFromFeatures(feats);

    stages[e] = out.predLabel;
    probs[e] = out.probs;
  }
  return { stages, probs };
}

// NEW: this matches what sleep_stage.js expects
async function runHypnogram({
  recording,
  epochSec = 30,
  channelIndex = 0,
  modelUrl = "model.json",
}) {
  if (!recording || !Array.isArray(recording.channels) || recording.channels.length === 0) {
    throw new Error("Invalid recording");
  }
  const ch = recording.channels[channelIndex] || recording.channels[0];
  if (!ch || !ch.samples || !ch.samples.length) {
    throw new Error("Selected channel has no samples");
  }

  const fs = ch.fs || 256;
  const { predictFromFeatures } = await loadSleepStageModel(modelUrl);

  return predictHypnogram(ch.samples, fs, predictFromFeatures, epochSec);
}



  // Back-compat + convenience wrapper
  async function run(recording, opts = {}) {
    const modelUrlOrObj = opts.modelObject || opts.modelUrl || "model.json";
    const epochSec = (opts.epochSec != null) ? opts.epochSec : 30;
    const channelIndex = (opts.channelIndex != null) ? opts.channelIndex : 0;

    return await runHypnogram({
      recording,
      epochSec,
      channelIndex,
      modelUrl: modelUrlOrObj,
    });
  }

  function runFromSamples(samples, fs = 256, opts = {}) {
    const recording = { channels: [{ samples, fs }] };
    const modelUrlOrObj = opts.modelObject || opts.modelUrl || "model.json";
    return runHypnogram({
      recording,
      epochSec: (opts.epochSec != null) ? opts.epochSec : 30,
      channelIndex: 0,
      modelUrl: modelUrlOrObj,
    });
  }

  window.LucidifySleepStage = {
    run,
    runFromSamples,
  };
})();
