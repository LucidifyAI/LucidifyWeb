/*  yasa_features.js
    Feature extraction for YASA-like sleep staging in pure JS.

    Per 30s epoch per channel:
      std, iqr, skew, kurt, nzc, hjorth mobility/complexity,
      relative band powers (EEG/EOG), power ratios (EEG),
      absolute broad-band power 0.4–30,
      permutation entropy, Higuchi FD, Petrosian FD

    Plus smoothed+robust-normalized feature copies:
      7.5 min centered triangular rolling mean (15 epochs) -> _c7min_norm
      2 min past rolling mean (4 epochs)                  -> _p2min_norm

    This file is an original implementation for compatibility.
*/
console.log("LOADED yasa_features.js VERSION = 2026-03-02-A");
(function () {
  "use strict";

  const BANDS_DEFAULT = [
    [0.4, 1, "sdelta"],
    [1, 4, "fdelta"],
    [4, 8, "theta"],
    [8, 12, "alpha"],
    [12, 16, "sigma"],
    [16, 30, "beta"],
  ];

  // ------------------------- small stats helpers -------------------------

  function quantileSorted(sorted, q) {
    if (sorted.length === 0) return NaN;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] === undefined) return sorted[base];
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }

  function robustScaleColumn(col, qLow = 0.05, qHigh = 0.95) {
    const s = Array.from(col).sort((a, b) => a - b);
    const med = quantileSorted(s, 0.5);
    const lo = quantileSorted(s, qLow);
    const hi = quantileSorted(s, qHigh);
    let scale = (hi - lo);
    if (!Number.isFinite(scale) || scale === 0) scale = 1;

    const out = new Float64Array(col.length);
    for (let i = 0; i < col.length; i++) out[i] = (col[i] - med) / scale;
    return out;
  }

  function stdDdof1(x) {
    const n = x.length;
    if (n < 2) return 0;
    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;

    let v = 0;
    for (let i = 0; i < n; i++) {
      const d = x[i] - m;
      v += d * d;
    }
    v /= (n - 1);
    return Math.sqrt(v);
  }

  function iqr2575(x) {
    const s = Array.from(x).sort((a, b) => a - b);
    const q25 = quantileSorted(s, 0.25);
    const q75 = quantileSorted(s, 0.75);
    return q75 - q25;
  }

  function varianceDdof0(x) {
    const n = x.length;
    if (n === 0) return 0;
    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;

    let v = 0;
    for (let i = 0; i < n; i++) {
      const d = x[i] - m;
      v += d * d;
    }
    return v / n;
  }

  function skewness(x) {
    const n = x.length;
    if (n < 3) return 0;

    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;

    let m2 = 0, m3 = 0;
    for (let i = 0; i < n; i++) {
      const d = x[i] - m;
      const d2 = d * d;
      m2 += d2;
      m3 += d2 * d;
    }
    m2 /= n;
    m3 /= n;

    const s = Math.sqrt(m2) || 1;
    return m3 / (s * s * s);
  }

  function kurtosisFisher(x) {
    const n = x.length;
    if (n < 4) return 0;

    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;

    let m2 = 0, m4 = 0;
    for (let i = 0; i < n; i++) {
      const d = x[i] - m;
      const d2 = d * d;
      m2 += d2;
      m4 += d2 * d2;
    }
    m2 /= n;
    m4 /= n;

    const v = m2 || 1;
    return (m4 / (v * v)) - 3;
  }

  function numZeroCrossings(x) {
    let nzc = 0;
    let prev = (x[0] >= 0);
    for (let i = 1; i < x.length; i++) {
      const cur = (x[i] >= 0);
      if (cur !== prev) nzc++;
      prev = cur;
    }
    return nzc;
  }

  function hjorthParams(x) {
    const n = x.length;
    if (n < 3) return { mob: 0, comp: 0 };

    const dx = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) dx[i] = x[i + 1] - x[i];

    const ddx = new Float64Array(n - 2);
    for (let i = 0; i < n - 2; i++) ddx[i] = dx[i + 1] - dx[i];

    const var0 = varianceDdof0(x);
    const var1 = varianceDdof0(dx);
    const var2 = varianceDdof0(ddx);

    const mob = Math.sqrt((var1 || 0) / (var0 || 1));
    const mob1 = Math.sqrt((var2 || 0) / (var1 || 1));
    const comp = (mob > 0) ? (mob1 / mob) : 0;
    return { mob, comp };
  }

  // ------------------------- nonlinear features -------------------------

  function factorial(k) {
    let f = 1;
    for (let i = 2; i <= k; i++) f *= i;
    return f;
  }

  function permIndex(vals) {
    const n = vals.length;
    const idxs = Array.from({ length: n }, (_, i) => i);
    idxs.sort((i, j) => vals[i] - vals[j] || (i - j));

    const lehmer = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let c = 0;
      for (let j = i + 1; j < n; j++) if (idxs[i] > idxs[j]) c++;
      lehmer[i] = c;
    }

    let rank = 0;
    for (let i = 0; i < n; i++) rank += lehmer[i] * factorial(n - i - 1);
    return rank;
  }

  function permEntropy(x, order = 3, delay = 1) {
    const n = x.length;
    const m = order;
    const tau = delay;
    const N = n - (m - 1) * tau;
    if (N <= 1) return 0;

    const fact = (m === 3) ? 6 : factorial(m);
    const counts = new Float64Array(fact);

    if (m === 3) {
      for (let i = 0; i < N; i++) {
        const a = x[i];
        const b = x[i + tau];
        const c = x[i + 2 * tau];

        let idx = 0;
        if (a <= b && b <= c) idx = 0;
        else if (a <= c && c <= b) idx = 1;
        else if (b <= a && a <= c) idx = 2;
        else if (b <= c && c <= a) idx = 3;
        else if (c <= a && a <= b) idx = 4;
        else idx = 5;
        counts[idx] += 1;
      }
    } else {
      const tmp = new Array(m);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < m; j++) tmp[j] = x[i + j * tau];
        const idx = permIndex(tmp);
        counts[idx] += 1;
      }
    }

    let H = 0;
    const inv = 1 / N;
    for (let i = 0; i < counts.length; i++) {
      const p = counts[i] * inv;
      if (p > 0) H -= p * Math.log(p);
    }
    const Hmax = Math.log(fact) || 1;
    return H / Hmax;
  }

  function higuchiFD(x, kmax = 10) {
    const N = x.length;
    if (N < (kmax + 2)) return 1;

    const xReg = new Float64Array(kmax);
    const yReg = new Float64Array(kmax);

    for (let k = 1; k <= kmax; k++) {
      let mLm = 0;

      for (let m = 0; m < k; m++) {
        const nMax = Math.floor((N - m - 1) / k);
        if (nMax <= 0) continue;

        let ll = 0;
        for (let j = 1; j < nMax; j++) {
          const a = x[m + j * k];
          const b = x[m + (j - 1) * k];
          ll += Math.abs(a - b);
        }

        ll /= k;
        ll *= (N - 1) / (k * nMax);
        mLm += ll;
      }

      mLm /= k;
      xReg[k - 1] = Math.log(1.0 / k);
      yReg[k - 1] = Math.log(mLm || 1e-12);
    }

    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < kmax; i++) {
      const xi = xReg[i], yi = yReg[i];
      sx += xi; sy += yi; sxx += xi * xi; sxy += xi * yi;
    }
    const denom = (kmax * sxx - sx * sx) || 1;
    return (kmax * sxy - sx * sy) / denom;
  }

  function petrosianFD(x) {
    const N = x.length;
    if (N < 2) return 1;

    let Nd = 0;
    let prev = x[1] - x[0];
    for (let i = 2; i < N; i++) {
      const cur = x[i] - x[i - 1];
      if ((cur >= 0) !== (prev >= 0)) Nd++;
      prev = cur;
    }

    const n = N;
    const num = Math.log10(n);
    const den = num + Math.log10(n / (n + 0.4 * Nd));
    return num / (den || 1);
  }

  // ------------------------- smoothing + robust scaling -------------------------

  function triangWeights(L) {
    const w = new Float64Array(L);
    const mid = (L - 1) / 2;
    const denom = mid + 1;
    for (let i = 0; i < L; i++) w[i] = (denom - Math.abs(i - mid)) / denom;
    return w;
  }

  function rollingTriangCentered(matrix /* [T][D] */, L /*15*/) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      throw new Error(`rollingTriangCentered: empty matrix (T=${matrix?.length ?? "null"})`);
    }
    if (matrix[0] == null || typeof matrix[0].length !== "number") {
      throw new Error(`rollingTriangCentered: matrix[0] invalid (${Object.prototype.toString.call(matrix[0])})`);
    }

    const T = matrix.length;
    const D = matrix[0].length;
    const w = triangWeights(L);
    const mid = (L - 1) >> 1;

    const out = new Array(T);
    for (let t = 0; t < T; t++) {
      const row = new Float64Array(D);
      for (let d = 0; d < D; d++) {
        let acc = 0, wsum = 0;
        for (let k = 0; k < L; k++) {
          const tt = t + (k - mid);
          if (tt < 0 || tt >= T) continue;
          const wk = w[k];
          acc += matrix[tt][d] * wk;
          wsum += wk;
        }
        row[d] = acc / (wsum || 1);
      }
      out[t] = row;
    }
    return out;
  }

  function rollingPastMean(matrix /* [T][D] */, L /*4*/) {
    const T = matrix.length;
    const D = matrix[0].length;
    const out = new Array(T);

    for (let t = 0; t < T; t++) {
      const row = new Float64Array(D);
      const start = Math.max(0, t - (L - 1));
      const count = (t - start + 1);

      for (let d = 0; d < D; d++) {
        let acc = 0;
        for (let tt = start; tt <= t; tt++) acc += matrix[tt][d];
        row[d] = acc / count;
      }
      out[t] = row;
    }
    return out;
  }

  function robustScaleMatrixCols(matrix /* [T][D] */) {
    const T = matrix.length;
    const D = matrix[0].length;

    const cols = new Array(D);
    for (let d = 0; d < D; d++) {
      const c = new Float64Array(T);
      for (let t = 0; t < T; t++) c[t] = matrix[t][d];
      cols[d] = robustScaleColumn(c, 0.05, 0.95);
    }

    const out = new Array(T);
    for (let t = 0; t < T; t++) {
      const r = new Float64Array(D);
      for (let d = 0; d < D; d++) r[d] = cols[d][t];
      out[t] = r;
    }
    return out;
  }

  function sortFeatureNames(names) {
    return Array.from(names).sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
  }

  // ------------------------- epoching + feature extraction -------------------------

  function windowEpochs(x /* Float64Array */, fs, epochSec) {
    if (!x || !Number.isFinite(x.length)) {
      console.error("windowEpochs: x is null/invalid", x);
      return [];
    }
    if (!Number.isFinite(fs) || fs <= 0) {
      console.error("windowEpochs: fs invalid", fs);
      return [];
    }
    if (!Number.isFinite(epochSec) || epochSec <= 0) {
      console.error("windowEpochs: epochSec invalid", epochSec);
      return [];
    }

    const nPer = Math.floor(fs * epochSec);
    const nEpoch = Math.floor(x.length / nPer);

    console.log("windowEpochs:", { fs, epochSec, xLen: x.length, nPer, nEpoch });
    if (nEpoch <= 0) return [];

    const epochs = new Array(nEpoch);
    for (let e = 0; e < nEpoch; e++) {
      const start = e * nPer;
      const seg = new Float64Array(nPer);
      for (let i = 0; i < nPer; i++) seg[i] = x[start + i];
      epochs[e] = seg;
    }
    return epochs;
  }

  function extractChannelFeatures(epochs, fs, epochSec, chType, dsp) {
    const T = epochs.length;

    const winSec = Math.min(5, epochSec);
    const nperseg = Math.floor(winSec * fs);

    const baseNames = ["std", "iqr", "skew", "kurt", "nzc", "hmob", "hcomp"];
    const bandNames = BANDS_DEFAULT.map(b => b[2]);
    const ratioNames = (chType === "eeg") ? ["dt", "ds", "db", "at"] : [];
    const extraNames = ["abspow", "perm", "higuchi", "petrosian"];

    const names = baseNames
      .concat(chType !== "emg" ? bandNames : [])
      .concat(ratioNames)
      .concat(extraNames);

    const D = names.length;
    const mat = new Array(T);

    for (let t = 0; t < T; t++) {
      const ep = epochs[t];
if (t === 0 && !window.__YASA_EPOCH0_SIGNAL) {
  // export exactly once per run, no gating flag required
  let mu = 0;
  for (let i = 0; i < ep.length; i++) mu += ep[i];
  mu /= ep.length;

  let v = 0;
  for (let i = 0; i < ep.length; i++) {
    const d = ep[i] - mu;
    v += d * d;
  }
  v /= Math.max(1, ep.length); // ddof=0

  window.__YASA_EPOCH0_SIGNAL = {
    chType,
    fs,
    n: ep.length,
    mean: mu,
    var: v,
    first16: Array.from(ep.slice(0, 16)), // quick sanity
    signal: Array.from(ep),
  };
  console.log(
    "Exported __YASA_EPOCH0_SIGNAL",
    { chType, fs, n: ep.length, mean: mu, var: v }
  );
}
      if (t === 0 || t === 10 || t === 100) {
        let mu = 0;
        for (let i = 0; i < ep.length; i++) mu += ep[i];
        mu /= ep.length;

        let s2 = 0;
        for (let i = 0; i < ep.length; i++) {
          const d = ep[i] - mu;
          s2 += d * d;
        }
        const std = Math.sqrt(s2 / Math.max(1, ep.length - 1));
        console.log(`JS ${chType} t=${t} epMean=${mu} epStd=${std} epLen=${ep.length}`);
      }

      const row = new Float64Array(D);
      let j = 0;

      // base stats
      row[j++] = stdDdof1(ep);
      row[j++] = iqr2575(ep);
      row[j++] = skewness(ep);
      row[j++] = kurtosisFisher(ep);
      row[j++] = numZeroCrossings(ep);

      const hj = hjorthParams(ep);
      row[j++] = hj.mob;
      row[j++] = hj.comp;

      let bandPowers = null;
      let totalBroad = 0;

      // EEG/EOG: spectral features
      if (chType !== "emg") {
        const { freqs, psd } = dsp.welchMedianPSD(ep, fs, nperseg);

        // Export epoch0 PSD (once per run), optionally gated by a flag
        const wantExport = (window.__LUCIDIFY_YASA_EXPORT_EPOCH0_PSD !== false);
        if (wantExport && t === 0 && !window.__YASA_EPOCH0_PSD) {
          window.__YASA_EPOCH0_PSD = {
            chType,
            fs,
            nperseg,
            freqs: Array.from(freqs),
            psd: Array.from(psd),
          };
          console.log("Exported __YASA_EPOCH0_PSD:", {
            chType,
            fs,
            nperseg,
            nFreq: freqs.length,
            f0: freqs[0],
            f1: freqs[1],
            psd0: psd[0],
            psd1: psd[1],
          });
        }

        // Debug Parseval-ish sanity (informative; Welch-median won't match variance perfectly)
        if (t === 0 || t === 10 || t === 100) {
          const df = freqs[1] - freqs[0];
          let total = 0;
          for (let i = 0; i < psd.length; i++) total += psd[i];
          const v = varianceDdof0(ep);
          console.log(`JS ${chType} t=${t} PSD_int=${total * df} var=${v} ratio=${(total * df) / (v || 1)}`);
        }

        totalBroad = dsp.trapzBand(psd, freqs, 0.4, 30.0) || 0;

        bandPowers = {};
        let sdeltaAbs = 0;
        let fdeltaAbs = 0;

        for (const [f0, f1, nm] of BANDS_DEFAULT) {
          const bpAbs = dsp.trapzBand(psd, freqs, f0, f1) || 0;
          if (nm === "sdelta") sdeltaAbs = bpAbs;
          if (nm === "fdelta") fdeltaAbs = bpAbs;
          bandPowers[nm] = (totalBroad > 0) ? (bpAbs / totalBroad) : 0;
        }

        if (t === 0 || t === 10 || t === 100) {
          const deltaAbs = sdeltaAbs + fdeltaAbs;
          const sdeltaRel = bandPowers.sdelta || 0;
          const fdeltaRel = bandPowers.fdelta || 0;
          console.log(
            `JS ${chType} t=${t} abspow_0p4_30=${totalBroad} ` +
            `sdeltaAbs=${sdeltaAbs} fdeltaAbs=${fdeltaAbs} deltaAbs=${deltaAbs} ` +
            `sdeltaRel=${sdeltaRel} fdeltaRel=${fdeltaRel} deltaRel=${(sdeltaRel + fdeltaRel)}`
          );
        }

        for (const nm of bandNames) row[j++] = bandPowers[nm] || 0;
      }

      // ratios for EEG only (uses relative band powers)
      if (chType === "eeg") {
        const bp = bandPowers || {};
        const delta = (bp.sdelta || 0) + (bp.fdelta || 0);
        const theta = bp.theta || 1e-12;
        const sigma = bp.sigma || 1e-12;
        const beta = bp.beta || 1e-12;
        const alpha = bp.alpha || 0;

        row[j++] = delta / theta;  // dt
        row[j++] = delta / sigma;  // ds
        row[j++] = delta / beta;   // db
        row[j++] = alpha / theta;  // at
      }

      // EMG: abspow only (no relative bands/ratios)
      if (chType === "emg") {
        const { freqs, psd } = dsp.welchMedianPSD(ep, fs, nperseg);
        totalBroad = dsp.trapzBand(psd, freqs, 0.4, 30.0) || 0;
      }

      row[j++] = totalBroad || 0;

      // nonlinear
      row[j++] = permEntropy(ep, 3, 1);
      row[j++] = higuchiFD(ep, 10);
      row[j++] = petrosianFD(ep);

      mat[t] = row;
    }

    return { names, mat };
  }

  function buildFeatureTable(signals, fs, epochSec, metadata, dsp) {
    const chOrder = [];
    if (signals.eeg) chOrder.push(["eeg", signals.eeg]);
    if (signals.eog) chOrder.push(["eog", signals.eog]);
    if (signals.emg) chOrder.push(["emg", signals.emg]);

    const chEpochs = chOrder.map(([type, arr]) => [type, windowEpochs(arr, fs, epochSec)]);
    const T = chEpochs[0][1].length;

    if (!Number.isFinite(T) || T <= 0) {
      throw new Error(`buildFeatureTable: 0 epochs. epochSec=${epochSec} fs=${fs}`);
    }

    const feats = [];
    for (const [type, epochs] of chEpochs) {
      const { names, mat } = extractChannelFeatures(epochs, fs, epochSec, type, dsp);
      feats.push({ type, names, mat });
    }

    const allNames = [];
    let Dall = 0;
    for (const f of feats) {
      for (const nm of f.names) allNames.push(`${f.type}_${nm}`);
      Dall += f.names.length;
    }

    const base = new Array(T);
    for (let t = 0; t < T; t++) {
      const row = new Float64Array(Dall);
      let j = 0;
      for (const f of feats) {
        const r = f.mat[t];
        for (let k = 0; k < r.length; k++) row[j++] = r[k];
      }
      base[t] = row;
    }

    const rollC = robustScaleMatrixCols(rollingTriangCentered(base, 15));
    const rollP = robustScaleMatrixCols(rollingPastMean(base, 4));

    const namesC = allNames.map(nm => `${nm}_c7min_norm`);
    const namesP = allNames.map(nm => `${nm}_p2min_norm`);

    const timeHour = new Float64Array(T);
    const timeNorm = new Float64Array(T);
    const totalSec = (T - 1) * epochSec || 1;
    for (let t = 0; t < T; t++) {
      const sec = t * epochSec;
      timeHour[t] = sec / 3600;
      timeNorm[t] = sec / totalSec;
    }

    const hasAge = metadata && Number.isFinite(metadata.age);
    const hasMale = metadata && (metadata.male === 0 || metadata.male === 1 || metadata.male === true || metadata.male === false);

    const finalNames = allNames
      .concat(namesC)
      .concat(namesP)
      .concat(["time_hour", "time_norm"])
      .concat(hasAge ? ["age"] : [])
      .concat(hasMale ? ["male"] : []);

    const finalMat = new Array(T);
    for (let t = 0; t < T; t++) {
      const row = new Float64Array(finalNames.length);
      let j = 0;

      const b = base[t];
      for (let k = 0; k < b.length; k++) row[j++] = b[k];

      const rc = rollC[t];
      for (let k = 0; k < rc.length; k++) row[j++] = rc[k];

      const rp = rollP[t];
      for (let k = 0; k < rp.length; k++) row[j++] = rp[k];

      row[j++] = timeHour[t];
      row[j++] = timeNorm[t];
      if (hasAge) row[j++] = Math.trunc(metadata.age);
      if (hasMale) row[j++] = metadata.male ? 1 : 0;

      finalMat[t] = row;
    }

    const sort = true;
    if (sort) {
      const sortedNames = sortFeatureNames(finalNames);
      const nameToIdx = new Map(finalNames.map((n, i) => [n, i]));

      const sortedMat = new Array(T);
      for (let t = 0; t < T; t++) {
        const src = finalMat[t];
        const dst = new Float64Array(sortedNames.length);
        for (let i = 0; i < sortedNames.length; i++) dst[i] = src[nameToIdx.get(sortedNames[i])];
        sortedMat[t] = dst;
      }
      return { featureNames: sortedNames, X: sortedMat };
    }

    return { featureNames: finalNames, X: finalMat };
  }

  window.YASA_FEATURES = { buildFeatureTable };
})();