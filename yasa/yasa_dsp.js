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

  // One-sided PSD for a single segment (Welch inner loop).
  // Returns { freqs: Float64Array, pxx: Float64Array } where freqs spans [0..fs/2].
  function rfftOneSidedPxx(x, fs, win, nfft) {
    const n = x.length;
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);

    // Window + (optional) mean removal (detrend constant)
    let mu = 0;
    for (let i = 0; i < n; i++) mu += x[i];
    mu /= (n || 1);

    for (let i = 0; i < n; i++) re[i] = (x[i] - mu) * win[i];
    for (let i = n; i < nfft; i++) re[i] = 0;

    fftRadix2(re, im);

    const nOut = (nfft >> 1) + 1;
    const freqs = new Float64Array(nOut);
    const pxx = new Float64Array(nOut);

    // Scale consistent with Welch "density":
    // Pxx = |X|^2 / (fs * sum(win^2))
    let winPow = 0;
    for (let i = 0; i < n; i++) winPow += win[i] * win[i];
    winPow = winPow || 1;

    const scale = 1 / (fs * winPow);

    // one-sided: double non-DC and non-Nyquist bins
    for (let k = 0; k < nOut; k++) {
      freqs[k] = (k * fs) / nfft;
      const mag2 = re[k] * re[k] + im[k] * im[k];
      let val = mag2 * scale;
      if (k !== 0 && k !== nfft / 2) val *= 2;
      pxx[k] = val;
    }

    return { freqs, pxx };
  }

  // Welch PSD with median averaging across segments.
  // opts: { nperseg, noverlap, nfft } (samples)
  function welchMedian(x, fs, opts) {
    const nperseg = opts?.nperseg ?? Math.max(8, Math.floor(fs * 5)); // default 5s
    const noverlap = opts?.noverlap ?? Math.floor(nperseg / 2);
    const step = Math.max(1, nperseg - noverlap);
    const nfft = opts?.nfft ?? nextPow2(nperseg);

    if (x.length < nperseg) {
      // pad to one segment
      const pad = new Float64Array(nperseg);
      for (let i = 0; i < x.length; i++) pad[i] = x[i];
      x = pad;
    }

    const win = hamming(nperseg);
    const nOut = (nfft >> 1) + 1;

    // Collect per-bin values across segments to median them.
    const acc = Array.from({ length: nOut }, () => []);
    let nSeg = 0;

    for (let start = 0; start + nperseg <= x.length; start += step) {
      nSeg++;
      const seg = x.subarray(start, start + nperseg);
      const { freqs, pxx } = rfftOneSidedPxx(seg, fs, win, nfft);
      for (let k = 0; k < nOut; k++) acc[k].push(pxx[k]);
      // freqs same each segment; keep last
      opts._freqs = freqs;
    }

    const freqs = opts._freqs || new Float64Array(nOut);
    const pxxMed = new Float64Array(nOut);
    for (let k = 0; k < nOut; k++) {
      pxxMed[k] = median(acc[k]);
    }

    return { freqs, pxx: pxxMed, nSeg };
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
    resampleTo100Hz: (x, fsIn) => downsampleTo(x, fsIn, 100),   // or your existing resampler
    bandpass_04_30: (x, fs) => bandpass04_30(x, fs, 0.4, 30.0), // adapt to your bandpass signature
  
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
  };
  
  window.YASA_DSP = api;
})();
