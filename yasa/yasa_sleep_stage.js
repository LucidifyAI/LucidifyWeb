/*!
 * yasa_sleep_stage.js
 *
 * Adapter layer to keep your existing main.js call:
 *   window.LucidifyYasaSleepStage.runFromSamples(samples, fs, opts)
 *
 * Depends on:
 *   - yasa/yasa_dsp.js        (window.YASA_DSP)
 *   - yasa/yasa_features.js   (window.YASA_FEATURES)
 *   - yasa/yasa_lgbm.js       (window.YASA_LGBM)
 *   - yasa/yasa_staging.js    (window.YASA_STAGE)
 *
 * Attribution / License:
 *   This is an independent JavaScript adapter for a YASA-compatible staging engine.
 *   YASA (Python) is BSD-3-Clause. Include the upstream LICENSE in /yasa/LICENSE.
 */

(function () {
  "use strict";

  async function loadJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Failed to load JSON: ${url} (${r.status})`);
    return await r.json();
  }

  function argmaxRow(p) {
    let best = 0;
    let bestv = p[0];
    for (let i = 1; i < p.length; i++) {
      if (p[i] > bestv) { bestv = p[i]; best = i; }
    }
    return best;
  }

  function stageNameToId(stageName) {
    // YASA returns ["W","N1","N2","N3","R"]
    switch (stageName) {
      case "W": return 0;
      case "N1": return 1;
      case "N2": return 2;
      case "N3": return 3;
      case "R": return 4;
      default: return 0;
    }
  }

  // Expose same API style as your existing LucidifySleepStage runner.
  window.LucidifyYasaSleepStage = {
    /**
     * runFromSamples(samples, fs, opts)
     *
     * samples: Array<number> | Float32Array | Float64Array
     * fs: sampling rate of samples
     *
     * opts:
     *   epochSec?: number (default 30)
     *   modelUrl?: string (default "yasa/yasa_model_dump.json")
     *   physDim?: string|null (unused here; samples should already be in µV for best parity)
     *   metadata?: { age?: number, male?: 0|1|true|false } (optional)
     *   eogSamples?: Array<number> (optional; must align in time with EEG)
     *   emgSamples?: Array<number> (optional; must align in time with EEG)
     */
    async runFromSamples(samples, fs, opts) {
      if (!window.YASA_STAGE?.stageYASA) {
        throw new Error("YASA_STAGE.stageYASA not found. Check script load order.");
      }

      const epochSec = opts?.epochSec ?? 30;
      const modelUrl = opts?.modelUrl ?? "yasa/yasa_model_dump.json";
      const metadata = opts?.metadata ?? null;

      // If you want to support EOG/EMG later, pass via opts.
      const eog = opts?.eogSamples ?? null;
      const emg = opts?.emgSamples ?? null;

      // Load model dump once per call (you can cache at a higher level if desired).
	  const modelDump =
	  window.__YASA_MODEL_DUMP__ ??
	  await loadJSON(modelUrl);
	  
      // Run YASA-like staging. Expects signals in µV.
      const result = await window.YASA_STAGE.stageYASA({
        eeg: samples,
        eog,
        emg,
        fs,
        epochSec,
        metadata,
        modelDump,
        classNames: ["W", "N1", "N2", "N3", "R"],
      });

      // Convert stage labels to ids matching your hypnogram renderer:
      // 0=W,1=N1,2=N2,3=N3,4=REM
      // (YASA uses "R" for REM.)
      const probs = result.probs; // Array< Float64Array(5) >
      const stages = new Array(probs.length);

      for (let i = 0; i < probs.length; i++) {
        // Prefer YASA's predicted labels if present (result.stages are names).
        // But keep robust by computing from probs.
        const id = result.stages && result.stages[i] ? stageNameToId(result.stages[i]) : argmaxRow(probs[i]);
        stages[i] = id;
      }

      return { stages, probs };
    },
  };
})();
