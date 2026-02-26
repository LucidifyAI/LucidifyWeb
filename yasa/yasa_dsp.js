/*  yasa_dsp.js
    DSP utilities for YASA-like staging in pure JS.

    Implements:
      - Downsample/resample helpers (target 100 Hz)
      - Simple Butterworth-ish bandpass (0.4–30 Hz) via RBJ biquads
      - Welch PSD with Hamming window, median averaging
      - Bandpower integration helpers

    License note:
      This file is an original implementation for compatibility.
*/
(function () {
  "use strict";
  const MNE_FIR_0P4_30_FS100 = window.__MNE_FIR_0P4_30_FS100__ || null;
  // ------------------------- small math helpers -------------------------
  function clamp(x, a, b) { return Math.min(Math.max(x, a), b); }

  function mean(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i];
    return x.length ? (s / x.length) : 0;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Array.from(arr);
    a.sort((p, q) => p - q);
    const m = a.length >> 1;
    return (a.length & 1) ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function hamming(N) {
    const w = new Float64Array(N);
    const a0 = 0.54, a1 = 0.46;
    const denom = (N - 1) || 1;
    for (let n = 0; n < N; n++) {
      w[n] = a0 - a1 * Math.cos((2 * Math.PI * n) / denom);
    }
    return w;
  }
function hann(N) {
  const w = new Float64Array(N);
  const denom = (N - 1) || 1;
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
  }
  return w;
}
  // ------------------------- FFT (radix-2) -------------------------
  // in-place FFT on Float64Array re/im (length must be power of 2)
  function fftRadix2(re, im) {
    const n = re.length;

    // bit reversal
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) { j -= m; m >>= 1; }
      j += m;
    }

    // butterflies
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vr = re[i + k + half], vi = im[i + k + half];
          const vRe = vr * wRe - vi * wIm;
          const vIm = vr * wIm + vi * wRe;

          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + half] = uRe - vRe;
          im[i + k + half] = uIm - vIm;

          const nwRe = wRe * wlenRe - wIm * wlenIm;
          const nwIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nwRe; wIm = nwIm;
        }
      }
    }
  }
function isPowerOf2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

// In-place multiply complex arrays: (ar + i ai) *= (br + i bi)
function cmulInplace(ar, ai, br, bi) {
  for (let i = 0; i < ar.length; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
}

// Inverse FFT for radix-2 via conjugate trick
function ifftRadix2(re, im) {
  for (let i = 0; i < re.length; i++) im[i] = -im[i];
  fftRadix2(re, im);
  const invN = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= invN;
    im[i] = -im[i] * invN;
  }
}

// Bluestein FFT for arbitrary length n (complex), output length n.
function fftBluestein(re, im) {
  const n = re.length;
  if (n === 1) return { reOut: Float64Array.of(re[0]), imOut: Float64Array.of(im[0]) };

  // m = next power of 2 >= 2n-1
  let m = 1;
  while (m < (2 * n - 1)) m <<= 1;

  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);

  // a[k] = x[k] * exp(-i*pi*k^2/n)
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    aRe[k] = re[k] * c - im[k] * s;
    aIm[k] = re[k] * s + im[k] * c;
  }

  // b[k] = exp(+i*pi*k^2/n), mirrored
  for (let k = 0; k < n; k++) {
    const ang = +Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    bRe[k] = c;
    bIm[k] = s;
    if (k !== 0) {
      bRe[m - k] = c;
      bIm[m - k] = s;
    }
  }

  // FFT(a), FFT(b) using radix-2 on length m
  fftRadix2(aRe, aIm);
  fftRadix2(bRe, bIm);

  // pointwise multiply
  cmulInplace(aRe, aIm, bRe, bIm);

  // inverse FFT
  ifftRadix2(aRe, aIm);

  // y[k] = conv[k] * exp(-i*pi*k^2/n)
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    const cr = aRe[k];
    const ci = aIm[k];
    outRe[k] = cr * c - ci * s;
    outIm[k] = cr * s + ci * c;
  }

  return { reOut: outRe, imOut: outIm };
}

// Unified FFT: radix-2 if possible else Bluestein
function fftAny(re, im) {
  const n = re.length;
  if (isPowerOf2(n)) {
    fftRadix2(re, im);
    return { reOut: re, imOut: im };
  }
  return fftBluestein(re, im);
}

function hann(N) {
  const w = new Float64Array(N);
  const denom = (N - 1) || 1;
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
  }
  return w;
}
  // One-sided PSD for a single segment (Welch inner loop).
  // Returns { freqs: Float64Array, pxx: Float64Array } where freqs spans [0..fs/2].
  function rfftOneSidedPxx(x, fs, win, nfft) {
  const n = x.length;

  // detrend="constant"
  let mu = 0;
  for (let i = 0; i < n; i++) mu += x[i];
  mu /= (n || 1);

  // Window + zero-pad to nfft
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);

  for (let i = 0; i < n; i++) re[i] = (x[i] - mu) * win[i];
  for (let i = n; i < nfft; i++) re[i] = 0;

  // FFT (supports non-power-of-2 via Bluestein)
  const { reOut, imOut } = fftAny(re, im);

  const nOut = Math.floor(nfft / 2) + 1;
  const freqs = new Float64Array(nOut);
  const pxx = new Float64Array(nOut);

  // SciPy welch scaling='density': |X|^2 / (fs * sum(win^2))
  let winPow = 0;
  for (let i = 0; i < n; i++) winPow += win[i] * win[i];
  winPow = winPow || 1;
  const scale = 1 / (fs * winPow);

  // one-sided doubling except DC and Nyquist (if even nfft)
  const nyqBin = (nfft % 2 === 0) ? (nfft / 2) : -1;

  for (let k = 0; k < nOut; k++) {
    freqs[k] = (k * fs) / nfft;
    const mag2 = reOut[k] * reOut[k] + imOut[k] * imOut[k];
    let val = mag2 * scale;
    if (k !== 0 && k !== nyqBin) val *= 2;
    pxx[k] = val;
  }

  return { freqs, pxx };
}

  // Welch PSD with median averaging across segments.
  // opts: { nperseg, noverlap, nfft } (samples)
function welchMedian(x, fs, opts) {
  const nperseg = opts?.nperseg ?? Math.max(8, Math.floor(fs * 5)); // 5s default
  const noverlap = opts?.noverlap ?? Math.floor(nperseg / 2);
  const step = Math.max(1, nperseg - noverlap);

  // IMPORTANT: back to nextPow2
  const nfft = opts?.nfft ?? nextPow2(nperseg);

  if (x.length < nperseg) {
    const pad = new Float64Array(nperseg);
    for (let i = 0; i < x.length; i++) pad[i] = x[i];
    x = pad;
  }

  const win = hamming(nperseg);
  const nOut = Math.floor(nfft / 2) + 1;

  const acc = Array.from({ length: nOut }, () => []);
  let freqsLast = null;

  for (let start = 0; start + nperseg <= x.length; start += step) {
    const seg = x.subarray(start, start + nperseg);
    const { freqs, pxx } = rfftOneSidedPxx(seg, fs, win, nfft);
    freqsLast = freqs;
    for (let k = 0; k < nOut; k++) acc[k].push(pxx[k]);
  }

  const freqs = freqsLast || new Float64Array(nOut);
  const pxxMed = new Float64Array(nOut);
  for (let k = 0; k < nOut; k++) pxxMed[k] = median(acc[k]);

  return { freqs, pxx: pxxMed };
}

  // Integrate PSD over [fmin,fmax] using trapezoids.
  function bandpowerFromPxx(freqs, pxx, fmin, fmax) {
    const lo = Math.min(fmin, fmax);
    const hi = Math.max(fmin, fmax);
    let s = 0;
    for (let i = 0; i < freqs.length - 1; i++) {
      const f0 = freqs[i], f1 = freqs[i + 1];
      if (f1 < lo || f0 > hi) continue;
      const a0 = clamp(f0, lo, hi);
      const a1 = clamp(f1, lo, hi);
      const w = (a1 - a0);
      if (w <= 0) continue;

      // linear interpolate pxx at clamped endpoints
      const t0 = (a0 - f0) / (f1 - f0 || 1);
      const t1 = (a1 - f0) / (f1 - f0 || 1);
      const p0 = pxx[i] + (pxx[i + 1] - pxx[i]) * t0;
      const p1 = pxx[i] + (pxx[i + 1] - pxx[i]) * t1;

      s += 0.5 * (p0 + p1) * w;
    }
    return s;
  }
//---------------------------------------------------------------------------------
function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function firBandpassKernel(lowHz, highHz, fs, taps) {
  // windowed-sinc bandpass = lowpass(high) - lowpass(low)
  // then normalize gain at f0 (default 10 Hz) so |H(f0)| = 1
  const M = taps - 1;
  const h = new Float64Array(taps);

  const fc1 = lowHz / fs;   // 0..0.5
  const fc2 = highHz / fs;

  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // Hamming
    const lp2 = 2 * fc2 * sinc(2 * fc2 * k);
    const lp1 = 2 * fc1 * sinc(2 * fc1 * k);
    h[n] = (lp2 - lp1) * w;
  }

  // Normalize gain at a representative passband frequency.
  // Pick f0=10 Hz (well within 0.4–30).
  const f0 = 10.0;
  const w0 = 2 * Math.PI * (f0 / fs);

  let re = 0, im = 0;
  for (let n = 0; n < taps; n++) {
    const ang = -w0 * n;
    const c = Math.cos(ang), s = Math.sin(ang);
    re += h[n] * c;
    im += h[n] * s;
  }
  const mag = Math.sqrt(re * re + im * im) || 1;

  // Scale taps so |H(f0)| = 1
  for (let n = 0; n < taps; n++) h[n] /= mag;

  return h;
}

function firConvolveSame(x, h) {
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);
  const half = (m - 1) >> 1;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < m; k++) {
      const xi = i + k - half;
      if (xi >= 0 && xi < n) acc += x[xi] * h[k];
    }
    y[i] = acc;
  }
  return y;
}

function filtfiltFIR_reflect(x, h) {
  // Reflect padding to avoid edge attenuation (critical for low cutoff like 0.4 Hz)
  const n = x.length;
  const m = h.length;
  const pad = Math.min(n - 1, 3 * (m - 1)); // typical filtfilt padlen heuristic
  if (pad <= 0) return firConvolveSame(x, h);

  // build padded signal: reflect at both ends
  const xp = new Float64Array(n + 2 * pad);
  // left pad (reflect)
  for (let i = 0; i < pad; i++) {
    xp[i] = x[pad - i]; // reflect around x[0]
  }
  // center
  for (let i = 0; i < n; i++) {
    xp[pad + i] = x[i];
  }
  // right pad (reflect)
  for (let i = 0; i < pad; i++) {
    xp[pad + n + i] = x[n - 2 - i];
  }

  // forward filter (same-length conv on padded)
  const y1 = firConvolveSame(xp, h);

  // reverse
  const yr = new Float64Array(y1.length);
  for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];

  // backward filter
  const y2 = firConvolveSame(yr, h);

  // reverse back
  const y = new Float64Array(y2.length);
  for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];

  // remove padding
  return y.subarray(pad, pad + n);
}
function bandpassMNE_04_30_zeroPhase_fs100(x, fs) {
  if (fs !== 100) throw new Error(`bandpassMNE_04_30_zeroPhase_fs100 expects fs=100, got ${fs}`);

  if (!MNE_FIR_0P4_30_FS100 || !Array.isArray(MNE_FIR_0P4_30_FS100.taps)) {
    throw new Error("Missing window.__MNE_FIR_0P4_30_FS100__ (load mne_fir_0p4_30_fs100.js before yasa_dsp.js).");
  }
  if (MNE_FIR_0P4_30_FS100.taps.length !== 825) {
    throw new Error(`MNE taps length mismatch: expected 825, got ${MNE_FIR_0P4_30_FS100.taps.length}`);
  }

  const h = Float64Array.from(MNE_FIR_0P4_30_FS100.taps);
  return filtfiltFIR_reflect(x, h);
}
function bandpassFIR_04_30_zeroPhase(x, fs) {
  if (fs !== 100) throw new Error(`bandpassFIR_04_30_zeroPhase expects fs=100, got ${fs}`);
  const taps = 401; // longer = closer to MNE FIR response
  const h = firBandpassKernel(0.4, 30.0, fs, taps);
  return filtfiltFIR_reflect(x, h);
}
  // ------------------------- resampling / downsampling -------------------------
  // Simple linear resample (works for non-integer ratios).
  function resampleLinear(x, fsIn, fsOut) {
    if (fsIn === fsOut) return Float64Array.from(x);
    const nOut = Math.max(1, Math.floor((x.length * fsOut) / fsIn));
    const y = new Float64Array(nOut);
    const scale = fsIn / fsOut;
    for (let i = 0; i < nOut; i++) {
      const t = i * scale;
      const j = Math.floor(t);
      const a = t - j;
      const x0 = (j >= 0 && j < x.length) ? x[j] : 0;
      const x1 = (j + 1 >= 0 && j + 1 < x.length) ? x[j + 1] : x0;
      y[i] = x0 * (1 - a) + x1 * a;
    }
    return y;
  }

  // If ratio is integer, do a light anti-alias via moving average then decimate.
  function decimateMovingAverage(x, factor) {
    factor = Math.max(1, Math.floor(factor));
    if (factor === 1) return Float64Array.from(x);

    const n = x.length;
    const yLen = Math.floor(n / factor);
    const y = new Float64Array(yLen);

    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += x[i];
      if ((i + 1) % factor === 0) {
        y[(i + 1) / factor - 1] = acc / factor;
        acc = 0;
      }
    }
    return y;
  }

function downsampleTo(x, fsIn, fsTarget) {
  if (fsIn === fsTarget) return Float64Array.from(x);

  // Diagnostic: if fsIn is exactly 500 Hz and target is 100 Hz, do pure decimation
  // (take every 5th sample). This avoids moving-average blur and avoids linear interpolation.
  if (fsIn === 500 && fsTarget === 100) {
    const step = 5;
    const n = Math.floor(x.length / step);
    const y = new Float64Array(n);
    for (let i = 0, j = 0; j < n; i += step, j++) {
      y[j] = x[i];
    }
    return y;
  }

  // Fallback to existing behavior for other rates
  const ratio = fsIn / fsTarget;
  if (Math.abs(ratio - Math.round(ratio)) < 1e-9) {
    return decimateMovingAverage(x, Math.round(ratio));
  }
  return resampleLinear(x, fsIn, fsTarget);
}

  // ------------------------- filtering (RBJ biquads) -------------------------
  // RBJ cookbook biquad coefficients.
  // Returns {b0,b1,b2,a1,a2} normalized with a0=1.
  function biquadLowpass(fc, fs, Q) {
    const w0 = 2 * Math.PI * (fc / fs);
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);

    let b0 = (1 - cosw0) / 2;
    let b1 = (1 - cosw0);
    let b2 = (1 - cosw0) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;

    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return { b0, b1, b2, a1, a2 };
  }

  function biquadHighpass(fc, fs, Q) {
    const w0 = 2 * Math.PI * (fc / fs);
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);

    let b0 = (1 + cosw0) / 2;
    let b1 = -(1 + cosw0);
    let b2 = (1 + cosw0) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;

    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return { b0, b1, b2, a1, a2 };
  }

  function applyBiquad(x, c) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const { b0, b1, b2, a1, a2 } = c;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      y[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return y;
  }
function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function firLowpassKernel(cutoffHz, fs, taps) {
  // windowed-sinc lowpass, Hamming window
  // cutoffHz: e.g. 40 for decim 500->100 (Nyquist target=50, keep passband <= 40)
  const fc = cutoffHz / fs; // normalized (cycles/sample), 0..0.5
  const M = taps - 1;
  const h = new Float64Array(taps);

  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // Hamming
    const val = 2 * fc * sinc(2 * fc * k) * w;
    h[n] = val;
    sum += val;
  }

  // normalize DC gain to 1
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

function firConvolve(x, h) {
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);
  const half = (m - 1) >> 1;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < m; k++) {
      const xi = i + k - half;
      if (xi >= 0 && xi < n) acc += x[xi] * h[k];
    }
    y[i] = acc;
  }
  return y;
}

function filtfiltFIR_zeroPad(x, h) {
  // zero-phase FIR by forward/backward filtering (no padding)
  const y1 = firConvolve(x, h);
  // reverse
  const yr = new Float64Array(y1.length);
  for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];
  const y2 = firConvolve(yr, h);
  // reverse back
  const y = new Float64Array(y2.length);
  for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];
  return y;
}

function decimateBy5(x) {
  const n = Math.floor(x.length / 5);
  const y = new Float64Array(n);
  for (let i = 0, j = 0; j < n; i += 5, j++) y[j] = x[i];
  return y;
}

function resample500To100FIR(x) {
  // Anti-alias lowpass then decimate by 5.
  // cutoff chosen conservatively below new Nyquist=50Hz.
  const taps = 101;          // odd length
  const cutoff = 40;         // Hz
  const h = firLowpassKernel(cutoff, 500, taps);
  const xf = filtfiltFIR_reflect(x, h);
  return decimateBy5(xf);
}
  // A practical bandpass: cascade HP then LP, each applied twice (≈4th-order overall).
  function bandpass04_30(x, fs, fLo, fHi) {
    const lo = Math.max(0.0001, fLo);
    const hi = Math.min(0.499 * fs, fHi);
    const Q = Math.SQRT1_2; // ~0.707 (Butterworth-ish)

    let y = Float64Array.from(x);
    // highpass twice
    const hp = biquadHighpass(lo, fs, Q);
    y = applyBiquad(y, hp);
    y = applyBiquad(y, hp);
    // lowpass twice
    const lp = biquadLowpass(hi, fs, Q);
    y = applyBiquad(y, lp);
    y = applyBiquad(y, lp);
    return y;
  }

  // ------------------------- exported API -------------------------
  // --- export API with names expected by yasa_staging.js ---
  const api = {
    // expected names:
resampleTo100Hz: (x, fsIn) => {
  if (fsIn === 100) return Float64Array.from(x);
  if (fsIn === 500) return resample500To100FIR(Float64Array.from(x));
  return downsampleTo(x, fsIn, 100); // fallback for other rates
},
bandpass_04_30: (x, fs) => bandpassMNE_04_30_zeroPhase_fs100(x, fs),
  
    // expected by yasa_features.js if you used my earlier feature code:
welchMedianPSD: (epoch, fs, nperseg) => {
  const { freqs, pxx } = welchMedian(epoch, fs, { nperseg });
  return { freqs, psd: pxx };
},
    trapzBand: (psd, freqs, f0, f1) => bandpowerFromPxx(freqs, psd, f0, f1),
  
    // also expose originals (optional)
    _downsampleTo: downsampleTo,
    _bandpowerFromPxx: bandpowerFromPxx,
    _welchMedian: welchMedian,
	bandpassFIR_04_30_zeroPhase,
  };
  
  window.YASA_DSP = api;
})();
