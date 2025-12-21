(function () {
  "use strict";

  // ---- Embedded model.json ----
  const MODEL = {
    format: "sleep_stage_lr_v1",
    labels: ["W","N1","N2","N3","REM"],
    feature_order: [
      "log_delta","log_theta","log_alpha","log_sigma","log_beta",
      "log_delta_over_beta","log_sigma_over_theta","log_thetaalpha_over_beta",
      "sef95","spec_entropy","rms","zero_cross_rate"
    ],
    means: [-22.331802368164062,-24.397289276123047,-25.743223190307617,-26.402225494384766,-26.546798706054688,4.214993476867676,-2.0049359798431396,2.361865520477295,8.007974624633789,2.9092788696289062,2.0313264030846767e-05,0.0842948630452156],
    stds: [1.1829572916030884,0.4911311864852905,0.3490687608718872,0.5115553140640259,0.3959295451641083,1.306697964668274,0.5387573838233948,0.6098589897155762,3.4724528789520264,0.45556798577308655,1.0178369848290458e-05,0.03330378606915474],
    W: [
      [-0.004339134320616722,-1.0512455701828003,1.3466871976852417,-2.047595739364624,0.3612864911556244,-0.11339738219976425,-0.9858927726745605,-0.22838787734508514,0.3611123561859131,0.40840476751327515,2.2276034355163574,1.3095165491104126],
      [-0.5634723901748657,-0.2682851254940033,-0.41918861865997314,-0.6458674073219299,0.6761465072631836,-0.7149838805198669,-0.3686991333961487,-0.612909197807312,0.09402799606323242,0.4628537893295288,-0.31794998049736023,0.821704089641571],
      [0.131379172205925,0.42400917410850525,-0.6424850225448608,1.709810495376587,-0.21408069133758545,0.1838100403547287,1.2369418144226074,0.2835305631160736,-0.1886923462152481,0.41069328784942627,-1.1122334003448486,-0.421636164188385],
      [1.9268707036972046,0.8673789501190186,0.40017154812812805,1.579830527305603,-0.1699422150850296,1.7958862781524658,0.7093647122383118,0.8379111289978027,-1.0912206172943115,-0.3058040142059326,0.4472958445549011,-1.7302284240722656],
      [-1.4904383420944214,0.028142597526311874,-0.6851851344108582,-0.5961777567863464,-0.6534100770950317,-1.1513150930404663,-0.5917145609855652,-0.2801446318626404,0.8247725963592529,-0.9761478900909424,-1.244715929031372,0.020643945783376694]
    ],
    b: [-1.2508232593536377,-1.232494831085205,3.9400134086608887,-0.7978888154029846,-0.658806562423706]
  };

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
    const fo = MODEL.feature_order;
    const x = new Array(fo.length);
    for (let i = 0; i < fo.length; i++) {
      const k = fo[i];
      const v = featuresByName[k];
      if (!Number.isFinite(v)) throw new Error(`Missing/non-finite feature: ${k}=${v}`);
      x[i] = (v - MODEL.means[i]) / (MODEL.stds[i] || 1);
    }
    const logits = new Array(MODEL.labels.length);
    for (let c = 0; c < MODEL.labels.length; c++) {
      let s = MODEL.b[c];
      const row = MODEL.W[c];
      for (let j = 0; j < x.length; j++) s += row[j] * x[j];
      logits[c] = s;
    }
    const probs = softmaxStable(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return { predId: best, predLabel: MODEL.labels[best], probs, logits };
  }


  window.LucidifySleepStage = {
    runFromSamples(samples, fs, epochSec = 30) {
      const samplesPerEpoch = Math.floor(fs * epochSec);
      const nEpochs = Math.floor(samples.length / samplesPerEpoch);
      const stages = new Array(nEpochs);
      const probs = new Array(nEpochs);

      for (let e = 0; e < nEpochs; e++) {
        const start = e * samplesPerEpoch;
        const stop = start + samplesPerEpoch;
        const epoch = samples.slice(start, stop);

        const feats = window.computeFeatures(epoch, fs);
        const out = predictFromFeatures(feats);

        stages[e] = out.predLabel;
        probs[e] = out.probs;
      }
      return { stages, probs };
    }
  };
})();
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
window.computeFeatures = computeFeatures;
