// harness_js_check.js
// Usage:
//   node harness_js_check.js yasa_ref.json
//
// Assumes these files exist in the same folder:
//   - yasa_dsp.js               (your current JS DSP bundle)
//   - (optional) mne_fir_0p4_30_fs100.json  (ONLY if yasa_dsp.js expects it; if embedded, fine)

const fs = require("fs");
const vm = require("vm");
const path = require("path");

function loadScriptIntoContext(ctx, filename) {
  const code = fs.readFileSync(filename, "utf8");
  vm.runInContext(code, ctx, { filename });
}

function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}
function std(x) {
  const mu = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mu;
    s += d * d;
  }
  return x.length ? Math.sqrt(s / x.length) : 0;
}
function chk(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * (i + 1);
  return s;
}
function stats(x) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < mn) mn = x[i];
    if (x[i] > mx) mx = x[i];
  }
  return { n: x.length, mean: mean(x), std: std(x), min: mn, max: mx, chk: chk(x) };
}
function diffReport(name, a, b) {
  // compares Float64/Array of same length
  const n = Math.min(a.length, b.length);
  let maxAbs = 0;
  let sumAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    const ad = Math.abs(d);
    if (ad > maxAbs) maxAbs = ad;
    sumAbs += ad;
    sumSq += d * d;
  }
  const rmse = Math.sqrt(sumSq / (n || 1));
  console.log(`${name}: n=${n} maxAbs=${maxAbs} meanAbs=${sumAbs / (n || 1)} rmse=${rmse}`);
}

function assertNear(label, a, b, relTol = 1e-6, absTol = 1e-9) {
  const d = Math.abs(a - b);
  const ok = d <= Math.max(absTol, relTol * Math.max(1, Math.abs(b)));
  console.log(`${label}: JS=${a} PY=${b} diff=${d} ${ok ? "OK" : "!!"}`);
  return ok;
}

function main() {
  const refPath = process.argv[2] || "yasa_ref.json";
  const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));

  // VM context that looks like a browser enough for your IIFE
  const ctx = vm.createContext({
    console,
    window: {},        // your yasa_dsp.js attaches to window.YASA_DSP
    Float64Array,
    Math,
  });
  ctx.window = ctx.window; // explicit

  // Load your DSP
  const dspPath = path.resolve("yasa_dsp.js");
  loadScriptIntoContext(ctx, dspPath);

  if (!ctx.window.YASA_DSP) throw new Error("window.YASA_DSP not found after loading yasa_dsp.js");

  const DSP = ctx.window.YASA_DSP;

  // Rebuild the exact same synthetic raw_500 from Python’s first32 + stats is NOT enough,
  // so we do the same generator in JS too with the same RNG seed.
  //
  // To keep it simple + deterministic without implementing numpy RNG,
  // we just compare the *pipeline outputs* using Python’s first32 as a smoke test,
  // and then compare the stage stats and PSD scalars.
  //
  // If you want bit-identical arrays, we can switch to: Python dumps the full raw_500.
  //
  // For now: we will regenerate the synth in JS with a small LCG RNG.

  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function randn(rng) {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  function makeSynth(fs, seconds) {
    const n = Math.floor(fs * seconds);
    const x = new Float64Array(n);
    const rng = lcg(1234);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const val =
        120.0 * Math.sin(2 * Math.PI * 1.2 * t) +
        40.0 * Math.sin(2 * Math.PI * 10.0 * t) +
        15.0 * Math.sin(2 * Math.PI * 20.0 * t) +
        30.0 * Math.sin(2 * Math.PI * 0.2 * t) +
        5.0 * randn(rng);
      x[i] = val;
    }
    return x;
  }

  const fsIn = ref.meta.fs_in;
  const fsOut = ref.meta.fs;

  const raw500 = makeSynth(fsIn, 30.0);
  const resamp100 = DSP.resampleTo100Hz(raw500, fsIn);
  const bp100 = DSP.bandpass_04_30(resamp100, fsOut);

  // Stats comparisons
  console.log("\n=== STATS (JS vs PY) ===");
  const sRaw = stats(raw500);
  const sRes = stats(resamp100);
  const sBp = stats(bp100);

  const pyRaw = ref.signals.raw_500.stats;
  const pyRes = ref.signals.resamp_100.stats;
  const pyBp = ref.signals.bandpass_100.stats;

  assertNear("raw.mean", sRaw.mean, pyRaw.mean, 1e-2, 1e-2);
  assertNear("raw.std",  sRaw.std,  pyRaw.std,  1e-2, 1e-2);

  assertNear("resamp.mean", sRes.mean, pyRes.mean, 1e-2, 1e-2);
  assertNear("resamp.std",  sRes.std,  pyRes.std,  1e-2, 1e-2);

  assertNear("bp.mean", sBp.mean, pyBp.mean, 1e-2, 1e-2);
  assertNear("bp.std",  sBp.std,  pyBp.std,  1e-2, 1e-2);

  // Welch/PSD + bandpowers
  console.log("\n=== WELCH + BANDPOWER ===");
  const nperseg = ref.welch.nperseg;
  const { freqs, psd } = DSP.welchMedianPSD(bp100, fsOut, nperseg);

  // Scalars
  const df = freqs[1] - freqs[0];
  let psdSum = 0;
  for (let i = 0; i < psd.length; i++) psdSum += psd[i];

  assertNear("df", df, ref.welch.df, 1e-6, 1e-9);
  assertNear("psdSum", psdSum, ref.welch.psd_sum, 1e-2, 1e-2);
  assertNear("psdSum*df", psdSum * df, ref.welch.psd_sum_df, 1e-2, 1e-2);

  // Bandpowers (trapz)
  const abs_0p4_30 = DSP.trapzBand(psd, freqs, 0.4, 30.0);
  const abs_sdelta = DSP.trapzBand(psd, freqs, 0.4, 1.0);
  const abs_fdelta = DSP.trapzBand(psd, freqs, 1.0, 4.0);
  const abs_delta = DSP.trapzBand(psd, freqs, 0.4, 4.0);

  assertNear("abs_0p4_30", abs_0p4_30, ref.bandpower.abs_0p4_30, 1e-2, 1e-2);
  assertNear("abs_sdelta", abs_sdelta, ref.bandpower.abs_sdelta, 1e-2, 1e-2);
  assertNear("abs_fdelta", abs_fdelta, ref.bandpower.abs_fdelta, 1e-2, 1e-2);
  assertNear("abs_delta", abs_delta, ref.bandpower.abs_delta, 1e-2, 1e-2);

  // Optional detailed diffs (freq arrays and psd arrays)
  console.log("\n=== ARRAY DIFFS (freqs/psd) ===");
  diffReport("freqs", freqs, ref.welch.freqs);
  diffReport("psd", psd, ref.welch.psd);

  console.log("\nDone.");
}

main();